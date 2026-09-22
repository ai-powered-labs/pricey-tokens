// collectors/codex.ts — codex 请求收集 (~/.codex/sessions/**/rollout-*.jsonl)
// 职责边界: rollout jsonl → RequestRow[] (request 粒度) + TurnRow[] (用户轮次)。
// 事件语义移植自站点侧解析器 (口径 SSOT 在站点侧), 账本口径下从"会话累计末值"改为
// 逐事件 request 粒度:
//   - 每 token_count 事件 = 一次 API 请求: tokens 取 info.last_token_usage (该次
//     请求的增量); last 缺失时回退相邻 total_token_usage 差分 (total 是会话累计
//     计数器, 差分即该次增量; 首事件差分基线为 0);
//   - 差分为负 (计数器回退/重置) 视为数据异常, 该事件跳过且差分基线重同步;
//   - **成功过滤**: codex 的错误请求不产生 token_count 事件, "tokens 在场"即成功
//     判定本身; 四分类全零行不入账本;
//   - model 取该事件之前最后出现的 turn_context 值 (短会话可能连 turn_context
//     都没有 → "unknown");
//   - ts 取事件包装行的 timestamp; 无 timestamp 的事件沿用文件内最近可解析时刻
//     (事件流单调), 全程无可解析时刻的事件才跳过;
//   - 无 token_count 的文件 (旧格式 / 过短会话) 整文件进 skipped 附原因 (编排层)。
// n_tools (v2, 源格式 2026-09 经 codex-rs v0.94 源码验证): rollout 持久化策略不落
//   执行类 event_msg (exec_command_begin 等), 权威工具调用记录是 response_item 行
//   payload.type ∈ {function_call, custom_tool_call, local_shell_call,
//   web_search_call} (输出型 *_output 是结果不计)。归属: response 的 function_call
//   落盘先于其 token_count 事件 (流内 item 先到, 完成时才发 token_count), 故 pending
//   工具计数记到**下一个** token_count 请求行; 末尾未跟请求的 pending 丢弃。
// n_turns (v2): turn_context 事件计数 (每用户轮恰好一个, 持久化策略恒落盘)。
// 归并键: reqKey = "<rollout 文件名>#<文件内 token_count 事件序号 (1 起)>";
// turnKey = "<rollout 文件名>#tc<turn_context 序号 (1 起)>";
// sessKey = rollout 文件名 (文件即会话)。cached_input_tokens → cacheRead
// (codex 无 cache 写入概念, cacheWrite 恒 0)。
import {basename} from "node:path";
import {readFile} from "node:fs/promises";
import type {RequestRow, TurnRow} from "../types.js";
import {isObj, posNum} from "../guards.js";

interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

// {input_tokens, cached_input_tokens, output_tokens} 三件套; 字段缺失按 0, 对象缺失返回 null
function normUsage(v: unknown): TokenUsage | null {
  if (!isObj(v)) return null;
  const g = (k: string): number => posNum(v[k]);
  return {input: g("input_tokens"), cached: g("cached_input_tokens"), output: g("output_tokens")};
}

// 事件增量的三来源优先级: last 直给 > total 差分 > 无 (跳过)
function eventDelta(last: TokenUsage | null, total: TokenUsage | null, prevTotal: TokenUsage | null): TokenUsage | null {
  if (last) return last;
  if (!total) return null;
  const base = prevTotal ?? {input: 0, cached: 0, output: 0};
  const d = {input: total.input - base.input, cached: total.cached - base.cached, output: total.output - base.output};
  return d.input < 0 || d.cached < 0 || d.output < 0 ? null : d; // 负差分 = 计数器异常
}

// response_item 的工具调用 payload.type 词表 (codex-rs ResponseItem serde snake_case,
// 2026-09 v0.94 验证; 执行类 event_msg 不持久化, 见头注)
const TOOL_CALL_ITEM_TYPES: ReadonlySet<string> = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);

export interface CodexFileResult {
  rows: RequestRow[];
  turns: TurnRow[];
  skipped: string | null; // 无 token 数据的文件附原因 (含文件短名前缀)
}

// 单文件收集: 读文件 → 该会话全部请求行 + 轮次行, 或跳过原因 (读取失败由编排层兜为 skipped)
export async function collectCodexRequests(path: string): Promise<CodexFileResult> {
  const displayName = path.replace(/^.*\.codex\/sessions\//, ""); // 相对 sessions 的短名
  const text = await readFile(path, "utf8");
  const fileBase = basename(displayName).replace(/\.jsonl$/, "");
  let lastTotal: TokenUsage | null = null; // 最近一次 total_token_usage (差分基线)
  let model = ""; // turn_context 最后出现的模型 (运行值)
  let ts = 0; // 最近可解析的事件时刻 (运行值)
  let eventSeq = 0; // token_count 事件序号 (reqKey 组成)
  let turnSeq = 0; // turn_context 事件序号 (turnKey 组成)
  let pendingTools = 0; // 已见未归属的工具调用 (归下一个 token_count 请求)
  let sawAnyTokenEvent = false;
  const rows: RequestRow[] = [];
  const turns: TurnRow[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 坏行静默跳过 (事件流非计费面, 单行损坏不影响其他事件)
    }
    if (!isObj(o) || typeof o.type !== "string") continue;
    if (o.type === "turn_context") {
      const p = o.payload;
      if (isObj(p) && typeof p.model === "string" && p.model !== "") model = p.model;
      turnSeq += 1;
      turns.push({harness: "codex", turnKey: `${fileBase}#tc${turnSeq}`, sessKey: fileBase});
    } else if (o.type === "response_item") {
      const p = o.payload;
      if (isObj(p) && typeof p.type === "string" && TOOL_CALL_ITEM_TYPES.has(p.type)) pendingTools += 1;
    } else if (o.type === "event_msg") {
      const p = o.payload;
      if (!isObj(p) || p.type !== "token_count") continue;
      const info = isObj(p.info) ? p.info : null;
      if (!info) continue;
      if (typeof o.timestamp === "string") {
        const t = Date.parse(o.timestamp);
        if (Number.isFinite(t)) ts = t;
      }
      const total = normUsage(info.total_token_usage);
      const delta = eventDelta(normUsage(info.last_token_usage), total, lastTotal);
      if (total) lastTotal = total; // 差分基线前进 (无论本事件是否可计)
      eventSeq += 1;
      if (delta === null) continue; // 无增量信息 (非错误, 该事件不构成请求行; pending 留待下一事件)
      const nTools = pendingTools;
      pendingTools = 0;
      sawAnyTokenEvent = true;
      if (delta.input === 0 && delta.cached === 0 && delta.output === 0) continue; // 全零非用量
      if (ts <= 0) continue; // 无法归属时刻的请求无法归属日, 跳过
      rows.push({
        harness: "codex",
        reqKey: `${fileBase}#${eventSeq}`,
        sessKey: fileBase,
        model: model !== "" ? model : "unknown",
        ts,
        inT: delta.input,
        outT: delta.output,
        crT: delta.cached,
        cwT: 0,
        nTools,
      });
    }
  }
  if (!sawAnyTokenEvent) {
    return {rows, turns, skipped: `${displayName} (会话无可用 token_count 事件)`};
  }
  return {rows, turns, skipped: null};
}
