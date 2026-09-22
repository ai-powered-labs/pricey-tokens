// ledger.ts — requests 账本 + session_stats/day_stats 物化 (C5/C6 本地账本, 设计 §1/§5 的实现)
// 职责边界: SQLite 账本 (XDG_DATA_HOME/pricey-tokens/usage.db) 的唯一读写面 —
//   - requests 表: request 粒度原子 (含 n_tools 工具调用数), 归并幂等不双计 —
//     req_key 冲突时**后值覆盖且仅在值变化时写** (claude 流式 chunk 的同 messageId
//     行逐次累计、末值权威, 行并非不可变, 中途摄取后终值必须能覆盖; opencode/codex
//     行真不可变, 覆盖与忽略等价)。降级档预留: 未来只给会话累计的源用 req_key 前缀
//     '~sess~' + sess_key, latest-wins (当前三家源均有 request 粒度, 仅预留命名空间)。
//   - turn_events 表: 用户轮次原子 (v3)。用户行不入 requests (不构成用量), 摄取时
//     顺路计数, 同键幂等 (sess_key 后值覆盖, 库重建 rowid 复用时刷新绑定) — 与
//     requests 同款 "行原子 + 键归并" 哲学, 源重扫/库重建均不双计; requests 行
//     永不删 ⇒ 轮次行同样只增不减, 两侧一致陈旧。
//   - session_stats 表 (v3 物化): (harness, sess_key) 会话行 — first/last ts, day=
//     localDayKey(last_ts), 主模型 (产生 max_ctx 请求的模型, 并列取后到者), n_turns
//     (turn_events 计数 join), n_tools (requests Σ), 四分类 Σ, max_ctx (ctxEstimate
//     家族路由, TS 侧求值 — ctx.ts 是公式唯一来源, 严禁 SQL 侧复现)。恒等于 requests
//     ∪ turn_events 的派生, 受影响会话重算自愈。
//   - day_stats 表: day×model 物化 (n_req + n_tools + 三张直方图: ctx_hist 12 桶 /
//     out_hist 9 桶 / max_ctx_hist 12 桶 + 会话归因 n_turns), 增量摄取后只重算受影响
//     日 (含会话归因日迁移), 直接从 requests ∪ session_stats 重聚合, 精确归属。
//   - meta 表: schema_version + 各源摄取水位线 (键契约见 ingest.ts)。
// 会话归因规则 (设计 §5): 会话贡献 (max_ctx_hist + n_turns) 记 (last_ts 日, 主模型),
// 一会话一增量无跨模型双计; n_tools/out_hist/ctx_hist 仍是 request 各归各 (日,模型)。
// 不变量: ΣctxHist==nReq, ΣoutHist==nReq (逐请求入桶, 构造保证); ΣmaxCtxHist 按日
// 聚合 ≤ ΣnSess (会话末日必有请求在当日); **逐行** ΣmaxCtxHist≤nSess 在 "跨日压缩 +
// 换模型续会话" 边缘形态下不成立 (主模型当日无请求但会话末日在此日), 已知接受 —
// 直方图会话原子性 (一会话恰一增量) 不受影响。
// v2→v3 迁移: ALTER 加列 + 全量重算 session_stats/day_stats (从 requests 现算),
// 单事务原子; 存量行 n_tools/n_turns 无源数据 (水位线已过, 源不重扫) 恒 0, 新数据
// 起全字段 — max_ctx/max_ctx_hist 存量同样可从 requests 现算故真实回填。
// 读取面: 分享日记录 (ts 精确窗口) / ProfileV2 日行 (day 对齐窗口) / 对账用
// per-session rollup — 全部窗口路径共用同一聚合核心 (分享口径 == day_stats 口径
// 由构造保证)。ctx 公式与桶表唯一来源是 ctx.ts (契约冻结, 本模块不复现)。
// 体量注记: 源库 data 大载荷不过 TS 边界 (SQL 侧抽取), 但行集与重算读仍 O(N) —
// 50 万行首跑峰值 ~200MB 量级, 年化翻倍, 当前接受 (单机 CLI, 可重建)。
// 位置: dataHome 由调用方注入 (XDG_DATA_HOME 优先语义在 cli/ingest 侧)。
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import type {HarnessId, ProfileDayV2, ProfileModelV2, RequestRow, TurnRow, UsageRecord} from "./types.js";
import {createSqlite, type SqliteRwDb, type SqliteStmt} from "./sqlite.js";
import {CTX_BUCKET_COUNT, ctxBucketIndex, ctxEstimate, emptyCtxHist, emptyOutHist, OUT_BUCKET_COUNT, outBucketIndex} from "./ctx.js";
import {dayEndTs, dayStartTs, localDayKey} from "./day.js";

export const SCHEMA_VERSION = "3";

// 受影响会话引用 (重算编排的单位; Map key 序列化用 `${harness} ${sessKey}`)
export interface SessRef {
  harness: HarnessId;
  sessKey: string;
}

const sessRefKey = (s: SessRef): string => `${s.harness} ${s.sessKey}`;

// IN 子句分块上限 (SQLite 变量数保守界, 兼容旧版 999 限制)
const SQL_CHUNK = 500;

// 账本文件路径 (dataHome 下); dataHome = XDG_DATA_HOME 或 ~/.local/share
export function ledgerPath(dataHome: string): string {
  return join(dataHome, "pricey-tokens", "usage.db");
}

const DDL = `
CREATE TABLE IF NOT EXISTS requests (
  harness  TEXT NOT NULL,
  req_key  TEXT NOT NULL,
  sess_key TEXT NOT NULL,
  model    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  in_t  INTEGER NOT NULL,
  out_t INTEGER NOT NULL,
  cr_t  INTEGER NOT NULL,
  cw_t  INTEGER NOT NULL,
  n_tools INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (harness, req_key)
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_sess ON requests (harness, sess_key);
CREATE TABLE IF NOT EXISTS turn_events (
  harness  TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  sess_key TEXT NOT NULL,
  PRIMARY KEY (harness, turn_key)
);
CREATE INDEX IF NOT EXISTS idx_turn_events_sess ON turn_events (harness, sess_key);
CREATE TABLE IF NOT EXISTS session_stats (
  harness  TEXT NOT NULL,
  sess_key TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL,
  day      TEXT NOT NULL,
  model    TEXT NOT NULL,
  n_turns  INTEGER NOT NULL,
  n_tools  INTEGER NOT NULL,
  in_t  INTEGER NOT NULL,
  out_t INTEGER NOT NULL,
  cr_t  INTEGER NOT NULL,
  cw_t  INTEGER NOT NULL,
  max_ctx  INTEGER NOT NULL,
  PRIMARY KEY (harness, sess_key)
);
CREATE INDEX IF NOT EXISTS idx_session_stats_day ON session_stats (day);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS day_stats (
  day TEXT NOT NULL, model TEXT NOT NULL,
  in_t INTEGER NOT NULL, out_t INTEGER NOT NULL,
  cr_t INTEGER NOT NULL, cw_t INTEGER NOT NULL,
  n_sess INTEGER NOT NULL, n_req INTEGER NOT NULL,
  ctx_hist TEXT NOT NULL,
  out_hist TEXT NOT NULL,
  n_turns INTEGER NOT NULL,
  n_tools INTEGER NOT NULL,
  max_ctx_hist TEXT NOT NULL,
  PRIMARY KEY (day, model)
);
`;

// day×model 聚合累加器 (全部发射/物化窗口路径的共用核心 — 分叉会致 day_stats、
// 分享 hash 与 ProfileV2 静默不一致)。request 各归各字段 (四分类/nReq/ctxHist/
// outHist/nTools) + 会话归因字段 (nTurns/maxCtxHist)。
interface DayModelAcc {
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
  nReq: number;
  nTools: number;
  nTurns: number;
  lastTs: number; // 组内最大 ts (分享日记录的 "当日最后活跃时刻")
  sesses: Set<string>;
  ctxHist: number[];
  outHist: number[];
  maxCtxHist: number[];
}

function newAcc(ts: number): DayModelAcc {
  return {inT: 0, outT: 0, crT: 0, cwT: 0, nReq: 0, nTools: 0, nTurns: 0, lastTs: ts, sesses: new Set(), ctxHist: emptyCtxHist(), outHist: emptyOutHist(), maxCtxHist: emptyCtxHist()};
}

// 直方图 JSON 落盘解析 (发射守卫): 形状 + 可选 Σ 校验 — day_stats 被外部改写的
// 静默损坏在此拦截 (构造侧天然满足不变量)
function parseHist(text: string, expectLen: number, nReq: number | null, what: string, where: string): number[] {
  const hist = JSON.parse(text) as unknown;
  const ok = Array.isArray(hist) && hist.length === expectLen && hist.every((c) => typeof c === "number" && c >= 0) &&
    (nReq === null || hist.reduce((a, b) => a + (b as number), 0) === nReq);
  if (!ok) throw new Error(`day_stats ${what} 损坏 (${where}): ${text}${nReq === null ? "" : ` (nReq=${nReq})`}`);
  return hist as number[];
}

// requests 原始行 (SELECT 输出, 列值未定型) → (day, model) 聚合; ctx/out 入桶唯一
// 来源是 ctx.ts — 本函数是桶计数在账本侧的唯一调用点
function groupRequestRows(rows: ReadonlyArray<Record<string, unknown>>): Map<string, Map<string, DayModelAcc>> {
  const byDay = new Map<string, Map<string, DayModelAcc>>();
  for (const r of rows) {
    const ts = r.ts as number;
    const day = localDayKey(ts);
    let byModel = byDay.get(day);
    if (!byModel) {
      byModel = new Map();
      byDay.set(day, byModel);
    }
    const model = String(r.model);
    let acc = byModel.get(model);
    if (!acc) {
      acc = newAcc(ts);
      byDay.get(day)!.set(model, acc);
    }
    const inT = r.in_t as number;
    const outT = r.out_t as number;
    const crT = r.cr_t as number;
    const cwT = r.cw_t as number;
    acc.inT += inT;
    acc.outT += outT;
    acc.crT += crT;
    acc.cwT += cwT;
    acc.nReq += 1;
    acc.nTools += r.n_tools as number;
    if (ts > acc.lastTs) acc.lastTs = ts;
    acc.sesses.add(String(r.sess_key));
    acc.ctxHist[ctxBucketIndex(ctxEstimate(model, {inT, crT, cwT}))]! += 1;
    acc.outHist[outBucketIndex(outT)]! += 1;
  }
  return byDay;
}

// 会话归因贡献并入日聚合 (day/model 维度; 无 request 侧行的 (日,模型) 组在此
// 按需创建 — 如 "主模型当日无请求但会话末日在此日" 的边缘形态, 该行 nSess/nReq
// 为 0 但 maxCtxHist/nTurns 真实)
function mergeSessionContrib(
  byDay: Map<string, Map<string, DayModelAcc>>,
  day: string,
  model: string,
  nTurns: number,
  maxCtx: number,
): void {
  let byModel = byDay.get(day);
  if (!byModel) {
    byModel = new Map();
    byDay.set(day, byModel);
  }
  let acc = byModel.get(model);
  if (!acc) {
    acc = newAcc(0);
    byModel.set(model, acc);
  }
  acc.nTurns += nTurns;
  acc.maxCtxHist[ctxBucketIndex(maxCtx)]! += 1;
}

export interface SessionRollup {
  model: string;
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
}

// session_stats 行形状 (重算内核产物; 不直接外露, 测试经 SQL 侧读)
interface SessionAgg {
  harness: HarnessId;
  sessKey: string;
  firstTs: number;
  lastTs: number;
  day: string; // localDayKey(last_ts) — 会话归因日
  model: string; // 主模型
  nTurns: number;
  nTools: number;
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
  maxCtx: number;
}

export class Ledger {
  private readonly db: SqliteRwDb;
  private readonly upsertReq: SqliteStmt;
  private readonly insertTurn: SqliteStmt;
  private readonly selectRow: SqliteStmt;
  private readonly getMetaStmt: SqliteStmt;
  private readonly setMetaStmt: SqliteStmt;
  private txDepth = 0;

  private constructor(db: SqliteRwDb) {
    this.db = db;
    // upsert: 变化判定在 TS 侧点查旧行完成 (见 insertRequests), SQL 只负责写入 —
    // 比较逻辑单点持有, 不在 SQL/TS 双写
    this.upsertReq = db.prepare(`INSERT INTO requests (harness, req_key, sess_key, model, ts, in_t, out_t, cr_t, cw_t, n_tools)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(harness, req_key) DO UPDATE SET
        sess_key = excluded.sess_key, model = excluded.model, ts = excluded.ts,
        in_t = excluded.in_t, out_t = excluded.out_t, cr_t = excluded.cr_t, cw_t = excluded.cw_t,
        n_tools = excluded.n_tools`);
    this.insertTurn = db.prepare(`INSERT INTO turn_events (harness, turn_key, sess_key) VALUES (?,?,?)
      ON CONFLICT(harness, turn_key) DO UPDATE SET sess_key = excluded.sess_key`);
    this.selectRow = db.prepare("SELECT sess_key, model, ts, in_t, out_t, cr_t, cw_t, n_tools FROM requests WHERE harness = ? AND req_key = ?");
    this.getMetaStmt = db.prepare("SELECT v FROM meta WHERE k = ?");
    this.setMetaStmt = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  }

  /** 打开 (不存在则初始化) 账本。目录注入供测试。v2 库自动迁移到 v3 (单事务原子);
   * 其余版本不符时抛错 (不猜测降级)。 */
  static async open(dataHome: string): Promise<Ledger> {
    const file = ledgerPath(dataHome);
    await mkdir(join(file, ".."), {recursive: true});
    const db = await createSqlite(file);
    db.exec(DDL);
    const probe = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'");
    const versionRow = probe.all()[0];
    const version = versionRow === undefined ? null : String(versionRow.v);
    if (version === null) {
      const ledger = new Ledger(db);
      ledger.setMeta("schema_version", SCHEMA_VERSION);
      return ledger;
    }
    if (version === SCHEMA_VERSION) return new Ledger(db);
    if (version === "2") return Ledger.migrateV2ToV3(db);
    db.close();
    throw new Error(`账本 schema 版本不符 (${version} ≠ ${SCHEMA_VERSION}): 删除 ${file} 后重跑可全量重建`);
  }

  // v2 → v3 迁移: ALTER 加列 + 全量重算 (单事务原子 — 崩溃回滚保 v2 可重试)。
  // 存量行 n_tools/n_turns 无源 (水位线已过源不重扫, 见头注) 恒 0; max_ctx/
  // max_ctx_hist/ctx_hist/out_hist 从 requests 现算真实回填。
  private static migrateV2ToV3(db: SqliteRwDb): Ledger {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE requests ADD COLUMN n_tools INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE day_stats ADD COLUMN out_hist TEXT NOT NULL DEFAULT '[]'");
      db.exec("ALTER TABLE day_stats ADD COLUMN n_turns INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE day_stats ADD COLUMN n_tools INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE day_stats ADD COLUMN max_ctx_hist TEXT NOT NULL DEFAULT '[]'");
      const ledger = new Ledger(db);
      const pairs = db.prepare("SELECT DISTINCT harness, sess_key AS s FROM requests").all()
        .map((r) => ({harness: r.harness as HarnessId, sessKey: String(r.s)}));
      ledger.recomputeSessions(pairs);
      const days = db.prepare("SELECT DISTINCT day FROM day_stats").all().map((r) => String(r.day));
      ledger.recomputeDays(days);
      ledger.setMeta("schema_version", SCHEMA_VERSION);
      db.exec("COMMIT");
      return ledger;
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ===== 摄入面 =====

  getMeta(k: string): string | null {
    const row = this.getMetaStmt.all(k)[0];
    return row === undefined ? null : String(row.v);
  }

  setMeta(k: string, v: string): void {
    this.setMetaStmt.run(k, v);
  }

  // 事务/嵌套样板单点 (SAVEPOINT 语义: 外层 = 事务, 内层 = 保存点; ROLLBACK 纪律
  // 不逐处手抄; v2 迁移在显式事务内调用重算方法即自然嵌套)
  private tx(fn: () => void): void {
    const sp = `sp_${this.txDepth}`;
    this.txDepth += 1;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      fn();
      this.db.exec(`RELEASE ${sp}`);
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${sp}`);
      this.db.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** 单事务包裹一批写操作 (SAVEPOINT 嵌套: 外层=事务, 内层=保存点)。摄取编排把
   * "归并 + 重算" 收进单事务 — 崩溃整批回滚 → 水位线未推进 → 重扫全量重做
   * (幂等); 多事务批内的中途断裂面 (无轮次会话的同值重放不自愈形态) 由此消除。 */
  runInTx(fn: () => void): void {
    this.tx(fn);
  }

  // 幂等归并一批请求行; 返回 {changed, days, sessions}:
  //   changed = 实际落账变更行数 (同值重放 = 0 — 不双计的锚点; claude 流式终值
  //   覆盖计 1)。变化判定在 TS 侧 (PK 点查旧行, 首跑空表全 miss 零代价)。
  //   days = 受影响日全集 — 变更行的 ts 日 **加上被覆盖行的旧 ts 日** (upsert
  //   换日覆盖时旧日必须重算, 否则 day_stats 残留旧值, 物化与真值永久分叉)。
  //   sessions = 变更行会话 ∪ 被覆盖行旧会话 (upsert 换 sess_key 覆盖时 — 库重建
  //   rowid 复用形态 — 旧会话的 session_stats 必须重算, 否则残留已迁走请求的
  //   max_ctx/轮次, ΣmaxCtxHist 守卫误触)。
  insertRequests(rows: readonly RequestRow[]): {changed: number; days: Set<string>; sessions: SessRef[]} {
    if (rows.length === 0) return {changed: 0, days: new Set(), sessions: []};
    const days = new Set<string>();
    const sessKeys = new Set<string>();
    let changed = 0;
    this.tx(() => {
      for (const r of rows) {
        const prev = this.selectRow.all(r.harness, r.reqKey)[0];
        if (prev === undefined) {
          days.add(localDayKey(r.ts)); // 新行
        } else if (
          (prev.sess_key as string) === r.sessKey && (prev.model as string) === r.model && (prev.ts as number) === r.ts &&
          (prev.in_t as number) === r.inT && (prev.out_t as number) === r.outT && (prev.cr_t as number) === r.crT && (prev.cw_t as number) === r.cwT &&
          (prev.n_tools as number) === r.nTools
        ) {
          continue; // 同值重放: 零写入零受影响日
        } else {
          if ((prev.ts as number) !== r.ts) days.add(localDayKey(prev.ts as number)); // 被覆盖行旧日
          days.add(localDayKey(r.ts));
          if ((prev.sess_key as string) !== r.sessKey) sessKeys.add(sessRefKey({harness: r.harness, sessKey: prev.sess_key as string})); // 被覆盖行旧会话
        }
        this.upsertReq.run(r.harness, r.reqKey, r.sessKey, r.model, r.ts, r.inT, r.outT, r.crT, r.cwT, r.nTools);
        sessKeys.add(sessRefKey({harness: r.harness, sessKey: r.sessKey}));
        changed += 1;
      }
    });
    const sessions = [...sessKeys].map((k) => {
      const sp = k.indexOf(" ");
      return {harness: k.slice(0, sp) as HarnessId, sessKey: k.slice(sp + 1)};
    });
    return {changed, days, sessions};
  }

  // 幂等归并一批用户轮次行 (同键重放零变化; sess_key 后值覆盖 — 库重建 rowid 复用
  // 换会话时刷新绑定, 与 requests 同款 latest-wins); 返回出现过的会话全集 (无论
  // 是否新插入 — 轮次计数变化与请求变化共用同一重算路径, 集合语义足够)
  insertTurns(rows: readonly TurnRow[]): SessRef[] {
    if (rows.length === 0) return [];
    const sessKeys = new Set<string>();
    this.tx(() => {
      for (const r of rows) {
        this.insertTurn.run(r.harness, r.turnKey, r.sessKey);
        sessKeys.add(sessRefKey({harness: r.harness, sessKey: r.sessKey}));
      }
    });
    return [...sessKeys].map((k) => {
      const sp = k.indexOf(" ");
      return {harness: k.slice(0, sp) as HarnessId, sessKey: k.slice(sp + 1)};
    });
  }

  // 单会话重算内核: requests (ORDER BY ts, req_key — 主模型并列取后到者的确定性
  // 基础) + turn_events 计数 → SessionAgg; 无请求行返回 null (会话不存在)
  private recomputeOne(harness: HarnessId, sessKey: string): SessionAgg | null {
    const rows = this.db.prepare(`SELECT model, ts, in_t, out_t, cr_t, cw_t, n_tools FROM requests
      WHERE harness = ? AND sess_key = ? ORDER BY ts, req_key`).all(harness, sessKey);
    if (rows.length === 0) return null;
    const nTurns = (this.db.prepare("SELECT COUNT(*) AS c FROM turn_events WHERE harness = ? AND sess_key = ?").all(harness, sessKey)[0]!.c as number);
    let firstTs = Infinity;
    let lastTs = -Infinity;
    let maxCtx = -1;
    let mainModel = "";
    let nTools = 0;
    const sum = {inT: 0, outT: 0, crT: 0, cwT: 0};
    for (const r of rows) {
      const ts = r.ts as number;
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
      sum.inT += r.in_t as number;
      sum.outT += r.out_t as number;
      sum.crT += r.cr_t as number;
      sum.cwT += r.cw_t as number;
      nTools += r.n_tools as number;
      const model = String(r.model);
      const ctx = ctxEstimate(model, {inT: r.in_t as number, crT: r.cr_t as number, cwT: r.cw_t as number});
      if (ctx >= maxCtx) {
        maxCtx = ctx; // >= : 并列取后到者 (最贴近会话终态的请求)
        mainModel = model;
      }
    }
    return {harness, sessKey, firstTs, lastTs, day: localDayKey(lastTs), model: mainModel, nTurns, nTools, ...sum, maxCtx};
  }

  // 受影响会话重算: DELETE+INSERT 覆盖 (幂等; 恒等于 requests ∪ turn_events 派生,
  // 漂移自愈)。返回受影响归因日全集 = 旧 day ∪ 新 day (会话 last_ts 迁日时旧日的
  // maxCtxHist/nTurns 必须重算, 否则残留双计)。
  recomputeSessions(sessions: Iterable<SessRef>): Set<string> {
    const uniq = new Map<string, SessRef>();
    for (const s of sessions) uniq.set(sessRefKey(s), s);
    if (uniq.size === 0) return new Set();
    const days = new Set<string>();
    const delStmt = this.db.prepare("DELETE FROM session_stats WHERE harness = ? AND sess_key = ?");
    const insStmt = this.db.prepare(`INSERT INTO session_stats
      (harness, sess_key, first_ts, last_ts, day, model, n_turns, n_tools, in_t, out_t, cr_t, cw_t, max_ctx)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const oldDayStmt = this.db.prepare("SELECT day FROM session_stats WHERE harness = ? AND sess_key = ?");
    this.tx(() => {
      for (const s of uniq.values()) {
        const old = oldDayStmt.all(s.harness, s.sessKey)[0];
        if (old !== undefined) days.add(String(old.day));
        delStmt.run(s.harness, s.sessKey);
        const agg = this.recomputeOne(s.harness, s.sessKey);
        if (agg === null) continue; // 无请求行的会话不物化 (轮次只随请求行的会话入账)
        days.add(agg.day);
        insStmt.run(agg.harness, agg.sessKey, agg.firstTs, agg.lastTs, agg.day, agg.model, agg.nTurns, agg.nTools, agg.inT, agg.outT, agg.crT, agg.cwT, agg.maxCtx);
      }
    });
    return days;
  }

  // 受影响日重算: DELETE 受影响日 + 从 requests 全量重聚合回填 (幂等; 与
  // day_stats 现值无关, 恒等于 requests 的派生 — 漂移自愈) + session_stats 归因
  // 贡献并入 (调用方须先 recomputeSessions — 归因日并集进 days)
  recomputeDays(days: Iterable<string>): void {
    const daySet = [...new Set(days)];
    if (daySet.length === 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of daySet) {
      const s = dayStartTs(d);
      const e = dayEndTs(d);
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    }
    const grouped = groupRequestRows(this.requestsSince(lo, [], hi));
    // 会话归因贡献 (受影响日上的全部 session_stats 行)
    for (let i = 0; i < daySet.length; i += SQL_CHUNK) {
      const win = daySet.slice(i, i + SQL_CHUNK);
      const sessRows = this.db.prepare(`SELECT day, model, n_turns, max_ctx FROM session_stats WHERE day IN (${win.map(() => "?").join(",")})`).all(...win);
      for (const r of sessRows) {
        mergeSessionContrib(grouped, String(r.day), String(r.model), r.n_turns as number, r.max_ctx as number);
      }
    }
    const delDay = this.db.prepare("DELETE FROM day_stats WHERE day = ?");
    const insDay = this.db.prepare(`INSERT INTO day_stats
      (day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist, out_hist, n_turns, n_tools, max_ctx_hist)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.tx(() => {
      for (const d of daySet) {
        delDay.run(d);
        const byModel = grouped.get(d);
        if (!byModel) continue; // 该日已无任何请求且无归因会话 (数据被清理的极端形态)
        for (const [model, acc] of byModel) {
          insDay.run(d, model, acc.inT, acc.outT, acc.crT, acc.cwT, acc.sesses.size, acc.nReq,
            JSON.stringify(acc.ctxHist), JSON.stringify(acc.outHist), acc.nTurns, acc.nTools, JSON.stringify(acc.maxCtxHist));
        }
      }
    });
  }

  // ===== 发射面 =====

  requestCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS c FROM requests").all()[0]!.c as number;
  }

  private harnessFilter(harnesses: readonly HarnessId[]): string {
    if (harnesses.length === 0) return "";
    return `AND harness IN (${harnesses.map(() => "?").join(",")})`;
  }

  // 聚合核心的喂入 SQL 投影 SSOT (列清单改动只此一处 — 分享/day_stats 重算/
  // ProfileV2 过滤全部路径共用; maxTs 缺省 = 只设下界)
  private requestsSince(minTs: number, harnesses: readonly HarnessId[], maxTs?: number): Array<Record<string, unknown>> {
    const upper = maxTs === undefined ? "" : " AND ts < ?";
    const rows = this.db.prepare(`SELECT model, sess_key, in_t, out_t, cr_t, cw_t, ts, n_tools FROM requests WHERE ts >= ?${upper} ${this.harnessFilter(harnesses)}`).all(...(maxTs === undefined ? [minTs] : [minTs, maxTs]), ...harnesses);
    return rows;
  }

  // 分享日记录: ts 精确窗口 → (本地日, model) 聚合 (共用聚合核心, ts 取组内最大
  // — 当日最后活跃时刻, 与站点分享语义逐字对齐)
  dailyRecords(sinceMs: number | null, harnesses: readonly HarnessId[]): UsageRecord[] {
    const grouped = groupRequestRows(this.requestsSince(sinceMs ?? 0, harnesses));
    const recs: UsageRecord[] = [];
    for (const byModel of grouped.values()) {
      for (const [model, acc] of byModel) {
        recs.push({model, ts: acc.lastTs, inputTokens: acc.inT, outputTokens: acc.outT, cacheReadTokens: acc.crT, cacheWriteTokens: acc.cwT});
      }
    }
    return recs.sort((a, b) => a.ts - b.ts || (a.model < b.model ? -1 : 1));
  }

  // ProfileV2 日行: day 对齐窗口。无 harness 过滤 → day_stats 直读 (物化热路径);
  // 有过滤 → requests + session_stats 现算 (day_stats 无 harness 维度, 过滤口径由
  // 共用聚合核心保证与物化同构)。两路径共用 accToModelV2 发射与 sortProfileDays
  // 出口守卫 (ΣctxHist==nReq / ΣoutHist==nReq 逐行, ΣmaxCtxHist≤ΣnSess 按日聚合)。
  profileDays(sinceDay: string | null, harnesses: readonly HarnessId[]): ProfileDayV2[] {
    if (harnesses.length === 0) {
      const rows = sinceDay === null
        ? this.db.prepare("SELECT day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist, out_hist, n_turns, n_tools, max_ctx_hist FROM day_stats ORDER BY day").all()
        : this.db.prepare("SELECT day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist, out_hist, n_turns, n_tools, max_ctx_hist FROM day_stats WHERE day >= ? ORDER BY day").all(sinceDay);
      const byDay = new Map<string, ProfileModelV2[]>();
      for (const r of rows) {
        const day = String(r.day);
        let models = byDay.get(day);
        if (!models) {
          models = [];
          byDay.set(day, models);
        }
        const nReq = r.n_req as number;
        const where = `day=${day} model=${String(r.model)}`;
        models.push({
          id: String(r.model),
          in: r.in_t as number,
          out: r.out_t as number,
          cr: r.cr_t as number,
          cw: r.cw_t as number,
          nSess: r.n_sess as number,
          nReq,
          ctxHist: parseHist(String(r.ctx_hist), CTX_BUCKET_COUNT, nReq, "ctx_hist", where),
          outHist: parseHist(String(r.out_hist), OUT_BUCKET_COUNT, nReq, "out_hist", where),
          nTurns: r.n_turns as number,
          nToolCalls: r.n_tools as number,
          maxCtxHist: parseHist(String(r.max_ctx_hist), CTX_BUCKET_COUNT, null, "max_ctx_hist", where),
        });
      }
      return sortProfileDays(byDay);
    }
    const sinceTs = sinceDay === null ? 0 : dayStartTs(sinceDay);
    const grouped = groupRequestRows(this.requestsSince(sinceTs, harnesses));
    // 会话归因贡献 (harness 过滤口径; day 对齐下界 — 会话 last_ts 早于窗口首日的
    // 不进窗口, 与请求侧 dayStartTs 同界)
    const sessRows = sinceDay === null
      ? this.db.prepare(`SELECT day, model, n_turns, max_ctx FROM session_stats WHERE harness IN (${harnesses.map(() => "?").join(",")})`).all(...harnesses)
      : this.db.prepare(`SELECT day, model, n_turns, max_ctx FROM session_stats WHERE day >= ? AND harness IN (${harnesses.map(() => "?").join(",")})`).all(sinceDay, ...harnesses);
    for (const r of sessRows) {
      mergeSessionContrib(grouped, String(r.day), String(r.model), r.n_turns as number, r.max_ctx as number);
    }
    const byDay = new Map<string, ProfileModelV2[]>();
    for (const [day, byModel] of grouped) {
      byDay.set(day, [...byModel.entries()].map(([model, acc]) => accToModelV2(model, acc)));
    }
    return sortProfileDays(byDay);
  }

  // 窗口内出现的 harness 集合 (ProfileV2 harness 字段: 单源 = 源名, 多源 = mixed)
  distinctHarnesses(sinceDay: string | null, harnesses: readonly HarnessId[]): HarnessId[] {
    const sinceTs = sinceDay === null ? 0 : dayStartTs(sinceDay);
    const rows = this.db.prepare(`SELECT DISTINCT harness FROM requests WHERE ts >= ? ${this.harnessFilter(harnesses)}`).all(sinceTs, ...harnesses);
    return rows.map((r) => r.harness as HarnessId);
  }

  // 对账: 指定 harness 的 per-session rollup (sess_key, model) → 四分类和
  // (IN 列表按 SQL_CHUNK 分块, 与 recompute 路径同纪律 — 大会话集不撞变量数上限)
  sessionRollups(harness: HarnessId, sessKeys: readonly string[]): Map<string, SessionRollup[]> {
    const rollups = new Map<string, SessionRollup[]>();
    if (sessKeys.length === 0) return rollups;
    const stmt = this.db.prepare(`SELECT sess_key, model, SUM(in_t) AS in_t, SUM(out_t) AS out_t, SUM(cr_t) AS cr_t, SUM(cw_t) AS cw_t
      FROM requests WHERE harness = ? AND sess_key IN (${Array.from({length: Math.min(SQL_CHUNK, sessKeys.length)}, () => "?").join(",")}) GROUP BY sess_key, model`);
    for (let i = 0; i < sessKeys.length; i += SQL_CHUNK) {
      for (const r of stmt.all(harness, ...sessKeys.slice(i, i + SQL_CHUNK))) {
        const sess = String(r.sess_key);
        let list = rollups.get(sess);
        if (!list) {
          list = [];
          rollups.set(sess, list);
        }
        list.push({model: String(r.model), inT: r.in_t as number, outT: r.out_t as number, crT: r.cr_t as number, cwT: r.cw_t as number});
      }
    }
    return rollups;
  }
}

function accToModelV2(model: string, acc: DayModelAcc): ProfileModelV2 {
  return {
    id: model,
    in: acc.inT,
    out: acc.outT,
    cr: acc.crT,
    cw: acc.cwT,
    nSess: acc.sesses.size,
    nReq: acc.nReq,
    ctxHist: acc.ctxHist,
    outHist: acc.outHist,
    nTurns: acc.nTurns,
    nToolCalls: acc.nTools,
    maxCtxHist: acc.maxCtxHist,
  };
}

// ProfileV2 日行排序 + 发射出口守卫 (两路径共用漏斗): day 升序, 模型按四分类总量
// 降序 (大模型在前, 上传预览可读性)。守卫: ΣmaxCtxHist 按日聚合 ≤ ΣnSess —
// 会话末日必有当日请求 ⇒ 构造保证成立, 违规即 day_stats 落盘数据被外部改写
// (逐行 ≤ 在 "跨日压缩+换模型续会话" 边缘形态不成立, 见模块头注, 故按日聚合)。
function sortProfileDays(byDay: Map<string, ProfileModelV2[]>): ProfileDayV2[] {
  for (const [day, models] of byDay) {
    const histTotal = models.reduce((a, m) => a + m.maxCtxHist.reduce((x, y) => x + y, 0), 0);
    const sessTotal = models.reduce((a, m) => a + m.nSess, 0);
    if (histTotal > sessTotal) {
      throw new Error(`day_stats max_ctx_hist 损坏 (day=${day}): ΣmaxCtxHist=${histTotal} > ΣnSess=${sessTotal}`);
    }
  }
  const days: ProfileDayV2[] = [...byDay.entries()].map(([day, models]) => ({
    day,
    models: models.sort((a, b) => b.in + b.out + b.cr + b.cw - (a.in + a.out + a.cr + a.cw)),
  }));
  days.sort((a, b) => (a.day < b.day ? -1 : 1));
  return days;
}
