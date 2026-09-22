// guards.ts — jsonl 收集器共享的输入守卫
// 职责边界: claude/codex 收集器同款守卫的 SSOT (站点侧两份同款注记 "待第三家
// jsonl harness 出现再抽取共享", CLI 侧三家齐备即抽取)。opencode.ts 的 isObj 有意
// 排斥数组 (message data 契约是 JSON 对象), 与本处放行数组版语义不同, 勿盲目合并。

// 对象判定 (放行数组 — jsonl 事件行的 message/payload/info 字段实测未见数组形态,
// 站点侧同款; 需排斥数组时在消费点加 Array.isArray)
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// 正有限数否则 0 (usage 字段缺失/负值/Inf 按 0 计; Number.isFinite 已排除 ±Inf)
export const posNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// Error → 展示串 (e.message 恒定收敛点; 未来带 cause 链时只改此处)
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
