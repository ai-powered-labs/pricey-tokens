// share.ts — 分享 hash 编码 (站点 /calc #u= 比特兼容契约的 CLI 侧)
// 职责边界: SharePayload → lz-string compressToEncodedURIComponent(JSON) — 与站点
// src/share/hash.ts 的 encodeShare 同一算法同一键序 (v → records → spanHint →
// pasteLike; record: model → ts → inputTokens → outputTokens → cacheReadTokens →
// cacheWriteTokens), 站点 decodeShare (JSON.parse, 逐字段校验) 必须能解。
// CLI 生成侧语义: 有真实日粒度时间线 → spanHint: null (跨度由 records 时间线派生),
// pasteLike: false (恢复侧按 usage-export 语义 — 5h 峰值约束参与, 日粒度高估为
// 保守方向)。压缩比实测 6-8x; 大库 hash 超限警告阈值 (90KB) 定义于此。
// 坑: lz-string 是纯 CJS 包, node ESM 下必须默认导入后解构, named import 会炸。
import lzString from "lz-string";
import type {SharePayload, UsageRecord} from "./types.js";

const {compressToEncodedURIComponent} = lzString;

export const HASH_WARN_BYTES = 90 * 1024; // URL 过长风险阈值 (~90KB 后部分浏览器/终端受限)

export function encodeShare(payload: SharePayload): string {
  return compressToEncodedURIComponent(JSON.stringify(payload));
}

// 日粒度 records → 站点分享 payload (CLI 生成侧唯一形态)
export function sharePayloadOf(records: UsageRecord[]): SharePayload {
  return {v: 1, records, spanHint: null, pasteLike: false};
}

// site base + hash → 完整 URL; site 缺尾斜杠时补齐 (calc 页 hash 定位)
export function buildShareUrl(site: string, hash: string): string {
  const base = site.endsWith("/") ? site : `${site}/`;
  return `${base}#u=${hash}`;
}
