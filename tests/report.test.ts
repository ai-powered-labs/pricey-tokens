// report.test.ts — 用量摘要渲染测试
// 覆盖: fmtTokens 边界与进位、fmtCount 千分位、sparkline 级映射与全零防御、
// renderSummary 集成 (窗口头行/总览加法/模型排序与占比/稀疏日补零/名字截断)。
import {describe, expect, it} from "bun:test";
import {fmtTokens, fmtCount, sparkline, renderSummary} from "../src/report.js";
import type {ProfileDayV2, ProfileModelV2} from "../src/types.js";

describe("fmtTokens", () => {
  it("边界: <1000 原样, 千位进 K", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1K");
    expect(fmtTokens(1234)).toBe("1.2K");
  });

  it("去尾零与四舍五入进位", () => {
    expect(fmtTokens(1_950_000)).toBe("2M"); // 2.0M → 2M
    expect(fmtTokens(9_400_000)).toBe("9.4M");
    expect(fmtTokens(999_999)).toBe("1M"); // 999.999K → 1M
  });

  it("G/T 级", () => {
    expect(fmtTokens(9_400_000_000)).toBe("9.4G");
    expect(fmtTokens(1_200_000_000)).toBe("1.2G");
    expect(fmtTokens(3_000_000_000_000)).toBe("3T");
  });

  it("单调性 (属性): 递增输入 → 解析值非降", () => {
    const parse = (s: string): number => {
      const m = /^([\d.]+)([KMGT]?)$/.exec(s)!;
      const scale = {"": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12}[m[2]!]!;
      return Number(m[1]) * scale;
    };
    let prev = -Infinity;
    for (let n = 0; n <= 5_000_000; n += 9973) {
      const v = parse(fmtTokens(n));
      expect(v).toBeGreaterThanOrEqual(prev * 0.999); // 舍入容差
      prev = v;
    }
  });
});

describe("fmtCount", () => {
  it("千分位", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(999)).toBe("999");
    expect(fmtCount(12345)).toBe("12,345");
    expect(fmtCount(1234567)).toBe("1,234,567");
  });
});

describe("sparkline", () => {
  it("长度守恒, 0 → ▁, max → █", () => {
    const s = sparkline([0, 5, 10]);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe("▁");
    expect(s[2]).toBe("█");
  });

  it("全零防御 (max<=0 全 ▁)", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });

  it("负值钳 0 (长度守恒, 首格 ▁ — 纵深防御, 上游 posNum 已保证非负)", () => {
    expect(sparkline([-1, 0, 5])).toHaveLength(3);
    expect(sparkline([-1, 0, 5])[0]).toBe("▁");
  });
});

// ProfileModelV2 fixture — 直方图字段与摘要无关, 给形式合法值即可
function m(id: string, inT: number, outT: number, crT: number, cwT: number, nReq: number): ProfileModelV2 {
  return {id, in: inT, out: outT, cr: crT, cw: cwT, nSess: 1, nReq, ctxHist: [nReq], outHist: [nReq], nTurns: nReq, nToolCalls: nReq, maxCtxHist: [1]};
}

describe("renderSummary", () => {
  const days: ProfileDayV2[] = [
    {day: "2026-09-20", models: [m("claude-sonnet-5", 1_000_000, 100_000, 9_000_000, 0, 3), m("gpt-5-codex", 200_000, 20_000, 300_000, 0, 1)]},
    // 2026-09-21 无记录 → 趋势序列须补零
    {day: "2026-09-22", models: [m("claude-sonnet-5", 500_000, 50_000, 4_000_000, 0, 2)]},
  ];
  // 头行/总览/模型表/趋势四例共享同一 fixture 的渲染结果
  const out = renderSummary({days, windowLabel: "近 30 天", harnessLabel: "claude-code"});

  it("头行: 窗口标签 + 日历跨度 (含空日) + 模型数 + 源", () => {
    expect(out).toContain("近 30 天 · 2026-09-20 ~ 2026-09-22 (3 天) · 2 个模型 · claude-code");
  });

  it("总览: 计数与四分类是跨日跨模型加法", () => {
    expect(out).toContain("请求 6"); // 3+1+2
    expect(out).toContain("轮次 6");
    expect(out).toContain("工具调用 6");
    expect(out).toContain("输入 1.7M"); // 1.0M+0.2M+0.5M
    expect(out).toContain("缓存读 13.3M"); // 9M+0.3M+4M
  });

  it("模型表: 按四分类总量降序, bar 定长 16, 占比和 ≈ 100%", () => {
    const lines = out.split("\n");
    const big = lines.findIndex((l) => l.startsWith("claude-sonnet-5"));
    const small = lines.findIndex((l) => l.startsWith("gpt-5-codex"));
    expect(big).toBeGreaterThan(-1);
    expect(small).toBeGreaterThan(big); // 大模型在前
    const pct = [...out.matchAll(/(\d+)%/g)].map((x) => Number(x[1]));
    expect(pct).toHaveLength(2);
    expect(pct[0]! + pct[1]!).toBeGreaterThanOrEqual(99);
    expect(pct[0]! + pct[1]!).toBeLessThanOrEqual(101);
    for (const l of [lines[big]!, lines[small]!]) {
      expect(l.match(/[█░]{16}/)).not.toBeNull(); // 定长 16 的分布条
    }
  });

  it("趋势: 稀疏日补零后逐日一格, 峰值标注", () => {
    const trend = out.split("\n").find((l) => l.includes("每日") && l.includes("▁"))!;
    const spark = trend.match(/[▁▂▃▄▅▆▇█]+/g)![0]!;
    expect(spark).toHaveLength(3); // 3 个日历日 (中间空日补零)
    expect(out).toContain("(09-20)"); // 峰值 = 首日 10.1M
  });

  it("超长模型名截断到列宽内 (… 前缀保尾段 — 区分度在模型 id)", () => {
    const long = "very-long-provider-name/with/model-identity-ultra-long-v5";
    const out2 = renderSummary({days: [{day: "2026-09-20", models: [m(long, 1, 1, 1, 1, 1)]}], windowLabel: "全量", harnessLabel: "opencode"});
    const row = out2.split("\n").find((l) => l.includes("ultra-long-v5"))!;
    expect(row.startsWith("…")).toBe(true); // 保尾段非前段
    expect(row.slice(0, 31)).not.toContain("  "); // 名字列 (含 …) 恰占 NAME_W 内, 其后才接列间隔
  });

  it("单日窗口: range 无波浪线", () => {
    const out2 = renderSummary({days: [{day: "2026-09-20", models: [m("claude-sonnet-5", 1, 1, 1, 1, 1)]}], windowLabel: "全量", harnessLabel: "claude-code"});
    expect(out2).toContain("2026-09-20 (1 天)");
    expect(out2).not.toContain("~");
  });

  it("窗口超 TREND_DAYS: 趋势只留最近 30 天并改标签", () => {
    // 连排 35 天跨入 9 月 (峰值在末日 — 断言裁剪后 sparkline 恰 30 格)
    const wide: ProfileDayV2[] = Array.from({length: 35}, (_, i) => {
      const d = new Date(Date.parse("2026-07-28T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
      return {day: d, models: [m("claude-sonnet-5", 1000 + i, 100, 0, 0, 1)]};
    });
    const out3 = renderSummary({days: wide, windowLabel: "全量", harnessLabel: "claude-code"});
    expect(out3).toContain("最近 30 天");
    const trendLine = out3.split("\n").find((l) => l.includes("最近 30 天"))!;
    const spark = trendLine.match(/[▁▂▃▄▅▆▇█]+/g)![0]!;
    expect(spark).toHaveLength(30); // 恰 30 格 — 子串匹配会漏抓 "忘裁剪" 的坏法
    expect(out3).toContain("(35 天)"); // 头行日历跨度仍是全窗口
  });

  it("模型超 MODEL_ROWS: 表截断并注明从略数", () => {
    const many: ProfileDayV2[] = [{
      day: "2026-09-20",
      models: Array.from({length: 9}, (_, i) => m(`model-${i}`, 1000 - i, 0, 0, 0, 1)),
    }];
    const out4 = renderSummary({days: many, windowLabel: "全量", harnessLabel: "opencode"});
    expect(out4).toContain("…另 1 个模型从略");
    expect(out4).toContain("model-0");
    expect(out4).not.toContain("model-8"); // 第 9 个不进表
  });

  it("全零 token 窗口: 占比守卫不炸, bar 全空位", () => {
    const zero: ProfileDayV2[] = [{day: "2026-09-20", models: [m("claude-sonnet-5", 0, 0, 0, 0, 1)]}];
    const out5 = renderSummary({days: zero, windowLabel: "全量", harnessLabel: "claude-code"});
    expect(out5).toContain("0%");
    expect(out5).toContain("░".repeat(16));
  });
});
