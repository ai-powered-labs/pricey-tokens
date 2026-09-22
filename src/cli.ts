#!/usr/bin/env node
// cli.ts — pricey-tokens CLI 入口与三种出口模式的编排
// 职责边界: 参数解析 (args) → 增量摄取 (ingest → ledger, 全历史水位线增量, 与窗口
// 无关) → 账本窗口查询 → 按模式出口:
//   - 默认: stderr 用量摘要 (report.renderSummary, 总览/模型分布/每日趋势) →
//     日粒度记录 → 站点分享 hash → stdout URL (浏览器仅 --web 时调起 — CLI
//     默认不动用户桌面; #u= 比特兼容契约不变)
//   - --json: ProfileV2 JSON 到 stdout (day 粒度 + ctx 直方图)
//   - --upload: 完整预览 payload (ProfileV2) → 确认 → POST → (--share 打印分享 URL)
// 过程详情 (探测/跳过/对账/账本增量) 默认隐藏 — 压缩为单行计数提示 (异常可见不
// 刷屏), --verbose 展开。stdout 纪律: --json 模式下 stdout 只有 JSON; 默认模式
// stdout 只有分享 URL (摘要走 stderr, 保护 `| pbcopy` 类管道)。退出码: 0 成功 /
// 1 可预期失败 (无数据/参数错/上传失败)。
import {parseArgs, ArgsError, HELP_TEXT} from "./args.js";
import {ingestAll} from "./ingest.js";
import {Ledger} from "./ledger.js";
import {localDayKey} from "./day.js";
import {encodeShare, sharePayloadOf, buildShareUrl, HASH_WARN_BYTES} from "./share.js";
import {previewText, confirmUpload, uploadProfile} from "./upload.js";
import {loadOrCreateDeviceKey} from "./device-key.js";
import {openUrl} from "./browser.js";
import {dataHome} from "./discover.js";
import {renderSummary} from "./report.js";
import {createRequire} from "node:module";
import {errMsg} from "./guards.js";
import type {ProfileV2} from "./types.js";

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

  // ① 增量摄取: 账本 = 唯一数据源, 摄取与窗口无关 (首跑全量分钟级, 之后秒级)
  const home = (await import("node:os")).homedir();
  const dataRoot = dataHome(home); // opencode 源与账本共用此根
  // ② 窗口参数 (摄取前定死 — 查询与出口共用)
  const sinceMs = opts.days === "all" ? null : Date.now() - opts.days * 86400000;
  const sinceDay = sinceMs === null ? null : localDayKey(sinceMs);
  let daily: ReturnType<Ledger["dailyRecords"]>;
  let days: ReturnType<Ledger["profileDays"]>;
  let harness = "mixed";
  let report;
  {
    let ledger: Ledger;
    try {
      ledger = await Ledger.open(dataRoot);
    } catch (e) {
      err(`账本打开失败: ${errMsg(e)}`);
      return 1;
    }
    try {
      report = await ingestAll(ledger, {harnesses: opts.harnesses, home, dataRoot});
      daily = ledger.dailyRecords(sinceMs, opts.harnesses);
      days = ledger.profileDays(sinceDay, opts.harnesses);
      const harnessSet = ledger.distinctHarnesses(sinceDay, opts.harnesses);
      if (harnessSet.length === 1) harness = harnessSet[0]!;
    } finally {
      ledger.close(); // 摄取+查询完毕即关库; 出口 (上传/浏览器) 不再需要账本
    }
  }

  // 探测报告 (stderr — 保持 --json 的 stdout 纯净): 过程详情默认隐藏, --verbose
  // 展开; 默认仅在有跳过/告警时留一行计数提示 (异常可见但不刷屏)
  const verr = (msg: string): void => {
    if (opts.verbose) err(msg);
  };
  for (const s of report.statuses) {
    verr(`[${s.harness}] ${s.found ? "✓" : "✗ 未发现"} ${s.detail}`);
  }
  for (const s of report.skipped) verr(`[skip] ${s}`);
  for (const w of report.warnings) verr(w);
  verr(`\n账本: ${report.total} 请求累计 (本次新增 +${report.inserted})`);
  const hiddenCount = report.skipped.length + report.warnings.length;
  if (!opts.verbose && hiddenCount > 0) {
    err(`提示: ${hiddenCount} 条过程信息 (跳过 ${report.skipped.length}, 告警 ${report.warnings.length}) 已隐藏, 加 --verbose 查看`);
  }

  if (days.length === 0) {
    // 空数据判定只用 day 对齐窗口 (ts 精确窗口是其子集 — 窗口首日 00:00 到
    // sinceMs 间的用量只可能出现在 days 而不在 daily, 杂交判定会误报空)
    err(`\n窗口内 (${opts.days === "all" ? "全量" : `${opts.days} 天`}) 未收集到任何用量记录。`);
    err("若你确实在用这些工具, 加 --verbose 查看各源探测详情; 仍有问题检查数据目录权限或提 issue: https://github.com/ai-powered-labs/pricey-tokens");
    return 1;
  }

  // 默认出口模式 (无 --json 无 --upload): stderr 用量摘要 → 分享 hash → stdout URL
  // (--web 时才调起浏览器); 摘要与出口两处共用此谓词, 新增出口模式时只改这一处
  const defaultMode = !opts.json && !opts.upload;
  if (defaultMode) {
    err("\n" + renderSummary({
      days,
      windowLabel: opts.days === "all" ? "全量" : `近 ${opts.days} 天`,
      harnessLabel: harness === "mixed" ? "多源混合" : harness,
    }));
  }

  let exit = 0;

  // ③ 出口: --json / --upload 共用的 ProfileV2 (生成处保证 ΣctxHist==nReq 不变量)
  const profile: ProfileV2 = {
    schema: "pricey-tokens-profile/v2",
    harness,
    days,
    planUsed: null,
    collectedAt: Date.now(),
    toolVersion: VERSION,
    trust: "anon", // 具服务端证明力的 github 档是 API B3 交付物, CLI 恒 anon
  };

  if (opts.json) {
    out(JSON.stringify(profile, null, 2));
  }

  if (opts.upload) {
    err("\n=== 将上传的完整内容 (ProfileV2, 日粒度模型四分类计数 + 会话/请求/轮次/工具调用计数 + ctx/输出规模/会话最深上下文直方图桶计数, 无会话内容) ===\n");
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
      err(`上传失败: ${errMsg(e)}`);
      exit = 1;
    }
  }

  // 默认出口收尾: 分享 hash → stdout URL。浏览器仅 --web 时调起 (CLI 不自动动
  // 用户桌面 — 终端点击/管道复制已是完整直达路径; --json/--upload 模式无 URL,
  // 详见 README 各模式说明)
  if (defaultMode) {
    if (daily.length === 0) {
      err("\n提示: 窗口内用量全部落在窗口首日 00:00 到窗口起点之间 — 分享链接将不携带任何记录。");
    }
    const hash = encodeShare(sharePayloadOf(daily));
    const url = buildShareUrl(opts.site, hash);
    if (hash.length > HASH_WARN_BYTES) {
      err(`\n警告: 分享 hash ${hash.length} 字节 (> ${HASH_WARN_BYTES}), URL 过长可能被浏览器/终端截断。`);
      err("建议用 --days 7 缩小窗口后再生成分享链接。");
    }
    out(url);
    if (opts.web) {
      err("\n正在浏览器打开换算结果… (未自动打开时手动访问上方 URL)");
      openUrl(url);
    } else {
      err("\n分享链接已在上方输出 (终端通常可点击打开; 加 --web 可让 CLI 调起浏览器)");
    }
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
