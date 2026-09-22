// collectors/claude.ts — claude-code 请求收集 (~/.claude/projects/**/*.jsonl)
// 职责边界: jsonl → RequestRow[] (request 粒度账本行) + TurnRow[] (用户轮次)。解析
// 语义移植自站点侧解析器 (口径 SSOT 在站点侧, 此处是 CLI 公开归宿), 并按账本口径
// 补成功过滤与两个 v2 计数:
//   - 逐行解析 type==="assistant" 记录的 message.model + message.usage 四件套;
//   - 同 messageId (流式 chunk 重复携带累计 usage) 取最后一条 (去重末值);
//   - isSidechain 子代理消耗照常计入 (子代理是真实消耗);
//   - **成功过滤** (用户裁决 2026-09-22): 剔除 isApiErrorMessage === true 的行 —
//     计费了但中途失败的流被排除 ⇒ 额度消耗略低估, 有意 (README 注明);
//   - 四分类全零的行不构成用量, 不入账本 (账本行恒为用量承载行);
//   - 坏行 (非 JSON / 缺 model / 缺 usage / 缺时间戳) 静默跳过 (计数语义在
//     discover/ingest 侧的 skippedFiles);
//   - 第三方 Anthropic 兼容端点 usage 可能只回 input/output 两项, 缺项按 0 容错。
// n_tools (v2): 该 assistant 消息 content 数组中 type=="tool_use" 块计数 — 流式
//   chunk 的 tool_use 块只在末值行完整 (2026-09 本机实测: 同 messageId 首行 0 块/
//   末行 N 块), 与 usage 末值同源取末行; content 为字符串 (纯文本消息) 计 0。
// n_turns (v2): 真实用户轮次 — 设计 §5 机制字面是 "claude=user 行", 但实测 user 行
//   91% 是 tool_result 回传 (838/920)、54% 是 sidechain 子代理提示, 字面计数会让
//   n_turns≈n_tools 失去 "用户轮次" 语义, 故取设计意图: 剔除 isSidechain /
//   isMeta / 纯 tool_result content 的 user 行 (2026-09 本机实测真用户轮次 42/920)。
// 归并键: reqKey = "<sessKey>:<messageId>" (sessKey 隔离跨会话的同名 id; 无
// message.id 的行以行号独立计); sessKey = 行内 sessionId 字段, 缺省回退文件名stem。
// turnKey = "<sessKey>:<uuid>" (无 uuid 回退行号)。
import {readFile} from "node:fs/promises";
import {basename} from "node:path";
import type {RequestRow, TurnRow} from "../types.js";
import {isObj, posNum} from "../guards.js";

// content 数组 → tool_use 块计数 (content 缺失/字符串/块畸形均 0)
function countToolUse(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isObj(b) && b.type === "tool_use") n += 1;
  }
  return n;
}

// user 行 → 是否真实用户轮次 (剔除 sidechain 子代理 / isMeta 系统注入 / 纯 tool_result 回传)
function isRealUserTurn(o: Record<string, unknown>): boolean {
  if (o.isSidechain === true || o.isMeta === true) return false;
  const msg = isObj(o.message) ? o.message : null;
  const content = msg ? msg.content : undefined;
  if (!Array.isArray(content)) return true; // 字符串 content (用户输入文本) 或畸形
  return content.some((b) => !isObj(b) || b.type !== "tool_result"); // 含非 tool_result 块
}

// 单文件收集: 读文件 → 请求行 (messageId 去重末值) + 轮次行; 读取失败抛错由编排层
// 兜为 skipped; 无有效行返回空集 (claude 无 "整文件无 token" 语义, 不设 skipped 态)
export async function collectClaudeRequests(path: string): Promise<{rows: RequestRow[]; turns: TurnRow[]; skipped: null}> {
  const text = await readFile(path, "utf8");
  const fileSess = basename(path).replace(/\.jsonl$/, ""); // 文件名即会话 id (回退用)
  // reqKey → 末值: 流式 chunk 累计 usage 末行即全量 (ccusage 成熟做法)
  const byKey = new Map<string, RequestRow>();
  const turns: TurnRow[] = [];
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
    if (!isObj(o)) continue;
    if (o.type === "user") {
      if (!isRealUserTurn(o)) continue;
      const sessKey = typeof o.sessionId === "string" && o.sessionId !== "" ? o.sessionId : fileSess;
      const uuid = typeof o.uuid === "string" && o.uuid !== "" ? o.uuid : `@line:${lineno}`;
      turns.push({harness: "claude-code", turnKey: `${sessKey}:${uuid}`, sessKey});
      continue;
    }
    if (o.type !== "assistant") continue; // system/progress 等非计费面
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
    byKey.set(`${sessKey}:${msgId}`, {
      harness: "claude-code",
      reqKey: `${sessKey}:${msgId}`,
      sessKey,
      model,
      ts,
      inT,
      outT,
      crT,
      cwT,
      nTools: msg ? countToolUse(msg.content) : 0,
    });
  }
  return {rows: [...byKey.values()], turns, skipped: null};
}
