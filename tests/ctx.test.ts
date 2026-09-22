// ctx.test.ts — ctxEstimate 家族路由 + ctx/out 两张直方图测试 (契约冻结面的回归锚)
// 覆盖: 家族路由 (claude/anthropic 前缀、openai 四标记、未知缺省)、公式分叉
// (in+cr+cw vs in)、ctx 12 桶与 out 9 桶边界逐值 (左开右闭)、Σhist==nReq 入桶守卫。
import {describe, expect, it} from "bun:test";
import {ctxBucketIndex, ctxEstimate, ctxFamily, CTX_BUCKET_COUNT, CTX_BUCKET_EDGES, emptyCtxHist, outBucketIndex, OUT_BUCKET_COUNT, OUT_BUCKET_EDGES, emptyOutHist} from "../src/ctx.js";

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

describe("ctxBucketIndex 桶界 (左开右闭, 12 桶)", () => {
  it("桶边界表 = 契约冻结值", () => {
    expect(CTX_BUCKET_EDGES).toEqual([4096, 8192, 16384, 32768, 65536, 131072, 204800, 262144, 524288, 1048576, 2097152]);
    expect(CTX_BUCKET_COUNT).toBe(12);
  });

  it("边界值属下侧桶: (0,4k]→0, 4097→1, 桶界值即该桶上界", () => {
    expect(ctxBucketIndex(1)).toBe(0);
    expect(ctxBucketIndex(4096)).toBe(0);
    expect(ctxBucketIndex(4097)).toBe(1);
    expect(ctxBucketIndex(8192)).toBe(1);
    expect(ctxBucketIndex(131072)).toBe(5);
    expect(ctxBucketIndex(204800)).toBe(6); // 128k~200k 桶的上界
    expect(ctxBucketIndex(204801)).toBe(7); // 200k~256k (套餐语境档)
    expect(ctxBucketIndex(2097152)).toBe(10); // (1M,2M]
    expect(ctxBucketIndex(2097153)).toBe(11); // (2M,∞)
    expect(ctxBucketIndex(1e12)).toBe(11);
  });

  it("emptyCtxHist: 12 维零向量且独立副本", () => {
    const a = emptyCtxHist();
    const b = emptyCtxHist();
    expect(a).toEqual(Array(12).fill(0));
    a[0] = 1;
    expect(b[0]).toBe(0); // 不共享引用
  });

  it("逐请求入桶后 Σhist == n_req (不变量的构造侧来源)", () => {
    const ctxs = [100, 4096, 4097, 100000, 300000, 3000000];
    const hist = emptyCtxHist();
    for (const c of ctxs) hist[ctxBucketIndex(c)]! += 1;
    expect(hist.reduce((a, b) => a + b, 0)).toBe(ctxs.length);
  });
});

describe("outBucketIndex 桶界 (左开右闭, 9 桶)", () => {
  it("桶边界表 = 契约冻结值 (1k..128k 对数档)", () => {
    expect(OUT_BUCKET_EDGES).toEqual([1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]);
    expect(OUT_BUCKET_COUNT).toBe(9);
  });

  it("边界值属左桶: 0→0 ([0,1k] 合并), 1024→0, 1025→1, 末桶无上界", () => {
    expect(outBucketIndex(0)).toBe(0); // 纯输入请求计桶 0 (ΣoutHist==nReq 要求)
    expect(outBucketIndex(1)).toBe(0);
    expect(outBucketIndex(1024)).toBe(0);
    expect(outBucketIndex(1025)).toBe(1);
    expect(outBucketIndex(2048)).toBe(1);
    expect(outBucketIndex(65536)).toBe(6);
    expect(outBucketIndex(131072)).toBe(7);
    expect(outBucketIndex(131073)).toBe(8); // (128k,∞)
    expect(outBucketIndex(1e9)).toBe(8);
  });

  it("emptyOutHist: 9 维零向量且独立副本", () => {
    const a = emptyOutHist();
    const b = emptyOutHist();
    expect(a).toEqual(Array(9).fill(0));
    a[0] = 1;
    expect(b[0]).toBe(0);
  });

  it("逐请求入桶后 Σhist == n_req", () => {
    const outs = [0, 500, 1024, 9000, 90000, 500000];
    const hist = emptyOutHist();
    for (const o of outs) hist[outBucketIndex(o)]! += 1;
    expect(hist.reduce((a, b) => a + b, 0)).toBe(outs.length);
  });
});
