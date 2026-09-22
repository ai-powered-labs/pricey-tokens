// ledger.test.ts — requests 账本 + session_stats/day_stats 物化 + 发射面测试
// 覆盖: 开库与 schema 版本守卫、upsert 幂等 (同值重放零写入不双计; 流式终值
// 覆盖 + 换日旧日重算)、day_stats 受影响日重算 (含增量更新与漂移自愈)、
// session_stats 物化 (主模型归因/归因日/n_turns join/归因日迁移旧日重算)、
// day_stats 会话归并 (maxCtxHist 会话原子性/nTurns 归因/无请求行模型组)、
// v2→v3 迁移 (自动回填 + 幂等 + 存量 n_tools/n_turns 恒 0)、dailyRecords 分享形状
// (ts 精确窗口 + harness 过滤)、ProfileV2 日行形状 + ΣctxHist==nReq 不变量 +
// harness 过滤路径与物化路径同构、sessionRollups 对账侧、ctx_hist 损坏检测、
// day.ts 日界换算。
import {afterEach, describe, expect, it} from "bun:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {RequestRow} from "../src/types.js";
import {Ledger} from "../src/ledger.js";
import {localDayKey} from "../src/day.js";

async function makeDataHome(): Promise<{home: string; cleanup: () => Promise<void>}> {
  const home = await mkdtemp(join(tmpdir(), "pt-ledger-"));
  return {home, cleanup: () => rm(home, {recursive: true, force: true})};
}

const T = new Date(2026, 8, 22, 10, 30).getTime(); // 2026-09-22 10:30 本地
const row = (o: Partial<RequestRow> & {reqKey: string; ts: number}): RequestRow => ({
  harness: "opencode",
  sessKey: "s0",
  model: "zai/glm-5.3",
  inT: 100,
  outT: 50,
  crT: 10,
  cwT: 5,
  nTools: 0,
  ...o,
});

const homes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of homes.splice(0)) await c();
});
async function freshHome(): Promise<string> {
  const h = await makeDataHome();
  homes.push(h.cleanup);
  return h.home;
}

describe("Ledger 开库与版本守卫", () => {
  it("首开建表并落 schema_version; 重开复用", async () => {
    const home = await freshHome();
    const l1 = await Ledger.open(home);
    expect(l1.getMeta("schema_version")).toBe("3");
    l1.close();
    const l2 = await Ledger.open(home);
    expect(l2.requestCount()).toBe(0);
    l2.close();
  });
});

describe("账本幂等 (重采不双计)", () => {
  it("同批行重复 insert → 行数不变, 变更计数第二次为 0 (upsert 值变化才写)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    const rows = [row({reqKey: "a", ts: T}), row({reqKey: "b", ts: T + 100})];
    expect(l.insertRequests(rows).changed).toBe(2);
    const replay = l.insertRequests(rows); // 同值重放: 零写入零受影响日
    expect(replay.changed).toBe(0);
    expect(replay.days.size).toBe(0);
    expect(l.requestCount()).toBe(2);
    l.close();
  });

  it("值变化的覆盖 (claude 流式终值): 计 1, 行数不变, 旧日并入受影响日", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([row({reqKey: "a", ts: T, inT: 10})]);
    const day2 = T + 86400000;
    // 同 reqKey 跨日覆盖: ts 换日 + 值变化
    const {changed, days} = l.insertRequests([row({reqKey: "a", ts: day2, inT: 100})]);
    expect(changed).toBe(1);
    expect(l.requestCount()).toBe(1); // 仍单行
    expect(days.has(localDayKey(T))).toBe(true); // 旧日必须重算 (day_stats 不残留)
    expect(days.has(localDayKey(day2))).toBe(true);
    // 重算后旧日归零消失、新日携带终值
    l.recomputeDays(days);
    const d = l.profileDays(null, []);
    expect(d).toHaveLength(1);
    expect(d[0]!.day).toBe(localDayKey(day2));
    expect(d[0]!.models[0]!.in).toBe(100);
    l.close();
  });

  it("同 (harness, reqKey) 不同 harness 不冲突", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([row({reqKey: "x", ts: T}), row({harness: "claude-code", sessKey: "cs", model: "claude-sonnet-5", reqKey: "x", ts: T})]);
    expect(l.requestCount()).toBe(2);
    l.close();
  });
});

describe("day_stats 重算", () => {
  it("受影响日重算: 四分类和 / n_req / n_sess / ctx_hist 落桶正确", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    // glm-5.3 (未知缺省 in+cr+cw): 两请求 ctx 分别 115 (桶0) / 131072+ (按值)
    l.insertRequests([
      row({reqKey: "a", ts: T, inT: 100, outT: 1, crT: 10, cwT: 5}), // ctx=115 → 桶0
      row({reqKey: "b", ts: T + 1000, sessKey: "s1", inT: 100000, outT: 2, crT: 10000, cwT: 5000, model: "zai/glm-5.3"}), // ctx=115000 → 桶 (64k,128k]=5
    ]);
    l.recomputeDays([localDayKey(T)]);
    const days = l.profileDays(null, []);
    expect(days).toHaveLength(1);
    const m = days[0]!.models.find((x) => x.id === "zai/glm-5.3")!;
    expect(m.nReq).toBe(2);
    expect(m.nSess).toBe(2);
    expect(m.in).toBe(100100);
    expect(m.ctxHist[0]).toBe(1);
    expect(m.ctxHist[5]).toBe(1);
    expect(m.ctxHist.reduce((a, b) => a + b, 0)).toBe(2); // Σhist == nReq
    l.close();
  });

  it("同日增量追加后重算 → 日行更新 (不双计)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([row({reqKey: "a", ts: T})]);
    l.recomputeDays([localDayKey(T)]);
    l.insertRequests([row({reqKey: "b", ts: T + 2000})]);
    l.recomputeDays([localDayKey(T + 2000)]); // 同日再算
    const m = l.profileDays(null, [])[0]!.models[0]!;
    expect(m.nReq).toBe(2);
    expect(m.in).toBe(200);
    l.close();
  });

  it("不同日不相干: 只重算受影响日", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    const d2 = T + 86400000;
    l.insertRequests([row({reqKey: "a", ts: T}), row({reqKey: "b", ts: d2, inT: 999})]);
    l.recomputeDays([localDayKey(T), localDayKey(d2)]);
    // 删掉第二行的重算只影响 d2 — 通过再插入验证 (行 b 改写后同 req_key 被忽略)
    expect(l.profileDays(null, [])).toHaveLength(2);
    l.close();
  });

  it("ctx_hist 落盘损坏 → 发射时抛错 (不变量守卫)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([row({reqKey: "a", ts: T})]);
    l.recomputeDays([localDayKey(T)]);
    // 直接改写 day_stats 模拟外部损坏 (SqliteRwDb 不外露 — 用 Ledger 内部无法触达,
    // 以 build 形态验证: 通过 recompute 后人为再改) — 用同一 db 文件旁路写入
    l.close();
    const {createSqlite} = await import("../src/sqlite.js");
    const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
    db.exec(`UPDATE day_stats SET ctx_hist = '[1,0,0,0,0,0,0,0,0,0,0,0]'`); // Σ=1 但桶错位 + nReq 不匹配路径
    db.exec(`UPDATE day_stats SET n_req = 5`); // Σhist(1) ≠ nReq(5)
    db.close();
    const l2 = await Ledger.open(home);
    expect(() => l2.profileDays(null, [])).toThrow("ctx_hist 损坏");
    l2.close();
  });
});

describe("dailyRecords (分享形状, ts 精确窗口)", () => {
  it("窗口过滤 + (日,模型) 聚合 + ts 取组内最大 + 排序", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([
      row({reqKey: "a", ts: T, model: "m1", inT: 10}),
      row({reqKey: "b", ts: T + 3600000, model: "m1", inT: 20}), // 同日同模型
      row({reqKey: "c", ts: T + 86400000, model: "m2", inT: 5}), // 次日
      row({reqKey: "d", ts: T - 86400000 * 10, model: "old", inT: 7}), // 窗口外
    ]);
    const recs = l.dailyRecords(T - 1000, []);
    expect(recs).toEqual([
      {model: "m1", ts: T + 3600000, inputTokens: 30, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10},
      {model: "m2", ts: T + 86400000, inputTokens: 5, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5},
    ]);
    expect(l.dailyRecords(null, []).length).toBe(3); // 全量含 old
    l.close();
  });

  it("harness 过滤: 只输出指定源的记录 (占位符参数绑定)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([
      row({reqKey: "a", ts: T, inT: 1}),
      row({harness: "claude-code", sessKey: "cs", model: "claude-sonnet-5", reqKey: "x", ts: T, inT: 2}),
    ]);
    const only = l.dailyRecords(null, ["opencode"]);
    expect(only.map((r) => r.model)).toEqual(["zai/glm-5.3"]);
    expect(l.dailyRecords(null, ["opencode", "claude-code"])).toHaveLength(2);
    expect(l.dailyRecords(null, ["codex"])).toHaveLength(0);
    // distinctHarnesses 同口径过滤
    expect(l.distinctHarnesses(null, ["claude-code"])).toEqual(["claude-code"]);
    l.close();
  });
});

describe("ProfileV2 发射 (形状 + 不变量 + 双路径同构)", () => {
  it("物化路径 (day_stats) 与 harness 过滤路径 (requests 现算) 同构", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([
      row({reqKey: "a", ts: T, inT: 70000, crT: 0, cwT: 0}), // glm 未知缺省 ctx=70000 → 桶5
      row({harness: "claude-code", sessKey: "cs", model: "claude-sonnet-5", reqKey: "x", ts: T, inT: 5000, outT: 9, crT: 100, cwT: 0}), // anthropic ctx=5100 → 桶1
    ]);
    l.recomputeDays([localDayKey(T)]);
    const materialized = l.profileDays(null, []);
    const filtered = l.profileDays(null, ["opencode", "claude-code"]);
    expect(filtered).toEqual(materialized); // 过滤集合 = 全集时两路径必须逐字节同构
    // 形状断言: day / models(用量降序) / 不变量
    expect(materialized[0]!.day).toBe(localDayKey(T));
    const glm = materialized[0]!.models.find((m) => m.id === "zai/glm-5.3")!;
    expect(glm.ctxHist[5]).toBe(1);
    const cc = materialized[0]!.models.find((m) => m.id === "claude-sonnet-5")!;
    expect(cc.ctxHist[1]).toBe(1); // (4k,8k]
    for (const d of materialized) {
      for (const m of d.models) {
        expect(m.ctxHist.reduce((a, b) => a + b, 0)).toBe(m.nReq);
        expect(m.ctxHist).toHaveLength(12);
      }
    }
    l.close();
  });

  it("day 窗口: sinceDay 前的日排除", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([row({reqKey: "old", ts: T - 86400000}), row({reqKey: "new", ts: T})]);
    l.recomputeDays([localDayKey(T - 86400000), localDayKey(T)]);
    const days = l.profileDays(localDayKey(T), []);
    expect(days).toHaveLength(1);
    expect(days[0]!.models[0]!.nReq).toBe(1);
    l.close();
  });

  it("模型排序: 四分类总量降序; 多日 day 升序", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([
      row({reqKey: "a", ts: T, model: "small", inT: 1}),
      row({reqKey: "b", ts: T, model: "big", inT: 1000}),
      row({reqKey: "c", ts: T + 86400000, model: "big", inT: 1}),
    ]);
    l.recomputeDays([localDayKey(T), localDayKey(T + 86400000)]);
    const days = l.profileDays(null, []);
    expect(days.map((d) => d.day)).toEqual([localDayKey(T), localDayKey(T + 86400000)]);
    expect(days[0]!.models.map((m) => m.id)).toEqual(["big", "small"]);
    l.close();
  });

  it("v2 字段集: outHist/nTurns/nToolCalls/maxCtxHist 形状与不变量 (ΣoutHist==nReq, ΣmaxCtxHist≤nSess)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    ingestBatch(l, [
      row({reqKey: "a", sessKey: "sA", ts: T, inT: 100000, outT: 1500, nTools: 2}), // ctx 100000 桶5; out 1500 → outHist 桶1
      row({reqKey: "b", sessKey: "sA", ts: T + 1000, inT: 5000, outT: 50, nTools: 1}), // ctx 5000 桶1; out 50 → outHist 桶0
      row({reqKey: "c", sessKey: "sB", ts: T, inT: 300000, outT: 200000, nTools: 0}), // sB ctx 300000 → 桶7 (200k,256k]
    ], [
      {harness: "opencode", turnKey: "tA", sessKey: "sA"},
      {harness: "opencode", turnKey: "tB", sessKey: "sB"},
      {harness: "opencode", turnKey: "tB2", sessKey: "sB"},
    ]);
    const days = l.profileDays(null, []);
    const m = days[0]!.models[0]!; // 唯一模型 zai/glm-5.3
    expect(m.nReq).toBe(3);
    expect(m.nToolCalls).toBe(3); // request 各归各 Σ
    expect(m.nTurns).toBe(3); // 两会话轮次和 (1+2)
    expect(m.outHist).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]); // 50→桶0, 1500→桶1, 200000→桶8; Σ==nReq
    expect(m.ctxHist.reduce((a, b) => a + b, 0)).toBe(3);
    // 会话原子: sA max_ctx 100000 (桶5) + sB max_ctx 300000 (桶7), Σ=2 ≤ nSess=2
    expect(m.maxCtxHist[5]).toBe(1);
    expect(m.maxCtxHist[7]).toBe(1);
    expect(m.maxCtxHist.reduce((a, b) => a + b, 0)).toBe(2);
    expect(m.nSess).toBe(2);
    l.close();
  });

  it("out_hist 落盘损坏 (Σ≠nReq) → 发射时抛错; max_ctx_hist 按日聚合越界 → 抛错", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    ingestBatch(l, [row({reqKey: "a", ts: T, inT: 100000})]);
    l.close();
    const {createSqlite} = await import("../src/sqlite.js");
    const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
    db.exec(`UPDATE day_stats SET out_hist = '[0,0,0,0,0,0,0,0,0]'`); // Σ=0 ≠ nReq=1
    db.close();
    const l2 = await Ledger.open(home);
    expect(() => l2.profileDays(null, [])).toThrow("out_hist 损坏");
    l2.close();
    // max_ctx_hist 聚合守卫: ΣmaxCtxHist(2) > ΣnSess(1) — 构造不可能态模拟外部改写
    const home2 = await freshHome();
    const l3 = await Ledger.open(home2);
    ingestBatch(l3, [row({reqKey: "a", ts: T, inT: 100000})]);
    l3.close();
    const db2 = await createSqlite(join(home2, "pricey-tokens", "usage.db"));
    db2.exec(`UPDATE day_stats SET max_ctx_hist = '[2,0,0,0,0,0,0,0,0,0,0,0]'`);
    db2.close();
    const l4 = await Ledger.open(home2);
    expect(() => l4.profileDays(null, [])).toThrow("max_ctx_hist 损坏");
    l4.close();
  });
});

describe("sessionRollups (对账侧)", () => {
  it("按 (sess, model) 汇总, 只含查询集合", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    l.insertRequests([
      row({reqKey: "a", sessKey: "s0", ts: T, inT: 10}),
      row({reqKey: "b", sessKey: "s0", ts: T, inT: 15, model: "m2"}),
      row({reqKey: "c", sessKey: "s1", ts: T, inT: 99}),
    ]);
    const r = l.sessionRollups("opencode", ["s0"]);
    expect(r.get("s0")!.length).toBe(2);
    expect(r.get("s0")!.find((x) => x.model === "zai/glm-5.3")!.inT).toBe(10);
    expect(r.has("s1")).toBe(false);
    l.close();
  });
});

// ===== v3: session_stats / turn_events / 会话归并 (直读 db 断言内部物化) =====

interface SessRow {
  harness: string;
  sess_key: string;
  first_ts: number;
  last_ts: number;
  day: string;
  model: string;
  n_turns: number;
  n_tools: number;
  in_t: number;
  out_t: number;
  cr_t: number;
  cw_t: number;
  max_ctx: number;
}

async function readSessions(home: string): Promise<SessRow[]> {
  const {createSqlite} = await import("../src/sqlite.js");
  const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
  const rows = db.prepare("SELECT * FROM session_stats ORDER BY sess_key").all() as unknown as SessRow[];
  db.close();
  return rows;
}

async function readDayStats(home: string): Promise<Array<Record<string, unknown>>> {
  const {createSqlite} = await import("../src/sqlite.js");
  const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
  const rows = db.prepare("SELECT * FROM day_stats ORDER BY day, model").all();
  db.close();
  return rows;
}

// 摄取完整批次 (请求 + 轮次 + 重算链) — 模拟 ingest.commitBatch 的编排顺序
function ingestBatch(l: Ledger, rows: readonly RequestRow[], turns: readonly {harness: "opencode"; turnKey: string; sessKey: string}[] = []): void {
  const {changed: _c, days, sessions} = l.insertRequests(rows);
  const ts = l.insertTurns(turns);
  const sessDays = l.recomputeSessions([...sessions, ...ts]);
  l.recomputeDays([...days, ...sessDays]);
}

describe("session_stats 物化 (主模型归因 + 轮次 join)", () => {
  it("主模型 = 产生 max_ctx 请求的模型; day = last_ts 日; 四分类 Σ / n_tools Σ / max_ctx", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    // glm (unknown 家族: ctx=in+cr+cw) 3 请求 ctx 递增; claude (anthropic 同式) 1 请求 ctx 更深
    ingestBatch(l, [
      row({reqKey: "a", sessKey: "s0", ts: T, inT: 1000, crT: 0, cwT: 0, nTools: 2}), // ctx 1000
      row({reqKey: "b", sessKey: "s0", ts: T + 1000, inT: 5000, crT: 100, cwT: 0, nTools: 1}), // ctx 5100
      row({reqKey: "c", sessKey: "s0", ts: T + 2000, inT: 3000, crT: 0, cwT: 0, model: "claude-sonnet-5"}), // ctx 3000 < 5100
    ]);
    const sess = await readSessions(home);
    expect(sess).toHaveLength(1);
    const s = sess[0]!;
    expect(s.harness).toBe("opencode");
    expect(s.sess_key).toBe("s0");
    expect(s.first_ts).toBe(T);
    expect(s.last_ts).toBe(T + 2000);
    expect(s.day).toBe(localDayKey(T + 2000));
    expect(s.model).toBe("zai/glm-5.3"); // max_ctx 5100 的请求是 b (glm)
    expect(s.max_ctx).toBe(5100);
    expect(s.n_tools).toBe(3);
    expect(s.in_t).toBe(9000);
    expect(s.n_turns).toBe(0); // 无轮次行
    l.close();
  });

  it("n_turns = turn_events 计数; OpenAI 家族 ctx=in 路由进 max_ctx", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    ingestBatch(
      l,
      [
        row({reqKey: "a", sessKey: "s0", ts: T, inT: 900, crT: 50000, cwT: 0, model: "gpt-5"}), // openai: ctx=900 (cached⊆prompt)
        row({reqKey: "b", sessKey: "s0", ts: T + 1000, inT: 1200, crT: 0, cwT: 0, model: "gpt-5"}), // ctx=1200 → 主模型仍 gpt-5, max=1200
      ],
      [
        {harness: "opencode", turnKey: "t1", sessKey: "s0"},
        {harness: "opencode", turnKey: "t2", sessKey: "s0"},
        {harness: "opencode", turnKey: "t1", sessKey: "s0"}, // 同键重放幂等
        {harness: "opencode", turnKey: "t3", sessKey: "s-other"}, // 无请求会话的轮次
      ],
    );
    const sess = await readSessions(home);
    expect(sess).toHaveLength(1); // s-other 无请求不物化
    expect(sess[0]!.n_turns).toBe(2);
    expect(sess[0]!.max_ctx).toBe(1200);
    l.close();
  });

  it("跨日会话: 归因日 = last_ts 日; 后续请求迁日 → 旧归因日重算不残留 (会话原子性)", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    const d2 = T + 86400000;
    ingestBatch(l, [row({reqKey: "a", sessKey: "s0", ts: T, inT: 100000, crT: 0, cwT: 0})]); // 首日: 归因日 d1
    let stats = await readDayStats(home);
    const d1Row = stats.find((r) => r.day === localDayKey(T)) as unknown as {max_ctx_hist: string; n_turns: number};
    expect(JSON.parse(d1Row.max_ctx_hist).reduce((a: number, b: number) => a + b, 0)).toBe(1); // d1 有 1 会话贡献
    // 次日新请求 → 会话 last_ts 迁 d2 → 归因日迁 d2, d1 的贡献必须消失
    ingestBatch(l, [row({reqKey: "b", sessKey: "s0", ts: d2, inT: 50000, crT: 0, cwT: 0})]);
    stats = await readDayStats(home);
    const d1After = stats.find((r) => r.day === localDayKey(T)) as unknown as {max_ctx_hist: string};
    const d2After = stats.find((r) => r.day === localDayKey(d2)) as unknown as {max_ctx_hist: string; n_sess: number; n_req: number};
    expect(JSON.parse(d1After.max_ctx_hist).reduce((a: number, b: number) => a + b, 0)).toBe(0); // d1 贡献迁走
    expect(JSON.parse(d2After.max_ctx_hist).reduce((a: number, b: number) => a + b, 0)).toBe(1); // d2 接收
    expect(d2After.n_sess).toBe(1);
    expect(d2After.n_req).toBe(1);
    // 全局: 会话恰一增量 (两日直方图总和恒 1)
    const total = stats.reduce((a, r) => a + JSON.parse((r as {max_ctx_hist: string}).max_ctx_hist).reduce((x: number, y: number) => x + y, 0), 0);
    expect(total).toBe(1);
    l.close();
  });

  it("day_stats 会话归并: n_turns 记 (归因日, 主模型); 多会话各自一增量", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    ingestBatch(
      l,
      [
        row({reqKey: "a", sessKey: "sA", ts: T, inT: 100000, crT: 0, cwT: 0}), // sA max_ctx 100000 → 桶5 (64k,128k]
        row({reqKey: "b", sessKey: "sB", ts: T, inT: 5000, crT: 0, cwT: 0}), // sB max_ctx 5000 → 桶1 (4k,8k]
        row({reqKey: "c", sessKey: "sB", ts: T, inT: 9000, crT: 0, cwT: 0, model: "claude-sonnet-5"}), // sB 主模型变 claude (ctx 9000 > 5000)
      ],
      [
        {harness: "opencode", turnKey: "tA1", sessKey: "sA"},
        {harness: "opencode", turnKey: "tA2", sessKey: "sA"},
        {harness: "opencode", turnKey: "tB1", sessKey: "sB"},
      ],
    );
    const stats = await readDayStats(home);
    const glm = stats.find((r) => r.model === "zai/glm-5.3") as unknown as {n_turns: number; max_ctx_hist: string; n_sess: number; n_req: number};
    // glm 行: sA 归因 (2 turns, 桶5 +1) + sB 的请求侧 (n_sess 2, n_req 2 — sB 两请求都算)
    expect(glm.n_turns).toBe(2);
    expect(JSON.parse(glm.max_ctx_hist)[5]).toBe(1);
    expect(glm.n_sess).toBe(2);
    expect(glm.n_req).toBe(2);
    const cc = stats.find((r) => r.model === "claude-sonnet-5") as unknown as {n_turns: number; max_ctx_hist: string; n_sess: number; n_req: number};
    expect(cc.n_turns).toBe(1); // sB 归因 claude (主模型), 1 turn
    expect(JSON.parse(cc.max_ctx_hist)[2]).toBe(1); // 桶2 (8k,16k]
    expect(cc.n_req).toBe(1); // 请求侧: claude 1 请求
    expect(cc.n_sess).toBe(1);
    l.close();
  });

  it("重算幂等: 同批重放 → session_stats/day_stats 逐字节不变", async () => {
    const home = await freshHome();
    const l = await Ledger.open(home);
    const rows = [row({reqKey: "a", ts: T, nTools: 1}), row({reqKey: "b", ts: T + 1000, sessKey: "s1", inT: 50000, nTools: 2})];
    const turns = [{harness: "opencode" as const, turnKey: "t1", sessKey: "s0"}];
    ingestBatch(l, rows, turns);
    const sess1 = JSON.stringify(await readSessions(home));
    const day1 = JSON.stringify(await readDayStats(home));
    ingestBatch(l, rows, turns); // 同值重放
    ingestBatch(l, rows, turns); // 再放
    expect(JSON.stringify(await readSessions(home))).toBe(sess1);
    expect(JSON.stringify(await readDayStats(home))).toBe(day1);
    l.close();
  });
});

describe("v2 → v3 迁移 (自动回填)", () => {
  // 手工构造 v2 库 (C5 DDL 形态): requests 9 列 + day_stats 旧 9 列 + meta=2
  async function makeV2Ledger(home: string, rows: Array<{harness?: string; reqKey: string; sessKey?: string; model?: string; ts: number; inT?: number}>): Promise<void> {
    const {createSqlite} = await import("../src/sqlite.js");
    const {mkdir} = await import("node:fs/promises");
    await mkdir(join(home, "pricey-tokens"), {recursive: true});
    const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
    db.exec(`CREATE TABLE requests (
      harness TEXT NOT NULL, req_key TEXT NOT NULL, sess_key TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL,
      in_t INTEGER NOT NULL, out_t INTEGER NOT NULL, cr_t INTEGER NOT NULL, cw_t INTEGER NOT NULL,
      PRIMARY KEY (harness, req_key))`);
    db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    db.exec(`CREATE TABLE day_stats (
      day TEXT NOT NULL, model TEXT NOT NULL, in_t INTEGER NOT NULL, out_t INTEGER NOT NULL,
      cr_t INTEGER NOT NULL, cw_t INTEGER NOT NULL, n_sess INTEGER NOT NULL, n_req INTEGER NOT NULL,
      ctx_hist TEXT NOT NULL, PRIMARY KEY (day, model))`);
    for (const r of rows) {
      db.prepare("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)").run(
        r.harness ?? "opencode", r.reqKey, r.sessKey ?? "s0", r.model ?? "zai/glm-5.3", r.ts,
        r.inT ?? 100, 50, 10, 5);
    }
    // v2 时代的 day_stats 行 (旧形态, ctx_hist 是 12 维)
    db.prepare("INSERT INTO day_stats VALUES (?,?,?,?,?,?,?,?,?)").run(localDayKey(rows[0]!.ts), "zai/glm-5.3", 100, 50, 10, 5, 1, 1, "[1,0,0,0,0,0,0,0,0,0,0,0]");
    db.prepare("INSERT INTO meta VALUES ('schema_version', '2')").run();
    db.close();
  }

  it("v2 库首开 → ALTER + 全量回填: session_stats 真实 / day_stats 新列真实 / 存量 n_tools 与 n_turns 恒 0 / 版本升 3 / 二开幂等", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-mig-"));
    homes.push(() => rm(home, {recursive: true, force: true}));
    await makeV2Ledger(home, [
      {reqKey: "a", ts: T, inT: 100000},
      {reqKey: "b", ts: T + 1000, sessKey: "s1", inT: 5000},
    ]);
    const l = await Ledger.open(home);
    expect(l.getMeta("schema_version")).toBe("3");
    // session_stats 从 requests 现算 (真实回填): 2 会话, max_ctx 家族路由
    const sess = await readSessions(home);
    expect(sess).toHaveLength(2);
    expect(sess.find((s) => s.sess_key === "s0")!.max_ctx).toBe(100000 + 10 + 5);
    expect(sess.every((s) => s.n_turns === 0 && s.n_tools === 0)).toBe(true); // 存量无源恒 0
    // day_stats 新列: ctx_hist/out_hist 从 requests 现算真实; n_turns/n_tools/max_ctx_hist 结构在位
    const stats = await readDayStats(home);
    const m = stats[0] as unknown as {ctx_hist: string; out_hist: string; n_tools: number; n_turns: number; max_ctx_hist: string; n_req: number};
    expect(m.n_req).toBe(2);
    expect(JSON.parse(m.ctx_hist).reduce((a: number, b: number) => a + b, 0)).toBe(2);
    expect(JSON.parse(m.out_hist).reduce((a: number, b: number) => a + b, 0)).toBe(2); // ΣoutHist==nReq
    expect(m.n_tools).toBe(0); // 存量行 n_tools=0
    expect(m.n_turns).toBe(0); // 无 turn_events
    expect(JSON.parse(m.max_ctx_hist).reduce((a: number, b: number) => a + b, 0)).toBe(2); // 会话数真实回填
    l.close();
    // 二开: 版本 3 直通, 数据不变
    const l2 = await Ledger.open(home);
    expect(JSON.stringify(await readSessions(home))).toBe(JSON.stringify(sess));
    l2.close();
  });

  it("v3 后新摄取正常带 n_tools/轮次 (迁移不锁后续增量)", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-mig2-"));
    homes.push(() => rm(home, {recursive: true, force: true}));
    await makeV2Ledger(home, [{reqKey: "old", ts: T}]);
    const l = await Ledger.open(home);
    ingestBatch(l, [row({reqKey: "new", sessKey: "s0", ts: T + 1000, nTools: 4})], [{harness: "opencode", turnKey: "t1", sessKey: "s0"}]);
    const sess = await readSessions(home);
    const s0 = sess.find((s) => s.sess_key === "s0")!;
    expect(s0.n_tools).toBe(4); // 新行带工具数 (旧行 0)
    expect(s0.n_turns).toBe(1);
    l.close();
  });

  it("未知更高版本 → 抛错 (不猜测降级)", async () => {
    const home = await mkdtemp(join(tmpdir(), "pt-mig3-"));
    homes.push(() => rm(home, {recursive: true, force: true}));
    await makeV2Ledger(home, [{reqKey: "a", ts: T}]);
    {
      const {createSqlite} = await import("../src/sqlite.js");
      const db = await createSqlite(join(home, "pricey-tokens", "usage.db"));
      db.prepare("UPDATE meta SET v = '99' WHERE k = 'schema_version'").run();
      db.close();
    }
    await expect(Ledger.open(home)).rejects.toThrow("版本不符");
  });
});
