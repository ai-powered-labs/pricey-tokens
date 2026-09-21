// types.ts — 本包共享类型契约 SSOT
// 职责边界: 定义 收集器输出 (UsageRecord/ParseResult)、分享 payload (SharePayload)、
// 上传档案 (ProfileV1) 三组契约。字段形态与站点 (pkgs/pricey-tokens src/types.ts +
// src/share/hash.ts) 和 API (pkgs/pricey-tokens-api CONTRACT.md) 逐字对齐 — 三侧
// 同构类型禁止在本包内重复声明, 修改须回写上游契约。
// 口径来源: 站点解析器 2026-09 实测迁移 (见各收集器头注)。

// ===== 收集器输出 =====

// 单条用量聚合 (收集器按 session / 消息 / 日粒度聚合输出, 见各收集器头注)
export interface UsageRecord {
  model: string; // agent 原始模型串; opencode 统一为 "providerID/modelId" 拼接
  ts: number; // epoch ms
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AgentId = "opencode" | "claude-code" | "codex";

// 全部源清单 SSOT — args 的 --agent 合法域与 discover 的探测范围同源 (分叉会出现
// "--agent 拒绝但探测支持" 或反之的静默不一致); 新增 agent 时改此处 + 各分发点
export const ALL_AGENTS: readonly AgentId[] = ["opencode", "claude-code", "codex"];

export interface ParseResult {
  agent: AgentId;
  records: UsageRecord[]; // 未匹配模型的原始串原样保留 (匹配是站点引擎的事)
  skippedFiles: string[]; // 无法解析的文件, 含原因后缀
}

// ===== 分享 payload (站点 /calc #u= 比特兼容契约) =====
// 键序即序列化序: v → records → spanHint → pasteLike (record 键序 model → ts →
// inputTokens → outputTokens → cacheReadTokens → cacheWriteTokens)。站点 decodeShare
// 是 JSON.parse (键序无感), 但固定键序保证本包 encode 输出确定性 (golden vector 可测)。
export interface SharePayload {
  v: 1;
  records: UsageRecord[];
  spanHint: {firstTs: number; lastTs: number} | null;
  pasteLike: boolean;
}

// ===== 上传档案 (CONTRACT.md §1 冻结面) =====

export interface ProfileModelV1 {
  id: string; // agent 原始模型串 (引擎按裸 id 匹配 burnRate, 按原始串匹配 API 价)
  inputT: number; // 月化输入 token 速率 (tokens/月, 由收集器按 spanDays 外推)
  outputT: number;
  cacheReadT: number;
  cacheWriteT: number;
}

export interface ProfileV1 {
  schema: "pricey-tokens-profile/v1";
  agent: string; // 用量归属 agent (单源 = 源名; 多源混合 = "mixed")
  spanDays: number; // 数据时间跨度 (天, int), 倍数月化的分母
  models: ProfileModelV1[];
  planUsed?: string | null;
  collectedAt: number; // epoch ms
  toolVersion: string;
  trust?: "anon" | "github"; // B3 前 CLI 恒缺省 anon
}

// ===== CLI 参数 (args.ts 解析产物, 集中预处理: 下游拿到的恒为合法值) =====

export interface Options {
  json: boolean;
  upload: boolean;
  share: boolean;
  yes: boolean;
  days: number | "all"; // all = 全量; 数字 ≥ 1
  agents: AgentId[]; // 空数组 = 全部源
  api: string; // 上传 API base (无尾斜杠)
  site: string; // 分享站点 base (以 / 结尾或含 /calc/ 路径)
}
