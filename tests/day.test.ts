// day.test.ts — 本地日键与日界换算测试 (day_stats 日归属 SSOT 的回归锚)
// 覆盖: localDayKey 本地日字符串、dayStartTs/dayEndTs 日界一致性与跨午夜归属、
// 非法日键报错。
import {describe, expect, it} from "bun:test";
import {dayEndTs, dayStartTs, localDayKey} from "../src/day.js";

const T = new Date(2026, 8, 22, 10, 30).getTime(); // 2026-09-22 10:30 本地

describe("day.ts 日界换算", () => {
  it("localDayKey: 本地日字符串", () => {
    expect(localDayKey(T)).toBe("2026-09-22");
  });
  it("dayStartTs/dayEndTs: 本地日 [起, 止) 且跨午夜一致", () => {
    expect(dayStartTs("2026-09-22")).toBe(new Date(2026, 8, 22).getTime());
    expect(dayEndTs("2026-09-22")).toBe(new Date(2026, 8, 23).getTime());
    expect(dayEndTs("2026-09-22")).toBe(dayStartTs("2026-09-23"));
    // 全天任意时刻归属同一日键
    for (const h of [0, 12, 23]) {
      expect(localDayKey(new Date(2026, 8, 22, h, 59).getTime())).toBe("2026-09-22");
    }
  });
  it("非法日键报错 (仅格式校验)", () => {
    expect(() => dayStartTs("20260922")).toThrow();
    expect(() => dayEndTs("not-a-day")).toThrow();
  });
});
