// ingest.ts — 账本增量摄取编排 (水位线 + 成功过滤 + 对账)
// 职责边界: 枚举 (discover) → 各源增量收集 (collectors) → 账本幂等归并
// (ledger.insertRequests) → 受影响日重算 (ledger.recomputeDays) → 水位线推进。
// 摄取恒为**全历史增量** (与 --days 窗口无关 — 窗口是账本查询期概念); 首跑全量
// (17GB 源分钟级, 一次性), 之后增量秒级。
//
// 水位线契约 (meta 表键):
//   - `wl:oc:<db绝对路径>`   = 已摄取的 message 最大 rowid (append-only 单调);
//     探测 max(rowid) < 水位线 = 库被重建 → 重置 0 全量重扫 (收集器内判定)。
//   - `wl:file:<文件绝对路径>` = "<mtimeMs>:<size>"; 不匹配 (含文件缩小/新文件) →
//     整文件重收, upsert 幂等兜底 (值变化才写)。
// 崩溃一致性: 每源批次 "归并 → 重算日 → 推进水位线" 顺序执行, 任一步崩溃则水位线
// 未推进, 下次重扫同源幂等自愈 (重算日恒等于 requests 派生, 漂移自愈)。
//
// 对账 (设计 §1): opencode session 表是源的权威汇总 — 摄取后对**变动过的会话**
// 比较 账本 per-session rollup vs 源汇总行, 差异进 warnings (不 fail; 已知偏差:
// 成功过滤剔除的错误行会计入源汇总, 该类差异属预期告警面)。claude/codex 无会话级
// 权威源, 跳过。
import {stat} from "node:fs/promises";
import type {HarnessId, RequestRow, TurnRow} from "./types.js";
import {ALL_HARNESSES} from "./types.js";
import {errMsg} from "./guards.js";
import {findClaudeFiles, findCodexFiles, findOpencodeDbs, notFoundDetail} from "./discover.js";
import {collectClaudeRequests} from "./collectors/claude.js";
import {collectCodexRequests} from "./collectors/codex.js";
import {collectOpencodeRequests, opencodeSessionSummaries} from "./collectors/opencode.js";
import type {Ledger} from "./ledger.js";

export interface IngestStatus {
  harness: HarnessId;
  found: boolean;
  detail: string; // found: 源与增量计数; 未 found: 探测位置
}

export interface IngestReport {
  statuses: IngestStatus[];
  inserted: number; // 本次新归并行数 (重采/无变化 = 0)
  total: number; // 账本累计请求数 (摄取后)
  skipped: string[]; // 无法解析的源 (含原因后缀)
  warnings: string[]; // 水位线重置 / 对账差异等告警 (不 fail)
}

export interface IngestOptions {
  harnesses: HarnessId[]; // 空 = 全部
  home: string; // claude/codex jsonl 源的 home (测试注入)
  dataRoot: string; // opencode 源与账本共用的 XDG 数据根 (已解析 — 与 Ledger.open 同源)
}

// 批次落账: 归并 (请求 + 轮次) → 会话重算 → 受影响日重算, **单事务原子** (水位线
// 推进由调用方在批后执行 — 顺序即崩溃一致性: 批内任一步崩溃整批回滚, 水位线未
// 推进, 下次重扫同源幂等重做; 多事务批内的中途断裂面 — 如无轮次会话的同值重放
// 不自愈 — 由此消除)。受影响日 = 请求行 ts 日 ∪ 被覆盖行旧 ts 日 ∪ 会话归因日
// 迁移 (last_ts 换日时旧归因日必须重算, 否则 maxCtxHist/nTurns 残留双计)。
function commitBatch(ledger: Ledger, rows: readonly RequestRow[], turns: readonly TurnRow[]): number {
  let changed = 0;
  ledger.runInTx(() => {
    const r = ledger.insertRequests(rows);
    const turnSessions = ledger.insertTurns(turns);
    const sessDays = ledger.recomputeSessions([...r.sessions, ...turnSessions]);
    ledger.recomputeDays([...r.days, ...sessDays]);
    changed = r.changed;
  });
  return changed;
}

// opencode 摄取: 逐库 rowid 水位线增量 + 变动会话对账
async function ingestOpencode(ledger: Ledger, opts: IngestOptions, report: IngestReport): Promise<void> {
  const dbs = await findOpencodeDbs(opts.dataRoot);
  if (dbs.length === 0) {
    report.statuses.push({harness: "opencode", found: false, detail: notFoundDetail("opencode", opts.home)});
    return;
  }
  const parts: string[] = [];
  for (const dbPath of dbs) {
    const wlKey = `wl:oc:${dbPath}`;
    const since = Number(ledger.getMeta(wlKey) ?? 0);
    try {
      const {rows, turns, maxRowid, reset} = await collectOpencodeRequests(dbPath, since);
      const changed = commitBatch(ledger, rows, turns);
      report.inserted += changed;
      // 水位线推进不依赖收割行数 (新增行全被成功过滤的窗口也是合法终态 — 不推进
      // 会每跑重扫); since == maxRowid 时免写
      if (since !== maxRowid) ledger.setMeta(wlKey, String(maxRowid));
      if (reset && since > 0) {
        report.warnings.push(`[水位线] opencode 库 ${dbPath} max(rowid) 回退 (${maxRowid} < ${since}), 已全量重扫`);
      }
      parts.push(`${dbPath} (+${changed}${changed !== rows.length ? `/${rows.length}` : ""})`);
      const changedSessions = [...new Set(rows.map((r) => r.sessKey))];
      if (changedSessions.length > 0) await reconcileOpencode(ledger, dbPath, changedSessions, report);
    } catch (e) {
      report.skipped.push(`${dbPath} (${errMsg(e)})`);
      parts.push(`${dbPath} (收集失败: ${errMsg(e)})`);
    }
  }
  report.statuses.push({harness: "opencode", found: true, detail: parts.join("; ")});
}

// 对账: 账本 per-session rollup (Σ 全模型) vs 源 session 汇总行 (会话级合计 — 源
// 无 per-model 分解)。差异进 warnings 不 fail; 详情上限 10 条 + 总数 (stderr 可用性)。
// 整体容错: 对账是告警面非门禁, 任何一步失败只记 warning, 不把已成功摄取的库
// 误报为收集失败。
async function reconcileOpencode(ledger: Ledger, dbPath: string, changedSessions: string[], report: IngestReport): Promise<void> {
  try {
    const source = await opencodeSessionSummaries(dbPath);
    if (source === null) return; // 旧 schema 无权威汇总 → 无对账
    const ledgerSide = ledger.sessionRollups("opencode", changedSessions);
    let diffs = 0;
    const details: string[] = [];
    const zero = {inT: 0, outT: 0, crT: 0, cwT: 0};
    const sum = (xs: {inT: number; outT: number; crT: number; cwT: number}[]) =>
      xs.reduce((a, x) => ({inT: a.inT + x.inT, outT: a.outT + x.outT, crT: a.crT + x.crT, cwT: a.cwT + x.cwT}), zero);
    for (const sess of changedSessions) {
      const l = sum(ledgerSide.get(sess) ?? []);
      const s = source.get(sess) ?? zero;
      if (l.inT === s.inT && l.outT === s.outT && l.crT === s.crT && l.cwT === s.cwT) continue;
      diffs += 1;
      if (details.length < 10) {
        details.push(`会话 ${sess.slice(0, 12)}: 账本 in=${l.inT} out=${l.outT} cr=${l.crT} cw=${l.cwT} vs 源 in=${s.inT} out=${s.outT} cr=${s.crT} cw=${s.cwT}`);
      }
    }
    if (diffs > 0) {
      report.warnings.push(`[对账] opencode ${dbPath}: ${diffs} 个会话与源汇总不一致 (防源裁剪历史/解析漂移; 成功过滤剔除的错误行亦计入差异)`);
      for (const d of details) report.warnings.push(`[对账]   ${d}`);
      if (diffs > details.length) report.warnings.push(`[对账]   …另有 ${diffs - details.length} 处差异从略`);
    }
  } catch (e) {
    report.warnings.push(`[对账] opencode ${dbPath}: 对账失败, 已跳过 (${errMsg(e)})`);
  }
}

// jsonl 双源 (claude/codex) 摄取: 逐文件 mtime+size 水位线, 变化文件整收
// (无 token 数据 / 全被过滤的文件同样推进水位线 — 重试不会变好, 防每跑重解析;
//  读取失败不推进 — 瞬时 IO 错误下次自愈)
async function ingestJsonl(
  harness: "claude-code" | "codex",
  files: string[],
  collect: (path: string) => Promise<{rows: RequestRow[]; turns: TurnRow[]; skipped: string | null}>,
  ledger: Ledger,
  report: IngestReport,
): Promise<void> {
  let rescanned = 0;
  let inserted = 0;
  for (const path of files) {
    const wlKey = `wl:file:${path}`;
    let fingerprint: string;
    try {
      const st = await stat(path);
      fingerprint = `${Math.floor(st.mtimeMs)}:${st.size}`;
    } catch (e) {
      report.skipped.push(`${path} (${errMsg(e)})`);
      continue;
    }
    if (ledger.getMeta(wlKey) === fingerprint) continue; // 未变化 → 跳过 (增量秒级的核心)
    try {
      const {rows, turns, skipped} = await collect(path);
      if (skipped !== null) report.skipped.push(skipped);
      inserted += commitBatch(ledger, rows, turns);
      ledger.setMeta(wlKey, fingerprint);
      rescanned += 1;
    } catch (e) {
      report.skipped.push(`${path} (${errMsg(e)})`);
    }
  }
  report.inserted += inserted;
  report.statuses.push({harness, found: true, detail: `${files.length} 个会话文件 (重收 ${rescanned}, +${inserted})`});
}

export async function ingestAll(ledger: Ledger, opts: IngestOptions): Promise<IngestReport> {
  const report: IngestReport = {statuses: [], inserted: 0, total: 0, skipped: [], warnings: []};
  const wanted = new Set(opts.harnesses.length === 0 ? ALL_HARNESSES : opts.harnesses);
  if (wanted.has("opencode")) await ingestOpencode(ledger, opts, report);
  if (wanted.has("claude-code")) {
    const files = await findClaudeFiles(opts.home);
    if (files === null) report.statuses.push({harness: "claude-code", found: false, detail: notFoundDetail("claude-code", opts.home)});
    else await ingestJsonl("claude-code", files, collectClaudeRequests, ledger, report);
  }
  if (wanted.has("codex")) {
    const files = await findCodexFiles(opts.home);
    if (files === null) report.statuses.push({harness: "codex", found: false, detail: notFoundDetail("codex", opts.home)});
    else await ingestJsonl("codex", files, collectCodexRequests, ledger, report);
  }
  report.total = ledger.requestCount();
  return report;
}
