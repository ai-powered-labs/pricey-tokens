// upload.ts — ProfileV1 上传 (POST {api}/api/v1/profiles, CONTRACT.md §1 冻结面)
// 职责边界: 预览 (原样打印完整 payload — HA 遥测规范: 用户须能看到将发送的一切) →
// 确认 (--yes 或 TTY 交互; 非 TTY 且无 --yes 拒绝) → POST (X-Dedupe-Key 头) → 响应
// 解析 {profileId, shareUrl}。shareUrl 是站内相对路径 (/share/N), 由调用方拼 API
// base 成完整 URL。网络/非 2xx 响应抛错, 响应体 {"error": "<中文原因>"} 原样透传。
import {createInterface} from "node:readline/promises";
import {stdin, stderr as stderrStream} from "node:process";
import type {ProfileV1} from "./types.js";

export interface UploadResult {
  profileId: number;
  shareUrl: string; // 站内相对路径 (如 /share/7)
}

export function previewText(profile: ProfileV1): string {
  return JSON.stringify(profile, null, 2);
}

// 交互确认: --yes 直接过; TTY 下读一行 y/yes (其余拒); 非 TTY 拒 (无 --yes 时)
export async function confirmUpload(yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!stdin.isTTY) {
    process.stderr.write("非交互环境且未传 --yes, 已取消上传 (管道/脚本场景请显式加 --yes)\n");
    return false;
  }
  // prompt 走 stderr: --json 模式 stdout 必须只有 JSON (readline 的 output 是
  // prompt 回显通道, 不参与读取)
  const rl = createInterface({input: stdin, output: stderrStream});
  try {
    const answer = (await rl.question("确认上传以上内容? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function uploadProfile(api: string, profile: ProfileV1, dedupeKey: string): Promise<UploadResult> {
  const res = await fetch(`${api}/api/v1/profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dedupe-Key": dedupeKey,
    },
    body: JSON.stringify(profile),
    signal: AbortSignal.timeout(30_000), // API 不可达时别让 CLI 永久挂起
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = String((JSON.parse(text) as {error?: unknown}).error ?? text);
    } catch {
      // 非 JSON 错误体原样展示
    }
    throw new Error(`上传失败 (HTTP ${res.status}): ${detail}`);
  }
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error(`上传响应非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const r = o as {profileId?: unknown; shareUrl?: unknown};
  if (typeof r.profileId !== "number" || typeof r.shareUrl !== "string") {
    throw new Error(`上传响应形状异常 (缺 profileId/shareUrl): ${text.slice(0, 200)}`);
  }
  return {profileId: r.profileId, shareUrl: r.shareUrl};
}
