# dsh-llm-xai-oauth

Use a SuperGrok / X Premium subscription as a **native DeepSeek Harness LLM provider**. No xAI API key. Reuses the OAuth tokens already on the machine.

中文：[README.zh.md](README.zh.md)。Companion TUI: [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui).

## What this is

DeepSeek Harness already has an official DeepSeek route and a generic `llm-pi-ai` catalog. The catalog can *advertise* `xai`, but it cannot refresh a SuperGrok OAuth token or talk to the Grok subscription proxy. This plugin fills that gap:

- Registers the live `xai` adapter route (`grok-4.6` / `grok-4.5` / `grok-4.3`)
- Reads `~/.grok-bridge/auth.json` or `~/.grok/auth.json`
- Refreshes the access token five minutes before expiry
- Calls `https://cli-chat-proxy.grok.com/v1/chat/completions` with the same Bearer + `x-grok-client-*` headers grok-bridge uses
- Streams text, reasoning, tool calls, and usage through the same harness seam as DeepSeek official

`/model`, the Models page, and `agent-default-model` then treat Grok like any other provider.

This is intentionally narrow. It does not replace the built-in xAI catalog card, does not build a multi-subscription login desk, and does not invent a second token store.

## Install

Requires Node.js ≥ 22.19 and a DeepSeek Harness CLI (`dsh`) that can load profile bundles.

On a remote SSH box, install this next to [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) so `/model` can switch onto SuperGrok without a browser.

```bash
# any profile: tui / web / headless
dsh plugin --profile tui add github:cyjyyd/dsh-llm-xai-oauth
dsh plugin --profile web add github:cyjyyd/dsh-llm-xai-oauth
dsh plugin --profile headless add github:cyjyyd/dsh-llm-xai-oauth
```

Local checkout:

```bash
git clone https://github.com/cyjyyd/dsh-llm-xai-oauth.git
cd dsh-llm-xai-oauth
bash scripts/install.sh tui
```

The bundle patch inserts `id: llm-xai-oauth`. Confirm with:

```bash
dsh --profile tui --dump-config | grep llm-xai-oauth
```

## Login

If grok-bridge or the official Grok CLI already logged in, **do nothing**. The plugin reuses that file.

Otherwise, from a machine that can open `auth.x.ai`:

```bash
cd dsh-llm-xai-oauth
npm install
npm run login
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
- Not a Web “one-click login” settings card. Device login is CLI; token reuse is the point for SSH / headless machines.
- Does not register `registerConfigurableProviders('xai')`, because `llm-pi-ai` already advertises that catalog key. This package owns the **live adapter route**.

## Layout

```text
src/index.ts      Cordis plugin: register the xai route
src/adapter.ts    fetch + SSE chat-completions adapter
src/oauth.ts      load / refresh / device-code
src/serialize.ts  harness messages → Grok wire body
src/translate.ts  SSE → harness StreamChunks
cordis.patch.yml  profile bundle insert
```

## License

MIT
