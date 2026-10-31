# dsh-llm-xai-oauth

[![npm](https://img.shields.io/npm/v/dsh-llm-xai-oauth?style=flat-square&color=4b6fff)](https://www.npmjs.com/package/dsh-llm-xai-oauth)
[![npm downloads](https://img.shields.io/npm/dm/dsh-llm-xai-oauth?style=flat-square)](https://www.npmjs.com/package/dsh-llm-xai-oauth)
[![CI](https://github.com/cyjyyd/dsh-llm-xai-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/cyjyyd/dsh-llm-xai-oauth/actions/workflows/ci.yml)
[![dshfind](https://dshfind.com/api/badge/cyjyyd/dsh-llm-xai-oauth)](https://dshfind.com/zh/plugins/cyjyyd/dsh-llm-xai-oauth?ref=badge)

已经在付 SuperGrok / X Premium 的话，用这个插件把订阅接进 DeepSeek Harness：
原生 `xai` 路由、`grok-4.7`、设备码登录、token 刷新不依赖某个 TUI 开着。不需要 xAI API Key。

**headless、web、任意终端 profile 都能用。** SSH 终端 [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) 可以叠在上面，不是前置条件。

English: [README.md](README.md)

[dshfind 插件目录](https://dshfind.com/zh/plugins/cyjyyd/dsh-llm-xai-oauth) 已收录（请用 npm 安装，不要用页面上过期的 git 源）：

[![dshfind](https://dshfind.com/api/card/cyjyyd/dsh-llm-xai-oauth?lang=zh)](https://dshfind.com/zh/plugins/cyjyyd/dsh-llm-xai-oauth?ref=badge)

从 **npm** 装（开发时才用 GitHub 源）：

```bash
dsh plugin --profile headless add dsh-llm-xai-oauth@latest
npx dsh-llm-xai-oauth login
npx dsh-llm-xai-oauth daemon --install
dsh --profile headless --provider xai --model grok-4.7
```

profile 换成 `web` 或 `tui` 即可。**更新必须带 `@latest`。** 写成裸的 `add dsh-llm-xai-oauth` 时，pnpm 会沿用 lockfile 里钉死的旧版。

## 你要先知道的三件事

1. **这是订阅 OAuth，不是 API Key。** 装好插件后，dsh 走 `https://cli-chat-proxy.grok.com`，用 `~/.grok-bridge/auth.json` 里的 access token。
2. **access token 大约 1 小时过期。** 只开着 dsh 时，插件会在过期前 5 分钟、以及遇到 401 时刷新。dsh 没开着的时候，这个刷新不会发生。
3. **所以要另开一个刷新进程。** 用 `dsh-llm-xai-oauth daemon`，不要指望 TUI / headless 进程帮你整夜续期。

`/usage` 报 401、发消息也 401，几乎都是：token 已经过期，而当时没有进程在刷新。

## 5 分钟配好

下面默认你已经能运行 `dsh`（`npm i -g @deepseek-ai/dsh`，已验证 `0.1.5-rc.1` 至 `0.1.5-rc.3`、`0.1.7-rc.1`/`0.1.7-rc.2`、`0.2.0-rc.1`/`0.2.0-rc.2`、`0.2.1-rc.2` 至 `0.2.1-rc.5`（桌面端安装包所在的版本线）），Node.js ≥ 22.19。`0.1.2`、`0.1.6` alpha 与 `0.2.x` alpha 不支持。审计过程见[兼容性审计记录](https://github.com/cyjyyd/dsh-llm-xai-oauth/blob/main/docs/compatibility-audit-0.2.1-rc.5.md)。

### 1. 把插件装进 profile

```bash
dsh plugin --profile headless add dsh-llm-xai-oauth@latest
dsh plugin --profile web add dsh-llm-xai-oauth@latest
dsh plugin --profile tui add dsh-llm-xai-oauth@latest
```

确认 bundle 在（要看到 `id: llm-xai-oauth`。没有这条，`/model` 里不会出现可调用的 SuperGrok 路由）：

```bash
dsh --profile headless --dump-config | grep llm-xai-oauth
```

本机仓库只给开发用。日常请走 npm；目录里过期的 `github:` 装法在 pnpm ≥ 10 上还会拦 `prepare` 脚本。

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
- dsh 默认模型：`$DSH_HOME/settings.yaml` 的 `agent-default-model` → `xai` / `grok-4.7`  
  （如果已经是 `xai`，不会改你选的 grok 模型和思考强度）

没有 TTY 的 headless / CI 不会提示登录。TTY 上也可以设 `DSH_XAI_OAUTH_NO_LOGIN=1` 跳过。

### Windows 与桌面端：可视化首次引导

Windows 桌面端不带控制台，只在终端里打印设备码等于没人看得到。所以在 `win32` 上插件改为在本地起一个页面、用默认浏览器打开，在同一页里完成设备码授权：

- 页面上直接给出设备码、复制按钮和「打开授权页面」按钮；
- 轮询授权状态，xAI 一确认就变成「已连接」，不用手动刷新；
- 浅色 / 深色两套主题，和 DeepSeek Harness 桌面端一致。

引导页会一直服务到页面画出最终状态并回执为止（最多等 5 秒），所以授权成功一定看得见，不会出现端口先关掉、页面还停在「等待中」的情况。如果浏览器起不来（启动失败或默认浏览器被策略拦截），按钮会就地提示失败并把授权地址打到 stderr，而不是报一个其实没发生的成功。

页面只监听 `127.0.0.1` 的随机端口，并且挂在一条 128 位随机路径下，本机其他进程读不到待授权的设备码。除 xAI 接口外不依赖任何外部资源。

任意平台都可以手动开启或关闭：

```bash
npx dsh-llm-xai-oauth login --ui    # 在 Linux/macOS 上也走可视化引导
GROK_BRIDGE_NO_BROWSER=1 npx dsh-llm-xai-oauth login   # 完全不打开浏览器
```

如果打不开浏览器，引导页地址会打到 stderr，可以自己复制去打开。


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

dsh --profile tui --provider xai --model grok-4.7
dsh --profile headless "Reply with exactly: xai-harness-ok. Do not use tools."
```

在 [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) 里：`/model` 选 grok；`/usage` 读 SuperGrok 本周剩余额度。TUI 现在会在过期前刷新 token；若仍 401，会再强制刷新一次后重试。**这救得了“刚打开 TUI 时 token 刚过期”，救不了“机器睡了一夜、没有任何刷新进程”。** 第 3 步的 daemon 才是那个进程。

## 日常怎么切模型

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: xai
  model: grok-4.7
  reasoningEffort: high
```

或启动参数 / TUI `/model`。启动时插件会用当前 token 打 `GET {baseURL}/models`，`/model` 列表以订阅实时目录为准（现在一般是 `grok-4.7` 带 xhigh、`grok-4.5` 到 high）。静态回退仍含 `grok-4.3`。

| 模型 | 上下文 | 输出上限 | 思考强度 |
| --- | --- | --- | --- |
| `grok-4.7` | 500K | 64K | off / low / medium / high / xhigh |
| `grok-4.5` | 500K | 64K | off / low / medium / high |
| `grok-4.3` | 1M | 30K | off / low / medium / high |

DeepSeek 风格选择器里的 `max` 会映射成 `xhigh`。

可选配置是 `baseURL`、`reasoningEffort`、`models` 和重试 / 空闲超时。`0.1.5` 写在 `$DSH_HOME/settings.yaml` 的 `llm-xai-oauth:` 下；`0.1.7` 写在 profile patch 里，并且首次启动时会把那份旧文件导入一次。两种主机都是改完不用重启，下一次请求再生效。

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
- 不是 Web「一键登录」设置页，也没有 OAuth 回调端口。设备码授权本身可以再复用本机已有 token；Windows 上的可视化引导只是把同一个设备码放进浏览器页面，方便没有控制台的桌面端。
- 不会 `registerConfigurableProviders('xai')`，因为 `llm-pi-ai` 已经占用了这个目录名。本包只拥有**实际调用路由**。

## License

MIT
