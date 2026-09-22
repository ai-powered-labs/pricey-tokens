// claude.test.ts — claude-code 请求收集测试 (request 粒度 + 成功过滤)
// 覆盖: 四分类映射 / messageId 去重末值 (流式 chunk) / isApiErrorMessage 剔除 /
// 全零行剔除 / sidechain 计入 / reqKey(sess:msg) 与跨会话同 id 不冲突 /
// 坏行与缺字段静默跳过 / sessionId 缺省回退文件名。
import {describe, expect, it} from "bun:test";
import {collectClaudeRequests} from "../src/collectors/claude.js";
import {T0, claudeAssistant, claudeUser, makeHome, writeLines} from "./fixtures.js";

describe("collectClaudeRequests 解析", () => {
  it("assistant 行 → RequestRow (四分类 + reqKey/sessKey)", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, cacheRead: 5, cacheWrite: 3, ts: T0, sessionId: "sess-1"}),
      ]);
      const {rows, skipped} = await collectClaudeRequests(p);
      expect(skipped).toBeNull();
      expect(rows).toEqual([
        {harness: "claude-code", reqKey: "sess-1:m1", sessKey: "sess-1", model: "claude-sonnet-5", ts: T0, inT: 100, outT: 10, crT: 5, cwT: 3},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("同 messageId 流式 chunk 取末值 (累计 usage 最后一行)", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [
        claudeAssistant({msgId: "m1", input: 10, output: 1, ts: T0}),
        claudeAssistant({msgId: "m1", input: 100, output: 12, cacheRead: 7, ts: T0 + 5}),
      ]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.inT).toBe(100);
      expect(rows[0]!.crT).toBe(7);
    } finally {
      await h.cleanup();
    }
  });

  it("成功过滤: isApiErrorMessage 行剔除 (即使带 usage)", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [
        claudeAssistant({msgId: "ok", input: 50, output: 5, ts: T0}),
        claudeAssistant({msgId: "err", input: 500, output: 50, ts: T0, isApiError: true}),
      ]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows.map((r) => r.reqKey)).toEqual(["sess-1:ok"]);
    } finally {
      await h.cleanup();
    }
  });

  it("全零行剔除; user/坏行静默跳过", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [
        claudeAssistant({msgId: "zero", input: 0, output: 0, ts: T0}),
        claudeUser(T0),
        {broken: "not json will fail parse" /* 合法 JSON 但非 assistant */},
      ]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("sidechain 子代理消耗计入 (真实消耗)", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [claudeAssistant({msgId: "sub", input: 7, ts: T0, sidechain: true})]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("不同会话的同 messageId 各自独立 (sessKey 隔离)", async () => {
    const h = await makeHome();
    try {
      const p = await writeLines(`${h.home}/s1.jsonl`, [
        claudeAssistant({msgId: "dup", input: 1, ts: T0, sessionId: "sa"}),
        claudeAssistant({msgId: "dup", input: 2, ts: T0, sessionId: "sb"}),
      ]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.sessKey))).toEqual(new Set(["sa", "sb"]));
    } finally {
      await h.cleanup();
    }
  });

  it("sessionId 缺省回退文件名 stem (reqKey 仍唯一)", async () => {
    const h = await makeHome();
    try {
      const line = claudeAssistant({msgId: "m1", input: 1, ts: T0, sessionId: "sess-1"});
      delete (line as Record<string, unknown>).sessionId;
      const p = await writeLines(`${h.home}/conv-42.jsonl`, [line]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows[0]!.sessKey).toBe("conv-42");
      expect(rows[0]!.reqKey).toBe("conv-42:m1");
    } finally {
      await h.cleanup();
    }
  });

  it("无 message.id 的行按行号独立计 (@line:N)", async () => {
    const h = await makeHome();
    try {
      const l1 = claudeAssistant({msgId: "explicit", input: 1, ts: T0});
      const l2 = claudeAssistant({msgId: "noid", input: 2, ts: T0});
      delete (l2 as {message: {id?: string}}).message.id;
      const p = await writeLines(`${h.home}/s1.jsonl`, [l1, l2]);
      const {rows} = await collectClaudeRequests(p);
      expect(rows.map((r) => r.reqKey).sort()).toEqual(["sess-1:@line:2", "sess-1:explicit"]);
    } finally {
      await h.cleanup();
    }
  });
});
