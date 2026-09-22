// types.ts — 本包共享类型契约 SSOT
// 职责边界: 定义 收集器输出 (RequestRow — request 粒度账本行)、分享 payload
// (SharePayload)、上传档案 (ProfileV2) 三组契约。SharePayload 字段形态与站点
// (pricey-tokens-website 仓 site/src/types.ts + site/src/share/hash.ts) 逐字对齐
// — 站点比特兼容面, 修改须回写上游契约; ProfileV2 与 API 契约 (同仓
// api/CONTRACT.md) 对齐。口径来源: 站点解析器 2026-09 实测迁移 (见各收集器头注)。

// ===== 收集器输出 (request 粒度, 归并进账本的原子) =====

// 单条 API 请求的用量 (账本 requests 表的行形态; 请求不可变 ⇒ 归并幂等)
export interface RequestRow {
  harness: HarnessId;
  reqKey: string; // 归并键: claude=messageId / codex=rollout 文件名+事件序 / opencode=库名+rowid
  sessKey: string; // 会话归属 (对账 + n_sess 派生用)
  model: string; // 工具原始模型串; opencode 统一为 "providerID/modelId" 拼接
  ts: number; // 请求真实时刻 epoch ms
  inT: number;
  outT: number;
  crT: number;
  cwT: number;
  nTools: number; // 该请求 assistant 消息中的工具调用数 (源格式不可得时恒 0, 见各收集器头注)
}

// 用户轮次原子 (账本 turn_events 表的行形态; 用户行不入 requests, 摄取时顺路计数)。
// 键契约 (与 reqKey 同风格): claude="<sessKey>:<uuid|@line:N>" / opencode="<库名>:<rowid>"
// / codex="<rollout 文件名>#tc<文件内 turn_context 序号>"; INSERT OR IGNORE 归并幂等。
export interface TurnRow {
  harness: HarnessId;
  turnKey: string;
  sessKey: string;
}

export type HarnessId = "opencode" | "claude-code" | "codex";

// 全部源清单 SSOT — args 的 --harness 合法域与 discover 的探测范围同源 (分叉会出现
// "--harness 拒绝但探测支持" 或反之的静默不一致); 新增 harness 时改此处 + 各分发点
export const ALL_HARNESSES: readonly HarnessId[] = ["opencode", "claude-code", "codex"];

// 日粒度聚合记录 (分享 hash 的载荷; 账本窗口查询派生, 形态与站点解析器输出同构)
export interface UsageRecord {
  model: string; // 工具原始模型串; opencode 统一为 "providerID/modelId" 拼接
  ts: number; // epoch ms (日粒度聚合时 = 当日该模型最后活跃时刻)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

// ===== 上传档案 (ProfileV2 — day 粒度 + ctx 直方图 sketch) =====

// 模型日行: 四分类 + 会话/请求计数 + 三张直方图 (契约冻结桶界见 ctx.ts)。
// 字段集 v2 终态 (设计 §5): request 原子直方图 ctxHist/outHist (Σ==nReq),
// 会话原子直方图 maxCtxHist (Σ ≤ nSess, 会话按 (last_ts 日, 主模型) 归因,
// 一会话一增量), 加法标量 nTurns (会话归因) / nToolCalls (request 各归各)。
export interface ProfileModelV2 {
  id: string; // 工具原始模型串 (引擎按裸 id 匹配 burnRate, 按原始串匹配 API 价)
  in: number;
  out: number;
  cr: number;
  cw: number;
  nSess: number; // 该日该模型的去重会话数 (request 侧: 当日有该模型请求的会话)
  nReq: number; // 该日该模型的请求数
  ctxHist: number[]; // 12 维计数向量, 不变量 ΣctxHist == nReq
  outHist: number[]; // 9 维计数向量 (单请求输出规模), 不变量 ΣoutHist == nReq
  nTurns: number; // 用户轮次数 (会话归因: 主模型 × last_ts 日)
  nToolCalls: number; // 工具调用数 (request 各归各: Σ requests.n_tools)
  maxCtxHist: number[]; // 12 维计数向量 (会话最深上下文, 复用 ctx 桶表), ΣmaxCtxHist ≤ nSess (按日聚合保证)
}

export interface ProfileDayV2 {
  day: string; // 本地日 "YYYY-MM-DD"
  models: ProfileModelV2[];
}

export interface ProfileV2 {
  schema: "pricey-tokens-profile/v2";
  harness: string; // 用量归属 harness 工具 (单源 = 源名; 多源混合 = "mixed")
  days: ProfileDayV2[]; // 窗口内日行 (day 升序, 模型按用量降序)
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
  verbose: boolean; // 过程详情 (探测/跳过/对账/账本增量) — 默认压缩隐藏
  days: number | "all"; // all = 全量; 数字 ≥ 1
  harnesses: HarnessId[]; // 空数组 = 全部源
  api: string; // 上传 API base (无尾斜杠)
  site: string; // 分享站点 base (以 / 结尾或含 /calc/ 路径)
}
