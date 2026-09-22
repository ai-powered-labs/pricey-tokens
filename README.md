# pricey-tokens

本机 AI coding agent 用量收集器 — 一条命令, 把你的 token 消耗变成
[pricey-tokens](https://pricey-tokens.lambda.lc) 站点上的套餐换算结果。

```console
$ npx pricey-tokens
```

探测本机 **opencode / claude-code / codex** 的用量数据, 把每次 API 请求的 token
四分类 (输入 / 输出 / 缓存读 / 缓存写) 归并进**本机用量账本**, 聚合出日粒度画像,
生成站点分享链接并在浏览器打开 — 直接看到"你的用量按 API 计价值多少钱、哪个
订阅套餐更划算"。

## 安装与使用

零全局安装, 直接跑:

```console
$ npx pricey-tokens                 # 默认: 收集近 30 天 → 打开浏览器换算
$ npx pricey-tokens --days 7        # 小窗口 (分享链接更短)
$ npx pricey-tokens --days all      # 全量历史
$ npx pricey-tokens --json          # ProfileV2 JSON 到 stdout (日粒度 + ctx 直方图)
$ npx pricey-tokens --upload        # 上传社区档案 (上传前完整预览, 需确认)
$ npx pricey-tokens --upload --share --yes   # 上传并打印分享 URL (脚本场景)
$ npx pricey-tokens --harness opencode,claude-code   # 只收集指定源
```

要求: node ≥ 22.5 或 bun (SQLite 运行时是账本硬需求: bun 内置 `bun:sqlite`,
node 内置 `node:sqlite` — 更老的 node 无法运行本 CLI)。

### 参数一览

| 参数 | 说明 | 默认 |
|---|---|---|
| `--json` | 输出 ProfileV2 JSON (日粒度 + ctx 直方图) 到 stdout | 关 |
| `--upload` | 上传 ProfileV2 到社区档案 (先完整预览, 再确认) | 关 |
| `--share` | 上传后打印分享 URL (须与 `--upload` 同用) | 关 |
| `--yes` | 跳过上传交互确认 (非交互环境的显式授权) | 关 |
| `--days N\|all` | 出口窗口 (天); `all` = 全量历史; 摄取恒为全历史增量 | 30 |
| `--harness LIST` | 只收集指定源: `opencode,claude-code,codex` 逗号分隔 | 全部 |
| `--api URL` | 上传 API base | `https://pricey-tokens.lambda.lc` |
| `--site URL` | 分享站点 base (本地开发 `http://localhost:PORT/calc/`) | `https://pricey-tokens.lambda.lc/calc/` |
| `--help` / `--version` | 帮助 / 版本 | — |

## 本机用量账本 (requests ledger)

首次运行会把三个源的全部历史**请求级**用量归并进本机 SQLite 账本:

```
~/.local/share/pricey-tokens/usage.db      # XDG_DATA_HOME 优先
```

- **归并幂等**: req_key 冲突时后值覆盖且仅在值变化时写 — 重采永不双计; claude
  流式消息 (同 messageId 的累计 chunk 行, 末值权威) 中途摄取后终值能覆盖。
- **增量水位线**: opencode 按 message 表 rowid, claude/codex 按文件 mtime+大小。
  首跑全量 (重度用户 ~50 万请求, 分钟级, 一次性); 之后增量秒级。库被重建
  (rowid 回退) 或文件变化 (含缩小) 自动全量重收。
- **只收成功请求** (用户裁决): claude 剔除 `isApiErrorMessage` 行; opencode 剔除
  错误标记行; codex 的错误请求不产生 token 事件。**已知偏差**: 计费了但中途
  失败的流被排除 ⇒ 额度消耗略低估, 有意为之。
- **对账**: opencode 的 session 汇总表是源的权威汇总, 每次摄取后对变动过的会话
  对账 (账本 rollup vs 源汇总), 差异打 stderr 告警但不失败 — 用于发现源裁剪
  历史 / 解析漂移; 上条成功过滤剔除的行也会表现为预期内差异。
- **request 粒度永不出本机** (隐私 + 体量)。账本可随时删除, 下次运行自动全量重建。
- 从账本物化 `day_stats` (日×模型聚合: 四分类 + 请求/轮次/工具调用计数 + 三张
  直方图 — ctx / 输出规模 / 会话最深上下文) 与 `session_stats` (会话级: 起止 /
  主模型 / max_ctx / 轮次), 增量摄取后只重算受影响日与会话。

## 采集什么与不采集什么 (隐私边界)

**只采集** (每模型每日一条聚合 + 每请求计数):

- 模型标识串 (如 `zai/glm-5.3`、`claude-sonnet-5`)
- 时间戳 (日粒度; 账本内为请求时刻, 上传/分享为日粒度)
- token 四分类计数: 输入 / 输出 / 缓存读 / 缓写
- 计数与分布: 每日每模型的请求数、会话数、**轮次数与工具调用数**、
  **上下文大小直方图** (12 档: 4k/8k/16k/32k/64k/128k/200k/256k/512k/1M/2M/∞)、
  **单请求输出规模直方图** (9 档: 1k/2k/4k/8k/16k/32k/64k/128k/∞)、
  **会话最深上下文直方图** (复用 12 档 ctx 桶, 会话按主模型与最后活跃日归因,
  一会话一增量)

**绝不采集**: 会话内容、消息文本、代码、文件路径、项目名、提示词、任何用户输入。
收集器不读取上述字段 — 它们在本包的数据结构里没有位置。

需要知晓的边界:

- 模型串与时间戳本身保留 (这是"用量"的必要构成)。分享链接 (`#u=…`) 与上传档案
  (ProfileV2) 含且仅含上述聚合数据; **上传含日粒度计数与 ctx/输出规模/会话最深
  上下文直方图桶计数** (无小时粒度 — 作息隐私面不上传)。
- 默认模式生成的分享链接**完整携带**这些数据 (在 URL hash 里, 不经过服务器);
  `--upload` 模式上传前会**原样打印将发送的全部内容**, 你确认后才发出。
- 上传档案携带一个本地生成的随机 device key (`~/.config/pricey-tokens/device-key`),
  仅用于重复上传时覆盖你自己的旧档案, 不含身份信息。

## 数据源

| harness | 位置 | 说明 |
|---|---|---|
| opencode | `~/.local/share/opencode/opencode*.db` | message 表逐请求 (SQL 侧抽取); main/stable/local 等多通道库全收 (各通道独立库不重复; 非常规的库副本同收会双计, 注意) |
| claude-code | `~/.claude/projects/**/*.jsonl` | messageId 去重取末值 (流式 chunk 口径); 剔除 API 错误行 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | 逐 token_count 事件 (增量 `last_token_usage`, 缺失时累计值差分); 旧格式无 token 事件的文件跳过 |

注意: jsonl 侧手工复制/合并会话文件时, 旧快照可能以 "后收者胜" 覆盖终值 (req_key
按会话与消息 id 归并) — 与 opencode 库副本双计是同族的非常规使用风险。

读 opencode 库与本地账本共用同一 SQLite 运行时: bun (内置 `bun:sqlite`) 或
node ≥ 22.5 (内置 `node:sqlite`)。

## 口径说明

- **ctxEstimate (契约冻结)**: 上下文大小按 provider 家族路由 — Anthropic 系
  (`claude*` / `anthropic` provider) 为 in+cr+cw (三者不相交); OpenAI 系
  (`openai`/`gpt*`/`o*`/`codex*`) 为 in (cached ⊆ prompt); 未知缺省前者
  (宁高估不漏计)。全客户端同公式入桶, 跨端可比。
- **日粒度聚合**: 每模型每天一条记录 (分享 hash 载荷)。同日之内的峰值细节
  丢失 — 站点的 5h 峰值约束会按"全天量压到单点"计算, 结果偏保守 (高估套餐
  压力), 不会低估。
- **成功过滤偏差**: 只收成功请求 ⇒ 计费了但中途失败的流被排除, 额度消耗略
  低估 (见上)。
- **分享 hash 比特兼容**: 本包生成的 `#u=` 与站点 `src/share/hash.ts` 同算法同
  键序 (golden vector 测试固化), 站点 `decodeShare` 可直接解。

## 上传预览示例

```console
$ pricey-tokens --upload --days 30

=== 将上传的完整内容 (ProfileV2, 日粒度模型四分类计数 + 会话/请求/轮次/工具调用计数 + ctx/输出规模/会话最深上下文直方图桶计数, 无会话内容) ===

{
  "schema": "pricey-tokens-profile/v2",
  "harness": "mixed",
  "days": [
    { "day": "2026-09-22", "models": [
      { "id": "zai/glm-5.3", "in": 241358649, "out": 17437244, "cr": 341102856,
        "cw": 0, "nSess": 150, "nReq": 4574,
        "ctxHist": [1204, 811, 950, 762, 531, 219, 58, 31, 6, 2, 0, 0],
        "outHist": [4102, 388, 71, 12, 1, 0, 0, 0, 0],
        "nTurns": 312, "nToolCalls": 5321,
        "maxCtxHist": [18, 22, 31, 25, 20, 19, 9, 5, 1, 0, 0, 0] } ] }
  ],
  "planUsed": null,
  "collectedAt": 1789484209152,
  "toolVersion": "0.3.0",
  "trust": "anon"
}

=== 预览结束 ===

确认上传以上内容? [y/N]
```

上传契约见站点仓库 `pricey-tokens-api/CONTRACT.md`。

## 开发

```console
$ bun install
$ bun test          # 135 个测试 (账本幂等/水位线/对账/迁移 / 三家解析器 / ctx+out 直方图契约 / session 归因 / hash golden / 参数 / CLI 编排 / 上传)
$ bun run typecheck # TS 严格 (含 tests)
$ bun run build     # tsc → dist/ (node ESM, bin shebang)
```

- 运行时依赖仅 `lz-string`; argv 手写解析; SQLite 走运行时内置模块。
- 测试 fixtures 全部为合成数据 (隐私红线), 形态与站点侧 fixtures 同构。
- hash golden vector 由站点侧算法预生成, 内嵌断言逐字节相等。

### 推送到远端

仓库远端为 `github.com/ai-powered-labs/pricey-tokens`。

```console
$ git push origin master
```

npm 发布走 tag 触发的 GitHub Actions (`.github/workflows/publish.yml`) — 需 owner
在仓库 Settings → Secrets 配置 `NPM_TOKEN`。

## License

[MIT](./LICENSE)
