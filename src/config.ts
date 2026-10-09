// config.ts — 用户配置目录解析与可选配置文件读取
// 职责边界: ① configHome: 返回 pricey-tokens 配置目录 ~/.config/pricey-tokens
// (XDG_CONFIG_HOME 优先且须绝对路径 — 与 device-key 同根, 唯一解析点);
// ② readDeclaredPlan: 读 config.json 的 plan 字段 ("声明你在用的套餐" 的持久
// 来源, --plan flag 是它的高优先级覆盖)。读取全容错: 文件不存在 / 非法 JSON /
// 无 plan 字段 / plan 非字符串 / trim 后空 → 一律视为未声明 (null), 不报错不
// 警告 — 声明是可选增强, 不能因它阻塞采集主流程。套餐清单不内置本包 (避免与
// 站点双端漂移): planId 的 SSOT 是站点套餐清单 (详情页 URL /plan/<id>/ 即 id,
// 清单入口是首页套餐排行), 打错字由服务端
// 上传校验返回 400 可读错误。不提供写 config 的子命令 (用户手写, README 教学)。
import {readFile} from "node:fs/promises";
import {join} from "node:path";

// XDG_CONFIG_HOME 优先且须绝对路径 (相对值视同未设置); 返回值已含 pricey-tokens 段
export function configHome(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.startsWith("/") ? xdg : join(home, ".config");
  return join(root, "pricey-tokens");
}

// 已声明的套餐 id; 未声明 (含一切异常形态) 返回 null。home 注入供测试。
export async function readDeclaredPlan(home?: string): Promise<string | null> {
  const h = home ?? (await import("node:os")).homedir();
  const file = join(configHome(h), "config.json");
  try {
    const plan = (JSON.parse(await readFile(file, "utf8")) as {plan?: unknown}).plan;
    if (typeof plan !== "string") return null;
    const trimmed = plan.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null; // 不存在/不可读/非法 JSON → 未声明
  }
}
