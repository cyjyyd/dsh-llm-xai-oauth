# dsh-llm-xai-oauth

把 SuperGrok / X Premium 订阅接到 DeepSeek Harness，当成**原生 LLM 提供商**用。不需要 xAI API Key。

English: [README.md](README.md)。配套 TUI：[dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui)。

## 你要先知道的三件事

1. **这是订阅 OAuth，不是 API Key。** 装好插件后，dsh 走 `https://cli-chat-proxy.grok.com`，用 `~/.grok-bridge/auth.json` 里的 access token。
2. **access token 大约 1 小时过期。** 只开着 dsh 时，插件会在过期前 5 分钟、以及遇到 401 时刷新。dsh 没开着的时候，这个刷新不会发生。
3. **所以要另开一个刷新进程。** 用 `dsh-llm-xai-oauth daemon`，不要指望 TUI / headless 进程帮你整夜续期。

`/usage` 报 401、发消息也 401，几乎都是：token 已经过期，而当时没有进程在刷新。

## 5 分钟配好

下面默认你已经能运行 `dsh`（`npm i -g @deepseek-ai/dsh`），Node.js ≥ 22.19。远程 SSH 机器建议和 [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) 装在同一个 profile。

### 1. 把插件装进 profile

```bash
dsh plugin --profile tui add dsh-llm-xai-oauth
dsh plugin --profile headless add dsh-llm-xai-oauth
```

Web UI 用的话再加：

```bash
dsh plugin --profile web add dsh-llm-xai-oauth
```

确认 bundle 在：

```bash
dsh --profile tui --dump-config | grep llm-xai-oauth
```

应该能看到 `id: llm-xai-oauth`。没有这条，`/model` 里不会出现可调用的 SuperGrok 路由。

本机仓库 / GitHub 源仍然可用：

```bash
# 仓库
git clone https://github.com/cyjyyd/dsh-llm-xai-oauth.git
cd dsh-llm-xai-oauth
bash scripts/install.sh tui

# 或
dsh plugin --profile tui add github:cyjyyd/dsh-llm-xai-oauth
```

### 2. 登录一次（有浏览器的机器上）

本机已经用过 grok-bridge 或官方 Grok CLI、并且 `~/.grok-bridge/auth.json` / `~/.grok/auth.json` 还在，**这一步会自动复用，不再弹浏览器**。

否则在能打开 `auth.x.ai` 的终端里：

```bash
npx dsh-llm-xai-oauth login
# 已有 token 也要重登：
npx dsh-llm-xai-oauth login --force
```

终端会打印一个 URL 和用户码。用浏览器打开、授权 SuperGrok / X Premium。成功后写入：

- token：`~/.grok-bridge/auth.json`（权限 `0600`）
- dsh 默认模型：`$DSH_HOME/settings.yaml` 的 `agent-default-model` → `xai` / `grok-4.6`  
  （如果已经是 `xai`，不会改你选的 grok 模型和思考强度）

没有 TTY 的 headless / CI 不会提示登录。TTY 上也可以设 `DSH_XAI_OAUTH_NO_LOGIN=1` 跳过。

看当前 token 还剩多久：

```bash
npx dsh-llm-xai-oauth status
```

### 3. 挂上自动刷新（和 dsh 无关）

access token 短。TUI、headless、定时任务如果在 token 过期后才启动，读到的就是过期 token，`/usage` 和对话都会 401。

**推荐：用户级 systemd**

```bash
npx dsh-llm-xai-oauth daemon --install
```

它会写入 `~/.config/systemd/user/dsh-llm-xai-oauth.service` 并 `enable --now`。这个进程每分钟看一次 `auth.json`，过期前 5 分钟刷新，不需要 dsh 在跑。

没有 systemd、或不想装 user unit，二选一：

```bash
# 前台看着跑
npx dsh-llm-xai-oauth daemon

# 或 cron，每 20 分钟刷一次（token 仍有效时是空操作）
*/20 * * * * npx --yes dsh-llm-xai-oauth refresh >/tmp/dsh-xai-refresh.log 2>&1
```

卸掉 user unit：

```bash
npx dsh-llm-xai-oauth daemon --uninstall
```

临时手动刷一次：

```bash
npx dsh-llm-xai-oauth refresh
npx dsh-llm-xai-oauth refresh --force
```

### 4. 用 SuperGrok 跑一条

```bash
# 先看默认模型是不是 xai
grep -A3 agent-default-model ~/.dsh/settings.yaml

dsh --profile tui --provider xai --model grok-4.6
dsh --profile headless "Reply with exactly: xai-harness-ok. Do not use tools."
```

在 [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) 里：`/model` 选 grok；`/usage` 读 SuperGrok 本周剩余额度。TUI 现在会在过期前刷新 token；若仍 401，会再强制刷新一次后重试。**这救得了“刚打开 TUI 时 token 刚过期”，救不了“机器睡了一夜、没有任何刷新进程”。** 第 3 步的 daemon 才是那个进程。

## 日常怎么切模型

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: xai
  model: grok-4.6
  reasoningEffort: high
```

或启动参数 / TUI `/model`。启动时插件会用当前 token 打 `GET {baseURL}/models`，`/model` 列表以订阅实时目录为准（现在一般是 `grok-4.6` 带 xhigh、`grok-4.5` 到 high）。静态回退仍含 `grok-4.3`。

| 模型 | 上下文 | 输出上限 | 思考强度 |
| --- | --- | --- | --- |
| `grok-4.6` | 500K | 64K | off / low / medium / high / xhigh |
| `grok-4.5` | 500K | 64K | off / low / medium / high |
| `grok-4.3` | 1M | 30K | off / low / medium / high |

DeepSeek 风格选择器里的 `max` 会映射成 `xhigh`。

可选配置写在 `$DSH_HOME/settings.yaml` 的 `llm-xai-oauth:`（`baseURL`、`reasoningEffort`、`models`、重试 / 空闲超时）。改完不用重启 dsh，下一次请求再生效。

超长 SuperGrok 会话会把 500K 窗口填满，下一轮 `max_tokens` 装不下时代理常回笼统的 HTTP 400 `INVALID_REQUEST`。从 0.1.3 起，适配器用上一轮用量推算下一次 prompt；剩余上下文装不下请求的补全时，会抛 `CONTEXT_WINDOW_EXCEEDED`，让 harness 走溢出压缩再试。压缩 / 标题请求仍会发出，并把 `max_tokens` 钳到剩余窗口。

## 401 / 过期排查

```bash
npx dsh-llm-xai-oauth status
ls -l ~/.grok-bridge/auth.json
# systemd 用户服务
systemctl --user status dsh-llm-xai-oauth.service
journalctl --user -u dsh-llm-xai-oauth.service -n 50
```

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| `/usage` 或发消息 HTTP 401 | access token 过期，当时没人 refresh | `refresh --force`，并装 daemon |
| 长会话发消息 HTTP 400 `INVALID_REQUEST` | 剩余上下文小于 `max_tokens`；旧版插件不会触发压缩 | 升到 0.1.3+；若本轮已经失败可 `/compact` |
| status 显示 `no refresh_token` | 文件残缺或不是 OAuth 登录产物 | `login --force` |
| dump-config 没有 `llm-xai-oauth` | 插件没进这个 profile | 再执行第 1 步 |
| 有 token 但仍走 DeepSeek | `agent-default-model` 不是 xai | `/model` 切过去，或看 settings.yaml |
| daemon --install 失败 | 没有用户 systemd / linger | 改用 cron，或 `loginctl enable-linger $USER` |

代理：`HTTPS_PROXY` / `HTTP_PROXY` 对登录、刷新、对话都生效。

## 它不是什么

- 不是 xAI API Key 提供商。计量接口 `api.x.ai` 仍走通用 catalog。
- 不是 Codex / Claude / Copilot 聚合器。
- 不是 Web「一键登录」设置页。TTY device login + 复用本机 token，是给 SSH / headless 用的。
- 不会 `registerConfigurableProviders('xai')`，因为 `llm-pi-ai` 已经占用了这个目录名。本包只拥有**实际调用路由**。

## License

MIT
