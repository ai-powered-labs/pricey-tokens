// upload.test.ts — 上传与设备键测试
// 覆盖: confirmUpload 非 TTY 拒绝、uploadProfile 成功/错误响应形状 (本地 mock
// server)、device-key 首建/复用/损坏重生 (home 注入)。
import {afterEach, describe, expect, it} from "bun:test";
import {createServer, type Server} from "node:http";
import {readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {mkdtemp} from "node:fs/promises";
import {confirmUpload, uploadProfile} from "../src/upload.js";
import {loadOrCreateDeviceKey} from "../src/device-key.js";
import type {ProfileV1} from "../src/types.js";

const profile: ProfileV1 = {
  schema: "pricey-tokens-profile/v1",
  agent: "opencode",
  spanDays: 30,
  models: [{id: "zai/glm-5.3", inputT: 100, outputT: 10, cacheReadT: 200, cacheWriteT: 0}],
  planUsed: null,
  collectedAt: Date.now(),
  toolVersion: "test",
  trust: "anon",
};

describe("confirmUpload", () => {
  it("非 TTY 且无 --yes → false (bun test 的 stdin 非 TTY)", async () => {
    if (process.stdin.isTTY) return; // TTY 环境跳过 (交互无法自动化)
    expect(await confirmUpload(false)).toBe(false);
  });

  it("--yes → true (不读 stdin)", async () => {
    expect(await confirmUpload(true)).toBe(true);
  });
});

describe("uploadProfile (mock server)", () => {
  let server: Server | null = null;
  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  function start(handler: (req: {headers: Record<string, string | string[] | undefined>; body: string}, res: {writeHead: (code: number, headers?: Record<string, string>) => void; end: (s: string) => void}) => void): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => handler({headers: req.headers, body}, res));
      });
      server.listen(0, "127.0.0.1", () => resolve((server!.address() as {port: number}).port));
    });
  }

  it("200: 解析 profileId/shareUrl; 请求体与 Dedupe-Key 头按契约发送", async () => {
    let seen = {body: "", key: "", contentType: ""};
    const port = await start((req, res) => {
      seen = {body: req.body, key: String(req.headers["x-dedupe-key"] ?? ""), contentType: String(req.headers["content-type"] ?? "")};
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({profileId: 7, shareUrl: "/share/7"}));
    });
    const r = await uploadProfile(`http://127.0.0.1:${port}`, profile, "uuid-1");
    expect(r).toEqual({profileId: 7, shareUrl: "/share/7"});
    expect(JSON.parse(seen.body)).toEqual(profile); // 发送的即预览的 (HA 遥测规范对齐)
    expect(seen.key).toBe("uuid-1");
    expect(seen.contentType).toBe("application/json");
  });

  it("400: 错误体 {error} 透传", async () => {
    const port = await start((_req, res) => {
      res.writeHead(400, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: "spanDays 超限"}));
    });
    await expect(uploadProfile(`http://127.0.0.1:${port}`, profile, "k")).rejects.toThrow("spanDays 超限");
  });

  it("200 但响应缺字段 → 形状异常报错", async () => {
    const port = await start((_req, res) => {
      res.writeHead(200);
      res.end('{"wat": 1}');
    });
    await expect(uploadProfile(`http://127.0.0.1:${port}`, profile, "k")).rejects.toThrow("形状异常");
  });
});

describe("loadOrCreateDeviceKey (home 注入)", () => {
  it("首建 → 复用同值; 损坏内容 → 重生", async () => {
    process.env.XDG_CONFIG_HOME = undefined; // 走注入 home 的 ~/.config
    const home = await mkdtemp(join(tmpdir(), "pt-key-"));
    try {
      const key1 = await loadOrCreateDeviceKey(home);
      expect(key1).toMatch(/^[0-9a-f-]{36}$/);
      expect(await loadOrCreateDeviceKey(home)).toBe(key1); // 复用
      const file = join(home, ".config", "pricey-tokens", "device-key");
      await writeFile(file, "not-a-uuid\n");
      const key2 = await loadOrCreateDeviceKey(home);
      expect(key2).toMatch(/^[0-9a-f-]{36}$/);
      expect(key2).not.toBe("not-a-uuid");
      expect((await readFile(file, "utf8")).trim()).toBe(key2);
    } finally {
      await rm(home, {recursive: true, force: true});
    }
  });
});
