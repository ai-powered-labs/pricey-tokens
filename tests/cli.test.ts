// cli.test.ts — CLI 编排出口测试 (子进程跑 src/cli.ts, 断言退出码与 stdout/stderr 纪律)
// 覆盖: --help/--version 前置短路 (exit 0, 不落参数错误)、未知参数 exit 1、空数据
// home exit 1、--json stdout 纯净可 parse、默认模式 stdout 分流 (非 TTY 只有 URL —
// 机读管道契约; TTY 不打长 URL — script 伪终端; 两者均落盘 last-share-url.txt)、
// 落盘失败回退打印、HOME/XDG 注入。
import {describe, expect, it} from "bun:test";
import {mkdtemp, mkdir, rm, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {dataDir} from "../src/discover.js";
import {claudeAssistant, writeLines} from "./fixtures.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 共享 spawn 排水管线 (runCli 与 runCliTty 仅 argv 构造/pty 归一不同)
async function run(argv: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
    env: {...process.env, ...env},
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return {code: await proc.exited, stdout, stderr};
}

async function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  return run(["bun", "src/cli.ts", ...args], env);
}

// 伪终端跑 CLI (stdout.isTTY === true 的可信测试面): script 分配 pty; pty 下
// stdout/stderr 合流且 \n→\r\n — 断言前统一 normalize (仅 win32 无 script, 跳过)。
// 坑: darwin 的 BSD script 无 -e 旗标, 子进程退出码不传播 — 勿在此加非零退出码断言
async function runCliTty(args: string[], env: Record<string, string>): Promise<RunResult> {
  const cmd = ["bun", "src/cli.ts", ...args];
  const argv = process.platform === "darwin" ? ["script", "-q", "/dev/null", ...cmd] : ["script", "-qec", cmd.join(" "), "/dev/null"];
  const r = await run(argv, env);
  const norm = (s: string): string => s.replace(/\r\n/g, "\n");
  return {...r, stdout: norm(r.stdout), stderr: norm(r.stderr)};
}

// 测试临时 home (HOME + XDG_CONFIG_HOME + XDG_DATA_HOME 全指走, 防污染真实
// device-key 与数据目录/分享 URL 文件); urlFile = 落盘路径 SSOT (dataDir)
interface TempHome {
  home: string;
  env: {HOME: string; XDG_CONFIG_HOME: string; XDG_DATA_HOME: string};
  urlFile: string;
  cleanup: () => Promise<void>;
}

// 无 harness 数据的空 home
async function emptyHome(): Promise<TempHome> {
  const home = await mkdtemp(join(tmpdir(), "pt-cli-"));
  const env = {HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share")};
  return {home, env, urlFile: join(dataDir(env.XDG_DATA_HOME), "last-share-url.txt"), cleanup: () => rm(home, {recursive: true, force: true})};
}

// 有数据 home: 单条 1h 前的 claude assistant 消息 (默认出口的最小可复现数据)
async function homeWithMsg(): Promise<TempHome> {
  const h = await emptyHome();
  await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, [
    claudeAssistant({msgId: "m1", input: 100, output: 10, ts: Date.now() - 3600000}),
  ]);
  return h;
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
    const h = await homeWithMsg();
    try {
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
    const h = await homeWithMsg();
    try {
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

  it("有数据: 默认模式非 TTY stdout 只有 URL (机读管道契约), 完整 URL 落盘 last-share-url.txt", async () => {
    const h = await homeWithMsg();
    try {
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^http:\/\/localhost:19999\/calc\/#u=\S+\n$/); // stdout 纪律: 非 TTY 只有 URL (单行, 可 | pbcopy)
      expect(r.stderr).toMatch(/分享链接 \(\d+\.\dKB\)/); // 提示行含链接大小 (stderr 不污染管道)
      expect(r.stderr).toContain("last-share-url.txt");
      const content = await readFile(h.urlFile, "utf8"); // 一行 URL + 尾随换行
      expect(content).toMatch(/^http:\/\/localhost:19999\/calc\/#u=.+\n$/);
      await expect(readFile(`${h.urlFile}.tmp`)).rejects.toThrow(); // 原子写不留 .tmp 残留
    } finally {
      await h.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("有数据: TTY 终端不打长 URL (刷屏治理), 提示与落盘照常 (script 伪终端)", async () => {
    const h = await homeWithMsg();
    try {
      const r = await runCliTty(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("#u="); // 长串不进人眼终端 (pty 合流后全文皆无)
      expect(r.stdout).toMatch(/分享链接 \(\d+\.\dKB\)/); // 提示行照常 (经 pty 合流)
      expect(r.stdout).toContain("last-share-url.txt");
      expect(await readFile(h.urlFile, "utf8")).toMatch(/^http:\/\/localhost:19999\/calc\/#u=.+\n$/); // URL 完整落盘 (SSOT)
    } finally {
      await h.cleanup();
    }
  });

  it("落盘中途失败不毁上一次的好文件 (tmp+rename 原子性)", async () => {
    const h = await homeWithMsg();
    try {
      await mkdir(dataDir(h.env.XDG_DATA_HOME), {recursive: true});
      await writeFile(h.urlFile, "http://old/calc/#u=previous\n"); // 上一次的好文件
      await mkdir(`${h.urlFile}.tmp`); // tmp 占位为目录 → writeFile 阶段即失败 (EISDIR)
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:19999\/calc\/#u=/); // 非 TTY 恒打 URL (管道契约)
      expect(r.stderr).toContain("落盘");
      expect(await readFile(h.urlFile, "utf8")).toBe("http://old/calc/#u=previous\n"); // 旧文件逐字节不变
    } finally {
      await h.cleanup();
    }
  });

  it("超阈 hash (>90KB): 保留警告且指向落盘文件 (复制以文件为准)", async () => {
    const h = await emptyHome();
    try {
      // 日粒度同日同模型聚合为一条 → 用 多天×多模型 撑大 hash (2 天 × 6000 模型 ≈ 120KB);
      // 天步长 25h — 恰 24h 在 DST fall-back 时区可塌缩进同一本地日
      const now = Date.now();
      const lines = [0, 1].flatMap((d) =>
        Array.from({length: 6000}, (_, m) =>
          claudeAssistant({msgId: `m${d}_${m}`, model: `claude-sonnet-5-${m}`, input: 1000 + m, ts: now - d * 90000000}),
        ),
      );
      await writeLines(`${h.home}/.claude/projects/p/s.jsonl`, lines);
      const r = await runCli(["--days", "7"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^https:\/\/pricey-tokens\.lambda\.lc\/calc\/#u=\S+\n$/); // 非 TTY stdout 只有 URL
      expect(r.stderr).toContain("警告: 分享 hash");
      expect(r.stderr).toContain("复制以文件为准"); // 警告与新行为一致: 指向落盘文件
      expect(r.stderr).toContain("--days 7"); // 缩窗建议保留
      expect((await readFile(h.urlFile, "utf8")).length).toBeGreaterThan(90 * 1024); // 超阈 URL 完整落盘
    } finally {
      await h.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("落盘失败 (EISDIR): 降级回退 — 完整 URL 打印 stdout, stderr 含失败原因", async () => {
    const h = await homeWithMsg();
    try {
      // 同名目录 → rename(tmp, 目录) EISDIR: 与权限/磁盘状态无关的确定性失败注入
      await mkdir(h.urlFile, {recursive: true});
      const r = await runCli(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:19999\/calc\/#u=/); // 兜底不弱于旧行为
      expect(r.stderr).toContain("落盘");
      expect(r.stderr).toContain("EISDIR");
      expect(r.stderr).not.toContain("分享链接 ("); // 降级分支不与成功分支消息串台
    } finally {
      await h.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("TTY 落盘失败 (EISDIR): 回退打印 URL — 兜底不弱于旧行为", async () => {
    const h = await homeWithMsg();
    try {
      await mkdir(h.urlFile, {recursive: true});
      const r = await runCliTty(["--days", "7", "--site", "http://localhost:19999/calc/"], h.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("#u="); // TTY 正常不打长 URL, 落盘失败时回退打印 (pty 合流)
      expect(r.stdout).toContain("EISDIR");
      expect(r.stdout).toContain("手动访问上方 URL"); // 回退分支的兜底指引
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
    const h = await homeWithMsg();
    try {
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
    const h = await homeWithMsg();
    try {
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
    const h = await homeWithMsg();
    try {
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
