// ctx.test.ts — ctxEstimate 家族路由 + ctx/out 直方图 + DB 列名测试 (契约冻结面的回归锚)
// 覆盖: 家族路由 (claude/anthropic 前缀、openai 四标记、未知缺省)、公式分叉
// (in+cr+cw vs in)、ctx 9 桶与 out 4 桶边界逐值 (左开右闭, 32k 以下合桶)、
// Σhist==nReq 入桶守卫、独立列名 SSOT (gt<下界> 命名)。
import {describe, expect, it} from "bun:test";
import {ctxBucketIndex, ctxEstimate, ctxFamily, CTX_BUCKET_COUNT, CTX_BUCKET_EDGES, CTX_HIST_COLS, emptyCtxHist, outBucketIndex, OUT_BUCKET_COUNT, OUT_BUCKET_EDGES, OUT_HIST_COLS, emptyOutHist, MCTX_HIST_COLS} from "../src/ctx.js";

describe("ctxFamily 路由 (契约冻结)", () => {
  it("Anthropic 系: claude 前缀 / anthropic provider", () => {
    expect(ctxFamily("claude-sonnet-5")).toBe("anthropic");
    expect(ctxFamily("claude-opus-4-6-20260414")).toBe("anthropic");
    expect(ctxFamily("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(ctxFamily("anthropic/whatever")).toBe("anthropic");
  });

  it("OpenAI 系: openai/gpt/o/codex 四标记 (provider 段或 id 段)", () => {
    expect(ctxFamily("gpt-5")).toBe("openai");
    expect(ctxFamily("gpt-5-codex")).toBe("openai");
    expect(ctxFamily("o3")).toBe("openai");
    expect(ctxFamily("o4-mini")).toBe("openai");
    expect(ctxFamily("openai/gpt-5.2")).toBe("openai");
    expect(ctxFamily("openai/strange-id")).toBe("openai");
    expect(ctxFamily("codex-mini-latest")).toBe("openai");
  });

  it("anthropic 判定在前: claude 前缀永不被 o* 误伤", () => {
    expect(ctxFamily("claude-3-opus")).toBe("anthropic");
  });

  it("未知缺省: 非 OpenAI 的 provider/任意串", () => {
    expect(ctxFamily("zai/glm-5.3")).toBe("unknown");
    expect(ctxFamily("zai-coding-plan/glm-5.3")).toBe("unknown");
    expect(ctxFamily("glm-5.3")).toBe("unknown");
    expect(ctxFamily("google/gemini-3-pro")).toBe("unknown");
    expect(ctxFamily("unknown")).toBe("unknown");
  });
});

describe("ctxEstimate 公式 (契约冻结)", () => {
  const t = {inT: 1000, crT: 5000, cwT: 300};

  it("Anthropic 系 = in+cr+cw (三者不相交)", () => {
    expect(ctxEstimate("claude-sonnet-5", t)).toBe(6300);
  });

  it("OpenAI 系 = in (cached ⊆ prompt)", () => {
    expect(ctxEstimate("gpt-5", t)).toBe(1000);
    expect(ctxEstimate("openai/gpt-5", t)).toBe(1000);
  });

  it("未知缺省 = in+cr+cw (与 Anthropic 同式)", () => {
    expect(ctxEstimate("zai/glm-5.3", t)).toBe(6300);
  });
});

describe("ctxBucketIndex 桶界 (左开右闭, 9 桶, 32k 以下合桶)", () => {
  it("桶边界表 = 契约冻结值", () => {
    expect(CTX_BUCKET_EDGES).toEqual([32000, 64000, 128000, 200000, 256000, 512000, 1000000, 2000000]); // 十进制档, 与 API 侧 CTX_HIST_BOUNDS 逐值相同
    expect(CTX_BUCKET_COUNT).toBe(9);
  });

  it("边界值属下侧桶: (0,32k]→0, 32001→1, 桶界值即该桶上界 (十进制)", () => {
    expect(ctxBucketIndex(1)).toBe(0);
    expect(ctxBucketIndex(32000)).toBe(0);
    expect(ctxBucketIndex(32001)).toBe(1);
    expect(ctxBucketIndex(64000)).toBe(1);
    expect(ctxBucketIndex(128000)).toBe(2);
    expect(ctxBucketIndex(200000)).toBe(3); // 128k~200k 桶的上界 (套餐 200k 限额精确对齐)
    expect(ctxBucketIndex(200001)).toBe(4); // 200k~256k (超限首桶)
    expect(ctxBucketIndex(2000000)).toBe(7); // (1M,2M]
    expect(ctxBucketIndex(2000001)).toBe(8); // (2M,∞)
    expect(ctxBucketIndex(1e12)).toBe(8);
  });

  it("emptyCtxHist: 9 维零向量且独立副本", () => {
    const a = emptyCtxHist();
    const b = emptyCtxHist();
    expect(a).toEqual(Array(9).fill(0));
    a[0] = 1;
    expect(b[0]).toBe(0); // 不共享引用
  });

  it("逐请求入桶后 Σhist == n_req (不变量的构造侧来源)", () => {
    const ctxs = [100, 32768, 32769, 100000, 300000, 3000000];
    const hist = emptyCtxHist();
    for (const c of ctxs) hist[ctxBucketIndex(c)]! += 1;
    expect(hist.reduce((a, b) => a + b, 0)).toBe(ctxs.length);
  });
});

describe("outBucketIndex 桶界 (左开右闭, 4 桶, 32k 以下合桶)", () => {
  it("桶边界表 = 契约冻结值", () => {
    expect(OUT_BUCKET_EDGES).toEqual([32000, 64000, 128000]);
    expect(OUT_BUCKET_COUNT).toBe(4);
  });

  it("边界值属左桶: 0→0, 32000→0, 32001→1, 末桶无上界 (十进制)", () => {
    expect(outBucketIndex(0)).toBe(0); // 纯输入请求计桶 0 (ΣoutHist==nReq 要求)
    expect(outBucketIndex(1)).toBe(0);
    expect(outBucketIndex(32000)).toBe(0);
    expect(outBucketIndex(32001)).toBe(1);
    expect(outBucketIndex(64000)).toBe(1);
    expect(outBucketIndex(128000)).toBe(2);
    expect(outBucketIndex(128001)).toBe(3); // (128k,∞)
    expect(outBucketIndex(1e9)).toBe(3);
  });

  it("emptyOutHist: 4 维零向量且独立副本", () => {
    const a = emptyOutHist();
    const b = emptyOutHist();
    expect(a).toEqual(Array(4).fill(0));
    a[0] = 1;
    expect(b[0]).toBe(0);
  });

  it("逐请求入桶后 Σhist == n_req", () => {
    const outs = [0, 500, 32768, 9000, 90000, 500000];
    const hist = emptyOutHist();
    for (const o of outs) hist[outBucketIndex(o)]! += 1;
    expect(hist.reduce((a, b) => a + b, 0)).toBe(outs.length);
  });
});

describe("DB 独立列名 (区间命名 <前缀>_<下界>_<上界>, 分析面无复合字段)", () => {
  it("ctx/mctx 列名 = 9 桶区间 (末桶上界 inf)", () => {
    expect(CTX_HIST_COLS).toEqual(["ctx_0_32k", "ctx_32k_64k", "ctx_64k_128k", "ctx_128k_200k", "ctx_200k_256k", "ctx_256k_512k", "ctx_512k_1m", "ctx_1m_2m", "ctx_2m_inf"]);
    expect(MCTX_HIST_COLS).toEqual(["mctx_0_32k", "mctx_32k_64k", "mctx_64k_128k", "mctx_128k_200k", "mctx_200k_256k", "mctx_256k_512k", "mctx_512k_1m", "mctx_1m_2m", "mctx_2m_inf"]);
  });

  it("out 列名 = 4 桶区间; 列数与桶数一致", () => {
    expect(OUT_HIST_COLS).toEqual(["out_0_32k", "out_32k_64k", "out_64k_128k", "out_128k_inf"]);
    expect(CTX_HIST_COLS.length).toBe(CTX_BUCKET_COUNT);
    expect(OUT_HIST_COLS.length).toBe(OUT_BUCKET_COUNT);
    expect(MCTX_HIST_COLS.length).toBe(CTX_BUCKET_COUNT);
  });
});
