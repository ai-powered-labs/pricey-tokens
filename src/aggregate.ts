// aggregate.ts — 窗口内 records → 日粒度聚合 → ProfileV1 (月速率口径)
// 职责边界: 两级聚合, 输入是多源收集的 UsageRecord[] (session/消息/会话粒度混杂):
//   ① 日粒度: 按 (model, 本地时区日) 分组求和四类 tokens, ts 取组内最大值 (保留
//      "当天最后活跃时刻" — lastTs 与 spanDays 语义完整; 峰值细节丢失 = 同日全部量
//      压到单点, 5h 峰值被高估为全天量, 站点换算偏保守方向, README 注明)。
//   ② 月速率 (ProfileV1): spanDays = ceil((lastTs-firstTs)/86400000) 钳 [1, 3650]
//      (契约域); 各模型月速率 = round(总量 × 30 / spanDays) — 与 spanDays 自洽
//      (引擎侧 30/spanDays 外推还原原值, 站点种子档案同口径)。
// harness 字段: 单源 = 源名; 多源 = "mixed" (契约是自由串, 站点按 harness 过滤分榜,
// 混合档案如实标注)。模型 id 保留原始串 (含 opencode provider 前缀)。
import type {HarnessId, ParseResult, ProfileV1, UsageRecord} from "./types.js";

const DAY_MS = 86400000;

// 本地时区日的起点 (24:00 边界取本地日, 与用户 "每日用量" 直觉一致; DST 偏移由
// Date 语义自然处理)
function localDayKey(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

export interface Aggregation {
  daily: UsageRecord[]; // 日粒度 records (ts 升序; 分享 hash 的载荷)
  profile: ProfileV1;
  span: {firstTs: number; lastTs: number}; // 日粒度时间线跨度 (profile spanDays 的基准)
}

// 多源 records 合并去重前提: 各源数据位置互斥, 无跨源重复 (opencode 主库单通道 /
// claude 与 codex 各自目录) — 直接拼接。
export function aggregate(results: ParseResult[], toolVersion: string): Aggregation | null {
  const all: UsageRecord[] = [];
  const harnesses = new Set<HarnessId>();
  for (const r of results) {
    harnesses.add(r.harness);
    for (const rec of r.records) all.push(rec);
  }
  if (all.length === 0) return null;

  // ① 日粒度聚合
  const byDay = new Map<string, {model: string; ts: number; input: number; output: number; cacheRead: number; cacheWrite: number}>();
  for (const r of all) {
    const key = `${localDayKey(r.ts)}\u0000${r.model}`;
    let s = byDay.get(key);
    if (!s) {
      s = {model: r.model, ts: r.ts, input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      byDay.set(key, s);
    }
    s.input += r.inputTokens;
    s.output += r.outputTokens;
    s.cacheRead += r.cacheReadTokens;
    s.cacheWrite += r.cacheWriteTokens;
    if (r.ts > s.ts) s.ts = r.ts;
  }
  const daily: UsageRecord[] = [...byDay.values()]
    .map((s) => ({model: s.model, ts: s.ts, inputTokens: s.input, outputTokens: s.output, cacheReadTokens: s.cacheRead, cacheWriteTokens: s.cacheWrite}))
    .sort((a, b) => a.ts - b.ts || (a.model < b.model ? -1 : 1));

  // ② 月速率 (span = 日粒度时间线; 首组 ts 取组内 max, 与原始首条最多差 <1 天,
  // spanDays 偏小方向 → 月速率偏大保守, 可忽略)。daily 已按 ts 升序 — 首尾即极值
  const firstTs = daily[0]!.ts;
  const lastTs = daily[daily.length - 1]!.ts;
  const spanDays = Math.min(3650, Math.max(1, Math.ceil((lastTs - firstTs) / DAY_MS)));

  const byModel = new Map<string, {input: number; output: number; cacheRead: number; cacheWrite: number}>();
  for (const r of all) {
    let m = byModel.get(r.model);
    if (!m) {
      m = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      byModel.set(r.model, m);
    }
    m.input += r.inputTokens;
    m.output += r.outputTokens;
    m.cacheRead += r.cacheReadTokens;
    m.cacheWrite += r.cacheWriteTokens;
  }
  // 按月速率降序输出 (大模型在前, 上传预览可读性)
  const models = [...byModel.entries()]
    .map(([id, m]) => ({
      id,
      inputT: Math.round((m.input * 30) / spanDays),
      outputT: Math.round((m.output * 30) / spanDays),
      cacheReadT: Math.round((m.cacheRead * 30) / spanDays),
      cacheWriteT: Math.round((m.cacheWrite * 30) / spanDays),
    }))
    .sort((a, b) => b.inputT + b.outputT + b.cacheReadT + b.cacheWriteT - (a.inputT + a.outputT + a.cacheReadT + a.cacheWriteT));

  const harness = harnesses.size === 1 ? ([...harnesses][0] as string) : "mixed";
  const profile: ProfileV1 = {
    schema: "pricey-tokens-profile/v1",
    harness,
    spanDays,
    models,
    planUsed: null,
    collectedAt: Date.now(),
    toolVersion,
    trust: "anon", // 具服务端证明力的 github 档是 API B3 交付物, CLI 恒 anon
  };
  return {daily, profile, span: {firstTs, lastTs}};
}
