// day.ts — 本地时区日键与日界换算 (day_stats 的日归属 SSOT)
// 职责边界: "ts → 本地日字符串" 与 "日字符串 → 该日 [起,止) epoch ms 界" 的唯一
// 实现。请求各归各日 (设计 §1 日归属), DST 偏移由 Date 本地构造语义自然处理
// (23/25 小时日的日界仍是本地 00:00)。day_stats / 摄取水位线 / ProfileV2 窗口
// 全部经此模块, 禁止各消费点手写同款换算。

// ts → "YYYY-MM-DD" (本地时区日)
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDay(day: string): {y: number; m: number; d: number} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`非法日键: ${day} (期望 YYYY-MM-DD)`);
  return {y: Number(m[1]), m: Number(m[2]), d: Number(m[3])};
}

// "YYYY-MM-DD" → 该本地日 00:00 的 epoch ms (含边界)
export function dayStartTs(day: string): number {
  const {y, m, d} = parseDay(day);
  return new Date(y, m - 1, d).getTime();
}

// "YYYY-MM-DD" → 下一本地日 00:00 的 epoch ms (排他上界; 与 dayStartTs(下一日) 恒等)
export function dayEndTs(day: string): number {
  const {y, m, d} = parseDay(day);
  return new Date(y, m - 1, d + 1).getTime();
}
