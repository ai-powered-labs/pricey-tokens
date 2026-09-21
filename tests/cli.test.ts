// cli.test.ts — CLI 编排出口测试 (子进程跑 src/cli.ts, 断言退出码与 stdout/stderr 纪律)
// 覆盖: --help/--version 前置短路 (exit 0, 不落参数错误)、未知参数 exit 1、空数据
// home exit 1、--json stdout 纯净可 parse、默认模式 stdout 是 URL、HOME/XDG 注入。
import {describe, expect, it} from "bun:test";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {T0, claudeAssistant, writeLines} from "./fixtures.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
    env: {...process.env, ...env},
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return {code, stdout, stderr};
}

// 无 agent 数据的临时 home (HOME + XDG_CONFIG_HOME 都指走, 防污染真实 device-key)
async function emptyHome(): Promise<{home: string; env: Record<string, string>; cleanup: () => Promise<void>}> {
  const home = await mkdtemp(join(tmpdir(), "pt-cli-"));
  return {
    home,
    env: {HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share")},
    cleanup: () => rm(home, {recursive: true, force: true}),
  };
}

describe("cli 参数出口", () => {
  it("--help: exit 0, stdout 含用法 (任何组合下都不落参数错误)", async () => {
    for (const args of [["--help"], ["-h"], ["--json", "--help"]]) {
      const h = await emptyHome();
      try {
        const r = await runCli(args, h.env);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("用法: pricey-tokens");
        expect(r.stderr).not.toContain("参数错误");
      } finally {
        await h.cleanup();
      }
    }
  });

  it("--version: exit 0, stdout 是版本号", async () => {
    const h = await emptyHome();
    try {
      const r = await runCli(["--version"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await h.cleanup();
    }
  });

  it("未知参数: exit 1, stderr 含参数错误", async () => {
    const h = await emptyHome();
    try {
      const r = await runCli(["--wat"], h.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("参数错误");
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli 数据出口", () => {
  it("空数据 home: exit 1, stderr 提示未收集到", async () => {
    const h = await emptyHome();
    try {
      const r = await runCli(["--json"], h.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("未收集到任何用量记录");
    } finally {
      await h.cleanup();
    }
  });

  it("有数据: --json stdout 纯 JSON 可 parse (探测报告全在 stderr)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 86400000}),
      ]);
      const r = await runCli(["--json", "--days", "7"], h.env);
      expect(r.code).toBe(0);
      const profile = JSON.parse(r.stdout); // stdout 纯 JSON (任何诊断混入都会炸)
      expect(profile.schema).toBe("pricey-tokens-profile/v1");
      expect(profile.agent).toBe("claude-code");
      expect(r.stderr).toContain("[claude-code]");
    } finally {
      await h.cleanup();
    }
  });

  it("有数据: 默认模式 stdout 是 #u= URL, 不打开浏览器路径也可复现", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 3600000}),
      ]);
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:19999\/calc\/#u=/);
    } finally {
      await h.cleanup();
    }
  });

  it("--upload 非 TTY 且无 --yes: 拒绝上传 exit 1 (预览已打印)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 3600000}),
      ]);
      const r = await runCli(["--upload"], h.env); // 测试进程 stdin 非 TTY
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("将上传的完整内容");
      expect(r.stderr).toContain("已取消上传");
    } finally {
      await h.cleanup();
    }
  });
});
