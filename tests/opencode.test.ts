// opencode.test.ts — opencode 收集器测试 (口径对齐站点 tests/opencode.test.ts +
// export-usage.test.sh 的双通道同数要求; I/O 换 CLI 路径形态)
// 覆盖: 新 schema session 汇总 (model JSON 拼接 / 秒毫秒折算 / reasoning 并入 /
// 零消耗与无模型行排除 / Inf 守卫)、旧 schema message fallback、新旧共存取 session、
// 窗口过滤 (SQL 侧, CLI 特有)、坏库报错。
import {describe, expect, it} from "bun:test";
import {collectOpencode, epochMs} from "../src/collectors/opencode.js";
import {T0, DAY, makeHome, makeOpencodeDbFile, makeOpencodeDualDbFile, makeOpencodeLegacyDbFile, ocMsg} from "./fixtures.js";

describe("epochMs 秒/毫秒折算", () => {
  it("秒 (<1e11) ×1000, 毫秒 (>1e11) 原样, 无效值 null", () => {
    expect(epochMs(1778224249)).toBe(1778224249000);
    expect(epochMs(1778224249123)).toBe(1778224249123);
    expect(epochMs(0)).toBeNull();
    expect(epochMs(-5)).toBeNull();
    expect(epochMs("x")).toBeNull();
    expect(epochMs(Infinity)).toBeNull();
  });
});

describe("collectOpencode 新 schema (session 汇总)", () => {
  it("model JSON {id,providerID} → 拼接; reasoning 并入 output; 毫秒时间原样", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(`${h.home}/opencode.db`, [
        {model: JSON.stringify({id: "glm-5.3", providerID: "zai-coding-plan"}), input: 100, output: 50, reasoning: 7, cacheRead: 5000, cacheWrite: 300, time: T0},
      ]);
      const r = await collectOpencode(db, null);
      expect(r.agent).toBe("opencode");
      expect(r.records).toEqual([
        {model: "zai-coding-plan/glm-5.3", ts: T0, inputTokens: 100, outputTokens: 57, cacheReadTokens: 5000, cacheWriteTokens: 300},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("秒时间戳 ×1000 折算 (updated_at spec 名)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(
        `${h.home}/opencode.db`,
        [{model: '{"id":"m","providerID":"p"}', input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: Math.floor(T0 / 1000)}],
        "updated_at",
      );
      const r = await collectOpencode(db, null);
      expect(r.records[0]!.ts).toBe(Math.floor(T0 / 1000) * 1000);
    } finally {
      await h.cleanup();
    }
  });

  it("model 单边缺省降级 / 非串 NULL / 零消耗行 / 无时间行排除", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(`${h.home}/opencode.db`, [
        {model: '{"id":"","providerID":"opus"}', input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}, // 只剩 provider
        {model: '{"id":"x","providerID":""}', input: 20, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}, // 只剩 id
        {model: "plain-string", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}, // 零消耗 → 排除
        {model: "no-time", input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: 0}, // 无时间 → 排除
        {model: null, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}, // 无模型 → 排除
      ]);
      const r = await collectOpencode(db, null);
      expect(r.records.map((x) => x.model).sort()).toEqual(["opus", "x"]);
    } finally {
      await h.cleanup();
    }
  });

  it("Inf cell 守卫: 9e999 字面量 → Inf 时间行整行排除, Inf token 按 0 (行保留)", async () => {
    const h = await makeHome();
    try {
      // 直接以 SQL 字面量注入 Inf (SQLite 浮点溢出即 +Inf — 镜像 export-usage.test.sh)
      const {Database} = await import("bun:sqlite");
      const dbPath = `${h.home}/opencode.db`;
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE session (id text PRIMARY KEY, model text, tokens_input integer NOT NULL DEFAULT 0,
        tokens_output integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0, time_updated integer NOT NULL)`);
      db.exec(`INSERT INTO session VALUES ('a', 'm1', 9e999, 1, 0, 0, ${T0})`); // Inf input
      db.exec(`INSERT INTO session VALUES ('b', 'm2', 1, 1, 0, 0, 9e999)`); // Inf time → 整行排除
      db.close();
      const r = await collectOpencode(dbPath, null);
      expect(r.records).toEqual([{model: "m1", ts: T0, inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0}]);
    } finally {
      await h.cleanup();
    }
  });

  it("tokens_reasoning 列缺失 → 按 0 (v1 早期 schema)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(
        `${h.home}/opencode.db`,
        [{model: "m", input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}],
        "time_updated",
        ["tokens_reasoning"],
      );
      const r = await collectOpencode(db, null);
      expect(r.records[0]!.outputTokens).toBe(5);
    } finally {
      await h.cleanup();
    }
  });

  it("窗口过滤 (SQL 侧): 秒/毫秒折算后判定", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(`${h.home}/opencode.db`, [
        {model: "old", input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0},
        {model: "new", input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0 + 10 * DAY},
      ]);
      const r = await collectOpencode(db, T0 + 5 * DAY);
      expect(r.records.map((x) => x.model)).toEqual(["new"]);
    } finally {
      await h.cleanup();
    }
  });

  it("session 缺汇总列 → 按新 schema 报列缺失 (不静默回退)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(
        `${h.home}/opencode.db`,
        [{model: "m", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}],
        "time_updated",
        ["tokens_input"],
      );
      // drop tokens_input 后 session 表仍存在但无汇总列, 且无 message 表 → 报错
      await expect(collectOpencode(db, null)).rejects.toThrow("无可用用量源");
    } finally {
      await h.cleanup();
    }
  });
});

describe("collectOpencode 旧 schema (message fallback)", () => {
  it("assistant 行 data JSON → provider/modelID 拼接, reasoning 并入, cache 读写分离", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeLegacyDbFile(`${h.home}/opencode.db`, [
        ocMsg({input: 100, output: 50, reasoning: 7, cacheRead: 5000, cacheWrite: 300, created: T0}),
        ocMsg({role: "user", created: T0}), // 非 assistant 静默过滤
      ]);
      const r = await collectOpencode(db, null);
      expect(r.records).toEqual([
        {model: "zai-coding-plan/glm-5.3", ts: T0, inputTokens: 100, outputTokens: 57, cacheReadTokens: 5000, cacheWriteTokens: 300},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("坏 data 行 (NULL / 坏 JSON) 静默排除; 窗口过滤在 TS 侧", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeLegacyDbFile(`${h.home}/opencode.db`, [
        null,
        "{broken json",
        ocMsg({input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, created: T0}),
        ocMsg({input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, created: T0 + 10 * DAY}),
      ]);
      const all = await collectOpencode(db, null);
      expect(all.records).toHaveLength(2);
      const win = await collectOpencode(db, T0 + 5 * DAY);
      expect(win.records.map((x) => x.inputTokens)).toEqual([1]);
    } finally {
      await h.cleanup();
    }
  });

  it("message-only 库 (无 session 表) 正常收集", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeLegacyDbFile(`${h.home}/opencode.db`, [ocMsg({input: 3, created: T0})], {noSession: true});
      const r = await collectOpencode(db, null);
      expect(r.records).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("collectOpencode 新旧共存", () => {
  it("session tokens 汇总列与 message 表并存 → 取 session 路径, message 不重复计数", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDualDbFile(
        `${h.home}/opencode.db`,
        [{model: '{"id":"m","providerID":"p"}', input: 42, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}],
        [ocMsg({input: 999, created: T0})], // 若误走 message 路径会得到 999
      );
      const r = await collectOpencode(db, null);
      expect(r.records).toEqual([{model: "p/m", ts: T0, inputTokens: 42, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}]);
    } finally {
      await h.cleanup();
    }
  });
});

describe("collectOpencode 坏库", () => {
  it("非 SQLite 文件 → 报错 (调用方转 skipped)", async () => {
    const h = await makeHome();
    try {
      const {writeFile} = await import("node:fs/promises");
      const p = `${h.home}/opencode.db`;
      await writeFile(p, "definitely not sqlite");
      await expect(collectOpencode(p, null)).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });
});
