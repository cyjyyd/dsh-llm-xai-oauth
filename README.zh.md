# dsh-llm-xai-oauth

把 SuperGrok / X Premium 订阅接到 DeepSeek Harness，当成**原生 LLM 提供商**用。不需要 xAI API Key。复用本机已经登录过的 OAuth token。

English: [README.md](README.md)。配套 TUI：[dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui)。

## 它解决什么

Harness 自带 DeepSeek 官方路由，以及通用的 `llm-pi-ai` 目录。目录可以*展示* `xai`，但不能刷新 SuperGrok 的 OAuth token，也不能打 Grok 订阅代理。这个插件补上这一段：

- 注册真正可调用的 `xai` 路由（`grok-4.6` / `grok-4.5` / `grok-4.3`）
- 读取 `~/.grok-bridge/auth.json` 或 `~/.grok/auth.json`
- 过期前 5 分钟自动 refresh
- 用和 grok-bridge 相同的 Bearer + `x-grok-client-*` 头调用 `https://cli-chat-proxy.grok.com/v1/chat/completions`
- 文本、思考、工具调用、usage 走和 DeepSeek 官方一样的 harness 流式协议

之后 `/model`、Models 页、`agent-default-model` 都会把 Grok 当成普通提供商。

刻意做窄：不替换内置 xAI catalog 卡片，不做全订阅登录台，不另建一份 token 仓库。

## 安装

需要 Node.js ≥ 22.19，以及能加载 profile bundle 的 `dsh` CLI。

```bash
dsh plugin --profile tui add github:cyjyyd/dsh-llm-xai-oauth
dsh plugin --profile web add github:cyjyyd/dsh-llm-xai-oauth
dsh plugin --profile headless add github:cyjyyd/dsh-llm-xai-oauth
```

本地仓库：

```bash
git clone https://github.com/cyjyyd/dsh-llm-xai-oauth.git
cd dsh-llm-xai-oauth
bash scripts/install.sh tui
```

bundle patch 会插入 `id: llm-xai-oauth`。确认：

```bash
dsh --profile tui --dump-config | grep llm-xai-oauth
```

## 登录

本机已经用 grok-bridge 或官方 Grok CLI 登录过，就**不用再登录**。插件直接复用那份文件。

否则在能打开 `auth.x.ai` 的机器上：

```bash
cd dsh-llm-xai-oauth
npm install
npm run login
```

这会走 xAI device-code，把 token 写到 `~/.grok-bridge/auth.json`（权限 `0600`），之后的请求通过 `https://auth.x.ai/oauth2/token` refresh。

## 使用

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: xai
  model: grok-4.6
  reasoningEffort: high
```

或启动时指定：

```bash
dsh --profile tui --provider xai --model grok-4.6
dsh --profile headless "Reply with exactly: xai-harness-ok. Do not use tools."
```

默认目录（仅作选择器展示；代理实际能提供的 `grok-*` 仍可请求）：

| 模型 | 上下文 | 输出上限 | 思考强度 |
| --- | --- | --- | --- |
| `grok-4.6` | 500K | 64K | off / low / medium / high / xhigh |
| `grok-4.5` | 500K | 64K | off / low / medium / high |
| `grok-4.3` | 1M | 30K | off / low / medium / high |

DeepSeek 风格选择器里的 `max` 会映射成 `xhigh`。

可选配置在 `llm-xai-oauth:`（`baseURL`、`reasoningEffort`、`models`、重试 / 空闲超时）。改完不用重启，下一次请求再生效。

## 它不是什么

- 不是 xAI API Key 提供商。计量接口 `api.x.ai` 仍走通用 catalog。
- 不是 Codex / Claude / Copilot 聚合器。
- 不是 Web「一键登录」设置页。CLI device login + 复用本机 token，是给 SSH / headless 用的。
- 不会 `registerConfigurableProviders('xai')`，因为 `llm-pi-ai` 已经占用了这个目录名。本包只拥有**实际调用路由**。

## License

MIT
