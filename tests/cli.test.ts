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

// 无 harness 数据的临时 home (HOME + XDG_CONFIG_HOME 都指走, 防污染真实 device-key)
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

  it("有数据: --json stdout 纯 JSON 可 parse (过程详情默认隐藏, stderr 无探测报告)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 86400000}),
      ]);
      const r = await runCli(["--json", "--days", "7"], h.env);
      expect(r.code).toBe(0);
      const profile = JSON.parse(r.stdout); // stdout 纯 JSON (任何诊断混入都会炸)
      expect(profile.schema).toBe("pricey-tokens-profile/v2");
      expect(profile.harness).toBe("claude-code");
      expect(profile.days).toHaveLength(1);
      const m = profile.days[0].models[0];
      expect(m.id).toBe("claude-sonnet-5");
      expect(m.in).toBe(100);
      expect(m.nReq).toBe(1);
      expect(m.ctxHist.reduce((a: number, b: number) => a + b, 0)).toBe(1); // Σhist==nReq
      expect(r.stderr).not.toContain("[claude-code]"); // 过程详情已隐藏
      expect(r.stderr).not.toContain("账本:");
      expect(r.stderr).not.toContain("用量摘要"); // 摘要是默认出口模式独有
    } finally {
      await h.cleanup();
    }
  });

  it("有数据: 二跑增量秒级路径 — 未变文件零重收且输出等价 (账本幂等)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 3600000}),
      ]);
      const r1 = await runCli(["--json", "--days", "7"], h.env);
      const r2 = await runCli(["--json", "--verbose", "--days", "7"], h.env); // 增量详情走 verbose
      expect(r2.code).toBe(0);
      expect(r2.stderr).toContain("重收 0");
      expect(r2.stderr).toContain("+0");
      const p1 = JSON.parse(r1.stdout);
      const p2 = JSON.parse(r2.stdout);
      p2.collectedAt = p1.collectedAt; // 时戳外逐字段等价
      expect(p2).toEqual(p1);
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

  it("成功过滤: isApiErrorMessage 行不进任何出口", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "ok", input: 100, output: 10, ts: Date.now() - 3600000}),
        claudeAssistant({msgId: "err", input: 9999, output: 99, ts: Date.now() - 3600000, isApiError: true}),
      ]);
      const r = await runCli(["--json", "--days", "7"], h.env);
      const m = JSON.parse(r.stdout).days[0].models[0];
      expect(m.in).toBe(100);
      expect(m.nReq).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("--harness 过滤: 只收集指定源 (端到端, harness 字段 = 源名)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 86400000}),
      ]);
      const r = await runCli(["--json", "--days", "7", "--harness", "claude-code"], h.env);
      expect(r.code).toBe(0);
      const profile = JSON.parse(r.stdout);
      expect(profile.harness).toBe("claude-code");
      expect(profile.days[0].models[0].id).toBe("claude-sonnet-5");
      // 其余源未发现但 claude-code 有数据 → exit 0
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

describe("cli 输出分级 (--verbose)", () => {
  // claude 有数据 + codex 空 rollout (skipped 面) — 同时具备摘要与隐藏提示的触发条件
  async function homeWithSkip() {
    const h = await emptyHome();
    await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
      claudeAssistant({msgId: "m1", input: 1000, output: 100, ts: Date.now() - 3600000}),
    ]);
    await writeLines(`${h.home}/.codex/sessions/2026/09/22/rollout-empty.jsonl`, []);
    return h;
  }

  it("默认模式: stderr 是用量摘要 + 跳过压缩提示, 无过程详情; stdout 仍只有 URL", async () => {
    const h = await homeWithSkip();
    try {
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:19999\/calc\/#u=/); // stdout 纪律不变
      expect(r.stderr).toContain("用量摘要"); // 结果向信息上位
      expect(r.stderr).toContain("已隐藏"); // 异常可见但不刷屏
      expect(r.stderr).toContain("--verbose");
      expect(r.stderr).not.toContain("[skip]");
      expect(r.stderr).not.toContain("[claude-code]");
      expect(r.stderr).not.toContain("账本:");
    } finally {
      await h.cleanup();
    }
  });

  it("--verbose: 过程详情 (探测/跳过/账本增量) 回归 stderr", async () => {
    const h = await homeWithSkip();
    try {
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/", "--verbose"], h.env);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("[claude-code]");
      expect(r.stderr).toContain("[skip]");
      expect(r.stderr).toContain("账本:");
      expect(r.stderr).not.toContain("已隐藏"); // 展开时不再压缩提示
      expect(r.stderr).toContain("用量摘要"); // 摘要与 verbose 正交, 照常打印
    } finally {
      await h.cleanup();
    }
  });

  it("无跳过无告警: 默认模式无压缩提示 (干净输出)", async () => {
    const h = await emptyHome();
    try {
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
        claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 3600000}),
      ]);
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("已隐藏");
    } finally {
      await h.cleanup();
    }
  });

  it("--upload 模式: 有预览与压缩提示, 但无用量摘要 (摘要独占默认出口)", async () => {
    const h = await homeWithSkip();
    try {
      const r = await runCli(["--upload", "--days", "7"], h.env); // 非 TTY 无 --yes → 预览后取消
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("将上传的完整内容");
      expect(r.stderr).toContain("已隐藏"); // 跳过压缩提示照常
      expect(r.stderr).not.toContain("用量摘要");
    } finally {
      await h.cleanup();
    }
  });
});
