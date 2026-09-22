// claude.test.ts — claude-code 收集器测试 (移植自站点 tests/claude.test.ts)
// 覆盖: messageId 去重取末值 (流式 chunk 累计)、isSidechain 计入、cache 四件套映射、
// 第三方端点缺 cache 字段容错、坏行跳过、无 assistant 记录文件进 skippedFiles、
// 窗口过滤 (CLI 特有)。
import {describe, expect, it} from "bun:test";
import {collectClaude} from "../src/collectors/claude.js";
import {T0, claudeAssistant, claudeUser, makeHome, writeLines, writeRaw} from "./fixtures.js";

describe("collectClaude", () => {
  it("messageId 去重取末值: 流式 chunk 累计 usage, 末行即全量", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/p/s.jsonl`, [
        claudeUser(),
        claudeAssistant({msgId: "m1", input: 10, output: 20, ts: T0}),
        claudeAssistant({msgId: "m1", input: 30, output: 40, ts: T0 + 1}),
        claudeAssistant({msgId: "m2", input: 5, output: 6, ts: T0 + 2}),
      ]);
      const r = await collectClaude([f], null);
      expect(r.harness).toBe("claude-code");
      expect(r.records).toHaveLength(2);
      expect(r.records[0]).toMatchObject({model: "claude-sonnet-5", ts: T0 + 1, inputTokens: 30, outputTokens: 40});
      expect(r.records[1]).toMatchObject({inputTokens: 5, outputTokens: 6});
    } finally {
      await h.cleanup();
    }
  });

  it("isSidechain 子代理消耗照常计入 (第三方模型串透传)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", model: "glm-4.7", input: 7, output: 8, sidechain: true, ts: T0}),
      ]);
      const r = await collectClaude([f], null);
      expect(r.records).toHaveLength(1);
      expect(r.records[0]).toMatchObject({model: "glm-4.7", inputTokens: 7, outputTokens: 8});
    } finally {
      await h.cleanup();
    }
  });

  it("cache 四件套映射; 第三方端点缺 cache 字段按 0 容错", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 50, cacheRead: 5000, cacheWrite: 300, ts: T0}),
        claudeAssistant({msgId: "m2", model: "glm-4.7", input: 10, output: 20, ts: T0}), // 无 cache 键
      ]);
      const r = await collectClaude([f], null);
      expect(r.records[0]).toMatchObject({cacheReadTokens: 5000, cacheWriteTokens: 300});
      expect(r.records[1]).toMatchObject({cacheReadTokens: 0, cacheWriteTokens: 0});
    } finally {
      await h.cleanup();
    }
  });

  it("坏行跳过且不影响好行解析 (非 JSON / 缺 usage / 坏时间戳)", async () => {
    const h = await makeHome();
    try {
      const f = await writeRaw(
        `${h.home}/p/s.jsonl`,
        [
          "{not-json",
          JSON.stringify(claudeAssistant({msgId: "m1", input: 1, output: 2, ts: T0})),
          JSON.stringify({type: "assistant", timestamp: "not-a-date", message: {id: "m2", model: "x", usage: {input_tokens: 1}}}),
        ].join("\n"),
      );
      const r = await collectClaude([f], null);
      expect(r.records).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("无 assistant 记录的文件 → skippedFiles 附原因", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/p/only-user.jsonl`, [claudeUser()]);
      const r = await collectClaude([f], null);
      expect(r.records).toHaveLength(0);
      expect(r.skippedFiles[0]).toContain("无 assistant 记录");
    } finally {
      await h.cleanup();
    }
  });

  it("窗口过滤: 去重后按记录 ts 过滤 (旧记录不计)", async () => {
    const h = await makeHome();
    try {
      const f = await writeLines(`${h.home}/p/s.jsonl`, [
        claudeAssistant({msgId: "old", input: 100, output: 10, ts: T0}),
        claudeAssistant({msgId: "new", input: 1, output: 1, ts: T0 + 10 * 86400000}),
      ]);
      const r = await collectClaude([f], T0 + 5 * 86400000);
      expect(r.records).toHaveLength(1);
      expect(r.records[0]).toMatchObject({inputTokens: 1});
    } finally {
      await h.cleanup();
    }
  });
});
