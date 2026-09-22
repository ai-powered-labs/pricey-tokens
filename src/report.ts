// report.ts — 默认出口的终端用量摘要渲染 (ProfileDayV2[] → 人类可读文本块)
// 职责边界: 纯函数渲染, 无 IO/时区依赖 (日期序列走 UTC 字面算术, 与本地时区无关);
// 统计口径只取加法安全的量 (token 四分类 / nReq / nTurns / nToolCalls — nSess 是
// 跨日跨模型的去重口径, 逐日相加会双计, 摘要宁缺毋滥不展示)。渲染产物由 cli.ts
// 打到 stderr (stdout 纪律: 默认模式 stdout 只有分享 URL, 保护 `| pbcopy` 类管道)。
import type {ProfileDayV2} from "./types.js";

// ===== 数字格式化 =====

// token 数 → 人类可读 (1000 进制, 常规量级内 ≤3 位有效数字, 去尾零): 950 / 1.2K / 2M / 9.4G
// (≥1e15 超真实 token 量级, 会溢出为 "1000T" — 不防御)
export function fmtTokens(n: number): string {
  const units = ["", "K", "M", "G", "T"];
  let u = 0;
  let v = n;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return r >= 1000 && u < units.length - 1 ? `1${units[u + 1]}` : `${r}${units[u]}`;
}

// 计数 → 千分位: 12345 → "12,345" (显式 locale, 与运行环境无关)
export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

// ===== 对齐基元 (显示宽度: CJK 全角按 2 列 — 表头中文与 ASCII 值同一张表对齐) =====

function dispW(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}
function padEndW(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - dispW(s)));
}
function padStartW(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - dispW(s))) + s;
}

// ===== sparkline =====

const BLOCKS = "▁▂▃▄▅▆▇█"; // 8 级块字符 (行尾使用, 不参与列对齐)

// 值序列 → 单行趋势 (长度守恒; 0 或 max<=0 时全 ▁ — 防御全零窗口; 负值钳 0)
export function sparkline(values: readonly number[]): string {
  const max = Math.max(...values, 0);
  return values.map((v) => BLOCKS[max <= 0 ? 0 : Math.min(7, Math.floor((Math.max(0, v) / max) * 8))]).join("");
}

// ===== 日期序列 (稀疏日补零 → 连续日历) =====

// "YYYY-MM-DD" 字面 +1 天 (UTC 算术 — 纯字符串日期迭代, 不涉及时区换算)
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

interface DayValue {
  day: string;
  tokens: number; // 当日四分类总和
}

function daySeries(days: readonly ProfileDayV2[]): DayValue[] {
  const byDay = new Map(days.map((d) => [d.day, d.models.reduce((a, m) => a + m.in + m.out + m.cr + m.cw, 0)]));
  const out: DayValue[] = [];
  let cur = days[0]!.day;
  const last = days[days.length - 1]!.day;
  while (cur <= last) {
    out.push({day: cur, tokens: byDay.get(cur) ?? 0});
    cur = nextDay(cur);
  }
  return out;
}

// ===== 模型聚合 (跨日合并, 按四分类总量降序 — 与 profileDays 模型排序同口径) =====

interface ModelAgg {
  id: string;
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
}

function aggregateModels(days: readonly ProfileDayV2[]): ModelAgg[] {
  const by = new Map<string, ModelAgg>();
  for (const d of days) {
    for (const m of d.models) {
      let a = by.get(m.id);
      if (!a) {
        a = {id: m.id, inT: 0, outT: 0, crT: 0, cwT: 0};
        by.set(m.id, a);
      }
      a.inT += m.in;
      a.outT += m.out;
      a.crT += m.cr;
      a.cwT += m.cw;
    }
  }
  return [...by.values()].sort((a, b) => b.inT + b.outT + b.crT + b.cwT - (a.inT + a.outT + a.crT + a.cwT));
}

// ===== 主渲染 =====

export interface SummaryInput {
  days: readonly ProfileDayV2[]; // 窗口内日行 (day 升序, 空数组由调用方先行拦截)
  windowLabel: string; // 窗口人话 ("近 30 天" / "全量")
  harnessLabel: string; // 源名 ("opencode" 等) 或 "多源混合"
}

const NAME_W = 30; // 模型名列宽 (覆盖常见 "provider/model" 全长; 超长保尾段 — 模型 id 的区分度在尾部)
const BAR_W = 16; // 分布条宽 (█ 填充 / ░ 空位)
const TREND_DAYS = 30; // 趋势 sparkline 最长天数 (更早的从略, 总览数字仍覆盖全窗口)
const MODEL_ROWS = 8; // 模型表最多行数 (防窗口内模型数失控)

export function renderSummary(input: SummaryInput): string {
  const {days, windowLabel, harnessLabel} = input;
  const models = aggregateModels(days);
  const series = daySeries(days);

  // 总览 (加法安全标量)
  let nReq = 0;
  let nTurns = 0;
  let nTools = 0;
  let tin = 0;
  let tout = 0;
  let tcr = 0;
  let tcw = 0;
  for (const d of days) {
    for (const m of d.models) {
      nReq += m.nReq;
      nTurns += m.nTurns;
      nTools += m.nToolCalls;
      tin += m.in;
      tout += m.out;
      tcr += m.cr;
      tcw += m.cw;
    }
  }

  const first = days[0]!.day;
  const last = days[days.length - 1]!.day;
  const range = first === last ? first : `${first} ~ ${last}`;
  const lines: string[] = [
    `用量摘要 · ${windowLabel} · ${range} (${series.length} 天) · ${models.length} 个模型 · ${harnessLabel}`,
    `  请求 ${fmtCount(nReq)} · 轮次 ${fmtCount(nTurns)} · 工具调用 ${fmtCount(nTools)}`,
    `  输入 ${fmtTokens(tin)} · 输出 ${fmtTokens(tout)} · 缓存读 ${fmtTokens(tcr)} · 缓存写 ${fmtTokens(tcw)}`,
  ];

  // 模型分布表 (列宽 = 表头与全部列值的显示宽度最大值)
  const shown = models.slice(0, MODEL_ROWS);
  const headers = ["输入", "输出", "缓存读", "缓存写"];
  const cells = shown.map((m) => [fmtTokens(m.inT), fmtTokens(m.outT), fmtTokens(m.crT), fmtTokens(m.cwT)]);
  const colW = headers.map((h, i) => Math.max(dispW(h), ...cells.map((c) => dispW(c[i]!))));
  const grand = tin + tout + tcr + tcw; // 窗口总量 (与总览行同一组累加器 — 单计算点)
  lines.push("");
  lines.push(
    `${padEndW("模型", NAME_W)}  ${headers.map((h, i) => padStartW(h, colW[i]!)).join("  ")}  ${" ".repeat(BAR_W)}  占比`,
  );
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i]!;
    const total = m.inT + m.outT + m.crT + m.cwT;
    const share = grand > 0 ? total / grand : 0;
    const filled = Math.round(BAR_W * share);
    const bar = "█".repeat(filled) + "░".repeat(BAR_W - filled);
    const name = dispW(m.id) > NAME_W ? "…" + m.id.slice(-(NAME_W - 1)) : m.id;
    lines.push(
      `${padEndW(name, NAME_W)}  ${cells[i]!.map((c, j) => padStartW(c, colW[j]!)).join("  ")}  ${bar}  ${Math.round(share * 100)}%`,
    );
  }
  if (models.length > MODEL_ROWS) lines.push(`  …另 ${models.length - MODEL_ROWS} 个模型从略`);

  // 每日趋势 (sparkline + 峰值/日均; 窗口更长时只展示最近 TREND_DAYS 天)
  const trend = series.length > TREND_DAYS ? series.slice(-TREND_DAYS) : series;
  const peak = trend.reduce((a, d) => (d.tokens > a.tokens ? d : a), trend[0]!);
  const tail = series.length > TREND_DAYS ? `最近 ${TREND_DAYS} 天` : `每日`;
  const avg = trend.reduce((a, d) => a + d.tokens, 0) / trend.length;
  lines.push("");
  lines.push(
    `  ${tail} tokens ${sparkline(trend.map((d) => d.tokens))}  峰值 ${fmtTokens(peak.tokens)} (${peak.day.slice(5)}) · 日均 ${fmtTokens(avg)}`,
  );
  return lines.join("\n");
}
