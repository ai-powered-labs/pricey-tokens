// collectors/opencode.ts — opencode 请求收集 (message 表, SQL 侧抽取) + 对账源读取
// 职责边界: 两面 —
//   ① collectOpencodeRequests: message 表 → RequestRow[] (request 粒度), rowid
//     水位线增量 (append-only 单调); 行筛选与字段抽取全部在 SQL 侧完成 (实测
//     17GB 库: data 列大载荷不过 TS 边界, 仅 9 个抽取小列过界)。口径:
//     - assistant 行 + **成功过滤** (用户裁决 2026-09-22): data JSON 顶层 error
//       键不在场 且 tokens 键在场 (实测 2026-09: 错误行 100% 伴随 tokens — 过滤
//       必要); 四分类全零行不入账本;
//     - model = data.{modelID, providerID} → "providerID/modelID" 拼接 (单边
//       缺省降级单串, 双缺跳过; 实测 user 行才有顶层 model 对象, assistant 契约
//       是 modelID/providerID);
//     - 时间 data.time.created 秒/毫秒按 1e11 阈值折算 (SELECT 输出原始值, 折算
//       收敛到 TS epochMs — 防双重折算), 无效时间行排除;
//     - token cell ±Inf/<0 守卫按 0 (行保留); rowid 分窗扫描, 内存有界。
//   ② opencodeSessionSummaries: session 表 (新 schema 汇总列) → 对账源 — 会话
//     级权威汇总 (ingest 摄取后对账用); 旧 schema (无 tokens 列) 返回 null。
// 归并键: reqKey = "<库文件名>:<message rowid>" (库名隔离多库同 rowid);
// sessKey = message.session_id 列 (NULL 行回退自会话键, 保唯一)。
import {basename} from "node:path";
import type {RequestRow} from "../types.js";
import {openSqlite, type SqliteDb} from "../sqlite.js";

const CHUNK_ROWID = 20000; // 分窗扫描窗口 (内存有界; rowid btree 范围查询无翻页代价)

// 秒/毫秒容错: >1e11 视为毫秒 (秒界 5138 年 / 毫秒界 1973 年, 无重叠区) — 与站点 epochMs 同键
export function epochMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e11 ? v : v * 1000;
}

// cell 正有限数守卫 (与站点侧同款三条件; ±Inf/负值/缺失按 0)
const cell = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export interface OcScanResult {
  rows: RequestRow[];
  maxRowid: number; // 本库 message 表当前最大 rowid (新水位线; 空表为 0)
  reset: boolean; // 库被重建 (maxRowid < 水位线) → 本次为全量重扫
}

// 增量扫描单个 opencode 库。库级失败 (非 SQLite / 无 message 表) 抛错, 调用方
// (ingest 编排) 转单源 skipped 不拖垮其他源。
export async function collectOpencodeRequests(dbPath: string, sinceRowid: number): Promise<OcScanResult> {
  const dbName = basename(dbPath);
  const db = await openSqlite(dbPath);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)));
    if (!tables.has("message")) {
      throw new Error(`opencode db 无 message 表 (现有表: ${[...tables].join(", ") || "无"})`);
    }
    const maxRowid = (db.all("SELECT MAX(rowid) AS m FROM message")[0]?.m as number | null) ?? 0;
    const reset = maxRowid < sinceRowid; // max 回退 = 库被重建 → 水位线重置全量重扫
    const since = reset ? 0 : sinceRowid;
    const rows: RequestRow[] = [];
    // rowid 分窗扫描: 每窗一个结果集, 17GB 库内存有界; 窗口边界为连续区间 (rowid
    // 空洞自然跨过), 覆盖 maxRowid 的末窗扫毕即终止
    for (let lo = since; ; lo += CHUNK_ROWID) {
      const hi = lo + CHUNK_ROWID;
      const chunk = db.all(`SELECT
          rowid AS rid, session_id AS sess,
          json_extract(data,'$.modelID') AS mid,
          json_extract(data,'$.providerID') AS pid,
          json_extract(data,'$.time.created') AS t,
          json_extract(data,'$.tokens.input') AS ti,
          json_extract(data,'$.tokens.output') AS to2,
          json_extract(data,'$.tokens.reasoning') AS tr,
          json_extract(data,'$.tokens.cache.read') AS tcr,
          json_extract(data,'$.tokens.cache.write') AS tcw
        FROM message
        WHERE rowid > ? AND rowid <= ?
          AND json_valid(data) = 1
          AND json_type(data) = 'object'
          AND json_extract(data,'$.role') = 'assistant'
          AND json_type(data,'$.error') IS NULL
          AND json_type(data,'$.tokens') IS NOT NULL
        ORDER BY rowid`, lo, hi);
      for (const r of chunk) {
        const ts = epochMs(r.t);
        if (ts === null) continue; // 无有效时间 → 无法归属日
        const mid = typeof r.mid === "string" ? r.mid : "";
        const pid = typeof r.pid === "string" ? r.pid : "";
        const model = mid && pid ? `${pid}/${mid}` : mid || pid;
        if (!model) continue; // 无模型归属
        const inT = cell(r.ti);
        const outT = cell(r.to2) + cell(r.tr); // reasoning 并入 output
        const crT = cell(r.tcr);
        const cwT = cell(r.tcw);
        if (inT === 0 && outT === 0 && crT === 0 && cwT === 0) continue; // 全零非用量
        const rid = r.rid as number;
        rows.push({
          harness: "opencode",
          reqKey: `${dbName}:${rid}`,
          sessKey: typeof r.sess === "string" && r.sess !== "" ? r.sess : `~self:${dbName}:${rid}`,
          model,
          ts,
          inT,
          outT,
          crT,
          cwT,
        });
      }
      if (hi > maxRowid) break; // 覆盖 max 的末窗已扫
    }
    return {rows, maxRowid, reset};
  } finally {
    db.close();
  }
}

// ===== 对账源: session 表权威汇总 (设计 §1 — 源的会话级汇总行) =====

export interface OcSessionSummary {
  sessKey: string;
  inT: number;
  outT: number; // 已并入 tokens_reasoning (与账本口径对齐)
  crT: number;
  cwT: number;
}

// 读全部会话汇总行 (session 表远小于 message 表, 全量读回)。口径注意: session 行
// 的 tokens 是**会话级合计** (无 per-model 分解, model 列还常为 NULL — 2026-09 实测
// 12664 行全库 model 大量为 NULL), 故对账只能是会话级总量对比。旧 schema (session
// 表无 tokens 汇总列 / 表缺失) 返回 null — 无权威源即无对账 (claude/codex 同理)。
export async function opencodeSessionSummaries(dbPath: string): Promise<Map<string, OcSessionSummary> | null> {
  const db = await openSqlite(dbPath);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)));
    if (!tables.has("session")) return null;
    const cols = new Set(db.all("PRAGMA table_info(session)").map((r) => String(r.name)));
    // 新 schema 判定: tokens 汇总列齐全 (有 tokens 列的库恒有时间列, 无需单列探测)
    if (["tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write"].some((c) => !cols.has(c))) return null;
    const reasoningExpr = cols.has("tokens_reasoning") ? "tokens_reasoning" : "0";
    const rows = db.all(`SELECT
        id,
        tokens_input AS input, tokens_output AS output, ${reasoningExpr} AS reasoning,
        tokens_cache_read AS cache_read, tokens_cache_write AS cache_write
      FROM session`);
    const out = new Map<string, OcSessionSummary>();
    for (const r of rows) {
      const sessKey = typeof r.id === "string" && r.id !== "" ? r.id : null;
      if (sessKey === null) continue;
      out.set(sessKey, {sessKey, inT: cell(r.input), outT: cell(r.output) + cell(r.reasoning), crT: cell(r.cache_read), cwT: cell(r.cache_write)});
    }
    return out;
  } finally {
    db.close();
  }
}
