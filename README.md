# dsh-llm-xai-oauth

Use a SuperGrok / X Premium subscription as a **native DeepSeek Harness LLM provider**. No xAI API key. Reuses the OAuth tokens already on the machine.

中文：[README.zh.md](README.zh.md)。Companion TUI: [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui).

## What this is

DeepSeek Harness already has an official DeepSeek route and a generic `llm-pi-ai` catalog. The catalog can *advertise* `xai`, but it cannot refresh a SuperGrok OAuth token or talk to the Grok subscription proxy. This plugin fills that gap:

- Registers the live `xai` adapter route (`grok-4.6` / `grok-4.5`（订阅实时目录；静态回退仍含 grok-4.3）)
- Searches `~/.grok-bridge/auth.json`, `~/.grok/auth.json`, and a small set of `~/.config` / `~/.local/share` locations
- If nothing reusable is found, starts the xAI device-code login on a TTY and writes `~/.grok-bridge/auth.json`
- Once a usable token exists, sets `agent-default-model` to `xai` / `grok-4.6` unless that section is already on `xai`
- Refreshes the access token five minutes before expiry
- Calls `https://cli-chat-proxy.grok.com/v1/chat/completions` with the same Bearer + `x-grok-client-*` headers grok-bridge uses
- Streams text, reasoning, tool calls, and usage through the same harness seam as DeepSeek official

`/model`, the Models page, and `agent-default-model` then treat Grok like any other provider.

On start the plugin first searches the machine for a reusable token. If none is found and the process has a TTY, it runs the xAI device-code login, then writes `agent-default-model` so dsh uses SuperGrok.

## Install

Requires Node.js ≥ 22.19 and a DeepSeek Harness CLI (`dsh`) that can load profile bundles.

On a remote SSH box, install this next to [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) so `/model` can switch onto SuperGrok without a browser.

```bash
# any profile: tui / web / headless. The CLI pulls npm.
dsh plugin --profile tui add dsh-llm-xai-oauth
dsh plugin --profile web add dsh-llm-xai-oauth
dsh plugin --profile headless add dsh-llm-xai-oauth
```

Local checkout:

```bash
git clone https://github.com/cyjyyd/dsh-llm-xai-oauth.git
cd dsh-llm-xai-oauth
bash scripts/install.sh tui
```

GitHub still works if you want a checkout instead of the registry:

```bash
dsh plugin --profile tui add github:cyjyyd/dsh-llm-xai-oauth
```

The bundle patch inserts `id: llm-xai-oauth`. Confirm with:

```bash
dsh --profile tui --dump-config | grep llm-xai-oauth
```

## Login

The plugin does this itself when dsh starts:

1. Search the machine for a reusable SuperGrok token (grok-bridge, Grok CLI, then common config dirs).
2. If none is found and the process has a TTY, print the device-code URL / user code and wait for `auth.x.ai`.
3. Write `~/.grok-bridge/auth.json` (`0600`) and set `$DSH_HOME/settings.yaml` `agent-default-model` to `xai` / `grok-4.6` if that section is not already on `xai`. A later login always writes the SuperGrok default.

If grok-bridge or the official Grok CLI already logged in, step 1 succeeds and **no browser dance runs**. Headless / CI hosts without a TTY skip the prompt; set `DSH_XAI_OAUTH_NO_LOGIN=1` to skip it even on a TTY.

To log in ahead of time, from a machine that can open `auth.x.ai`:

```bash
cd dsh-llm-xai-oauth
npm install
npm run login
# force a new device-code even when a token already exists:
node lib/login.js --force
```

That starts the xAI device-code flow, writes `~/.grok-bridge/auth.json` (`0600`), and later requests refresh through `https://auth.x.ai/oauth2/token`.

Override client / endpoints only when xAI changes them:

| Env | Default |
| --- | --- |
| `GROK_OAUTH_CLIENT_ID` | `b1a00492-073a-47ea-816f-4c329264a828` |
| `GROK_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` |
| `GROK_OAUTH_BASE` | `https://auth.x.ai` |
| `GROK_UPSTREAM_BASE` | `https://cli-chat-proxy.grok.com/v1` |
| `HTTPS_PROXY` | honored for both refresh and chat |
| `DSH_XAI_OAUTH_NO_LOGIN` | skip the startup device-code prompt |
| `GROK_BRIDGE_NO_BROWSER` | print the URL instead of opening a browser |

## Use it

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: xai
  model: grok-4.6
  reasoningEffort: high
```

Or pick the route at launch / in TUI:

```bash
dsh --profile tui --provider xai --model grok-4.6
dsh --profile headless "Reply with exactly: xai-harness-ok. Do not use tools."
```

The plugin also queries `GET {baseURL}/models` with the SuperGrok OAuth token at startup. The live listing currently returns `grok-4.6` (off / low / medium / high / **xhigh**) and `grok-4.5` (off / low / medium / high). `/model` in dsh-ssh-tui reads that adapter catalog.

Default catalog (advisory; the adapter still accepts a `grok-*` id the proxy serves):

| Model | Context | Output cap | Reasoning efforts |
| --- | --- | --- | --- |
| `grok-4.6` | 500K | 64K | off / low / medium / high / xhigh |
| `grok-4.5` | 500K | 64K | off / low / medium / high |
| `grok-4.3` | 1M | 30K | off / low / medium / high |

`max` in a DeepSeek-style picker maps to `xhigh`.

Optional plugin settings live under `llm-xai-oauth:` (`baseURL`, `reasoningEffort`, `models`, retry / idle timeout). Change them without restarting; the next request re-resolves.

## What it is not

- Not an xAI API-key provider. Metered `api.x.ai` stays on the generic catalog if you ever add an API key there.
- Not a Codex / Claude / Copilot aggregator. Those belong in other plugins.
- Not a Web “one-click login” settings card. Device login is CLI / TTY; token reuse is the point for SSH / headless machines.
- Does not register `registerConfigurableProviders('xai')`, because `llm-pi-ai` already advertises that catalog key. This package owns the **live adapter route**.

## Layout

```text
src/index.ts        Cordis plugin: search / login / register the xai route
src/bootstrap.ts    local token search, device login, dsh default model
src/discover.ts     bounded home/config token search
src/login-flow.ts   xAI device-code prompt
src/dsh-defaults.ts write agent-default-model
src/adapter.ts      fetch + SSE chat-completions adapter
src/oauth.ts        load / refresh / device-code
src/serialize.ts    harness messages → Grok wire body
src/translate.ts    SSE → harness StreamChunks
cordis.patch.yml    profile bundle insert
```

## License

MIT
