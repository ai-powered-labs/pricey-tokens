// discover.test.ts — 数据源枚举测试
// 覆盖: opencode 库发现 (排除边车 / 排序 / 目录缺失)、claude/codex jsonl 递归
// 枚举与文件名过滤、目录缺失 → null、notFoundDetail、XDG_DATA_HOME 优先、walk 排序。
import {describe, expect, it} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {dataHome, findClaudeFiles, findCodexFiles, findOpencodeDbs, notFoundDetail, walk} from "../src/discover.js";
import {makeHome, writeLines} from "./fixtures.js";

describe("dataHome (XDG 优先)", () => {
  it("XDG_DATA_HOME 绝对路径优先; 相对路径/缺省回退 ~/.local/share", () => {
    const old = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/xdg-data";
      expect(dataHome("/home/u")).toBe("/xdg-data");
      process.env.XDG_DATA_HOME = "relative/no";
      expect(dataHome("/home/u")).toBe(join("/home/u", ".local", "share"));
      delete process.env.XDG_DATA_HOME;
      expect(dataHome("/home/u")).toBe(join("/home/u", ".local", "share"));
    } finally {
      if (old !== undefined) process.env.XDG_DATA_HOME = old;
      else delete process.env.XDG_DATA_HOME;
    }
  });
});

describe("findOpencodeDbs", () => {
  it("枚举 opencode*.db, 排除边车, 字典序", async () => {
    const h = await makeHome();
    try {
      const dir = join(h.home, ".local", "share", "opencode");
      await mkdir(dir, {recursive: true});
      for (const f of ["opencode-stable.db", "opencode.db", "opencode-stable.db-wal", "opencode-stable.db-shm", "other.db", "opencode-local.db"]) {
        await writeFile(join(dir, f), "");
      }
      const dbs = await findOpencodeDbs(dataHome(h.home));
      expect(dbs).toEqual([join(dir, "opencode-local.db"), join(dir, "opencode-stable.db"), join(dir, "opencode.db")]);
    } finally {
      await h.cleanup();
    }
  });

  it("目录不存在 → 空清单", async () => {
    const h = await makeHome();
    try {
      const dbs = await findOpencodeDbs(dataHome(h.home));
      expect(dbs).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});

describe("findClaudeFiles / findCodexFiles", () => {
  it("claude: 递归枚举 projects 下全部 jsonl (含 subagents 嵌套)", async () => {
    const h = await makeHome();
    try {
      await writeLines(join(h.home, ".claude", "projects", "p1", "s1.jsonl"), []);
      await writeLines(join(h.home, ".claude", "projects", "p1", "subagents", "a1.jsonl"), []);
      await writeLines(join(h.home, ".claude", "projects", "p2", "s2.jsonl"), []);
      const files = await findClaudeFiles(h.home);
      expect(files).toHaveLength(3);
    } finally {
      await h.cleanup();
    }
  });

  it("codex: 只收 rollout-*.jsonl (普通 jsonl 排除)", async () => {
    const h = await makeHome();
    try {
      await writeLines(join(h.home, ".codex", "sessions", "2026", "05", "08", "rollout-a.jsonl"), []);
      await writeLines(join(h.home, ".codex", "sessions", "2026", "05", "08", "plain.jsonl"), []);
      const files = await findCodexFiles(h.home);
      expect(files).not.toBeNull();
      expect(files!).toHaveLength(1);
      expect(files![0]!.endsWith("rollout-a.jsonl")).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("目录缺失 → null; 存在但空 → []", async () => {
    const h = await makeHome();
    try {
      expect(await findClaudeFiles(h.home)).toBeNull();
      expect(await findCodexFiles(h.home)).toBeNull();
      await mkdir(join(h.home, ".claude", "projects"), {recursive: true});
      expect(await findClaudeFiles(h.home)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});

describe("walk 与 notFoundDetail", () => {
  it("walk: 递归 + 过滤 + 排序", async () => {
    const h = await makeHome();
    try {
      await writeLines(join(h.home, "b", "x.txt"), []);
      await writeLines(join(h.home, "a", "deep", "y.txt"), []);
      await writeLines(join(h.home, "a", "z.md"), []);
      const files = await walk(join(h.home), (p) => p.endsWith(".txt"));
      expect(files).toHaveLength(2);
      expect(files[0]!.includes(join("a", "deep"))).toBe(true); // 字典序
    } finally {
      await h.cleanup();
    }
  });

  it("notFoundDetail: 三源的探测位置描述", async () => {
    const h = await makeHome();
    try {
      expect(notFoundDetail("opencode", h.home)).toContain("opencode");
      expect(notFoundDetail("claude-code", h.home)).toContain(".claude/projects");
      expect(notFoundDetail("codex", h.home)).toContain("rollout-");
    } finally {
      await h.cleanup();
    }
  });
});
