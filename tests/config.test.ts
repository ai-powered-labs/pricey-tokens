// config.test.ts — 配置目录与套餐声明读取测试
// 覆盖: configHome 的 XDG 优先语义 (绝对路径优先 / 相对或未设置回落 ~/.config);
// readDeclaredPlan 在 XDG_CONFIG_HOME 注入临时目录下的全容错四态 (存在且合法 /
// 不存在 / 非法 JSON / plan 空串·非字符串·缺字段) — 异常形态一律静默视为未声明
// (null), 不抛错不警告 (声明是可选增强, 不能阻塞采集主流程)。
import {describe, expect, it} from "bun:test";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {configHome, readDeclaredPlan} from "../src/config.js";

// XDG_CONFIG_HOME 注入 /tmp 临时目录 (configHome 的 SSOT 环境变量; 用后必恢复)
async function withXdg(fn: (xdg: string) => Promise<void>): Promise<void> {
  const prev = process.env.XDG_CONFIG_HOME;
  const xdg = await mkdtemp(join(tmpdir(), "pt-cfg-"));
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    await fn(xdg);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    await rm(xdg, {recursive: true, force: true});
  }
}

// 在注入的 XDG 根下写 pricey-tokens/config.json
async function writeConfig(xdg: string, content: string): Promise<void> {
  await mkdir(join(xdg, "pricey-tokens"), {recursive: true});
  await writeFile(join(xdg, "pricey-tokens", "config.json"), content);
}

describe("configHome (XDG 优先语义)", () => {
  it("XDG_CONFIG_HOME 设置且绝对 → 优先; 未含 pricey-tokens 段由 configHome 补上", async () => {
    await withXdg(async (xdg) => {
      expect(configHome("/home/u")).toBe(join(xdg, "pricey-tokens"));
    });
  });

  it("XDG_CONFIG_HOME 未设置 → ~/.config/pricey-tokens", async () => {
    await withXdg(async () => {
      delete process.env.XDG_CONFIG_HOME;
      expect(configHome("/home/u")).toBe("/home/u/.config/pricey-tokens");
    });
  });

  it("XDG_CONFIG_HOME 相对路径 → 视同未设置 (宁回落不误写)", async () => {
    await withXdg(async () => {
      process.env.XDG_CONFIG_HOME = "relative/cfg";
      expect(configHome("/home/u")).toBe("/home/u/.config/pricey-tokens");
    });
  });
});

describe("readDeclaredPlan (XDG 注入, 全容错四态)", () => {
  it("存在且合法 → 返回 trim 后的 plan id", async () => {
    await withXdg(async (xdg) => {
      await writeConfig(xdg, JSON.stringify({plan: "  max-plan  "}));
      expect(await readDeclaredPlan("/home/u")).toBe("max-plan"); // home 被 XDG 覆盖
    });
  });

  it("文件不存在 → null (不报错)", async () => {
    await withXdg(async () => {
      expect(await readDeclaredPlan()).toBeNull();
    });
  });

  it("非法 JSON → null (静默容错)", async () => {
    await withXdg(async (xdg) => {
      await writeConfig(xdg, "{not json");
      expect(await readDeclaredPlan()).toBeNull();
    });
  });

  it("plan 空串 / 纯空白 / 非字符串 / 缺字段 → null", async () => {
    await withXdg(async (xdg) => {
      for (const bad of ['{"plan": ""}', '{"plan": "   "}', '{"plan": 42}', "{}"]) {
        await writeConfig(xdg, bad);
        expect(await readDeclaredPlan()).toBeNull();
      }
    });
  });
});
