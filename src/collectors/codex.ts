// collectors/codex.ts — codex 用量收集 (~/.codex/sessions/**/rollout-*.jsonl)
// 职责边界: 移植自站点 src/parsers/codex.ts (口径 SSOT 在站点侧, 此处是 CLI 公开
// 归宿), I/O 从浏览器 File 换为路径读取 (整文件缓冲, 与站点解析器同姿态); 解析语义逐字保持:
//   - 每 session 文件取**最后一条** token_count 事件的 info.total_token_usage 会话
//     累计值 (事件值单调递增, 逐事件求和必然重复计数 — 核心不变量, 回归测试固化);
//   - total_token_usage 缺失时回退 last_token_usage 差分累加;
//   - model 取 turn_context 事件最后出现的值 (短会话可能连 turn_context 都没有 → "unknown");
//   - 无 token_count 的文件 (旧格式 / 过短会话) 整文件进 skippedFiles 附原因;
//   - cached_input_tokens → cacheRead (codex 无 cache 写入概念, cacheWrite 恒 0)。
// 窗口过滤 (sinceMs): 按会话记录 ts (= 最后 token_count 时刻) 过滤 — 会话粒度天然
// 整体进出窗口 (无会话内拆分语义)。
import {readFile} from "node:fs/promises";
import type {ParseResult, UsageRecord} from "../types.js";
import {errMsg, isObj, posNum} from "../guards.js";

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

const addUsage = (a: TokenUsage | null, b: TokenUsage): TokenUsage =>
  a ? {input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output} : b;

// 单文件解析 → 会话级 UsageRecord | null (附跳过原因)
async function collectFile(path: string): Promise<{rec: UsageRecord; skipped: null} | {rec: null; skipped: string}> {
  const displayName = path.replace(/^.*\.codex\/sessions\//, ""); // 相对 sessions 的短名
  const text = await readFile(path, "utf8");
  let lastTotal: TokenUsage | null = null; // total_token_usage: 会话累计值, 只留末值
  let sumLast: TokenUsage | null = null; // last_token_usage: 单事件增量, 累加 (回退路径)
  let model = ""; // turn_context 最后出现的模型
  let ts = 0; // 最后一条 token_count 事件时刻 (累计值的测量点)
  let sawWrapper = false; // 是否见过新格式 wrapper 行 (旧格式行也有顶层裸 type, 须按三件套判别)
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 坏行静默跳过 (事件流非计费面, 单行损坏不影响累计值语义)
    }
    if (!isObj(o) || typeof o.type !== "string") continue;
    if (typeof o.timestamp === "string" && isObj(o.payload)) sawWrapper = true;
    if (o.type === "turn_context") {
      const p = o.payload;
      if (isObj(p) && typeof p.model === "string" && p.model !== "") model = p.model;
    } else if (o.type === "event_msg") {
      const p = o.payload;
      if (!isObj(p) || p.type !== "token_count") continue;
      const info = isObj(p.info) ? p.info : null;
      if (!info) continue;
      const total = normUsage(info.total_token_usage);
      if (total) lastTotal = total; // 累计值: 后者覆盖前者 (严禁求和)
      const last = normUsage(info.last_token_usage);
      if (last) sumLast = addUsage(sumLast, last);
      if (typeof o.timestamp === "string") {
        const t = Date.parse(o.timestamp);
        if (Number.isFinite(t)) ts = t;
      }
    }
  }
  const usage = lastTotal ?? sumLast;
  if (!usage) {
    return {rec: null, skipped: `${displayName} (${sawWrapper ? "会话无 token_count 事件" : "旧格式无 token 数据"})`};
  }
  return {
    rec: {
      model: model !== "" ? model : "unknown",
      ts,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cached,
      cacheWriteTokens: 0,
    },
    skipped: null,
  };
}

export async function collectCodex(paths: string[], sinceMs: number | null): Promise<ParseResult> {
  const records: UsageRecord[] = [];
  const skippedFiles: string[] = [];
  for (const path of paths) {
    try {
      const {rec, skipped} = await collectFile(path);
      if (skipped !== null) {
        skippedFiles.push(skipped);
        continue;
      }
      if (sinceMs !== null && rec.ts < sinceMs) continue; // 会话整体出窗 → 静默不计
      records.push(rec);
    } catch (e) {
      skippedFiles.push(`${path} (${errMsg(e)})`);
    }
  }
  return {agent: "codex", records, skippedFiles};
}
