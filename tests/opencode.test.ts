// opencode.test.ts — opencode 请求收集 (message 表 SQL 抽取) + 对账源读取测试
// 覆盖: SQL 抽取口径 (model 拼接 / 秒毫秒折算 / reasoning 并入 / cell 守卫 /
// 全零与无模型与坏行排除)、成功过滤 (error 键 / tokens 键缺失)、rowid 水位线
// (增量与库重建重置)、reqKey 库名隔离、n_tools (part 表工具计数 / 无 part 表计 0)、
// 用户轮次 (user 行顺路计数 / 键与幂等)、对账源 (session 汇总 / 旧 schema null)。
import {describe, expect, it} from "bun:test";
import {collectOpencodeRequests, epochMs, opencodeSessionSummaries} from "../src/collectors/opencode.js";
import {DAY, T0, makeHome, makeOpencodeDbFile, makeOpencodeMessageDb, ocMsg} from "./fixtures.js";

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

describe("collectOpencodeRequests (message 表抽取)", () => {
  it("assistant 行 → RequestRow (model 拼接 / reasoning 并入 / reqKey=库名:rowid / sessKey)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode-stable.db`, [
        {sess: "s1", data: ocMsg({input: 100, output: 50, reasoning: 7, cacheRead: 5000, cacheWrite: 300, created: T0})},
        {sess: "s1", data: ocMsg({role: "user", created: T0})}, // 非 assistant → 不构成用量行 (轮次行)
      ]);
      const {rows, maxRowid, reset} = await collectOpencodeRequests(db, 0);
      expect(reset).toBe(false);
      expect(maxRowid).toBe(2);
      expect(rows).toEqual([
        {harness: "opencode", reqKey: "opencode-stable.db:1", sessKey: "s1", model: "zai-coding-plan/glm-5.3", ts: T0, inT: 100, outT: 57, crT: 5000, cwT: 300, nTools: 0},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("成功过滤: error 键在场行 / tokens 键缺失行剔除", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [
        {data: ocMsg({input: 10})}, // 正常行
        {data: ocMsg({input: 999, error: true})}, // error 键在场 → 剔除
        {data: ocMsg({input: 888, noTokens: true})}, // 无 tokens 键 → 剔除
      ]);
      const {rows} = await collectOpencodeRequests(db, 0);
      expect(rows.map((r) => r.inT)).toEqual([10]);
    } finally {
      await h.cleanup();
    }
  });

  it("水位线增量: sinceRowid 之后才扫", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [
        {data: ocMsg({input: 1, created: T0})},
        {data: ocMsg({input: 2, created: T0})},
        {data: ocMsg({input: 3, created: T0 + DAY})},
      ]);
      const full = await collectOpencodeRequests(db, 0);
      expect(full.rows).toHaveLength(3);
      const inc = await collectOpencodeRequests(db, 2);
      expect(inc.rows.map((r) => r.inT)).toEqual([3]);
      expect(inc.maxRowid).toBe(3);
      const none = await collectOpencodeRequests(db, 3);
      expect(none.rows).toHaveLength(0); // 幂等重采: 水位线即最大 → 空
    } finally {
      await h.cleanup();
    }
  });

  it("库重建重置: maxRowid < 水位线 → 全量重扫 + reset 标记", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [{data: ocMsg({input: 5})}]);
      const {rows, reset} = await collectOpencodeRequests(db, 42); // 旧库水位线 42 > 现 max 1
      expect(reset).toBe(true);
      expect(rows).toHaveLength(1); // 重扫全量
    } finally {
      await h.cleanup();
    }
  });

  it("秒时间戳折算 / 无效时间行排除 / 全零行排除 / 坏 data 行排除 / model 单边降级", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [
        {data: ocMsg({input: 10, created: Math.floor(T0 / 1000)})}, // 秒 → ×1000
        {data: ocMsg({input: 20, created: 0})}, // 无效时间 → 排除
        {data: ocMsg({input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0})}, // 全零 → 排除
        {data: "{broken json"}, // 坏 JSON → SQL 侧 json_valid 排除
        {data: null}, // NULL data → 排除
        {data: ocMsg({input: 30, modelID: "", providerID: "opus"})}, // 单边 → "opus"
        {data: ocMsg({input: 40, modelID: "", providerID: ""})}, // 双缺 → 排除
      ]);
      const {rows} = await collectOpencodeRequests(db, 0);
      expect(rows.map((r) => [r.inT, r.model, r.ts])).toEqual([
        [10, "zai-coding-plan/glm-5.3", Math.floor(T0 / 1000) * 1000],
        [30, "opus", T0],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("reqKey 库名隔离: 不同库同 rowid 不冲突", async () => {
    const h = await makeHome();
    try {
      const a = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [{data: ocMsg({input: 1})}]);
      const b = await makeOpencodeMessageDb(`${h.home}/opencode-stable.db`, [{data: ocMsg({input: 2})}]);
      const ra = await collectOpencodeRequests(a, 0);
      const rb = await collectOpencodeRequests(b, 0);
      expect(ra.rows[0]!.reqKey).toBe("opencode.db:1");
      expect(rb.rows[0]!.reqKey).toBe("opencode-stable.db:1");
    } finally {
      await h.cleanup();
    }
  });

  it("无 message 表 → 抛错 (调用方转 skipped)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(`${h.home}/opencode.db`, []); // 仅 session 表
      await expect(collectOpencodeRequests(db, 0)).rejects.toThrow("无 message 表");
    } finally {
      await h.cleanup();
    }
  });

  it("session_id 列异常 (空串) → 自会话键兜底 (NOT NULL 且唯一)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [{sess: "", data: ocMsg({input: 1})}]);
      const {rows} = await collectOpencodeRequests(db, 0);
      expect(rows[0]!.sessKey).toBe("~self:opencode.db:1");
    } finally {
      await h.cleanup();
    }
  });
});

describe("collectOpencodeRequests n_tools (part 表工具计数)", () => {
  it("part 表 type=tool 行按 message_id 归属计数; 非 tool part 不计", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode-stable.db`, [
        {sess: "s1", data: ocMsg({input: 10, created: T0}), tools: 3},
        {sess: "s1", data: ocMsg({input: 20, created: T0})}, // 无 tool part → 0
      ]);
      const {rows} = await collectOpencodeRequests(db, 0);
      expect(rows.find((r) => r.inT === 10)!.nTools).toBe(3);
      expect(rows.find((r) => r.inT === 20)!.nTools).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("无 part 表 (远古 schema) → nTools 恒 0, 扫描不失败", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [{data: ocMsg({input: 1, created: T0})}]);
      const {rows} = await collectOpencodeRequests(db, 0);
      expect(rows[0]!.nTools).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("collectOpencodeRequests 用户轮次 (user 行顺路计数)", () => {
  it("user 行 → TurnRow (键 库名:rowid); assistant 行不产轮次", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode-stable.db`, [
        {sess: "s0", data: ocMsg({role: "user", created: T0})}, // rowid 1
        {sess: "s0", data: ocMsg({input: 10, created: T0})}, // rowid 2 (assistant)
        {sess: "s1", data: ocMsg({role: "user", created: T0})}, // rowid 3
      ]);
      const {turns} = await collectOpencodeRequests(db, 0);
      expect(turns).toEqual([
        {harness: "opencode", turnKey: "opencode-stable.db:1", sessKey: "s0"},
        {harness: "opencode", turnKey: "opencode-stable.db:3", sessKey: "s1"},
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("水位线增量: 窗口内 user 行才产轮次 (与请求行同窗口)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeMessageDb(`${h.home}/opencode.db`, [
        {sess: "s0", data: ocMsg({role: "user", created: T0})},
        {sess: "s0", data: ocMsg({input: 1, created: T0})},
        {sess: "s0", data: ocMsg({role: "user", created: T0})},
      ]);
      const inc = await collectOpencodeRequests(db, 1); // 只扫 rowid 2..3
      expect(inc.rows).toHaveLength(1);
      expect(inc.turns).toEqual([{harness: "opencode", turnKey: "opencode.db:3", sessKey: "s0"}]);
    } finally {
      await h.cleanup();
    }
  });
});

describe("opencodeSessionSummaries (对账源)", () => {
  it("新 schema session 表 → 会话级汇总 (reasoning 并入 output; model 列不参与对账)", async () => {
    const h = await makeHome();
    try {
      const db = await makeOpencodeDbFile(`${h.home}/opencode.db`, [
        {model: null, input: 100, output: 50, reasoning: 7, cacheRead: 5, cacheWrite: 3, time: T0}, // model NULL 是实测常态
        {model: '{"id":"m","providerID":"p"}', input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0},
      ]);
      const m = await opencodeSessionSummaries(db);
      expect(m!.get("s0")).toEqual({sessKey: "s0", inT: 100, outT: 57, crT: 5, cwT: 3});
      expect(m!.get("s1")).toEqual({sessKey: "s1", inT: 1, outT: 1, crT: 0, cwT: 0});
    } finally {
      await h.cleanup();
    }
  });

  it("旧 schema (无 tokens 汇总列 / 无 session 表) → null (无对账)", async () => {
    const h = await makeHome();
    try {
      const legacy = await makeOpencodeMessageDb(`${h.home}/legacy.db`, [{data: ocMsg({input: 1})}]); // 无 session 表
      expect(await opencodeSessionSummaries(legacy)).toBeNull();
      const oldSchema = await makeOpencodeMessageDb(`${h.home}/old.db`, [{data: ocMsg({input: 1})}], []);
      // sessionRows 空 → 不建 session 表 → null
      expect(await opencodeSessionSummaries(oldSchema)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
