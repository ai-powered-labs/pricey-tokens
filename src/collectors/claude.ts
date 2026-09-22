// collectors/claude.ts — claude-code 用量收集 (~/.claude/projects/**/*.jsonl)
// 职责边界: 移植自 pricey-tokens-website 仓 site/src/parsers/claude.ts (口径 SSOT 在站点侧, 此处是 CLI 公开
// 归宿), I/O 从浏览器 File 换为路径读取 (整文件缓冲, 与站点解析器同姿态); 解析语义逐字保持:
//   - 逐行解析 type==="assistant" 记录的 message.model + message.usage 四件套;
//   - 同 messageId (流式 chunk 重复携带累计 usage) 取最后一条 (去重);
//   - isSidechain 子代理消耗照常计入 (子代理是真实消耗);
//   - 坏行 (非 JSON / 缺 model / 缺 usage / 缺时间戳) 跳过并计数告警;
//   - 第三方 Anthropic 兼容端点 usage 可能只回 input/output 两项, 缺项按 0 容错。
// 窗口过滤 (sinceMs): 去重完成后按记录 ts 过滤 (一条消息的 chunk 同 ts, 先去重
// 再过滤与先过滤再去重等价, 且不破坏 byId 末值语义)。
import {readFile} from "node:fs/promises";
import type {ParseResult, UsageRecord} from "../types.js";
import {errMsg, isObj, posNum} from "../guards.js";

// 单文件解析: 文本 → UsageRecord[] (messageId 去重末值); 抛错仅限读取失败 (ENOENT 等)
async function collectFile(path: string): Promise<UsageRecord[]> {
  const text = await readFile(path, "utf8");
  // messageId → 末值: 流式 chunk 累计 usage 末行即全量 (ccusage 成熟做法)
  const byId = new Map<string, UsageRecord>();
  let lineno = 0;
  for (const rawLine of text.split("\n")) {
    lineno++;
    const line = rawLine.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 坏行跳过 (计数语义见 collectClaude 的 skippedFiles 注)
    }
    if (!isObj(o) || o.type !== "assistant") continue; // user/system/progress 等非计费面
    const msg = isObj(o.message) ? o.message : null;
    const usage = msg && isObj(msg.usage) ? msg.usage : null;
    const model = msg && typeof msg.model === "string" ? msg.model : "";
    if (!usage || !model) continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    // 无 message.id 的行按行号独立计 (无归并键, 不与真实 messageId 冲突)
    const key = msg && typeof msg.id === "string" && msg.id !== "" ? msg.id : `@line:${lineno}`;
    byId.set(key, {
      model,
      ts,
      inputTokens: posNum(usage.input_tokens),
      outputTokens: posNum(usage.output_tokens),
      cacheReadTokens: posNum(usage.cache_read_input_tokens),
      cacheWriteTokens: posNum(usage.cache_creation_input_tokens),
    });
  }
  if (byId.size === 0) {
    throw new Error("无 assistant 记录"); // 调用方以 displayName 前缀挂 skippedFiles
  }
  return [...byId.values()];
}

export async function collectClaude(paths: string[], sinceMs: number | null): Promise<ParseResult> {
  const records: UsageRecord[] = [];
  const skippedFiles: string[] = [];
  for (const path of paths) {
    const displayName = path.replace(/^.*\.claude\/projects\//, ""); // 相对 projects 的短名
    try {
      for (const r of await collectFile(path)) {
        if (sinceMs !== null && r.ts < sinceMs) continue;
        records.push(r);
      }
    } catch (e) {
      skippedFiles.push(`${displayName} (${errMsg(e)})`);
    }
  }
  return {harness: "claude-code", records, skippedFiles};
}
