// args.test.ts — CLI 参数解析测试
// 覆盖: 布尔旗标、--days 数字/all/非法、--agent 逗号与重复、--api 尾斜杠归一、
// --site 校验、默认值、未知参数与 --share 前置条件。
import {describe, expect, it} from "bun:test";
import {parseArgs, ArgsError, DEFAULT_API, DEFAULT_SITE} from "../src/args.js";

describe("parseArgs 默认值", () => {
  it("空参数 → 全默认", () => {
    const o = parseArgs([]);
    expect(o).toEqual({
      json: false,
      upload: false,
      share: false,
      yes: false,
      days: 30,
      agents: [],
      api: DEFAULT_API,
      site: DEFAULT_SITE,
    });
    expect(DEFAULT_API).toBe("https://pricey-tokens.lambda.lc");
    expect(DEFAULT_SITE).toBe("https://pricey-tokens.lambda.lc/calc/");
  });
});

describe("parseArgs 旗标与带值参数", () => {
  it("--json --upload --share --yes 组合", () => {
    const o = parseArgs(["--json", "--upload", "--share", "--yes"]);
    expect(o.json && o.upload && o.share && o.yes).toBe(true);
  });

  it("--days 7 / --days=all / --days all", () => {
    expect(parseArgs(["--days", "7"]).days).toBe(7);
    expect(parseArgs(["--days=all"]).days).toBe("all");
    expect(parseArgs(["--days", "all"]).days).toBe("all");
  });

  it("--days 非法值报错 (0 / 负数 / 小数 / 串)", () => {
    for (const bad of [["--days", "0"], ["--days", "-1"], ["--days", "1.5"], ["--days", "week"]] as string[][]) {
      expect(() => parseArgs(bad)).toThrow(ArgsError);
    }
  });

  it("--days 缺值报错", () => {
    expect(() => parseArgs(["--days"])).toThrow(ArgsError);
  });

  it("--agent 逗号分隔 / 重复出现 / 去重", () => {
    expect(parseArgs(["--agent", "opencode,claude-code"]).agents).toEqual(["opencode", "claude-code"]);
    expect(parseArgs(["--agent", "opencode", "--agent", "codex"]).agents).toEqual(["opencode", "codex"]);
    expect(parseArgs(["--agent", "opencode", "--agent", "opencode"]).agents).toEqual(["opencode"]);
  });

  it("--agent 非法值报错", () => {
    expect(() => parseArgs(["--agent", "cursor"])).toThrow(ArgsError);
  });

  it("--api 尾斜杠归一; --api=X 形态", () => {
    expect(parseArgs(["--api", "http://localhost:18731/"]).api).toBe("http://localhost:18731");
    expect(parseArgs(["--api=http://x.y"]).api).toBe("http://x.y");
  });

  it("--site 保留路径; 非 http(s) 报错", () => {
    expect(parseArgs(["--site", "http://localhost:4321/calc/"]).site).toBe("http://localhost:4321/calc/");
    expect(() => parseArgs(["--site", "localhost:4321"])).toThrow(ArgsError);
  });
});

describe("parseArgs 错误形态", () => {
  it("未知参数报错", () => {
    expect(() => parseArgs(["--wat"])).toThrow("未知参数");
    expect(() => parseArgs(["positional"])).toThrow("未知参数");
  });

  it("--share 单独使用报错 (须与 --upload 同用)", () => {
    expect(() => parseArgs(["--share"])).toThrow("--share");
    expect(() => parseArgs(["--share", "--upload"])).not.toThrow();
  });
});
