// codex.test.ts — codex 请求收集测试 (per-token_count 事件 request 粒度)
// 覆盖: last_token_usage 直给增量 / total 差分回退 / 负差分跳过且基线重同步 /
// 事件序号 reqKey / turn_context 运行模型 / 无 token 数据文件 skipped /
// 全零事件剔除 / 增量和 == 末态 total (逐事件求和不重复计数的性质锚)。
import {describe, expect, it} from "bun:test";
import {collectCodexRequests} from "../src/collectors/codex.js";
import {T0, DAY, codexOldFirstLine, codexSessionMeta, codexTokenLine, codexTurnContext, makeHome, writeLines} from "./fixtures.js";

const ROLLOUT = "rollout-2026-05-08T02-30-49-abc.jsonl";

async function writeRollout(home: string, lines: unknown[]): Promise<string> {
  return writeLines(`${home}/.codex/sessions/2026/05/08/${ROLLOUT}`, lines);
}

describe("collectCodexRequests 事件增量", () => {
  it("每 token_count 事件一行: tokens = last_token_usage", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTurnContext("gpt-5-codex"),
        codexTokenLine({ts: T0, total: [100, 20, 30], last: [100, 20, 30]}),
        codexTokenLine({ts: T0 + 1000, total: [250, 60, 80], last: [150, 40, 50]}),
      ]);
      const {rows, skipped} = await collectCodexRequests(p);
      expect(skipped).toBeNull();
      expect(rows).toEqual([
        {harness: "codex", reqKey: `${ROLLOUT.replace(".jsonl", "")}#1`, sessKey: ROLLOUT.replace(".jsonl", ""), model: "gpt-5-codex", ts: T0, inT: 100, outT: 30, crT: 20, cwT: 0},
        {harness: "codex", reqKey: `${ROLLOUT.replace(".jsonl", "")}#2`, sessKey: ROLLOUT.replace(".jsonl", ""), model: "gpt-5-codex", ts: T0 + 1000, inT: 150, outT: 50, crT: 40, cwT: 0},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("last 缺失 → total 差分回退 (首事件基线 0)", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, total: [100, 0, 30]}), // 无 last: 差分 = 100-0
        codexTokenLine({ts: T0 + 1000, total: [180, 0, 60]}), // 差分 = 80
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows.map((r) => r.inT)).toEqual([100, 80]);
    } finally {
      await h.cleanup();
    }
  });

  it("性质: 逐事件增量之和 == 末态 total (混合 last/差分来源)", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, total: [100, 10, 30], last: [100, 10, 30]}),
        codexTokenLine({ts: T0 + 1000, total: [300, 40, 90]}), // 差分 200/30/60
        codexTokenLine({ts: T0 + 2000, total: [500, 60, 120], last: [200, 20, 30]}),
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows.reduce((a, r) => a + r.inT, 0)).toBe(500); // == 末态 total.input
      expect(rows.reduce((a, r) => a + r.crT, 0)).toBe(60);
      expect(rows.reduce((a, r) => a + r.outT, 0)).toBe(120);
    } finally {
      await h.cleanup();
    }
  });

  it("负差分 (计数器回退) → 该事件跳过, 基线重同步", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, total: [500, 0, 100]}),
        codexTokenLine({ts: T0 + 1000, total: [100, 0, 20]}), // 回退 → 跳过, 基线=100
        codexTokenLine({ts: T0 + 2000, total: [250, 0, 60]}), // 差分 150/40
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows.map((r) => r.inT)).toEqual([500, 150]);
    } finally {
      await h.cleanup();
    }
  });

  it("turn_context 运行值: 各事件取其之前最后出现的模型", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTurnContext("gpt-5"),
        codexTokenLine({ts: T0, last: [10, 0, 0]}),
        codexTurnContext("o3"),
        codexTokenLine({ts: T0 + 1000, last: [5, 0, 0]}),
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows.map((r) => r.model)).toEqual(["gpt-5", "o3"]);
    } finally {
      await h.cleanup();
    }
  });

  it("无 turn_context → model=unknown; 无 timestamp 事件复用上一时刻", async () => {
    const h = await makeHome();
    try {
      // fixture 的 codexTokenLine 恒写 timestamp; 手写无 timestamp 包装行
      const noTs = {type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 7, cached_input_tokens: 0, output_tokens: 1}}}};
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, last: [10, 0, 0]}),
        noTs,
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.model).toBe("unknown");
      expect(rows[1]!.ts).toBe(T0);
    } finally {
      await h.cleanup();
    }
  });

  it("全零事件剔除 (不构成请求行)", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, last: [0, 0, 0]}),
        codexTokenLine({ts: T0 + 1000, last: [3, 0, 0]}),
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows.map((r) => r.inT)).toEqual([3]);
      expect(rows[0]!.reqKey.endsWith("#2")).toBe(true); // 序号按事件计, 不因剔除回退
    } finally {
      await h.cleanup();
    }
  });

  it("无 token_count 事件 (旧格式/过短会话) → skipped 附原因", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [codexOldFirstLine(), codexSessionMeta(), codexTurnContext("gpt-5")]);
      const {rows, skipped} = await collectCodexRequests(p);
      expect(rows).toHaveLength(0);
      expect(skipped).toContain("无可用 token_count 事件");
    } finally {
      await h.cleanup();
    }
  });

  it("多日会话: 各事件按自身 ts 归属 (请求各归各日)", async () => {
    const h = await makeHome();
    try {
      const p = await writeRollout(h.home, [
        codexTokenLine({ts: T0, last: [10, 0, 0]}),
        codexTokenLine({ts: T0 + DAY, last: [20, 0, 0]}),
      ]);
      const {rows} = await collectCodexRequests(p);
      expect(rows[0]!.ts).toBe(T0);
      expect(rows[1]!.ts).toBe(T0 + DAY);
    } finally {
      await h.cleanup();
    }
  });
});
