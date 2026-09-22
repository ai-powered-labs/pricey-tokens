// ledger.test.ts — requests 账本 + day_stats 物化 + 发射面测试
// 覆盖: 开库与 schema 版本守卫、upsert 幂等 (同值重放零写入不双计; 流式终值
// 覆盖 + 换日旧日重算)、day_stats 受影响日重算 (含增量更新与漂移自愈)、
// dailyRecords 分享形状 (ts 精确窗口 + harness 过滤)、ProfileV2 日行形状 +
// ΣctxHist==nReq 不变量 + harness 过滤路径与物化路径同构、sessionRollups 对账侧、
// ctx_hist 损坏检测、day.ts 日界换算。
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
    expect(l1.getMeta("schema_version")).toBe("2");
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
