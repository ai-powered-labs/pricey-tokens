// fixtures.ts — 测试合成数据构造器 (隐私红线: 仅合成数据, 严禁引入任何真实用户数据)
// 职责边界: 三家 harness 数据格式的最小闭环构造 (jsonl 行 / SQLite 库文件 / 临时目录),
// 形态移植自站点 tests/fixtures.ts (合成数值, 字段结构按 2026-09 实测)。
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";

export const DAY = 86400000;
// 合成基准时刻 (2026-05-08T02:30:49Z, 仅测试用 — 与站点 fixtures.T0 同值,
// golden vector 共用)
export const T0 = 1778224249123;
export const iso = (epochMs: number): string => new Date(epochMs).toISOString();

// --- 临时 home 目录 (每用例独立, afterAll 清理) ---

export interface TempHome {
  home: string;
  cleanup(): Promise<void>;
}

export async function makeHome(): Promise<TempHome> {
  const home = await mkdtemp(join(tmpdir(), "pricey-tokens-test-"));
  return {home, cleanup: () => rm(home, {recursive: true, force: true})};
}

export async function writeLines(path: string, lines: unknown[]): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

// --- claude-code 行构造 ---

let claudeSeq = 0;

export interface ClaudeOpts {
  model?: string;
  msgId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  ts?: number;
  sidechain?: boolean;
  sessionId?: string;
  isApiError?: boolean; // isApiErrorMessage 行 (成功过滤的剔除面)
  toolUses?: number; // message.content 中 tool_use 块数 (n_tools 提取面)
}

// assistant 记录; cache 字段缺省时不写键 (模拟第三方端点只回 input/output 的实测形态);
// toolUses > 0 时 content 为 [text 块, N × tool_use 块] 数组 (流式末值行的实测形态)
export function claudeAssistant(o: ClaudeOpts = {}): Record<string, unknown> {
  claudeSeq++;
  const usage: Record<string, number> = {input_tokens: o.input ?? 0, output_tokens: o.output ?? 0};
  if (o.cacheWrite !== undefined) usage.cache_creation_input_tokens = o.cacheWrite;
  if (o.cacheRead !== undefined) usage.cache_read_input_tokens = o.cacheRead;
  const n = o.toolUses ?? 0;
  const content = n > 0
    ? [{type: "text", text: "thinking..."}, ...Array.from({length: n}, (_, i) => ({type: "tool_use", id: `tu-${claudeSeq}-${i}`, name: "Bash", input: {cmd: "ls"}}))]
    : "ok";
  return {
    type: "assistant",
    isApiErrorMessage: o.isApiError ?? false ? true : undefined,
    isSidechain: o.sidechain ?? false,
    uuid: `u-${claudeSeq}`,
    sessionId: o.sessionId ?? "sess-1",
    timestamp: iso(o.ts ?? T0),
    message: {id: o.msgId ?? `msg-${claudeSeq}`, type: "message", role: "assistant", model: o.model ?? "claude-sonnet-5", usage, content},
  };
}

export interface ClaudeUserOpts {
  ts?: number;
  sessionId?: string;
  uuid?: string;
  sidechain?: boolean; // 子代理提示 (真实轮次剔除面)
  toolResult?: boolean; // content 为纯 tool_result 数组 (真实轮次剔除面)
  meta?: boolean; // isMeta 系统注入行 (真实轮次剔除面)
}

// user 记录 (轮次计数的判定面)
export function claudeUser(o: ClaudeUserOpts = {}): Record<string, unknown> {
  claudeSeq++;
  const content = o.toolResult
    ? [{type: "tool_result", tool_use_id: `tu-${claudeSeq}`, content: "output"}]
    : "hi";
  return {
    type: "user",
    isSidechain: o.sidechain ?? false,
    isMeta: o.meta ?? false ? true : undefined,
    uuid: o.uuid ?? `u-${claudeSeq}`,
    sessionId: o.sessionId ?? "sess-1",
    timestamp: iso(o.ts ?? T0),
    message: {role: "user", content},
  };
}

// --- codex 行构造 ({timestamp, type, payload} 新格式包装) ---

export interface CodexTokenOpts {
  ts?: number;
  total?: [input: number, cached: number, output: number] | null;
  last?: [input: number, cached: number, output: number] | null;
}

export function codexTokenLine(o: CodexTokenOpts): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  if (o.total) info.total_token_usage = {input_tokens: o.total[0], cached_input_tokens: o.total[1], output_tokens: o.total[2]};
  if (o.last) info.last_token_usage = {input_tokens: o.last[0], cached_input_tokens: o.last[1], output_tokens: o.last[2]};
  return {timestamp: iso(o.ts ?? T0), type: "event_msg", payload: {type: "token_count", info}};
}

export function codexTurnContext(model: string, ts = T0): Record<string, unknown> {
  return {timestamp: iso(ts), type: "turn_context", payload: {model, effort: "medium", approval_policy: "never"}};
}

// response_item 行 (工具调用记录, n_tools 提取面; type 词表经 codex-rs v0.94 验证)
export function codexToolItem(kind: "function_call" | "custom_tool_call" | "local_shell_call" | "web_search_call" = "function_call", ts = T0): Record<string, unknown> {
  return {timestamp: iso(ts), type: "response_item", payload: {type: kind, call_id: "c1", name: "shell"}};
}

// response_item 输出行 (工具结果 — 不计入 n_tools)
export function codexToolOutputItem(ts = T0): Record<string, unknown> {
  return {timestamp: iso(ts), type: "response_item", payload: {type: "function_call_output", call_id: "c1", output: {success: true}}};
}

// response_item 普通消息行 (非工具)
export function codexMessageItem(role: string, ts = T0): Record<string, unknown> {
  return {timestamp: iso(ts), type: "response_item", payload: {type: "message", role, content: [{type: "output_text", text: "hi"}]}};
}

export function codexSessionMeta(ts = T0): Record<string, unknown> {
  return {timestamp: iso(ts), type: "session_meta", payload: {id: "s-1", timestamp: iso(ts), cwd: "/tmp", originator: "codex_cli_rs", cli_version: "0.92.0"}};
}

// 旧格式首行形态 (2025-09-06 前, 无 type 包装)
export function codexOldFirstLine(ts = T0): Record<string, unknown> {
  return {id: "87436f9b", timestamp: iso(ts), instructions: "# You are a coding agent", git: {branch: "main"}};
}

// --- opencode db 构造 (bun:sqlite 直接建 .db 文件 — 收集器闭环, 不依赖外部文件) ---

export interface OcSessionRow {
  model: string | null;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  time: number;
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface FillCtx {
  exec(sql: string): unknown;
}

// session 表 (新 schema 形态) 建表+插行
function fillSessionTable(db: FillCtx, rows: OcSessionRow[]): void {
  const colSpec: Array<{name: string; decl: string; value: (r: OcSessionRow, i: number) => string}> = [
    {name: "id", decl: "text PRIMARY KEY", value: (_r, i) => `'s${i}'`},
    {name: "model", decl: "text", value: (r) => (r.model === null ? "NULL" : sqlStr(r.model))},
    {name: "tokens_input", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.input)},
    {name: "tokens_output", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.output)},
    {name: "tokens_reasoning", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.reasoning)},
    {name: "tokens_cache_read", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.cacheRead)},
    {name: "tokens_cache_write", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.cacheWrite)},
    {name: "time_updated", decl: "integer NOT NULL", value: (r) => String(r.time)},
  ];
  db.exec(`CREATE TABLE session (${colSpec.map((c) => `${c.name} ${c.decl}`).join(", ")})`);
  for (const [i, r] of rows.entries()) {
    db.exec(`INSERT INTO session (${colSpec.map((c) => c.name).join(", ")}) VALUES (${colSpec.map((c) => c.value(r, i)).join(", ")})`);
  }
}

export async function makeOpencodeDbFile(path: string, rows: OcSessionRow[]): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  const db = new Database(path);
  fillSessionTable(db, rows);
  db.close();
  return Promise.resolve(path);
}

export interface OcMsgOpts {
  role?: string;
  modelID?: string;
  providerID?: string;
  created?: number; // epoch ms
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  error?: boolean; // data.error 键在场 (成功过滤的剔除面)
  noTokens?: boolean; // 不写 tokens 键 (成功过滤的剔除面)
}

// message 行 data JSON (真实旧库 assistant 行字段结构, 合成数值);
// 非 assistant 角色 (user 等) 按实测形态只留 role/time。
export function ocMsg(o: OcMsgOpts = {}): string {
  if ((o.role ?? "assistant") !== "assistant") {
    return JSON.stringify({role: o.role, time: {created: o.created ?? T0}});
  }
  const input = o.input ?? 0;
  const output = o.output ?? 0;
  const reasoning = o.reasoning ?? 0;
  const d: Record<string, unknown> = {
    role: "assistant",
    time: {created: o.created ?? T0},
    modelID: o.modelID ?? "glm-5.3",
    providerID: o.providerID ?? "zai-coding-plan",
  };
  if (!o.noTokens) {
    d.tokens = {total: input + output + reasoning, input, output, reasoning, cache: {read: o.cacheRead ?? 0, write: o.cacheWrite ?? 0}};
  }
  if (o.error) d.error = {type: "MessageOutputLengthError"}; // 实测: 错误行顶层 error 键 (伴随 tokens)
  return JSON.stringify(d);
}

// message 表库 (账本摄取主形态): 行级 session 归属 + 可选新 schema session 汇总表
// (对账权威源) + 可选 part 表 (工具调用, n_tools 提取面 — 2026-09 实测 parts 在
// 独立 part 表而非 message.data 内嵌)。rowid 按插入序 1..N (水位线测试的可预测基准)。
export interface OcMsgRow {
  sess?: string; // 缺省 's0'
  data?: string | null; // 缺省 ocMsg() 默认行; null = NULL data 列
  tools?: number; // 为该 message 行生成的 tool part 数 (0 = 不生成)
}

// part 表 (id, message_id, session_id, data) — 真实 schema 同名列子集
function fillPartTable(db: FillCtx, parts: Array<{id: string; messageId: string; sessionId: string; type: string}>): void {
  db.exec(`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text)`);
  for (const p of parts) {
    db.exec(`INSERT INTO part (id, message_id, session_id, data) VALUES ('${p.id}', '${p.messageId}', '${p.sessionId}', ${sqlStr(JSON.stringify({type: p.type}))})`);
  }
}

export async function makeOpencodeMessageDb(path: string, rows: OcMsgRow[], sessionRows: OcSessionRow[] = []): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  const db = new Database(path);
  if (sessionRows.length > 0) {
    fillSessionTable(db, sessionRows);
  }
  const parts: Array<{id: string; messageId: string; sessionId: string; type: string}> = [];
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text)");
  for (const [i, r] of rows.entries()) {
    const data = r.data === undefined ? ocMsg() : r.data;
    const sess = r.sess ?? "s0";
    db.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m${i}', '${sess}', 0, 0, ${data === null ? "NULL" : sqlStr(data)})`);
    for (let t = 0; t < (r.tools ?? 0); t++) {
      parts.push({id: `p${i}-${t}`, messageId: `m${i}`, sessionId: sess, type: "tool"});
    }
  }
  if (parts.length > 0) fillPartTable(db, parts);
  db.close();
  return Promise.resolve(path);
}
