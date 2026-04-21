# Copilot Relay

轻量级 HTTP 代理，将 GitHub Copilot 的 API 桥接为 Anthropic 兼容端点，让 Claude Code 及其他 Anthropic SDK 客户端能够使用你的 Copilot 订阅。

## 功能特性

- **多账号池** — 注册多个 GitHub 账号，自动故障转移与冷却
- **Session 亲和负载均衡** — 同一 session 粘在同一账号，不同 session 在健康账号间均衡分配
- **Initiator 策略** — 通过控制 `x-initiator` 头来管理高级配额消耗（`off` / `session` / `always`）
- **流式代理** — SSE 响应零缓冲直通转发
- **审计日志** — 每个请求记录模型、token 数、initiator 及耗时，写入 `data/audit.jsonl`
- **用量与统计** — 通过管理端点实时查看配额跟踪与历史统计
- **热登录** — 运行时通过 `/relay/login/start` API 添加账号，无需重启

## 快速开始

### 前置条件

- [Bun](https://bun.sh) 运行时
- 一个已激活 Copilot 订阅的 GitHub 账号

### 使用 Claude Code 安装（推荐）

本项目内置了 [Claude Code 技能](https://docs.anthropic.com/en/docs/claude-code/skills)，可以一键完成安装和日常管理。在项目目录下打开终端运行 `claude`，然后使用内置斜杠命令：

**首次安装：**

```
/install-relay
```

该技能会引导你完成完整安装流程：安装依赖、GitHub 登录（会提示你手动运行 `bun run login`）、选择 initiator 策略、生成密钥、启动 relay、运行自检（健康检查 / 推理测试 / 用量查询），并打印包含所有配置值的摘要。

**启动或重启 relay：**

```
/start-relay
```

检查已有账号，确认 relay 是否已在运行，如未运行则启动，然后确认健康状态、用量和近期统计。

### 手动安装

```bash
# 1. 安装依赖
bun install

# 2. 使用 GitHub 账号登录（交互式 — 会打开浏览器）
bun run login

# 3. 生成共享密钥
export RELAY_SECRET=$(bun run generate-secret)
echo "请保存: $RELAY_SECRET"

# 4. 写入配置文件（可按需修改模型映射）
cp .relay-config.example.json .relay-config.json

# 按需编辑本地配置
$EDITOR .relay-config.json

# 5. 启动 relay
bun run serve

# 6. 验证
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
RELAY_SECRET="$RELAY_SECRET" bun run e2e
```

默认会读取仓库根目录的 `.relay-config.json`；也可以用 `RELAY_CONFIG_FILE` 环境变量指定其他路径。**所有配置项均从配置文件读取，不支持通过环境变量覆盖。** 仓库中提交的是 `.relay-config.example.json` 模板，本地实际配置文件 `.relay-config.json` 已加入 `.gitignore`。

`relaySecret` 必须在配置文件中设置（或将密钥写入 `data/relay.key` 文件）。客户端通过 `Authorization: Bearer <relaySecret>` 进行认证。

配置文件模板见仓库根目录的 `.relay-config.example.json`。

```bash
cat .relay-config.example.json
cp .relay-config.example.json .relay-config.json
```

如果你想使用其他本地文件名，也可以：

```bash
RELAY_CONFIG_FILE=.relay-config.local.json bun run serve
```

此时请自行创建 `.relay-config.local.json`，它同样已被 `.gitignore` 忽略。

现在的模型名转换逻辑是:匹配 `claude-(haiku|sonnet|opus)-<major>-<minor>`(可带 `-YYYYMMDD` 日期后缀),将版本号中的 `-` 转为 `.`,并丢弃日期后缀。例如:

- `claude-opus-4-7` → `claude-opus-4.7`
- `claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`
- `claude-haiku-4-5` → `claude-haiku-4.5`

其他模型名(包括 `gpt-5.4`、`o4-mini` 等)原样透传,不做任何改写。

`bun run e2e` 会直接调用本机 `claude` CLI，并通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 让 Claude CLI 真实走 relay，再校验返回文本是否精确匹配预期值。可选环境变量：

- `RELAY_BASE_URL`：默认 `http://127.0.0.1:8787`
- `E2E_EXPECTED_TEXT`：默认 `relay-e2e-ok`。

### 配合 Claude Code 使用

Relay 运行后，将 Claude Code 指向它：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=<你的 RELAY_SECRET>
claude
```

## 配置

所有配置通过 `.relay-config.json` 文件管理。唯一支持的环境变量是 `RELAY_CONFIG_FILE`（用于指定配置文件路径，默认为 `.relay-config.json`）。

| 配置文件字段             | 默认值       | 说明                                              |
| ------------------------ | ------------ | ------------------------------------------------- |
| `relaySecret`            | *（必填）*   | 客户端认证共享密钥（最少 32 个字符），也可写入 `data/relay.key` |
| `relayPort`              | `8787`       | 监听端口                                          |
| `relayBind`              | `127.0.0.1`  | 绑定地址                                          |
| `dataDir`                | `./data`     | 存放账号、审计日志和 relay 密钥的目录             |
| `logLevel`               | `info`       | 日志级别（`debug` / `info` / `warn` / `error`）   |
| `forceAgentInitiator`    | `session`    | Initiator 策略，详见下文                          |
| `upstreamTimeoutMs`      | `300000`     | 上游请求超时时间（毫秒）                          |
| `accountCooldownMs`      | `300000`     | 账号失败后冷却时间（毫秒）                        |
| `sessionAffinityTtlMs`   | `3600000`    | Session → 账号绑定的保留时长（毫秒），超时后视为新 session |
| `tokenRefreshSkewS`      | `60`         | 在 Copilot JWT 过期前多少秒刷新令牌               |

### Initiator 策略（`forceAgentInitiator`）

控制 `x-initiator` 头，决定请求是否消耗 Copilot 高级配额：

| 模式      | 行为 |
| --------- | ---- |
| `off`     | 根据请求体推断，用户发起的轮次 = `user`（消耗高级配额），工具延续和压缩 = `agent`（免费） |
| `session` | 一个 session 的首次请求 = `user`，同一 session 后续所有请求 = `agent`。Session 基于 `metadata.user_id` 识别，TTL 到期（`sessionAffinityTtlMs`）后再次出现将视为新 session。若请求不带 `metadata.user_id`，退回基于消息数量的启发式判断（单条 user 消息 = 首轮） |
| `always`  | 所有请求都以 `agent` 发送，最大限度节省配额 |

### 账号负载均衡

多账号池采用 **session 亲和 + 最少负载** 策略：

- 以请求 body 的 `metadata.user_id` 作为 session key（Anthropic / Claude Code / Copilot CLI 都会带）。
- 同一 session 的请求路由到同一账号，便于利用上游的对话缓存和配额连续性。
- 新 session 分配到当前活跃 session 数最少的健康账号；平局时 round-robin 打散。
- 绑定账号若进入冷却，自动迁移到其他健康账号，并更新绑定。
- Session 绑定在 `sessionAffinityTtlMs` 无活动后过期。
- 请求若未携带 `metadata.user_id`，直接走 round-robin。

## CLI 命令

```bash
bun run serve              # 启动 relay 服务器
bun run login              # 添加 GitHub 账号（交互式设备流程）
bun run accounts           # 列出已注册账号
bun run generate-secret    # 生成随机 64 位十六进制密钥
bun run e2e                # 运行真实 Claude 端到端测试
```

## 管理端点

所有管理端点均需要 `Authorization: Bearer <relaySecret>` 认证。

| 端点                             | 方法 | 说明                                     |
| -------------------------------- | ---- | ---------------------------------------- |
| `/relay/health`                  | GET  | 账号健康状态                             |
| `/relay/usage`                   | GET  | 各账号剩余高级配额                       |
| `/relay/stats?since=24h`         | GET  | 聚合请求统计（支持 `since`/`until` 参数） |
| `/relay/login/start`             | POST | 启动新的设备流程登录                     |
| `/relay/login/status?device_code=...` | GET  | 检查登录完成状态                         |
