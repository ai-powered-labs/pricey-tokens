// ctx.ts — ctxEstimate 上下文估算公式 + 12 桶直方图 + outHist 9 桶直方图 (契约冻结, 2026-09-22)
// 职责边界: 单一模块承载 ctxEstimate 的 provider 家族路由与两张桶边界表 — 这是跨端
// 可比性的前提 (设计文档 §5 契约冻结三件): 全客户端必须同公式入桶, 改公式或改桶
// = 契约版本 bump, 老数据按旧桶解释。严禁在其他模块复现任何一者 (含 SQL 侧)。
//
// 公式 (冻结):
//   Anthropic 系 (model 串 claude* 前缀, 或 provider 段 = "anthropic"):
//     ctx = in + cr + cw   (input ⊥ cacheRead ⊥ cacheWrite, 三者不相交)
//   OpenAI 系 (provider 段 = "openai", 或 id 段 openai*/gpt*/o*/codex* 前缀):
//     ctx = in             (cached ⊆ prompt, 计入 prompt 已覆盖)
//   未知缺省: ctx = in + cr + cw (宁可高估不漏计; 与 Anthropic 系同式)
// 桶边界 (对数档+套餐语境档, 12 桶, 左开右闭):
//   (0,4k] (4k,8k] (8k,16k] (16k,32k] (32k,64k] (64k,128k]
//   (128k,200k] (200k,256k] (256k,512k] (512k,1M] (1M,2M] (2M,∞)
//
// outHist (输出规模分布, 冻结): 单请求 outputTokens 落桶, 物理量无公式路由
// (家族路由是 ctx 特有的计费语义, out 无此分叉)。9 桶, 左开右闭:
//   (0,1k] (1k,2k] (2k,4k] (4k,8k] (8k,16k] (16k,32k] (32k,64k] (64k,128k] (128k,∞)
// 注: out=0 (纯输入请求) 计桶 0 — 不变量 ΣoutHist==nReq 要求每请求恰落一桶,
// [0,1k] 与首桶合并是结构性选择, 与 ctxHist 同款。

export type CtxFamily = "anthropic" | "openai" | "unknown";

// 桶上界表 (末桶无上界); 长度 = 桶数 - 1
export const CTX_BUCKET_EDGES: readonly number[] = [
  4096, 8192, 16384, 32768, 65536, 131072, 204800, 262144, 524288, 1048576, 2097152,
] as const;

export const CTX_BUCKET_COUNT = CTX_BUCKET_EDGES.length + 1; // 12

// 零向量直方图 (独立副本, 勿共享引用)
export function emptyCtxHist(): number[] {
  return Array.from({length: CTX_BUCKET_COUNT}, () => 0);
}

// ===== outHist 输出规模直方图 (9 桶) =====

// 桶上界表 (末桶无上界); 长度 = 桶数 - 1
export const OUT_BUCKET_EDGES: readonly number[] = [
  1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
] as const;

export const OUT_BUCKET_COUNT = OUT_BUCKET_EDGES.length + 1; // 9

export function emptyOutHist(): number[] {
  return Array.from({length: OUT_BUCKET_COUNT}, () => 0);
}

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
