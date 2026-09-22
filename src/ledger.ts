// ledger.ts — requests 账本 + day_stats 物化 (C5 本地账本, 设计 §1/§5 的实现)
// 职责边界: SQLite 账本 (XDG_DATA_HOME/pricey-tokens/usage.db) 的唯一读写面 —
//   - requests 表: request 粒度原子, 归并幂等不双计 — req_key 冲突时**后值覆盖且
//     仅在值变化时写** (claude 流式 chunk 的同 messageId 行逐次累计、末值权威,
//     行并非不可变, 中途摄取后终值必须能覆盖; opencode/codex 行真不可变, 覆盖
//     与忽略等价)。降级档预留: 未来只给会话累计的源用 req_key 前缀 '~sess~' +
//     sess_key, latest-wins (当前三家源均有 request 粒度, 仅预留命名空间)。
//   - meta 表: schema_version + 各源摄取水位线 (键契约见 ingest.ts)。
//   - day_stats 表: day×model 物化 (含 n_req + 12 维 ctx_hist JSON), 增量摄取后
//     只重算受影响日, 直接从 requests GROUP BY, 不经 session 中转。
// 读取面: 分享日记录 (ts 精确窗口) / ProfileV2 日行 (day 对齐窗口) / 对账用
// per-session rollup — 全部窗口路径共用同一聚合核心 (分享口径 == day_stats 口径
// 由构造保证)。ctx 公式与桶表唯一来源是 ctx.ts (契约冻结, 本模块不复现)。
// 体量注记: 源库 data 大载荷不过 TS 边界 (SQL 侧抽取), 但行集与重算读仍 O(N) —
// 50 万行首跑峰值 ~200MB 量级, 年化翻倍, 当前接受 (单机 CLI, 可重建)。
// 位置: dataHome 由调用方注入 (XDG_DATA_HOME 优先语义在 cli/ingest 侧)。
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import type {HarnessId, ProfileDayV2, ProfileModelV2, RequestRow, UsageRecord} from "./types.js";
import {createSqlite, type SqliteRwDb, type SqliteStmt} from "./sqlite.js";
import {ctxBucketIndex, ctxEstimate, emptyCtxHist} from "./ctx.js";
import {dayEndTs, dayStartTs, localDayKey} from "./day.js";

export const SCHEMA_VERSION = "2";

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
  PRIMARY KEY (harness, req_key)
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_sess ON requests (harness, sess_key);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS day_stats (
  day TEXT NOT NULL, model TEXT NOT NULL,
  in_t INTEGER NOT NULL, out_t INTEGER NOT NULL,
  cr_t INTEGER NOT NULL, cw_t INTEGER NOT NULL,
  n_sess INTEGER NOT NULL, n_req INTEGER NOT NULL,
  ctx_hist TEXT NOT NULL,
  PRIMARY KEY (day, model)
);
`;

// day×model 聚合累加器 (全部发射/物化窗口路径的共用核心 — 分叉会致 day_stats、
// 分享 hash 与 ProfileV2 静默不一致)
interface DayModelAcc {
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
  nReq: number;
  lastTs: number; // 组内最大 ts (分享日记录的 "当日最后活跃时刻")
  sesses: Set<string>;
  ctxHist: number[];
}

// requests 原始行 (SELECT 输出, 列值未定型) → (day, model) 聚合; ctx 入桶唯一
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
      acc = {inT: 0, outT: 0, crT: 0, cwT: 0, nReq: 0, lastTs: ts, sesses: new Set(), ctxHist: emptyCtxHist()};
      byModel.set(model, acc);
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
    if (ts > acc.lastTs) acc.lastTs = ts;
    acc.sesses.add(String(r.sess_key));
    acc.ctxHist[ctxBucketIndex(ctxEstimate(model, {inT, crT, cwT}))]! += 1;
  }
  return byDay;
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
  };
}

// ΣctxHist == nReq 不变量的发射侧守卫 (构造侧天然成立; 此处拦截 day_stats 落盘
// 数据被外部改写的静默损坏)
function parseCtxHist(text: string, nReq: number, where: string): number[] {
  const hist = JSON.parse(text) as unknown;
  if (!Array.isArray(hist) || hist.length !== 12 || hist.some((c) => typeof c !== "number") || hist.reduce((a, b) => a + (b as number), 0) !== nReq) {
    throw new Error(`day_stats ctx_hist 损坏 (${where}): ${text} (nReq=${nReq})`);
  }
  return hist as number[];
}

export interface SessionRollup {
  model: string;
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
}

export class Ledger {
  private readonly db: SqliteRwDb;
  private readonly upsertReq: SqliteStmt;
  private readonly selectRow: SqliteStmt;
  private readonly getMetaStmt: SqliteStmt;
  private readonly setMetaStmt: SqliteStmt;

  private constructor(db: SqliteRwDb) {
    this.db = db;
    // upsert: 变化判定在 TS 侧点查旧行完成 (见 insertRequests), SQL 只负责写入 —
    // 比较逻辑单点持有, 不在 SQL/TS 双写
    this.upsertReq = db.prepare(`INSERT INTO requests (harness, req_key, sess_key, model, ts, in_t, out_t, cr_t, cw_t)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(harness, req_key) DO UPDATE SET
        sess_key = excluded.sess_key, model = excluded.model, ts = excluded.ts,
        in_t = excluded.in_t, out_t = excluded.out_t, cr_t = excluded.cr_t, cw_t = excluded.cw_t`);
    this.selectRow = db.prepare("SELECT sess_key, model, ts, in_t, out_t, cr_t, cw_t FROM requests WHERE harness = ? AND req_key = ?");
    this.getMetaStmt = db.prepare("SELECT v FROM meta WHERE k = ?");
    this.setMetaStmt = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  }

  /** 打开 (不存在则初始化) 账本。目录注入供测试。版本不符时抛错 (无历史库, 不迁移)。 */
  static async open(dataHome: string): Promise<Ledger> {
    const file = ledgerPath(dataHome);
    await mkdir(join(file, ".."), {recursive: true});
    const db = await createSqlite(file);
    db.exec(DDL);
    const ledger = new Ledger(db);
    const version = ledger.getMeta("schema_version");
    if (version === null) {
      ledger.setMeta("schema_version", SCHEMA_VERSION);
    } else if (version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`账本 schema 版本不符 (${version} ≠ ${SCHEMA_VERSION}): 删除 ${file} 后重跑可全量重建`);
    }
    return ledger;
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

  // 事务样板单点 (ROLLBACK 纪律不逐处手抄)
  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // 幂等归并一批请求行; 返回 {changed, days}:
  //   changed = 实际落账变更行数 (同值重放 = 0 — 不双计的锚点; claude 流式终值
  //   覆盖计 1)。变化判定在 TS 侧 (PK 点查旧行, 首跑空表全 miss 零代价)。
  //   days = 受影响日全集 — 变更行的 ts 日 **加上被覆盖行的旧 ts 日** (upsert
  //   换日覆盖时旧日必须重算, 否则 day_stats 残留旧值, 物化与真值永久分叉)。
  insertRequests(rows: readonly RequestRow[]): {changed: number; days: Set<string>} {
    if (rows.length === 0) return {changed: 0, days: new Set()};
    const days = new Set<string>();
    let changed = 0;
    this.tx(() => {
      for (const r of rows) {
        const prev = this.selectRow.all(r.harness, r.reqKey)[0];
        if (prev === undefined) {
          days.add(localDayKey(r.ts)); // 新行
        } else if (
          (prev.sess_key as string) === r.sessKey && (prev.model as string) === r.model && (prev.ts as number) === r.ts &&
          (prev.in_t as number) === r.inT && (prev.out_t as number) === r.outT && (prev.cr_t as number) === r.crT && (prev.cw_t as number) === r.cwT
        ) {
          continue; // 同值重放: 零写入零受影响日
        } else {
          if ((prev.ts as number) !== r.ts) days.add(localDayKey(prev.ts as number)); // 被覆盖行旧日
          days.add(localDayKey(r.ts));
        }
        this.upsertReq.run(r.harness, r.reqKey, r.sessKey, r.model, r.ts, r.inT, r.outT, r.crT, r.cwT);
        changed += 1;
      }
    });
    return {changed, days};
  }

  // 受影响日重算: DELETE 受影响日 + 从 requests 全量重聚合回填 (幂等; 与
  // day_stats 现值无关, 恒等于 requests 的派生 — 漂移自愈)
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
    const delDay = this.db.prepare("DELETE FROM day_stats WHERE day = ?");
    const insDay = this.db.prepare("INSERT INTO day_stats (day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist) VALUES (?,?,?,?,?,?,?,?,?)");
    this.tx(() => {
      for (const d of daySet) {
        delDay.run(d);
        const byModel = grouped.get(d);
        if (!byModel) continue; // 该日已无任何请求 (数据被清理的极端形态)
        for (const [model, acc] of byModel) {
          insDay.run(d, model, acc.inT, acc.outT, acc.crT, acc.cwT, acc.sesses.size, acc.nReq, JSON.stringify(acc.ctxHist));
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
    const rows = this.db.prepare(`SELECT model, sess_key, in_t, out_t, cr_t, cw_t, ts FROM requests WHERE ts >= ?${upper} ${this.harnessFilter(harnesses)}`).all(...(maxTs === undefined ? [minTs] : [minTs, maxTs]), ...harnesses);
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
  // 有过滤 → requests 现算 (day_stats 无 harness 维度, 过滤口径由共用聚合核心保证
  // 与物化同构)
  profileDays(sinceDay: string | null, harnesses: readonly HarnessId[]): ProfileDayV2[] {
    if (harnesses.length === 0) {
      const rows = sinceDay === null
        ? this.db.prepare("SELECT day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist FROM day_stats ORDER BY day").all()
        : this.db.prepare("SELECT day, model, in_t, out_t, cr_t, cw_t, n_sess, n_req, ctx_hist FROM day_stats WHERE day >= ? ORDER BY day").all(sinceDay);
      const byDay = new Map<string, ProfileModelV2[]>();
      for (const r of rows) {
        const day = String(r.day);
        let models = byDay.get(day);
        if (!models) {
          models = [];
          byDay.set(day, models);
        }
        const nReq = r.n_req as number;
        models.push({
          id: String(r.model),
          in: r.in_t as number,
          out: r.out_t as number,
          cr: r.cr_t as number,
          cw: r.cw_t as number,
          nSess: r.n_sess as number,
          nReq,
          ctxHist: parseCtxHist(String(r.ctx_hist), nReq, `day=${day} model=${String(r.model)}`),
        });
      }
      return sortProfileDays(byDay);
    }
    const sinceTs = sinceDay === null ? 0 : dayStartTs(sinceDay);
    const grouped = groupRequestRows(this.requestsSince(sinceTs, harnesses));
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
  sessionRollups(harness: HarnessId, sessKeys: readonly string[]): Map<string, SessionRollup[]> {
    const rollups = new Map<string, SessionRollup[]>();
    if (sessKeys.length === 0) return rollups;
    const stmt = this.db.prepare(`SELECT sess_key, model, SUM(in_t) AS in_t, SUM(out_t) AS out_t, SUM(cr_t) AS cr_t, SUM(cw_t) AS cw_t
      FROM requests WHERE harness = ? AND sess_key IN (${sessKeys.map(() => "?").join(",")}) GROUP BY sess_key, model`);
    for (const r of stmt.all(harness, ...sessKeys)) {
      const sess = String(r.sess_key);
      let list = rollups.get(sess);
      if (!list) {
        list = [];
        rollups.set(sess, list);
      }
      list.push({model: String(r.model), inT: r.in_t as number, outT: r.out_t as number, crT: r.cr_t as number, cwT: r.cw_t as number});
    }
    return rollups;
  }
}

// ProfileV2 日行排序: day 升序, 模型按四分类总量降序 (大模型在前, 上传预览可读性)
function sortProfileDays(byDay: Map<string, ProfileModelV2[]>): ProfileDayV2[] {
  const days: ProfileDayV2[] = [...byDay.entries()].map(([day, models]) => ({
    day,
    models: models.sort((a, b) => b.in + b.out + b.cr + b.cw - (a.in + a.out + a.cr + a.cw)),
  }));
  days.sort((a, b) => (a.day < b.day ? -1 : 1));
  return days;
}
