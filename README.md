# pricey-tokens

本机 AI coding agent 用量收集器 — 一条命令, 把你的 token 消耗变成
[pricey-tokens](https://pricey-tokens.lambda.lc) 站点上的套餐换算结果。

```console
$ npx pricey-tokens
```

探测本机 **opencode / claude-code / codex** 的用量数据, 聚合每模型的 token 四分类
(输入 / 输出 / 缓存读 / 缓存写) 日粒度计数, 生成站点分享链接并在浏览器打开 —
直接看到"你的用量按 API 计价值多少钱、哪个订阅套餐更划算"。

解析逻辑移植自站点侧解析器 (本包是该逻辑的公开归宿, 站点后续将改为消费本包),
口径经双通道同数回归测试对齐。

## 安装与使用

零全局安装, 直接跑:

```console
$ npx pricey-tokens                 # 默认: 收集近 30 天 → 打开浏览器换算
$ npx pricey-tokens --days 7        # 小窗口 (分享链接更短)
$ npx pricey-tokens --days all      # 全量历史
$ npx pricey-tokens --json          # ProfileV1 JSON 到 stdout (月速率口径)
$ npx pricey-tokens --upload        # 上传社区档案 (上传前完整预览, 需确认)
$ npx pricey-tokens --upload --share --yes   # 上传并打印分享 URL (脚本场景)
$ npx pricey-tokens --agent opencode,claude-code   # 只收集指定源
```

要求: node ≥ 20.10 或 bun (读 opencode 库需 bun 或 node ≥ 22.5, 见下)。

### 参数一览

| 参数 | 说明 | 默认 |
|---|---|---|
| `--json` | 输出 ProfileV1 JSON (月速率口径) 到 stdout | 关 |
| `--upload` | 上传 ProfileV1 到社区档案 (先完整预览, 再确认) | 关 |
| `--share` | 上传后打印分享 URL (须与 `--upload` 同用) | 关 |
| `--yes` | 跳过上传交互确认 (非交互环境的显式授权) | 关 |
| `--days N\|all` | 收集窗口 (天); `all` = 全量历史 | 30 |
| `--agent LIST` | 只收集指定源: `opencode,claude-code,codex` 逗号分隔 | 全部 |
| `--api URL` | 上传 API base | `https://pricey-tokens.lambda.lc` |
| `--site URL` | 分享站点 base (本地开发 `http://localhost:PORT/calc/`) | `https://pricey-tokens.lambda.lc/calc/` |
| `--help` / `--version` | 帮助 / 版本 | — |

## 采集什么与不采集什么 (隐私边界)

**只采集** (每模型每日一条聚合):

- 模型标识串 (如 `zai/glm-5.3`、`claude-sonnet-5`)
- 时间戳 (日粒度)
- token 四分类计数: 输入 / 输出 / 缓存读 / 缓写

**绝不采集**: 会话内容、消息文本、代码、文件路径、项目名、提示词、任何用户输入。
收集器不读取上述字段 — 它们在本包的数据结构里没有位置。

需要知晓的边界:

- 模型串与时间戳本身保留 (这是"用量"的必要构成)。分享链接 (`#u=…`) 与上传档案
  (ProfileV1) 含且仅含上述聚合数据。
- 默认模式生成的分享链接**完整携带**这些数据 (在 URL hash 里, 不经过服务器);
  `--upload` 模式上传前会**原样打印将发送的全部内容**, 你确认后才发出。
- 上传档案携带一个本地生成的随机 device key (`~/.config/pricey-tokens/device-key`),
  仅用于重复上传时覆盖你自己的旧档案, 不含身份信息。

## 数据源

| agent | 位置 | 说明 |
|---|---|---|
| opencode | `~/.local/share/opencode/opencode*.db` | SQLite 双 schema 自动探测; main/stable/local 等多通道库全收 (各通道独立库不重复; 非常规的库副本同收会双计, 注意) |
| claude-code | `~/.claude/projects/**/*.jsonl` | messageId 去重取末值 (流式 chunk 口径) |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | 每会话取末条累计值 (不逐事件求和) |

读 opencode 库需要 SQLite 运行时: bun (内置 `bun:sqlite`) 或 node ≥ 22.5
(内置 `node:sqlite`)。都不满足时 opencode 源跳过并提示, 其余源照常。

## 口径说明

- **日粒度聚合**: 每模型每天一条记录 (保留 5 小时峰值约束所需的日级时间线)。
  同日之内的峰值细节丢失 — 站点的 5h 峰值约束会按"全天量压到单点"计算, 结果
  偏保守 (高估套餐压力), 不会低估。
- **月速率** (`--json` / 上传): 各模型四分类月速率 = 窗口总量 × 30 ÷ spanDays,
  与档案 spanDays 自洽 (站点引擎 `30/spanDays` 外推还原原值)。
- **分享 hash 比特兼容**: 本包生成的 `#u=` 与站点 `src/share/hash.ts` 同算法同
  键序 (golden vector 测试固化), 站点 `decodeShare` 可直接解。

## 上传预览示例

```console
$ pricey-tokens --upload --days 30

=== 将上传的完整内容 (ProfileV1, 仅模型串 + 四分类月速率 + 跨度, 无会话内容) ===

{
  "schema": "pricey-tokens-profile/v1",
  "agent": "mixed",
  "spanDays": 30,
  "models": [
    { "id": "zai/glm-5.3", "inputT": 2413586490, "outputT": 174372446,
      "cacheReadT": 34110285632, "cacheWriteT": 0 }
  ],
  "planUsed": null,
  "collectedAt": 1789484209152,
  "toolVersion": "0.1.0",
  "trust": "anon"
}

=== 预览结束 ===

确认上传以上内容? [y/N]
```

上传契约见站点仓库 `pricey-tokens-api/CONTRACT.md` (ProfileV1 冻结面)。

## 开发

```console
$ bun install
$ bun test          # 71 个测试 (三家解析器 / 聚合 / hash golden / 参数 / CLI 编排 / 上传)
$ bun run typecheck # TS 严格 (含 tests)
$ bun run build     # tsc → dist/ (node ESM, bin shebang)
```

- 运行时依赖仅 `lz-string`; argv 手写解析; SQLite 走运行时内置模块。
- 测试 fixtures 全部为合成数据 (隐私红线), 形态与站点侧 fixtures 同构。
- hash golden vector 由站点侧算法预生成, 内嵌断言逐字节相等。

### 推送到远端

仓库预期远端为 `github.com/luochen1990/pricey-tokens` (尚未创建)。owner 建仓后:

```console
$ git remote add origin git@github.com:luochen1990/pricey-tokens.git
$ git push -u origin master
```

npm 发布走 tag 触发的 GitHub Actions (`.github/workflows/publish.yml`) — 需 owner
在仓库 Settings → Secrets 配置 `NPM_TOKEN`。

## License

[MIT](./LICENSE)
