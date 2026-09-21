// aggregate.test.ts — 日粒度聚合与 ProfileV1 构造测试
// 覆盖: 同模型同日合并 (ts 取组内 max)、跨源同名模型合并、spanDays 计算与钳制、
// 月速率 = 总量×30/spanDays 自洽 (引擎外推还原)、agent 字段单源/混合、空输入。
import {describe, expect, it} from "bun:test";
import {aggregate} from "../src/aggregate.js";
import type {ParseResult, UsageRecord} from "../src/types.js";

const rec = (model: string, ts: number, o: Partial<UsageRecord> = {}): UsageRecord => ({
  model,
  ts,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...o,
});

// 固定两日跨度: 2026-05-08 与 05-09 (本地时区日, 合成数据避开 UTC 边界)
import {DAY, T0} from "./fixtures.js";

describe("aggregate 日粒度", () => {
  it("同模型同日多记录合并为一条, ts 取组内最大值", () => {
    const r = aggregate(
      [{agent: "opencode", records: [rec("m", T0, {inputTokens: 1}), rec("m", T0 + 3600000, {inputTokens: 2, outputTokens: 5}), rec("m", T0 + 7200000, {inputTokens: 3})], skippedFiles: []}],
      "test",
    )!;
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0]).toMatchObject({inputTokens: 6, outputTokens: 5, ts: T0 + 7200000});
  });

  it("同模型跨日分条; 不同模型分条; 输出 ts 升序", () => {
    const r = aggregate(
      [
        {
          agent: "opencode",
          records: [rec("b", T0 + DAY, {inputTokens: 1}), rec("a", T0, {inputTokens: 1}), rec("b", T0, {inputTokens: 1})],
          skippedFiles: [],
        },
      ],
      "test",
    )!;
    expect(r.daily.map((x) => x.model)).toEqual(["a", "b", "b"]);
    expect(r.daily[0]!.ts).toBeLessThanOrEqual(r.daily[1]!.ts);
  });

  it("跨源同名模型在 ProfileV1 models 合并为一条", () => {
    const r = aggregate(
      [
        {agent: "opencode", records: [rec("glm-5.3", T0, {inputTokens: 100})], skippedFiles: []},
        {agent: "claude-code", records: [rec("glm-5.3", T0, {inputTokens: 50})], skippedFiles: []},
      ],
      "test",
    )!;
    expect(r.profile.models).toHaveLength(1);
    expect(r.profile.models[0]).toMatchObject({id: "glm-5.3"});
  });
});

describe("aggregate ProfileV1 (月速率口径)", () => {
  it("spanDays = ceil(跨度); 月速率 = 总量×30/spanDays (引擎外推还原自洽)", () => {
    // 两日跨度 (T0 与 T0+2*DAY → 日粒度 3 天组? 不: 记录 2 条, ts 跨 2 天 → spanDays = 2)
    const r = aggregate(
      [{agent: "opencode", records: [rec("m", T0, {inputTokens: 300}), rec("m", T0 + 2 * DAY, {inputTokens: 300})], skippedFiles: []}],
      "test",
    )!;
    expect(r.profile.spanDays).toBe(2);
    const m = r.profile.models[0]!;
    expect(m.inputT).toBe(Math.round((600 * 30) / 2)); // 9000
    // 自洽性: spanDays × 月速率 / 30 == 总量 (round 容差)
    expect((m.inputT * r.profile.spanDays) / 30).toBeCloseTo(600, 6);
  });

  it("同刻记录 → spanDays 钳下限 1 (防除零)", () => {
    const r = aggregate([{agent: "codex", records: [rec("m", T0, {inputTokens: 30})], skippedFiles: []}], "test")!;
    expect(r.profile.spanDays).toBe(1);
    expect(r.profile.models[0]!.inputT).toBe(900); // 30 × 30 / 1
  });

  it("agent: 单源 = 源名, 多源 = mixed; 契约固定字段齐备", () => {
    const single = aggregate([{agent: "codex", records: [rec("m", T0)], skippedFiles: []}], "test")!;
    expect(single.profile.agent).toBe("codex");
    const multi = aggregate(
      [
        {agent: "codex", records: [rec("m", T0)], skippedFiles: []},
        {agent: "opencode", records: [rec("m2", T0)], skippedFiles: []},
      ],
      "test",
    )!;
    expect(multi.profile.agent).toBe("mixed");
    expect(multi.profile.schema).toBe("pricey-tokens-profile/v1");
    expect(multi.profile.trust).toBe("anon");
    expect(multi.profile.planUsed).toBeNull();
    expect(multi.profile.toolVersion).toBe("test");
    expect(multi.profile.collectedAt).toBeGreaterThan(0);
  });

  it("空输入 → null", () => {
    expect(aggregate([], "test")).toBeNull();
    expect(aggregate([{agent: "opencode", records: [], skippedFiles: []}], "test")).toBeNull();
  });

  it("models 按月速率总量降序输出", () => {
    const r = aggregate(
      [
        {
          agent: "opencode",
          records: [rec("small", T0, {inputTokens: 1}), rec("big", T0, {inputTokens: 10000})],
          skippedFiles: [],
        },
      ],
      "test",
    )!;
    expect(r.profile.models.map((m) => m.id)).toEqual(["big", "small"]);
  });
});
