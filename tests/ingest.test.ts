// ingest.test.ts — 摄取编排端到端测试 (临时 home + 临时账本)
// 覆盖: 全量首跑、幂等重采不双计 (二跑 inserted=0 且 total 不变)、opencode rowid
// 水位线增量与库重建重置、claude 文件 mtime+size 水位线 (追加触发重收, 未变跳过,
// 缩小整文件重收)、对账告警 (差异 stderr 形态, 不 fail; 旧 schema 无对账)、
// 成功过滤端到端 (opencode error 行不入账本)。
import {afterEach, describe, expect, it} from "bun:test";
import {appendFile, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ingestAll} from "../src/ingest.js";
import {Ledger} from "../src/ledger.js";
import {T0, DAY, claudeAssistant, claudeUser, makeOpencodeMessageDb, ocMsg, writeLines} from "./fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function freshEnv(): Promise<{home: string; dataHome: string}> {
  const t = await mkdtemp(join(tmpdir(), "pt-ingest-"));
  const home = join(t, "home");
  const dataHome = join(t, "data");
  cleanups.push(() => rm(t, {recursive: true, force: true}));
  return {home, dataHome};
}

async function ingest(home: string, dataRoot: string) {
  const ledger = await Ledger.open(dataRoot);
  try {
    return await ingestAll(ledger, {harnesses: [], home, dataRoot});
  } finally {
    ledger.close();
  }
}

describe("摄取幂等与水位线", () => {
  it("二跑幂等: inserted=0, total 不变 (不双计)", async () => {
    const {home, dataHome} = await freshEnv();
    await makeOpencodeMessageDb(join(dataHome, "opencode", "opencode.db"), [
      {sess: "s0", data: ocMsg({input: 10, created: T0})},
      {sess: "s0", data: ocMsg({input: 20, created: T0 + 1000})},
    ]);
    const r1 = await ingest(home, dataHome);
    expect(r1.inserted).toBe(2);
    expect(r1.total).toBe(2);
    const r2 = await ingest(home, dataHome);
    expect(r2.inserted).toBe(0);
    expect(r2.total).toBe(2);
    // statuses: 二跑报零增量
    const oc2 = r2.statuses.find((s) => s.harness === "opencode")!;
    expect(oc2.detail).toContain("+0");
  });

  it("opencode rowid 水位线: 追加行只增量摄取", async () => {
    const {home, dataHome} = await freshEnv();
    const db = join(dataHome, "opencode", "opencode.db");
    await makeOpencodeMessageDb(db, [{sess: "s0", data: ocMsg({input: 1, created: T0})}]);
    await ingest(home, dataHome);
    // 追加一行 (rowid 2) — 参数绑定插入, 避开引号转义
    const {Database} = await import("bun:sqlite");
    const d = new Database(db);
    d.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's0', 0, 0, ?)", ["m9", ocMsg({input: 5, created: T0 + DAY})]);
    d.close();
    const r2 = await ingest(home, dataHome);
    expect(r2.inserted).toBe(1);
    expect(r2.total).toBe(2);
  });

  it("opencode 库重建: maxRowid 回退 → 水位线重置全量重扫 + 告警; 同键行后值覆盖", async () => {
    const {home, dataHome} = await freshEnv();
    const db = join(dataHome, "opencode", "opencode.db");
    // 首跑: 3 行
    await makeOpencodeMessageDb(db, [
      {sess: "s0", data: ocMsg({input: 1, created: T0})},
      {sess: "s0", data: ocMsg({input: 2, created: T0})},
      {sess: "s0", data: ocMsg({input: 3, created: T0})},
    ]);
    await ingest(home, dataHome);
    // 重建: 新库只有 1 行 (max rowid 1 < 水位线 3) → 全量重扫; rowid 空间复用,
    // 同键行后值覆盖 (input 9 覆盖旧 1), 未复用的旧行保留
    await rm(db);
    await makeOpencodeMessageDb(db, [{sess: "s0", data: ocMsg({input: 9, created: T0})}]);
    const r2 = await ingest(home, dataHome);
    expect(r2.warnings.some((w) => w.includes("水位线") && w.includes("重扫"))).toBe(true);
    expect(r2.inserted).toBe(1); // 覆盖计 1
    expect(r2.total).toBe(3); // 行数不变 (覆盖非新增)
  });

  it("claude 文件水位线: 未变跳过 / 追加触发整文件重收 (幂等不双计) / 缩小整文件重收", async () => {
    const {home, dataHome} = await freshEnv();
    const f = join(home, ".claude", "projects", "p", "s.jsonl");
    await writeLines(f, [claudeAssistant({msgId: "m1", input: 10, ts: T0})]);
    const r1 = await ingest(home, dataHome);
    expect(r1.inserted).toBe(1);
    // 二跑未变: 零重收
    const r2 = await ingest(home, dataHome);
    expect(r2.inserted).toBe(0);
    expect(r2.statuses.find((s) => s.harness === "claude-code")!.detail).toContain("重收 0");
    // 追加 (mtime+size 变): 整文件重收, m1 幂等忽略, m2 新入账
    await appendFile(f, JSON.stringify(claudeAssistant({msgId: "m2", input: 20, ts: T0 + 1000})) + "\n");
    const r3 = await ingest(home, dataHome);
    expect(r3.inserted).toBe(1);
    expect(r3.total).toBe(2);
    // 缩小 (mtime+size 变): 整文件重收, m2 已不在文件 (账本行保留 — 请求不可变)
    await writeFile(f, JSON.stringify(claudeAssistant({msgId: "m1", input: 10, ts: T0})) + "\n");
    const r4 = await ingest(home, dataHome);
    expect(r4.inserted).toBe(0);
    expect(r4.total).toBe(2); // 历史行不回缩
  });

  it("claude 流式增长: 中途摄取部分值, 终值落盘后重收覆盖 (不冻结部分 usage)", async () => {
    const {home, dataHome} = await freshEnv();
    const f = join(home, ".claude", "projects", "p", "s.jsonl");
    // 流进行中: m1 累计 input=10 已写盘 → 中途摄取
    await writeLines(f, [claudeAssistant({msgId: "m1", input: 10, ts: T0})]);
    await ingest(home, dataHome);
    // 流完成: 终值 100 落盘 (同 msgId 末行) → mtime 变 → 重收 → upsert 覆盖
    await appendFile(f, JSON.stringify(claudeAssistant({msgId: "m1", input: 100, output: 5, ts: T0 + 5})) + "\n");
    const r2 = await ingest(home, dataHome);
    expect(r2.inserted).toBe(1); // 值变化 → 覆盖计 1
    expect(r2.total).toBe(1); // 仍单行, 不双计
    // 账本终值 100 (经 ProfileV2 发射验证)
    const ledger = await Ledger.open(dataHome);
    try {
      const m = ledger.profileDays(null, [])[0]!.models[0]!;
      expect(m.in).toBe(100);
      expect(m.out).toBe(5);
    } finally {
      ledger.close();
    }
  });

  it("codex 摄取三态: 首收 / 未变跳过 / 追加事件增量且不重算旧行", async () => {
    const {home, dataHome} = await freshEnv();
    const f = join(home, ".codex", "sessions", "2026", "05", "08", "rollout-x.jsonl");
    await writeLines(f, [
      {timestamp: new Date(T0).toISOString(), type: "turn_context", payload: {model: "gpt-5"}},
      {timestamp: new Date(T0).toISOString(), type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 10, cached_input_tokens: 0, output_tokens: 2}}}},
    ]);
    const r1 = await ingest(home, dataHome);
    expect(r1.inserted).toBe(1);
    expect(r1.total).toBe(1);
    // 未变: 跳过
    const r2 = await ingest(home, dataHome);
    expect(r2.inserted).toBe(0);
    // 追加事件 #2: 增量入账, 事件 #1 不重算 (reqKey 稳定)
    await appendFile(f, JSON.stringify({timestamp: new Date(T0 + 1000).toISOString(), type: "event_msg", payload: {type: "token_count", info: {last_token_usage: {input_tokens: 5, cached_input_tokens: 1, output_tokens: 0}}}}) + "\n");
    const r3 = await ingest(home, dataHome);
    expect(r3.inserted).toBe(1);
    expect(r3.total).toBe(2);
    const ledger = await Ledger.open(dataHome);
    try {
      const m = ledger.profileDays(null, [])[0]!.models[0]!;
      expect(m.nReq).toBe(2);
      expect(m.in).toBe(15);
      expect(m.cr).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("成功过滤端到端: opencode error 行不入账本", async () => {
    const {home, dataHome} = await freshEnv();
    await makeOpencodeMessageDb(join(dataHome, "opencode", "opencode.db"), [
      {sess: "s0", data: ocMsg({input: 10})},
      {sess: "s0", data: ocMsg({input: 99, error: true})},
    ]);
    const r = await ingest(home, dataHome);
    expect(r.total).toBe(1);
  });

  it("v3 端到端: 轮次与工具数经编排入账 → session_stats/day_stats 物化 (opencode + claude)", async () => {
    const {home, dataHome} = await freshEnv();
    await makeOpencodeMessageDb(join(dataHome, "opencode", "opencode.db"), [
      {sess: "s0", data: ocMsg({role: "user", created: T0})},
      {sess: "s0", data: ocMsg({input: 10, created: T0}), tools: 2},
    ]);
    await writeLines(join(home, ".claude", "projects", "p", "sess-x.jsonl"), [
      claudeUser({sessionId: "sess-x", uuid: "u1"}),
      claudeAssistant({msgId: "m1", input: 100, output: 5, ts: T0, sessionId: "sess-x", toolUses: 1}),
    ]);
    await ingest(home, dataHome);
    const ledger = await Ledger.open(dataHome);
    try {
      const days = ledger.profileDays(null, []);
      // opencode 会话: 2 工具 1 轮; claude 会话: 1 工具 1 轮 — 各归各模型行
      const oc = days[0]!.models.find((m) => m.id === "zai-coding-plan/glm-5.3")!;
      expect(oc.nReq).toBe(1);
      // (nTools/nTurns 发射面字段属下一提交; 此处经 day_stats 直读校验物化)
      const {createSqlite} = await import("../src/sqlite.js");
      const db = await createSqlite(join(dataHome, "pricey-tokens", "usage.db"));
      const d = db.prepare("SELECT model, n_tools, n_turns FROM day_stats").all();
      db.close();
      expect(d.find((r) => r.model === "zai-coding-plan/glm-5.3")).toMatchObject({n_tools: 2, n_turns: 1});
      expect(d.find((r) => r.model === "claude-sonnet-5")).toMatchObject({n_tools: 1, n_turns: 1});
    } finally {
      ledger.close();
    }
  });

  it("对账: 账本与源汇总不一致 → 告警不 fail; 一致 → 无告警", async () => {
    const {home, dataHome} = await freshEnv();
    // 源汇总 150, 消息合计 100 → 差异 50
    await makeOpencodeMessageDb(
      join(dataHome, "opencode", "opencode.db"),
      [{sess: "s0", data: ocMsg({input: 100, created: T0})}],
      [{model: null, input: 150, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, time: T0}],
    );
    const r = await ingest(home, dataHome);
    expect(r.warnings.some((w) => w.includes("[对账]") && w.includes("in=100") && w.includes("in=150"))).toBe(true);
    expect(r.total).toBe(1); // 不 fail: 摄取照常完成

    // 一致库 (多模型会话: 账本 Σ 全模型 == 源会话级合计) → 无对账告警
    const {home: h2, dataHome: d2} = await freshEnv();
    await makeOpencodeMessageDb(
      join(d2, "opencode", "opencode.db"),
      [
        {sess: "s0", data: ocMsg({input: 100, output: 5, reasoning: 2, cacheRead: 7, cacheWrite: 3, created: T0})},
        {sess: "s0", data: ocMsg({modelID: "gemini", providerID: "p2", input: 40, output: 1, created: T0})},
      ],
      [{model: null, input: 140, output: 6, reasoning: 2, cacheRead: 7, cacheWrite: 3, time: T0}],
    );
    const r2 = await ingest(h2, d2);
    expect(r2.warnings.filter((w) => w.includes("[对账]"))).toHaveLength(0);
  });

  it("旧 schema 库 (无 session 汇总) → 摄取正常, 无对账", async () => {
    const {home, dataHome} = await freshEnv();
    await makeOpencodeMessageDb(join(dataHome, "opencode", "opencode.db"), [{sess: "s0", data: ocMsg({input: 1, created: T0})}]);
    const r = await ingest(home, dataHome);
    expect(r.total).toBe(1);
    expect(r.warnings).toHaveLength(0);
  });

  it("未发现源: found=false + 探测位置; 坏库转 skipped 不拖垮其他源", async () => {
    const {home, dataHome} = await freshEnv();
    // 坏 opencode 库 + 正常 claude 文件
    await mkdir(join(dataHome, "opencode"), {recursive: true});
    await writeFile(join(dataHome, "opencode", "opencode.db"), "not sqlite");
    await writeLines(join(home, ".claude", "projects", "p", "s.jsonl"), [claudeAssistant({msgId: "m1", input: 1, ts: T0})]);
    const r = await ingest(home, dataHome);
    expect(r.statuses.find((s) => s.harness === "opencode")!.found).toBe(true); // 文件在 → found (但收集失败)
    expect(r.skipped.some((s) => s.includes("opencode.db"))).toBe(true);
    expect(r.total).toBe(1); // claude 照常
    expect(r.statuses.find((s) => s.harness === "codex")!.found).toBe(false); // 无 codex 目录
  });
});
