// fixtures.ts — 测试合成数据构造器 (隐私红线: 仅合成数据, 严禁引入任何真实用户数据)
// 职责边界: 三家 agent 数据格式的最小闭环构造 (jsonl 行 / SQLite 库文件 / 临时目录),
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

// 原始文本写入 (坏行/混排测试需要非 JSON 化的行内容)
export async function writeRaw(path: string, text: string): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  await writeFile(path, text);
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
}

// assistant 记录; cache 字段缺省时不写键 (模拟第三方端点只回 input/output 的实测形态)
export function claudeAssistant(o: ClaudeOpts = {}): Record<string, unknown> {
  claudeSeq++;
  const usage: Record<string, number> = {input_tokens: o.input ?? 0, output_tokens: o.output ?? 0};
  if (o.cacheWrite !== undefined) usage.cache_creation_input_tokens = o.cacheWrite;
  if (o.cacheRead !== undefined) usage.cache_read_input_tokens = o.cacheRead;
  return {
    type: "assistant",
    isSidechain: o.sidechain ?? false,
    uuid: `u-${claudeSeq}`,
    sessionId: "sess-1",
    timestamp: iso(o.ts ?? T0),
    message: {id: o.msgId ?? `msg-${claudeSeq}`, type: "message", role: "assistant", model: o.model ?? "claude-sonnet-5", usage},
  };
}

export function claudeUser(ts = T0): Record<string, unknown> {
  return {type: "user", uuid: `u-${++claudeSeq}`, timestamp: iso(ts), message: {role: "user", content: "hi"}};
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

// session 表 (新 schema 形态) 建表+插行; timeColumn 双名 + dropColumns 模拟缺列 schema
function fillSessionTable(db: FillCtx, rows: OcSessionRow[], timeColumn: string, dropColumns: string[]): void {
  const colSpec: Array<{name: string; decl: string; value: (r: OcSessionRow, i: number) => string}> = [
    {name: "id", decl: "text PRIMARY KEY", value: (_r, i) => `'s${i}'`},
    {name: "model", decl: "text", value: (r) => (r.model === null ? "NULL" : sqlStr(r.model))},
    {name: "tokens_input", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.input)},
    {name: "tokens_output", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.output)},
    {name: "tokens_reasoning", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.reasoning)},
    {name: "tokens_cache_read", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.cacheRead)},
    {name: "tokens_cache_write", decl: "integer NOT NULL DEFAULT 0", value: (r) => String(r.cacheWrite)},
    {name: timeColumn, decl: "integer NOT NULL", value: (r) => String(r.time)},
  ];
  const active = colSpec.filter((c) => !dropColumns.includes(c.name));
  db.exec(`CREATE TABLE session (${active.map((c) => `${c.name} ${c.decl}`).join(", ")})`);
  for (const [i, r] of rows.entries()) {
    db.exec(`INSERT INTO session (${active.map((c) => c.name).join(", ")}) VALUES (${active.map((c) => c.value(r, i)).join(", ")})`);
  }
}

export async function makeOpencodeDbFile(path: string, rows: OcSessionRow[], timeColumn = "time_updated", dropColumns: string[] = []): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  const db = new Database(path);
  fillSessionTable(db, rows, timeColumn, dropColumns);
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
  return JSON.stringify({
    role: "assistant",
    time: {created: o.created ?? T0},
    modelID: o.modelID ?? "glm-5.3",
    providerID: o.providerID ?? "zai-coding-plan",
    tokens: {total: input + output + reasoning, input, output, reasoning, cache: {read: o.cacheRead ?? 0, write: o.cacheWrite ?? 0}},
  });
}

// 旧 schema 库: 旧形态 session 表 + message 表; messages 为 data 列原文
// (字符串直插 — 允许塞坏 JSON / NULL 异常行)
export async function makeOpencodeLegacyDbFile(path: string, messages: Array<string | null>, opts: {noSession?: boolean} = {}): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  const db = new Database(path);
  if (!opts.noSession) {
    db.exec("CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)");
  }
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text)");
  for (const [i, m] of messages.entries()) {
    db.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m${i}', 's0', 0, 0, ${m === null ? "NULL" : sqlStr(m)})`);
  }
  db.close();
  return Promise.resolve(path);
}

// 新旧共存库 (新版 opencode 库形态): 验证 schema 探测优先 session 汇总路径
export async function makeOpencodeDualDbFile(path: string, sessionRows: OcSessionRow[], messages: Array<string | null>): Promise<string> {
  await mkdir(join(path, ".."), {recursive: true});
  const db = new Database(path);
  fillSessionTable(db, sessionRows, "time_updated", []);
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text)");
  for (const [i, m] of messages.entries()) {
    db.exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m${i}', 's0', 0, 0, ${m === null ? "NULL" : sqlStr(m)})`);
  }
  db.close();
  return Promise.resolve(path);
}
