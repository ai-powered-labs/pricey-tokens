// discover.test.ts — 数据源探测与收集编排测试 (home 注入临时目录)
// 覆盖: 三源探测 found/未发现报告、--agent 过滤、codex 日期路径剪枝 (整树跳过但
// 不误杀窗口内文件)、收集失败转 skipped 不拖垮其他源。
import {describe, expect, it} from "bun:test";
import {collectAll} from "../src/discover.js";
import {T0, DAY, claudeAssistant, codexTokenLine, codexTurnContext, makeHome, makeOpencodeDbFile, ocMsg, writeLines} from "./fixtures.js";

// 注意: T0 (2026-05-08) 在过去; 窗口判定用绝对 sinceMs 注入, 不依赖 now。
describe("collectAll 探测", () => {
  it("空 home → 三源全未发现, exit 语义由调用方判 records 空", async () => {
    const h = await makeHome();
    try {
      const {results, statuses} = await collectAll({agents: [], sinceMs: null, home: h.home});
      expect(results).toHaveLength(0);
      expect(statuses).toHaveLength(3);
      expect(statuses.every((s) => !s.found)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("三源齐备 → 各自收集 (合成数据, 绝对窗口)", async () => {
    const h = await makeHome();
    try {
      await makeOpencodeDbFile(`${h.home}/.local/share/opencode/opencode.db`, [
        {model: '{"id":"m","providerID":"p"}', input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0},
      ]);
      await writeLines(`${h.home}/.claude/projects/proj/s1.jsonl`, [claudeAssistant({msgId: "m1", input: 2, ts: T0})]);
      await writeLines(`${h.home}/.codex/sessions/2026/05/08/rollout-x.jsonl`, [
        codexTurnContext("gpt-5.6", T0),
        codexTokenLine({ts: T0, total: [3, 0, 0]}),
      ]);
      const {results, statuses} = await collectAll({agents: [], sinceMs: null, home: h.home});
      expect(statuses.filter((s) => s.found)).toHaveLength(3);
      expect(results).toHaveLength(3);
      const total = results.flatMap((r) => r.records.map((x) => x.inputTokens)).sort();
      expect(total).toEqual([1, 2, 3]);
    } finally {
      await h.cleanup();
    }
  });

  it("--agent 单源过滤: 只探测指定源", async () => {
    const h = await makeHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [claudeAssistant({msgId: "m", input: 1, ts: T0})]);
      const {results, statuses} = await collectAll({agents: ["claude-code"], sinceMs: null, home: h.home});
      expect(statuses.map((s) => s.agent)).toEqual(["claude-code"]);
      expect(results).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("codex 日期路径剪枝: 窗口外整日目录跳过, 窗口内保留 (语义等价于逐文件过滤)", async () => {
    const h = await makeHome();
    try {
      const since = T0; // 窗口起点 = T0
      await writeLines(`${h.home}/.codex/sessions/2026/05/08/rollout-in.jsonl`, [
        codexTokenLine({ts: T0, total: [10, 0, 0]}),
      ]);
      await writeLines(`${h.home}/.codex/sessions/2026/04/01/rollout-out.jsonl`, [
        codexTokenLine({ts: T0 - 30 * DAY, total: [99, 0, 0]}),
      ]);
      const {results, statuses} = await collectAll({agents: ["codex"], sinceMs: since, home: h.home});
      const codex = results.find((r) => r.agent === "codex")!;
      // 剪枝后 04/01 目录被整树跳过 (statuses detail 里只有 1 个文件)
      expect(statuses[0]!.detail).toContain("1 个会话文件");
      expect(codex.records.map((r) => r.inputTokens)).toEqual([10]);
    } finally {
      await h.cleanup();
    }
  });

  it("剪枝跨午夜回归: 会话落昨夜目录但最后 token_count 已进窗 → 不被误剪 (2026-09 review #2)", async () => {
    const h = await makeHome();
    try {
      // 会话开始于 05/08 23:00 (落 05/08 目录), 最后 token_count 在 05/09 00:30;
      // 窗口起点 = 05/09 00:00 → 目录日终点 (05/09 00:00) + 1 天余量 > 起点, 不可剪
      const day8 = T0; // 2026-05-08 02:30 (T0 基准); 构造 23:00 与次日 00:30 需绝对时刻
      const lateNight = Date.UTC(2026, 4, 8, 23, 0, 0);
      const afterMidnight = Date.UTC(2026, 4, 9, 0, 30, 0);
      const since = Date.UTC(2026, 4, 9, 0, 0, 0);
      expect(lateNight).toBeGreaterThan(day8 - 1); // 仍在 05/08 目录日内的前提自检
      await writeLines(`${h.home}/.codex/sessions/2026/05/08/rollout-x.jsonl`, [
        codexTurnContext("gpt-5.6", lateNight),
        codexTokenLine({ts: lateNight, total: [50, 0, 0]}),
        codexTokenLine({ts: afterMidnight, total: [80, 0, 0]}),
      ]);
      const {results} = await collectAll({agents: ["codex"], sinceMs: since, home: h.home});
      const codex = results.find((r) => r.agent === "codex")!;
      expect(codex.records).toHaveLength(1); // ts=afterMidnight ≥ since → 必须保留
      expect(codex.records[0]!.inputTokens).toBe(80);
    } finally {
      await h.cleanup();
    }
  });

  it("opencode 库损坏 → 该源 skipped 不拖垮 claude 源", async () => {
    const h = await makeHome();
    try {
      const {writeFile, mkdir} = await import("node:fs/promises");
      await mkdir(`${h.home}/.local/share/opencode`, {recursive: true});
      await writeFile(`${h.home}/.local/share/opencode/opencode.db`, "junk");
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [claudeAssistant({msgId: "m", input: 5, ts: T0})]);
      const {results} = await collectAll({agents: [], sinceMs: null, home: h.home});
      const oc = results.find((r) => r.agent === "opencode")!;
      expect(oc.records).toHaveLength(0);
      expect(oc.skippedFiles.length).toBeGreaterThan(0);
      const cl = results.find((r) => r.agent === "claude-code")!;
      expect(cl.records).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("XDG_DATA_HOME 注入 (opencode 库位置)", () => {
  it("绝对路径 XDG_DATA_HOME 生效", async () => {
    const h = await makeHome();
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = `${h.home}/xdg-data`;
    try {
      await makeOpencodeDbFile(`${h.home}/xdg-data/opencode/opencode.db`, [
        {model: "m", input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0},
      ]);
      const {statuses} = await collectAll({agents: ["opencode"], sinceMs: null, home: h.home});
      expect(statuses[0]!.found).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      await h.cleanup();
    }
  });
});
