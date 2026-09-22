// codex.test.ts — codex 收集器测试 (移植自站点 tests/codex.test.ts)
// 覆盖: 多 token_count 事件取尾值不重复计数 (核心不变量)、model 取最后 turn_context、
// last_token_usage 差分回退、total/last 并存以 total 为准、旧格式文件进 skippedFiles、
// 窗口过滤 (CLI 特有)、单调累计属性 (随机化)。
import {describe, expect, it} from "bun:test";
import {collectCodex} from "../src/collectors/codex.js";
import {T0, DAY, codexOldFirstLine, codexSessionMeta, codexTokenLine, codexTurnContext, makeHome, writeLines} from "./fixtures.js";

describe("collectCodex", () => {
  it("多 token_count 事件取尾值不重复计数 (total_token_usage 是会话累计值)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-1.jsonl`, [
        codexSessionMeta(T0),
        codexTurnContext("gpt-5.6", T0),
        codexTokenLine({ts: T0 + 1000, total: [100, 40, 200]}),
        codexTokenLine({ts: T0 + 2000, total: [250, 90, 400]}),
        codexTokenLine({ts: T0 + 3000, total: [300, 120, 500]}),
      ]);
      const r = await collectCodex([f], null);
      expect(r.harness).toBe("codex");
      expect(r.records).toEqual([
        {model: "gpt-5.6", ts: T0 + 3000, inputTokens: 300, outputTokens: 500, cacheReadTokens: 120, cacheWriteTokens: 0},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("model 取最后出现的 turn_context (会话中途换模型)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-2.jsonl`, [
        codexTurnContext("gpt-5.5", T0),
        codexTokenLine({ts: T0 + 1, total: [10, 0, 20]}),
        codexTurnContext("gpt-5.6", T0 + 2),
        codexTokenLine({ts: T0 + 3, total: [30, 0, 40]}),
      ]);
      const r = await collectCodex([f], null);
      expect(r.records[0]!.model).toBe("gpt-5.6");
      expect(r.records[0]!.inputTokens).toBe(30); // 尾值, 非两事件之和
    } finally {
      await h.cleanup();
    }
  });

  it("total_token_usage 缺失时回退 last_token_usage 差分累加", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-3.jsonl`, [
        codexTokenLine({ts: T0, last: [10, 2, 20]}),
        codexTokenLine({ts: T0 + 3600000, last: [5, 1, 8]}),
      ]);
      const r = await collectCodex([f], null);
      expect(r.records).toEqual([{model: "unknown", ts: T0 + 3600000, inputTokens: 15, outputTokens: 28, cacheReadTokens: 3, cacheWriteTokens: 0}]);
    } finally {
      await h.cleanup();
    }
  });

  it("total 与 last 并存时以 total 为准 (末值, 不再叠加 last)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-4.jsonl`, [
        codexTokenLine({ts: T0, total: [100, 0, 200], last: [50, 0, 80]}),
        codexTokenLine({ts: T0 + 1, total: [110, 0, 260], last: [10, 0, 60]}),
      ]);
      const r = await collectCodex([f], null);
      expect(r.records[0]!.inputTokens).toBe(110);
      expect(r.records[0]!.outputTokens).toBe(260);
    } finally {
      await h.cleanup();
    }
  });

  it("旧格式 (无 wrapper 包装) → skippedFiles 附原因", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-old.jsonl`, [
        codexOldFirstLine(),
        {type: "message", role: "assistant", id: "msg_1", content: [{type: "output_text", text: "hi"}]},
        {type: "function_call", name: "shell", arguments: "{}", call_id: "c1", id: "fc_1"},
      ]);
      const r = await collectCodex([f], null);
      expect(r.records).toHaveLength(0);
      expect(r.skippedFiles[0]).toContain("旧格式无 token 数据");
    } finally {
      await h.cleanup();
    }
  });

  it("窗口过滤: 会话整体出窗 → 不计 (会话粒度无拆分语义)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/rollout-5.jsonl`, [
        codexTurnContext("gpt-5.6", T0),
        codexTokenLine({ts: T0, total: [10, 0, 20]}),
      ]);
      const r = await collectCodex([f], T0 + DAY);
      expect(r.records).toHaveLength(0);
      const r2 = await collectCodex([f], T0);
      expect(r2.records).toHaveLength(1); // 恰在窗口边界 (>=) 计入
    } finally {
      await h.cleanup();
    }
  });

  it("属性: 任意单调累计事件序列, 解析值恒 == 末条累计值 (绝不逐事件求和)", async () => {
    const h = await makeHome();
    try {
      // 确定性伪随机 (xorshift32): 20 个文件 × 各 3..15 条递增累计 token_count 事件
      let seed = 0x2f6e2b1;
      const rnd = (n: number): number => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return Math.abs(seed) % n;
      };
      const paths: string[] = [];
      const expected: Array<[number, number, number, number]> = []; // [ts, in, cached, out]
      for (let fileIdx = 0; fileIdx < 20; fileIdx++) {
        const events = 3 + rnd(13);
        let i = 0;
        let c = 0;
        let o = 0;
        let lastTs = 0;
        const lines: unknown[] = [codexTurnContext(`m-${fileIdx}`, T0)];
        for (let e = 0; e < events; e++) {
          i += rnd(1000);
          c += rnd(500);
          o += rnd(800);
          lastTs = T0 + e * 60000;
          lines.push(codexTokenLine({ts: lastTs, total: [i, c, o]}));
        }
        paths.push(await writeLines(`${h.home}/rollout-r${fileIdx}.jsonl`, lines));
        expected.push([lastTs, i, c, o]);
      }
      const r = await collectCodex(paths, null);
      expect(r.records).toHaveLength(20);
      for (const [idx, [ts, i, c, o]] of expected.entries()) {
        expect(r.records[idx]).toMatchObject({ts, inputTokens: i, cacheReadTokens: c, outputTokens: o});
      }
    } finally {
      await h.cleanup();
    }
  });
});
