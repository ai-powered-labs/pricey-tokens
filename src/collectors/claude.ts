// collectors/claude.ts — claude-code 请求收集 (~/.claude/projects/**/*.jsonl)
// 职责边界: jsonl → RequestRow[] (request 粒度账本行)。解析语义移植自站点侧解析器
// (口径 SSOT 在站点侧, 此处是 CLI 公开归宿), 并按账本口径补成功过滤:
//   - 逐行解析 type==="assistant" 记录的 message.model + message.usage 四件套;
//   - 同 messageId (流式 chunk 重复携带累计 usage) 取最后一条 (去重末值);
//   - isSidechain 子代理消耗照常计入 (子代理是真实消耗);
//   - **成功过滤** (用户裁决 2026-09-22): 剔除 isApiErrorMessage === true 的行 —
//     计费了但中途失败的流被排除 ⇒ 额度消耗略低估, 有意 (README 注明);
//   - 四分类全零的行不构成用量, 不入账本 (账本行恒为用量承载行);
//   - 坏行 (非 JSON / 缺 model / 缺 usage / 缺时间戳) 静默跳过 (计数语义在
//     discover/ingest 侧的 skippedFiles);
//   - 第三方 Anthropic 兼容端点 usage 可能只回 input/output 两项, 缺项按 0 容错。
// 归并键: reqKey = "<sessKey>:<messageId>" (sessKey 隔离跨会话的同名 id; 无
// message.id 的行以行号独立计); sessKey = 行内 sessionId 字段, 缺省回退文件名stem。
import {readFile} from "node:fs/promises";
import {basename} from "node:path";
import type {RequestRow} from "../types.js";
import {isObj, posNum} from "../guards.js";

// 单文件收集: 读文件 → 请求行 (messageId 去重末值); 读取失败抛错由编排层兜为
// skipped; 无有效行返回空 rows (claude 无 "整文件无 token" 语义, 不设 skipped 态)
export async function collectClaudeRequests(path: string): Promise<{rows: RequestRow[]; skipped: null}> {
  const text = await readFile(path, "utf8");
  const fileSess = basename(path).replace(/\.jsonl$/, ""); // 文件名即会话 id (回退用)
  // reqKey → 末值: 流式 chunk 累计 usage 末行即全量 (ccusage 成熟做法)
  const byKey = new Map<string, RequestRow>();
  let lineno = 0;
  for (const rawLine of text.split("\n")) {
    lineno++;
    const line = rawLine.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 坏行跳过 (计数语义在编排层)
    }
    if (!isObj(o) || o.type !== "assistant") continue; // user/system/progress 等非计费面
    if (o.isApiErrorMessage === true) continue; // 成功过滤 (API 错误行非成功请求)
    const msg = isObj(o.message) ? o.message : null;
    const usage = msg && isObj(msg.usage) ? msg.usage : null;
    const model = msg && typeof msg.model === "string" ? msg.model : "";
    if (!usage || !model) continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
    if (!Number.isFinite(ts)) continue;
    const sessKey = typeof o.sessionId === "string" && o.sessionId !== "" ? o.sessionId : fileSess;
    // 无 message.id 的行按行号独立计 (无归并键, 不与真实 messageId 冲突)
    const msgId = msg && typeof msg.id === "string" && msg.id !== "" ? msg.id : `@line:${lineno}`;
    const inT = posNum(usage.input_tokens);
    const outT = posNum(usage.output_tokens);
    const crT = posNum(usage.cache_read_input_tokens);
    const cwT = posNum(usage.cache_creation_input_tokens);
    if (inT === 0 && outT === 0 && crT === 0 && cwT === 0) continue; // 全零非用量行
    byKey.set(`${sessKey}:${msgId}`, {harness: "claude-code", reqKey: `${sessKey}:${msgId}`, sessKey, model, ts, inT, outT, crT, cwT});
  }
  return {rows: [...byKey.values()], skipped: null};
}
