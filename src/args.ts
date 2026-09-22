// args.ts — CLI 参数手写解析 (零依赖, 勿引 yargs)
// 职责边界: argv → Options, 集中完成全部默认值/校验/归一化 — 下游拿到的恒为合法值
// (核心逻辑免参数检查)。解析失败/未知参数抛 ArgsError (调用方转 stderr + exit 1)。
// 形态支持: --flag / --opt value / --opt=value; --days all 或数字; --harness 可重复
// 出现且值支持逗号分隔。
import type {HarnessId, Options} from "./types.js";
import {ALL_HARNESSES} from "./types.js";

export class ArgsError extends Error {}

export const DEFAULT_API = "https://pricey-tokens.lambda.lc";
export const DEFAULT_SITE = "https://pricey-tokens.lambda.lc/calc/";

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, ""); // 去尾斜杠 (拼接 /api/... 时统一)
}

// --k=v 归一化为 --k v 两个 token (首个 = 切分, 值可再含 =); 主循环每选项单分支
function normalizeEquals(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      out.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}

export function parseArgs(rawArgv: string[]): Options {
  const argv = normalizeEquals(rawArgv);
  const opts: Options = {
    json: false,
    upload: false,
    share: false,
    yes: false,
    verbose: false,
    web: false,
    days: 30,
    harnesses: [],
    api: DEFAULT_API,
    site: DEFAULT_SITE,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      if (i + 1 >= argv.length) throw new ArgsError(`${arg} 缺少参数值`);
      return argv[++i]!;
    };
    if (arg === "--json") opts.json = true;
    else if (arg === "--upload") opts.upload = true;
    else if (arg === "--share") opts.share = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--web") opts.web = true;
    else if (arg === "--days") parseDays(value());
    else if (arg === "--harness") parseHarnesses(value());
    else if (arg === "--api") opts.api = normalizeBase(value());
    else if (arg === "--site") opts.site = siteValue(value());
    else throw new ArgsError(`未知参数: ${arg} (用 --help 查看用法)`);
  }
  if (opts.share && !opts.upload) throw new ArgsError("--share 需与 --upload 同用 (分享 URL 由上传响应派生)");
  if (opts.web && (opts.json || opts.upload)) throw new ArgsError("--web 仅用于默认分享链接模式 (与 --json / --upload 互斥)");
  return opts;

  function parseDays(v: string): void {
    if (v === "all") {
      opts.days = "all";
      return;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new ArgsError(`--days 参数值非法: ${v} (应为正整数 1~3650 或 all)`);
    opts.days = n;
  }

  function parseHarnesses(v: string): void {
    for (const part of v.split(",")) {
      const a = part.trim();
      if (!ALL_HARNESSES.includes(a as HarnessId)) throw new ArgsError(`--harness 参数值非法: ${a} (应为 ${ALL_HARNESSES.join(" / ")} 的逗号分隔)`);
      if (!opts.harnesses.includes(a as HarnessId)) opts.harnesses.push(a as HarnessId);
    }
  }

  function siteValue(v: string): string {
    if (!/^https?:\/\//.test(v)) throw new ArgsError(`--site 参数值非法: ${v} (应为 http(s):// 开头的站点 base)`);
    return v;
  }
}

export const HELP_TEXT = `pricey-tokens — 本机 AI coding agent 用量收集器

用法: pricey-tokens [选项]

探测本机 opencode / claude-code / codex 数据源, 聚合为日粒度用量,
生成站点分享链接打印到终端 (换算你的用量值多少钱; 加 --web 才在浏览器打开)。

选项:
  --json             输出 ProfileV2 JSON (日粒度 + ctx 直方图) 到 stdout
  --upload           上传 ProfileV2 到社区档案 (上传前完整预览, 需确认)
  --share            上传后打印分享 URL (须与 --upload 同用)
  --yes              跳过上传交互确认 (非交互环境的显式授权)
  --verbose          打印过程详情 (探测/跳过/对账/账本增量 — 排查问题时用)
  --web              在系统浏览器打开分享链接 (默认只打印 URL; 与 --json / --upload 互斥)
  --days N|all       出口窗口天数 (默认 30; all = 全量; 摄取恒为全历史增量)
  --harness LIST       只收集指定源, 逗号分隔: opencode,claude-code,codex
  --api URL          上传 API base (默认 https://pricey-tokens.lambda.lc)
  --site URL         分享站点 base (默认 https://pricey-tokens.lambda.lc/calc/,
                     本地开发: http://localhost:PORT/calc/)
  --help             显示本帮助
  --version          显示版本

隐私: 只聚合每模型每日的 token 四分类计数、会话/请求计数与 ctx 直方图桶计数,
不读取任何会话内容; 用量账本只存本机 (~/.local/share/pricey-tokens/usage.db)。
详见 README "采集什么与不采集什么"。`;
