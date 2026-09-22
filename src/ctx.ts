// ctx.ts — ctxEstimate 上下文估算公式 + ctx/maxCtx 9 桶直方图 + outHist 4 桶直方图 (契约冻结, 2026-09-22)
// 职责边界: 单一模块承载 ctxEstimate 的 provider 家族路由与两张桶边界表 + DB 独立列名 —
// 这是跨端可比性的前提 (设计文档 §5 契约冻结三件): 全客户端必须同公式入桶, 改公式或改桶
// = 契约版本 bump, 老数据按旧桶解释。严禁在其他模块复现任何一者 (含 SQL 侧)。
//
// 公式 (冻结):
//   Anthropic 系 (model 串 claude* 前缀, 或 provider 段 = "anthropic"):
//     ctx = in + cr + cw   (input ⊥ cacheRead ⊥ cacheWrite, 三者不相交)
//   OpenAI 系 (provider 段 = "openai", 或 id 段 openai*/gpt*/o*/codex* 前缀):
//     ctx = in             (cached ⊆ prompt, 计入 prompt 已覆盖)
//   未知缺省: ctx = in + cr + cw (宁可高估不漏计; 与 Anthropic 系同式)
// 桶边界 (2026-09-22 用户裁决: 32k 以下不分桶 — 小请求无决策差异, 决策面全在
// 128k+ 帽位; 9 桶, 左开右闭):
//   (0,32k] (32k,64k] (64k,128k] (128k,200k] (200k,256k] (256k,512k] (512k,1M] (1M,2M] (2M,∞)
//
// outHist (输出规模分布, 冻结; 同裁决 32k 合桶, 4 桶): 单请求 outputTokens 落桶,
// 物理量无公式路由 (家族路由是 ctx 特有的计费语义, out 无此分叉)。左开右闭:
//   (0,32k] (32k,64k] (64k,128k] (128k,∞)
// 注: out=0 (纯输入请求) 计桶 0 — 不变量 ΣoutHist==nReq 要求每请求恰落一桶。
//
// DB 列名 (分析面独立列, 用户裁决 "db 无复合字段"): 每桶一列, 名 = <前缀>_<下界>_<上界>
// 的区间命名 (ctx_200k_256k = (200000, 256000] 桶; 末桶上界 inf)。count(>X) = Σ{列:
// 下界 ≥ X} 列 — 列名即区间, 零心算。JSON 契约 (传输面) 仍是数组, DB (分析面) 拆列 —
// 两面各按其职。

export type CtxFamily = "anthropic" | "openai" | "unknown";

// 桶上界表 (末桶无上界); 长度 = 桶数 - 1。**十进制档** (k=10³): 与套餐限额
// (200k = 200,000 tokens 等) 精确对齐 — 尾桶求和即超限计数, 无插值误差;
// 与 API 侧 site/src/types.ts CTX_HIST_BOUNDS 逐值相同 (跨端一致是硬约束)
export const CTX_BUCKET_EDGES: readonly number[] = [
  32000, 64000, 128000, 200000, 256000, 512000, 1000000, 2000000,
] as const;

export const CTX_BUCKET_COUNT = CTX_BUCKET_EDGES.length + 1; // 9

// 零向量直方图 (独立副本, 勿共享引用)
export function emptyCtxHist(): number[] {
  return Array.from({length: CTX_BUCKET_COUNT}, () => 0);
}

// ===== outHist 输出规模直方图 (4 桶) =====

// 桶上界表 (末桶无上界); 长度 = 桶数 - 1 (十进制档, 同 CTX 注记)
export const OUT_BUCKET_EDGES: readonly number[] = [
  32000, 64000, 128000,
] as const;

export const OUT_BUCKET_COUNT = OUT_BUCKET_EDGES.length + 1; // 4

export function emptyOutHist(): number[] {
  return Array.from({length: OUT_BUCKET_COUNT}, () => 0);
}

// ===== DB 独立列名 (day_stats 分析面; 与桶表同源生成, 勿手抄) =====

// 数值 → 列名段 (十进制 32k/200k/1m/2m 风格; 0 → "0")
function boundTag(v: number): string {
  if (v === 0) return "0";
  if (v % 1_000_000 === 0) return `${v / 1_000_000}m`;
  if (v % 1000 === 0) return `${v / 1000}k`;
  return String(v);
}

// 桶 i 的区间标签 [下界段, 上界段] (下界 = i==0 ? 0 : edges[i-1]; 末桶上界 "inf")
function intervalTags(edges: readonly number[]): Array<[string, string]> {
  return Array.from({length: edges.length + 1}, (_, i) => [
    boundTag(i === 0 ? 0 : edges[i - 1]!),
    i < edges.length ? boundTag(edges[i]!) : "inf",
  ]);
}

// ctx/maxCtx 直方图的 9 个列名: ctx_0_32k, ctx_32k_64k, ..., ctx_2m_inf
export const CTX_HIST_COLS: readonly string[] = intervalTags(CTX_BUCKET_EDGES).map(([lo, hi]) => `ctx_${lo}_${hi}`);

// outHist 的 4 个列名: out_0_32k, out_32k_64k, out_64k_128k, out_128k_inf
export const OUT_HIST_COLS: readonly string[] = intervalTags(OUT_BUCKET_EDGES).map(([lo, hi]) => `out_${lo}_${hi}`);

// maxCtxHist 的 9 个列名: mctx_0_32k, ..., mctx_2m_inf
export const MCTX_HIST_COLS: readonly string[] = intervalTags(CTX_BUCKET_EDGES).map(([lo, hi]) => `mctx_${lo}_${hi}`);

// model 串 → provider 家族。"providerID/modelId" 拼接串取首 "/" 拆段; 裸串整体
// 视为 id 段。anthropic 判定在前 (claude* 永不落入 openai 的 o* 前缀误伤)。
export function ctxFamily(model: string): CtxFamily {
  const slash = model.indexOf("/");
  const provider = slash === -1 ? "" : model.slice(0, slash);
  const id = slash === -1 ? model : model.slice(slash + 1);
  if (provider === "anthropic" || id.startsWith("claude")) return "anthropic";
  if (provider === "openai" || id.startsWith("openai") || id.startsWith("gpt") || id.startsWith("o") || id.startsWith("codex")) {
    return "openai";
  }
  return "unknown";
}

// 家族路由的 ctx 估算 (冻结公式本体)
export function ctxEstimate(model: string, t: {inT: number; crT: number; cwT: number}): number {
  return ctxFamily(model) === "openai" ? t.inT : t.inT + t.crT + t.cwT;
}

// 边界表 → 落桶序号 (左开右闭区间, 边界值归左桶: 4096 ∈ (0,4k] → 桶 0)。
// 两张直方图共用同一找桶逻辑, 分叉会致桶语义静默不一致。
function bucketIndex(edges: readonly number[], v: number): number {
  for (let i = 0; i < edges.length; i++) {
    if (v <= edges[i]!) return i;
  }
  return edges.length;
}

// ctx 值 → 桶序号 0..11
export function ctxBucketIndex(ctx: number): number {
  return bucketIndex(CTX_BUCKET_EDGES, ctx);
}

// out 值 → 桶序号 0..8 (0 计桶 0 — 见头注 [0,1k] 注记)
export function outBucketIndex(out: number): number {
  return bucketIndex(OUT_BUCKET_EDGES, out);
}
