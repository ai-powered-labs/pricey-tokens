// discover.ts — 本机 harness 数据源探测与枚举
// 职责边界: 按各 harness 的约定数据位置**只做枚举** (存在性 + 文件清单), 不解析
// 不收集 (摄取编排在 ingest.ts)。数据位置约定:
//   - opencode: $XDG_DATA_HOME/opencode/opencode*.db (缺省 ~/.local/share/opencode/)
//     枚举数据目录下全部 opencode*.db — main/stable/local/fork 各通道安装各有独立
//     库且互不共享会话, 全收防漏 (2026-09 本机实测活跃库在 opencode-stable.db);
//     非常规的库副本同收会双计 (req_key 按库文件名隔离, 副本库的行各自独立),
//     README 注明。
//   - claude-code: ~/.claude/projects/**/*.jsonl (project 目录下会话文件, 含
//     subagents 子目录)。
//   - codex: ~/.codex/sessions/**/rollout-*.jsonl。
// 摄取以水位线增量 (文件 mtime+size / db rowid), 全量枚举本身是廉价操作 (walk +
// stat), 无需按窗口剪枝 — 窗口只是账本查询期概念。
import {readdir} from "node:fs/promises";
import {join} from "node:path";
import type {HarnessId} from "./types.js";

// XDG 数据根 (opencode 源与账本共用此根; 缺省 ~/.local/share)
export function dataHome(home: string): string {
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.startsWith("/")
    ? process.env.XDG_DATA_HOME
    : join(home, ".local", "share");
}

// 递归枚举 root 下匹配 filter 的文件 (排序稳定)
export async function walk(root: string, filter: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const dirs: string[] = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      continue; // 无权限/消失的目录静默跳过 (探测语义由上层 readdir 报)
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) dirs.push(p);
      else if (e.isFile() && filter(p)) out.push(p);
    }
  }
  return out.sort();
}

// opencode 源库清单 (排除 -shm/-wal/journal 边车, 字典序); dataRoot 为已解析的
// XDG 数据根 (与账本同根 — 解析归调用方, 本层不读 env)。目录不存在 → 空清单。
export async function findOpencodeDbs(dataRoot: string): Promise<string[]> {
  const dir = join(dataRoot, "opencode");
  const dbs: string[] = [];
  try {
    for (const e of await readdir(dir, {withFileTypes: true})) {
      if (e.isFile() && /^opencode.*\.db$/.test(e.name) && !/-(shm|wal|journal)$/.test(e.name)) {
        dbs.push(join(dir, e.name));
      }
    }
  } catch {
    // 目录不存在/不可读 → 未发现
  }
  return dbs.sort();
}

// claude-code 会话文件清单 (~/.claude/projects/**/*.jsonl); 目录不存在返回 null
export async function findClaudeFiles(home: string): Promise<string[] | null> {
  const root = join(home, ".claude", "projects");
  try {
    await readdir(root);
  } catch {
    return null;
  }
  return walk(root, (p) => p.endsWith(".jsonl"));
}

// codex 会话文件清单 (~/.codex/sessions/**/rollout-*.jsonl); 目录不存在返回 null
export async function findCodexFiles(home: string): Promise<string[] | null> {
  const root = join(home, ".codex", "sessions");
  try {
    await readdir(root);
  } catch {
    return null;
  }
  return walk(root, (p) => /(?:^|\/)rollout-[^/]*\.jsonl$/.test(p));
}

// 探测位置描述 (未 found 时的 status detail 用 — 与上面三个枚举器同源)
export function notFoundDetail(harness: HarnessId, home: string): string {
  switch (harness) {
    case "opencode":
      return `${join(dataHome(home), "opencode")}/opencode*.db`;
    case "claude-code":
      return `${join(home, ".claude", "projects")}/**/*.jsonl`;
    case "codex":
      return `${join(home, ".codex", "sessions")}/**/rollout-*.jsonl`;
  }
}
