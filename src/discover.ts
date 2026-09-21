// discover.ts — 本机 agent 数据源探测与收集编排
// 职责边界: 按各 agent 的约定数据位置探测存在性, 枚举文件并调用对应收集器; 输出
// 探测报告 (每源 found/缺失) 供 CLI 摘要与测试断言。数据位置约定:
//   - opencode: $XDG_DATA_HOME/opencode/opencode*.db (缺省 ~/.local/share/opencode/)
//     收集数据目录下全部 opencode*.db — main/stable/local/fork 各通道安装各有独立
//     库且互不共享会话, 全收防漏 (2026-09 本机实测活跃库在 opencode-stable.db);
//     非常规的库副本同收会双计, README 注明。
//   - claude-code: ~/.claude/projects/**/*.jsonl (project 目录下会话文件)
//   - codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; 路径日期可解析且整日
//     (+1 天余量) 在窗口外时整树剪枝 (IO 优化, 语义过滤在各收集器)。
// 单源收集失败 (库损坏 / 列缺失) 转该源 skipped 不拖垮其他源。
import {readdir, stat} from "node:fs/promises";
import {join} from "node:path";
import type {AgentId, ParseResult, UsageRecord} from "./types.js";
import {ALL_AGENTS} from "./types.js";
import {errMsg} from "./guards.js";
import {collectOpencode} from "./collectors/opencode.js";
import {collectClaude} from "./collectors/claude.js";
import {collectCodex} from "./collectors/codex.js";

export interface SourceStatus {
  agent: AgentId;
  found: boolean;
  detail: string; // found: 文件数/库路径; 未 found: 探测位置
}

export interface CollectOutcome {
  results: ParseResult[]; // 每个**发现且收集成功**的源一项 (skipped 并入对应项)
  statuses: SourceStatus[]; // 全部探测源的报告 (含未 found)
}

function dataHome(home: string): string {
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.startsWith("/")
    ? process.env.XDG_DATA_HOME
    : join(home, ".local", "share");
}

// 递归枚举 root 下匹配 filter 的文件; prune 命中时整子树跳过 (codex 日期剪枝)
async function walk(root: string, filter: (path: string) => boolean, prune: (dirPath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const dirs: string[] = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      continue; // 无权限/消失的目录静默跳过 (探测语义由上层 stat 报)
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!prune(p)) dirs.push(p);
      } else if (e.isFile() && filter(p)) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

// sessions/YYYY/MM/DD/… → 该日终了时刻 (UTC 口径, 目录日期本就是 UTC 日界);
// 任一层不可解析返回 null (不剪枝, 保语义)
function dirDayEndMs(path: string): number | null {
  const m = path.match(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d) + 86400000; // 当日 24:00 = 下一日 00:00
  return Number.isFinite(t) ? t : null;
}

export interface CollectOptions {
  agents: AgentId[]; // 空 = 全部
  sinceMs: number | null; // null = 全量
  home?: string; // 注入 home (测试); 缺省 os.homedir()
}

export async function collectAll(opts: CollectOptions): Promise<CollectOutcome> {
  const home = opts.home ?? (await import("node:os")).homedir();
  const wanted = new Set(opts.agents.length === 0 ? ALL_AGENTS : opts.agents);
  const statuses: SourceStatus[] = [];
  const results: ParseResult[] = [];

  // --- opencode ---
  // 数据目录下全部 opencode*.db (排除 -shm/-wal/journal 边车): main/stable/local/fork
  // 各通道安装各有独立库且互不共享会话, 全收防漏 (2026-09 本机实测活跃库在
  // opencode-stable.db 而非 opencode.db); 非常规的库副本同收会双计, README 注明
  if (wanted.has("opencode")) {
    const dir = join(dataHome(home), "opencode");
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
    dbs.sort();
    if (dbs.length === 0) {
      statuses.push({agent: "opencode", found: false, detail: `${dir}/opencode*.db`});
    } else {
      const records: UsageRecord[] = [];
      const skipped: string[] = [];
      for (const dbPath of dbs) {
        try {
          const r = await collectOpencode(dbPath, opts.sinceMs);
          records.push(...r.records);
          statuses.push({agent: "opencode", found: true, detail: `${dbPath} (${r.records.length} 会话)`});
        } catch (e) {
          skipped.push(`${dbPath} (${errMsg(e)})`);
          statuses.push({agent: "opencode", found: true, detail: `${dbPath} (收集失败: ${errMsg(e)})`});
        }
      }
      results.push({agent: "opencode", records, skippedFiles: skipped});
    }
  }

  // --- claude-code / codex (jsonl 双源, 同骨架: stat → walk → collect → status) ---
  interface JsonlSpec {
    agent: AgentId;
    root: string;
    notFoundDetail: string; // 探测位置描述 (未 found 时)
    fileFilter: (p: string) => boolean;
    prune: (dir: string) => boolean;
    collect: (paths: string[], sinceMs: number | null) => Promise<ParseResult>;
    unit: string; // 窗口内计数单位文案 ("条消息" / "个会话")
  }
  const collectJsonl = async (spec: JsonlSpec): Promise<void> => {
    let dirExists = false;
    let files: string[] = [];
    try {
      await stat(spec.root);
      dirExists = true;
      files = await walk(spec.root, spec.fileFilter, spec.prune);
    } catch {
      // 目录不存在/不可读 → 未发现
    }
    if (!dirExists) {
      statuses.push({agent: spec.agent, found: false, detail: spec.notFoundDetail});
      return;
    }
    // 目录存在但文件为空 (全被日期剪枝/空目录) 仍报 found — "窗口外有数据"≠"源未装"
    const r = await spec.collect(files, opts.sinceMs);
    statuses.push({agent: spec.agent, found: true, detail: `${files.length} 个会话文件 (窗口内 ${r.records.length} ${spec.unit})`});
    results.push(r);
  };
  const specs: JsonlSpec[] = [
    {
      agent: "claude-code",
      root: join(home, ".claude", "projects"),
      notFoundDetail: `${join(home, ".claude", "projects")}/**/*.jsonl`,
      fileFilter: (p) => p.endsWith(".jsonl"),
      prune: () => false,
      collect: collectClaude,
      unit: "条消息",
    },
    {
      agent: "codex",
      root: join(home, ".codex", "sessions"),
      notFoundDetail: `${join(home, ".codex", "sessions")}/**/rollout-*.jsonl`,
      fileFilter: (p) => p.endsWith(".jsonl") && /(?:^|\/)rollout-[^/]*\.jsonl$/.test(p),
      prune: (dir) => {
        if (opts.sinceMs === null) return false;
        const dayEnd = dirDayEndMs(dir);
        // +1 天余量: rollout 按会话开始日落目录, 记录 ts 取最后 token_count 时刻 —
        // 跨午夜会话的目录日与事件日差 1 天, 不留余量会把 ts 已进窗的会话静默误剪
        // (语义过滤兜底在各收集器)。超过余量的超长会话仍会被误剪, 属可接受近似。
        return dayEnd !== null && dayEnd + 86400000 <= opts.sinceMs;
      },
      collect: collectCodex,
      unit: "个会话",
    },
  ];
  for (const spec of specs) {
    if (wanted.has(spec.agent)) await collectJsonl(spec);
  }

  return {results, statuses};
}
