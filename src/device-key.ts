// device-key.ts — 上传去重键的本地持久化
// 职责边界: ~/.config/pricey-tokens/device-key (XDG_CONFIG_HOME 优先) 存取一个
// UUID — 契约 (CONTRACT.md §1) 的 X-Dedupe-Key: 首次生成后长期复用, 同 key 重复
// 上传 = 覆盖前档 (latest wins)。仅用于去重, 不进任何聚合输出。文件 0600 (它是
// 档案所有权凭据, 勿让同机其他用户读走冒名覆盖)。
import {mkdir, readFile, writeFile, rename} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

function keyPath(home: string): string {
  const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.startsWith("/")
    ? process.env.XDG_CONFIG_HOME
    : join(home, ".config");
  return join(configHome, "pricey-tokens", "device-key");
}

// 读已有 key (非空且形如 UUID); 不存在/损坏时生成新 key 落盘。目录注入供测试。
export async function loadOrCreateDeviceKey(home?: string): Promise<string> {
  const h = home ?? (await import("node:os")).homedir();
  const file = keyPath(h);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) return existing;
  } catch {
    // 不存在/不可读 → 走生成
  }
  const key = randomUUID();
  await mkdir(join(file, ".."), {recursive: true});
  // temp+rename 原子落盘: 崩溃中断不留半截 key (半截会被下次当损坏重生新 UUID,
  // 产生孤儿档案); rename 同文件系统原子替换, mode 在创建时生效
  const tmp = `${file}.tmp`;
  await writeFile(tmp, key + "\n", {mode: 0o600});
  await rename(tmp, file);
  return key;
}
