// share.test.ts — 分享 hash 比特兼容测试 (站点 decodeShare 可解的硬保证)
// 覆盖: ① golden vector — 固定输入的期望串由**站点侧算法** (pkgs/pricey-tokens
// src/share/hash.ts 的 encodeShare, lz-string 1.5.0) 预先生成, 本包输出须逐字节
// 相等 (键序/算法/版本任一漂移都会被抓到); ② 本地 roundtrip — 用与站点同版的
// lz-string decompress 还原后逐字段相等; ③ URL 拼接; ④ 大 payload 压缩性。
import {describe, expect, it} from "bun:test";
import lzString from "lz-string";
import {encodeShare, sharePayloadOf, buildShareUrl} from "../src/share.js";
import type {SharePayload, UsageRecord} from "../src/types.js";
import {T0, DAY} from "./fixtures.js";

const {decompressFromEncodedURIComponent} = lzString;

// --- golden vector (生成: 站点 worktree 内 lz-string 1.5.0 compressToEncodedURIComponent
// 对下方 JSON.stringify(payload) 的输出; 记录键序 model→ts→inputTokens→outputTokens→
// cacheReadTokens→cacheWriteTokens, payload 键序 v→records→spanHint→pasteLike) ---
const goldenRecords: UsageRecord[] = [
  {model: "zai/glm-5.3", ts: T0, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 0},
  {model: "zai/glm-5.3", ts: T0 + DAY, inputTokens: 2000, outputTokens: 200, cacheReadTokens: 6000, cacheWriteTokens: 10},
  {model: "claude-sonnet-5", ts: T0 + DAY, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 7},
  {model: "gpt-5.2-codex", ts: T0 + 2 * DAY, inputTokens: 400, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0},
];
const goldenHash = "N4IgbiBcCMA0ICcCmBjA9ggJgZygbVAFs1MkAbKEALwEMBLAegHMzCBaAVgDoBmEeAC64YAdhEAOAEySALLICc0ST3h0AdgAcArgIAqaANZI1w6AAYL8NDu17Dx05ZAoaKABZIASkhqZ9RkygOCzN4F3ckAHUEOgEkfwcoMwBfWCISckpaRhZ2bj5BUzFxHnMANhlFZVVNHQTAyEkQqxs6+wam0OdXD29feuEy5u6I6Nj49sdU9NIKSGcyGi1SNmw0NTUkAU5+ECEoaGLSswqqlRB1WwGoHidrASvJm67w3p8-J8gXnqiYuOvICJpiBiLNKEwNNtuJI2OhSAAPXb7UQSHjyERmSpKc6XNoBYQyO6tOz4qCEsI-PofUmQcROV6-cYAlIAXXg2A0NDUAAl1AIoGotGQyPBOdg4gAZOhGKAAMxoZGwSGSQA";

describe("golden vector (站点比特兼容)", () => {
  it("固定输入 → 与站点算法输出逐字节相等", () => {
    const payload: SharePayload = {v: 1, records: goldenRecords, spanHint: null, pasteLike: false};
    expect(encodeShare(payload)).toBe(goldenHash);
  });

  it("键序漂移会被 golden 抓到 (spanHint 在前 → 不同串)", () => {
    const bad = {records: goldenRecords, spanHint: null, pasteLike: false, v: 1} as SharePayload;
    expect(encodeShare(bad)).not.toBe(goldenHash);
  });
});

describe("roundtrip (站点 decodeShare 同版解压)", () => {
  it("decode → JSON 形状与站点校验契约逐字段满足", () => {
    const json = decompressFromEncodedURIComponent(goldenHash);
    expect(json).not.toBeNull();
    const p = JSON.parse(json!) as SharePayload;
    expect(p.v).toBe(1);
    expect(p.records).toEqual(goldenRecords);
    expect(p.spanHint).toBeNull();
    expect(p.pasteLike).toBe(false);
  });

  it("sharePayloadOf: CLI 生成侧形态 (spanHint null / pasteLike false)", () => {
    const payload = sharePayloadOf(goldenRecords);
    expect(payload).toEqual({v: 1, records: goldenRecords, spanHint: null, pasteLike: false});
  });

  it("大 payload (30 天 × 多模型) 显著压缩", () => {
    const records: UsageRecord[] = [];
    for (let d = 0; d < 30; d++) {
      for (const m of ["zai/glm-5.3", "claude-sonnet-5", "gpt-5.2-codex"]) {
        records.push({model: m, ts: T0 + d * DAY, inputTokens: 12345 + d, outputTokens: 678, cacheReadTokens: 99999, cacheWriteTokens: 12});
      }
    }
    const hash = encodeShare(sharePayloadOf(records));
    expect(hash.length).toBeGreaterThan(100);
    expect(hash.length).toBeLessThan(JSON.stringify(records).length / 3);
    const back = JSON.parse(decompressFromEncodedURIComponent(hash)!) as SharePayload;
    expect(back.records).toEqual(records);
  });
});

describe("buildShareUrl", () => {
  it("site 补尾斜杠后拼 #u=", () => {
    expect(buildShareUrl("https://pricey-tokens.lambda.lc/calc/", "ABC")).toBe("https://pricey-tokens.lambda.lc/calc/#u=ABC");
    expect(buildShareUrl("http://localhost:4321/calc", "X")).toBe("http://localhost:4321/calc/#u=X");
  });
});
