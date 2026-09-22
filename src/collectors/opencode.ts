// collectors/opencode.ts — opencode 用量收集 (SQLite 双 schema, SQL 侧端口)
// 职责边界: 读取 opencode SQLite (.db) 用量 → UsageRecord[]; schema 探测与口径
// 移植自 lc-studio/nixos 的 export-usage.sh (该导出工具已退役, 本文件是口径 SSOT
// 的公开归宿; 行筛选在 SQLite 侧完成 — 17GB 实测库亚秒级), TS 守卫与站点
// (pricey-tokens-website 仓 site/src/parsers/opencode.ts) 同键:
//   - 新 schema (session 表含 tokens_input 汇总列): 一行一 session 汇总; model JSON
//     {id, providerID} → "providerID/id" 拼接 (单边缺省降级为单串, 双缺跳过); 时间列
//     候选 updated_at / time_updated 双名; tokens_reasoning 并入 output (列缺失按 0)。
//   - 旧 schema fallback: session 表无任何 tokens 列时走 message 表 data JSON —
//     assistant 行 {modelID, providerID, tokens:{input,output,reasoning,cache:{read,write}}},
//     一行一消息; 坏 data 行 / 非 assistant 行静默排除 (站点解析器计入 skippedFiles,
//     导出通道契约无该位, 此处与 SQL 通道对齐只做排除)。
//   - 时间秒/毫秒按 1e11 阈值折算, **只折算一次** (TS epochMs SSOT; SQL 侧仅 WHERE
//     过滤用折算表达式, SELECT 输出原始值防双重折算)。
//   - ±Infinity cell 守卫 (< 9e999, 镜像 TS isFinite): Inf cell 按 0 计 (行保留),
//     Inf 时间行整行排除; 零消耗行 / 无模型归属行 / 无有效时间行不导出。
// 与站点侧的双通道同库同数是硬要求: 口径分叉会被站点的 golden/roundtrip 测试抓到。
import type {ParseResult, UsageRecord} from "../types.js";
import {openSqlite, type SqliteDb} from "../sqlite.js";

const TIME_COLUMNS = ["updated_at", "time_updated"] as const;
const TOKEN_COLUMNS = ["tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write"] as const;

// 秒/毫秒容错: >1e11 视为毫秒 (秒界 5138 年 / 毫秒界 1973 年, 无重叠区) — 与站点 epochMs 同键
export function epochMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e11 ? v : v * 1000;
}

// cell 的 < 9e999 是 SQL 侧叙事 (export-usage.sh 的 typeof 守卫); TS 侧 Number.isFinite
// 已排除 ±Inf, 与站点 cell 同款三条件即语义完备
const cell = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// token 四件套 → UsageRecord (reasoning 并入 output); 全零返回 null (零消耗行不构成
// 用量)。两条 schema 路径共用的口径 SSOT — 分叉会致两路径用量面静默分叉
function usageRecord(
  model: string,
  ts: number,
  t: {input: unknown; output: unknown; reasoning: unknown; cacheRead: unknown; cacheWrite: unknown},
): UsageRecord | null {
  const inputTokens = cell(t.input);
  const outputTokens = cell(t.output) + cell(t.reasoning);
  const cacheReadTokens = cell(t.cacheRead);
  const cacheWriteTokens = cell(t.cacheWrite);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  return {model, ts, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens};
}

// SQL 侧的 model JSON → "providerID/id" 拼接 (与 export-usage.sh CASE 同构):
// JSON {id, providerID} 双全拼接 / 单边降级单串 / 双缺 NULL; 非 JSON 串原样透传
function modelExpr(): string {
  return `CASE
      WHEN model IS NULL OR model = '' THEN NULL
      WHEN typeof(model) <> 'text' THEN NULL
      WHEN substr(model,1,1) = '{' AND json_valid(model) = 1 THEN
        CASE
          WHEN json_type(model,'$.providerID') = 'text' AND json_extract(model,'$.providerID') <> ''
               AND json_type(model,'$.id') = 'text' AND json_extract(model,'$.id') <> ''
            THEN json_extract(model,'$.providerID') || '/' || json_extract(model,'$.id')
          WHEN json_type(model,'$.id') = 'text' AND json_extract(model,'$.id') <> ''
            THEN json_extract(model,'$.id')
          WHEN json_type(model,'$.providerID') = 'text' AND json_extract(model,'$.providerID') <> ''
            THEN json_extract(model,'$.providerID')
          ELSE NULL
        END
      ELSE model
    END`;
}

// cell 守卫 SQL 片段 (与 export-usage.sh 同构; 参数可为列名或字面量 0)
function cellExpr(col: string): string {
  return `CASE WHEN typeof(${col}) IN ('integer','real') AND ${col} > 0 AND ${col} < 9e999 THEN ${col} ELSE 0 END`;
}

// --- 新 schema: session 汇总行 (一行一 session), 窗口过滤在 SQL 侧 ---
function sessionRecords(db: SqliteDb, cols: Set<string>, sinceMs: number | null): UsageRecord[] {
  const timeCol = TIME_COLUMNS.find((c) => cols.has(c));
  const missing = TOKEN_COLUMNS.filter((c) => !cols.has(c));
  if (!timeCol || missing.length > 0) {
    throw new Error(`opencode session 表列缺失: ${[...(!timeCol ? TIME_COLUMNS : []), ...missing].join(", ")} (实际列: ${[...cols].join(", ")})`);
  }
  const reasoningExpr = cols.has("tokens_reasoning") ? "tokens_reasoning" : "0";
  // WHERE 过滤用折算表达式 (SQL 侧行筛选); SELECT 输出原始 time 值, 折算收敛到 TS epochMs
  const where =
    sinceMs === null
      ? `WHERE typeof(${timeCol}) IN ('integer','real') AND ${timeCol} > 0 AND ${timeCol} < 9e999`
      : `WHERE typeof(${timeCol}) IN ('integer','real') AND ${timeCol} > 0 AND ${timeCol} < 9e999
         AND (CASE WHEN ${timeCol} > 100000000000 THEN ${timeCol} ELSE ${timeCol} * 1000 END) >= ${sinceMs}`;
  const rows = db.all(`SELECT
      ${modelExpr()} AS model,
      tokens_input AS input,
      tokens_output AS output,
      ${reasoningExpr} AS reasoning,
      tokens_cache_read AS cache_read,
      tokens_cache_write AS cache_write,
      ${timeCol} AS time
    FROM session
    ${where}`);
  const records: UsageRecord[] = [];
  for (const row of rows) {
    const model = typeof row.model === "string" && row.model !== "" ? row.model : null;
    const ts = epochMs(row.time);
    if (model === null || ts === null) continue;
    const rec = usageRecord(model, ts, {input: row.input, output: row.output, reasoning: row.reasoning, cacheRead: row.cache_read, cacheWrite: row.cache_write});
    if (rec) records.push(rec);
  }
  return records;
}

// --- 旧 schema fallback: message 表 data JSON (assistant 行, 一行一消息) ---
// 行有效性预筛在 SQL 侧 (json_valid/role); 秒/毫秒折算与窗口过滤在 TS 侧补

// data JSON 字段守卫 (模块级, 勿内联回循环 — 逐行重建闭包): isObj 有意排斥数组
// (message data 契约是 JSON 对象, 与 guards.isObj 放行数组版语义不同, 勿合并)
const msgIsObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function messageRecords(db: SqliteDb, sinceMs: number | null): UsageRecord[] {
  const rows = db.all(`SELECT data FROM message
    WHERE data IS NOT NULL AND json_valid(data) = 1 AND json_type(data) = 'object'
      AND json_extract(data,'$.role') = 'assistant'`);
  const records: UsageRecord[] = [];
  for (const row of rows) {
    let o: unknown;
    try {
      o = JSON.parse(String(row.data));
    } catch {
      continue; // json_valid 已筛, 此处理论不可达 (防御 sqlite json 边角)
    }
    if (typeof o !== "object" || o === null) continue;
    const d = o as Record<string, unknown>;
    // "providerID/modelID" 拼接 — 与站点 joinProviderModel 同构 (单边缺省降级, 双缺 null)
    const id = str(d.modelID);
    const prov = str(d.providerID);
    const model = id && prov ? `${prov}/${id}` : id || prov || null;
    const timeObj = msgIsObj(d.time) ? d.time : {};
    const ts = epochMs(timeObj.created);
    if (model === null || ts === null) continue;
    if (sinceMs !== null && ts < sinceMs) continue; // 窗口过滤 (折算后的最终判定)
    const tokens = msgIsObj(d.tokens) ? d.tokens : {};
    const cache = msgIsObj(tokens.cache) ? tokens.cache : {};
    const rec = usageRecord(model, ts, {input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: cache.read, cacheWrite: cache.write});
    if (rec) records.push(rec);
  }
  return records;
}

// 主入口: 收集单个 opencode 库。库级失败 (非 SQLite / 列缺失 / 无用量源) 抛错,
// 调用方 (discover 编排) 转单源 skippedFiles 不拖垮其他源。
export async function collectOpencode(dbPath: string, sinceMs: number | null): Promise<ParseResult> {
  const db = await openSqlite(dbPath);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)));
    // schema 探测 (与站点解析器同键): session 含 tokens_input 汇总列 → session 路径;
    // 否则 (旧库 / session 表缺失) → message 表 fallback; 两者皆无 → 报错
    const sessionCols = tables.has("session")
      ? new Set(db.all("PRAGMA table_info(session)").map((r) => String(r.name)))
      : new Set<string>();
    if (sessionCols.has("tokens_input")) {
      return {agent: "opencode", records: sessionRecords(db, sessionCols, sinceMs), skippedFiles: []};
    }
    if (tables.has("message")) {
      return {agent: "opencode", records: messageRecords(db, sinceMs), skippedFiles: []};
    }
    throw new Error(`opencode db 无可用用量源: session 表缺 tokens 汇总列或不存在, 且无 message 表 (现有表: ${[...tables].join(", ") || "无"})`);
  } finally {
    db.close();
  }
}
