// browser.ts — 跨平台打开浏览器 (--web 的显式出口; 默认出口只打印 URL, 不动浏览器)
// 职责边界: spawn 平台 opener 后即脱管 (detached + ignore stdio + unref, CLI 不等
// 浏览器); opener 不存在时静默降级 — 调用方已把 URL 打印到 stdout, 用户可手动打开。
import {spawn} from "node:child_process";

export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, {detached: true, stdio: "ignore"});
    child.on("error", () => undefined); // ENOENT 等静默 (URL 已打印, 手动打开兜底)
    child.unref();
  } catch {
    // 同上: 打开失败不构成 CLI 失败
  }
}
