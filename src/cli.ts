#!/usr/bin/env node
// cli.ts — pricey-tokens CLI 入口与三种出口模式的编排
// 职责边界: 参数解析 (args) → 探测收集 (discover) → 聚合 (aggregate) → 按模式出口:
//   - 默认: 构造站点分享 hash → 打开浏览器 (CLI 的核心体验: 一条命令看到换算结果)
//   - --json: ProfileV1 JSON 到 stdout (纯净输出, 诊断走 stderr)
//   - --upload: 完整预览 payload → 确认 → POST → (--share 打印分享 URL)
// stdout 纪律: --json 模式下 stdout 只有 JSON; 人类可读摘要/警告一律 stderr 或
// 非 json 模式的 stdout。退出码: 0 成功 / 1 可预期失败 (无数据/参数错/上传失败)。
import {parseArgs, ArgsError, HELP_TEXT} from "./args.js";
import {collectAll} from "./discover.js";
import {aggregate} from "./aggregate.js";
import {encodeShare, sharePayloadOf, buildShareUrl, HASH_WARN_BYTES} from "./share.js";
import {previewText, confirmUpload, uploadProfile} from "./upload.js";
import {loadOrCreateDeviceKey} from "./device-key.js";
import {openUrl} from "./browser.js";
import {createRequire} from "node:module";
import {errMsg} from "./guards.js";

const require = createRequire(import.meta.url);
const VERSION: string = (require("../package.json") as {version: string}).version;

function out(msg: string): void {
  process.stdout.write(msg + "\n");
}
function err(msg: string): void {
  process.stderr.write(msg + "\n");
}

async function main(): Promise<number> {
  // help/version 前置短路 (先于 parseArgs — 任何参数组合下 --help 都须能显示,
  // 走 parseArgs 的未知参数分支会以 exit 1 拒绝)
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    out(HELP_TEXT);
    return 0;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    out(VERSION);
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ArgsError) {
      err(`参数错误: ${e.message}`);
      return 1;
    }
    throw e;
  }

  const sinceMs = opts.days === "all" ? null : Date.now() - opts.days * 86400000;
  const {results, statuses} = await collectAll({harnesses: opts.harnesses, sinceMs});

  // 探测报告 (stderr — 保持 --json 的 stdout 纯净)
  for (const s of statuses) {
    err(`[${s.harness}] ${s.found ? "✓" : "✗ 未发现"} ${s.detail}`);
  }
  const skipped = results.flatMap((r) => r.skippedFiles);
  for (const s of skipped) err(`[skip] ${s}`);
  const noData = results.every((r) => r.records.length === 0);
  if (noData) {
    err(`\n窗口内 (${opts.days === "all" ? "全量" : `${opts.days} 天`}) 未收集到任何用量记录。`);
    err("若你确实在用这些工具, 检查数据目录权限或提 issue: https://github.com/ai-powered-labs/pricey-tokens");
    return 1;
  }

  const agg = aggregate(results, VERSION);
  if (agg === null) {
    err("聚合失败: 无有效记录");
    return 1;
  }
  const {profile, span} = agg;
  err(`\n聚合: ${profile.models.length} 个模型, 跨度 ${profile.spanDays} 天 (${new Date(span.firstTs).toISOString().slice(0, 10)} ~ ${new Date(span.lastTs).toISOString().slice(0, 10)}), harness=${profile.harness}`);

  let exit = 0;

  if (opts.json) {
    out(JSON.stringify(profile, null, 2));
  }

  if (opts.upload) {
    err("\n=== 将上传的完整内容 (ProfileV1, 仅模型串 + 四分类月速率 + 跨度, 无会话内容) ===\n");
    err(previewText(profile));
    err("\n=== 预览结束 ===\n");
    if (!(await confirmUpload(opts.yes))) {
      err("已取消上传。");
      return 1;
    }
    const key = await loadOrCreateDeviceKey();
    try {
      const r = await uploadProfile(opts.api, profile, key);
      err(`\n上传成功: profileId=${r.profileId}`);
      if (opts.share) {
        out(`${opts.api}${r.shareUrl}`);
      }
    } catch (e) {
      err(`上传失败: ${e instanceof Error ? e.message : String(e)}`);
      exit = 1;
    }
  }

  // 默认出口 (无 --json 无 --upload): 分享 hash + 打开浏览器
  // (--json/--upload 模式下不重复打开 — 详见 README 各模式说明)
  if (!opts.json && !opts.upload) {
    const hash = encodeShare(sharePayloadOf(agg.daily));
    const url = buildShareUrl(opts.site, hash);
    if (hash.length > HASH_WARN_BYTES) {
      err(`\n警告: 分享 hash ${hash.length} 字节 (> ${HASH_WARN_BYTES}), URL 过长可能被浏览器/终端截断。`);
      err("建议用 --days 7 缩小窗口后再生成分享链接。");
    }
    out(url);
    err("\n正在浏览器打开换算结果… (未自动打开时手动访问上方 URL)");
    openUrl(url);
  }
  return exit;
}

main().then(
  (code) => {
    // exitCode 而非 process.exit: 事件循环自然排空挂起的 stdout 写入后退出
    // (大 hash URL ≥90KB 走管道时, process.exit 会截断未 flush 的输出)
    process.exitCode = code;
  },
  (e) => {
    err(`意外错误: ${e instanceof Error ? (e.stack ?? e.message) : errMsg(e)}`);
    process.exitCode = 1;
  },
);
