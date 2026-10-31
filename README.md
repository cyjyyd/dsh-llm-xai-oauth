# dsh-llm-xai-oauth

[![npm](https://img.shields.io/npm/v/dsh-llm-xai-oauth?style=flat-square&color=4b6fff)](https://www.npmjs.com/package/dsh-llm-xai-oauth)
[![npm downloads](https://img.shields.io/npm/dm/dsh-llm-xai-oauth?style=flat-square)](https://www.npmjs.com/package/dsh-llm-xai-oauth)
[![CI](https://github.com/cyjyyd/dsh-llm-xai-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/cyjyyd/dsh-llm-xai-oauth/actions/workflows/ci.yml)
[![dshfind](https://dshfind.com/api/badge/cyjyyd/dsh-llm-xai-oauth)](https://dshfind.com/en/plugins/cyjyyd/dsh-llm-xai-oauth?ref=badge)

You already pay for SuperGrok / X Premium. This plugin puts that subscription
into DeepSeek Harness as a live `xai` route: `grok-4.7`, device-code login,
token refresh that does not depend on a TUI being open. No xAI API key.

Works in **headless**, **web**, and any terminal profile. The SSH TUI
[dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui) can sit on top; it is not
required.

中文：[README.zh.md](README.zh.md)

Listed on [dshfind](https://dshfind.com/en/plugins/cyjyyd/dsh-llm-xai-oauth):

[![dshfind](https://dshfind.com/api/card/cyjyyd/dsh-llm-xai-oauth?lang=en)](https://dshfind.com/en/plugins/cyjyyd/dsh-llm-xai-oauth?ref=badge)

Install from **npm** (do not use the GitHub source unless you are developing):

```bash
dsh plugin --profile headless add dsh-llm-xai-oauth@latest
npx dsh-llm-xai-oauth login
npx dsh-llm-xai-oauth daemon --install
dsh --profile headless --provider xai --model grok-4.7
```

Swap `headless` for `web` or `tui`. **Updates must use `@latest`.** A bare
`add dsh-llm-xai-oauth` keeps whatever version pnpm already pinned.

## Three facts that matter

1. **This is subscription OAuth, not an API key.** After install, dsh talks to `https://cli-chat-proxy.grok.com` with the access token in `~/.grok-bridge/auth.json`.
2. **The access token lasts about an hour.** While dsh is running, the plugin refreshes five minutes before expiry and again on HTTP 401. If dsh is not running, that refresh does not happen.
3. **So you need a refresher that is not the dsh process.** Use `dsh-llm-xai-oauth daemon`. Do not expect the TUI or a headless one-shot to keep the token alive overnight.

`/usage` returning 401, then chat also 401, almost always means: the token expired and nothing was refreshing it.

## Setup in five minutes

You need Node.js ≥ 22.19 and a DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh`).
Verified on `0.1.5-rc.1` through `0.1.5-rc.3`, on `0.1.7-rc.1` and `0.1.7-rc.2`, on `0.2.0-rc.1` and `0.2.0-rc.2`, and on `0.2.1-rc.2`
through `0.2.1-rc.5` — the line the Windows and macOS desktop builds ship. `0.1.2`, the `0.1.6` alphas and the `0.2.x` alphas are not
supported. See the [compatibility audit](https://github.com/cyjyyd/dsh-llm-xai-oauth/blob/main/docs/compatibility-audit-0.2.1-rc.5.md) for the evidence behind that list.

### 1. Add the plugin to a profile

```bash
dsh plugin --profile headless add dsh-llm-xai-oauth@latest
dsh plugin --profile web add dsh-llm-xai-oauth@latest
dsh plugin --profile tui add dsh-llm-xai-oauth@latest
```

Confirm the bundle landed (`id: llm-xai-oauth`). Without that line, `/model` will not have a live SuperGrok route:

```bash
dsh --profile headless --dump-config | grep llm-xai-oauth
```

A local checkout is for development. Prefer npm; a bare `github:` install is what outdated directories still suggest, and pnpm ≥ 10 will refuse its `prepare` script until you allow builds.

### 2. Log in once (from a machine that can open a browser)

If grok-bridge or the official Grok CLI already left `~/.grok-bridge/auth.json` or `~/.grok/auth.json` on this machine, **this step reuses it and does not open a browser**.

Otherwise, from a terminal that can open `auth.x.ai`:

```bash
npx dsh-llm-xai-oauth login
# force a new device-code even when a token already exists:
npx dsh-llm-xai-oauth login --force
```

The CLI prints a URL and a user code. Authorize SuperGrok / X Premium in the browser. On success it writes:

- token: `~/.grok-bridge/auth.json` (`0600`)
- dsh default model: `$DSH_HOME/settings.yaml` `agent-default-model` → `xai` / `grok-4.7`  
  (if that section is already `xai`, your grok model and effort are left alone)

Headless / CI hosts without a TTY skip the prompt. Set `DSH_XAI_OAUTH_NO_LOGIN=1` to skip it even on a TTY.

### Windows and the desktop app: visual first-run guide

The Windows desktop build ships no console, so a terminal-only login would print its device code where nobody can read it. On `win32` the plugin serves a local page instead, opens it in the default browser, and completes the same device-code grant there:

- the device code, a copy button, and an **Open the authorization page** button;
- live status that flips to *connected* the moment xAI hands back tokens, with no manual refresh;
- light and dark themes, matching the DeepSeek Harness desktop client.

The guide stays up until the page has painted the final state and acknowledged it (5 s cap), so a successful authorization is always visible before the port closes. If the browser cannot be launched — a spawn failure or a blocked default browser — the button says so inline and the authorization URL is announced on stderr, instead of reporting a success that never happened.

The page is served from `127.0.0.1` on an ephemeral port under a random 128-bit path, so no other local process can read the pending code. It pulls in no external asset and needs no network beyond the xAI endpoints.

Force it on any platform, or suppress it:

```bash
npx dsh-llm-xai-oauth login --ui    # serve the guide even on Linux/macOS
GROK_BRIDGE_NO_BROWSER=1 npx dsh-llm-xai-oauth login   # never launch a browser
```

When no browser can be launched, the guide's URL is printed to stderr so you can open it yourself.

Check remaining lifetime:

```bash
npx dsh-llm-xai-oauth status
```

### 3. Keep the token fresh (this is not dsh)

Access tokens are short. A TUI, headless job, or cron that starts after expiry will read a dead token; `/usage` and chat then 401.

**Recommended: a user systemd unit**

```bash
npx dsh-llm-xai-oauth daemon --install
```

That writes `~/.config/systemd/user/dsh-llm-xai-oauth.service` and `enable --now`. The process re-reads `auth.json` about once a minute and refreshes five minutes before expiry. dsh does not need to be running.

No systemd, or you do not want a user unit:

```bash
# foreground
npx dsh-llm-xai-oauth daemon

# or cron every 20 minutes (no-op while the token is still valid)
*/20 * * * * npx --yes dsh-llm-xai-oauth refresh >/tmp/dsh-xai-refresh.log 2>&1
```

Remove the user unit:

```bash
npx dsh-llm-xai-oauth daemon --uninstall
```

Refresh once by hand:

```bash
npx dsh-llm-xai-oauth refresh
npx dsh-llm-xai-oauth refresh --force
```

### 4. Run one SuperGrok turn

```bash
grep -A3 agent-default-model ~/.dsh/settings.yaml

dsh --profile tui --provider xai --model grok-4.7
dsh --profile headless "Reply with exactly: xai-harness-ok. Do not use tools."
```

In [dsh-ssh-tui](https://github.com/cyjyyd/dsh-ssh-tui): `/model` picks Grok; `/usage` reads the SuperGrok weekly remaining quota. The TUI now refreshes a due token before `/usage`, and on 401 it force-refreshes once and retries. **That covers “I opened the TUI just as the token expired”. It does not cover “the machine slept overnight with no refresher”.** Step 3 is that refresher.

## Switching models later

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: xai
  model: grok-4.7
  reasoningEffort: high
```

Or pass `--provider` / `--model`, or use `/model` in the TUI. At startup the plugin calls `GET {baseURL}/models` with the current token; `/model` prefers that live catalog (currently `grok-4.7` with xhigh, `grok-4.5` up to high). The static fallback still lists `grok-4.3`.

| Model | Context | Output cap | Reasoning efforts |
| --- | --- | --- | --- |
| `grok-4.7` | 500K | 64K | off / low / medium / high / xhigh |
| `grok-4.5` | 500K | 64K | off / low / medium / high |
| `grok-4.3` | 1M | 30K | off / low / medium / high |

`max` in a DeepSeek-style picker maps to `xhigh`.

Optional plugin settings are `baseURL`, `reasoningEffort`, `models`, and the retry / idle timeout. On `0.1.5` they live under `llm-xai-oauth:` in `$DSH_HOME/settings.yaml`. On `0.1.7` they live in the profile patch and `0.1.7` imports that file once, on its first start. Either way a change reaches the next request without a restart.

Long SuperGrok chats can fill the 500K window and then 400 with a generic `INVALID_REQUEST` because `max_tokens` no longer fits. From 0.1.3 the adapter projects the next prompt from the last usage sample and, when remaining context cannot hold the requested completion, throws `CONTEXT_WINDOW_EXCEEDED` so harness overflow compaction can retry. Compaction / title calls still go through, with `max_tokens` clamped to the remainder.

## 401 / expiry

```bash
npx dsh-llm-xai-oauth status
ls -l ~/.grok-bridge/auth.json
systemctl --user status dsh-llm-xai-oauth.service
journalctl --user -u dsh-llm-xai-oauth.service -n 50
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/usage` or chat HTTP 401 | access token expired, nothing refreshed it | `refresh --force`, then install the daemon |
| chat HTTP 400 `INVALID_REQUEST` on a long session | remaining context < `max_tokens`; older plugin versions did not trip compaction | update to 0.1.3+; `/compact` if a turn already failed |
| status says `no refresh_token` | truncated file / not an OAuth login | `login --force` |
| dump-config has no `llm-xai-oauth` | plugin is not in this profile | repeat step 1 |
| token exists but dsh still uses DeepSeek | `agent-default-model` is not `xai` | `/model`, or edit settings.yaml |
| `daemon --install` fails | no user systemd / linger | use cron, or `loginctl enable-linger $USER` |

`HTTPS_PROXY` / `HTTP_PROXY` apply to login, refresh, and chat.

Override client / endpoints only when xAI changes them:

| Env | Default |
| --- | --- |
| `GROK_OAUTH_CLIENT_ID` | `b1a00492-073a-47ea-816f-4c329264a828` |
| `GROK_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` |
| `GROK_OAUTH_BASE` | `https://auth.x.ai` |
| `GROK_UPSTREAM_BASE` | `https://cli-chat-proxy.grok.com/v1` |
| `DSH_XAI_OAUTH_NO_LOGIN` | skip the startup device-code prompt |
| `GROK_BRIDGE_NO_BROWSER` | print the URL instead of opening a browser |

## What it is not

- Not an xAI API-key provider. Metered `api.x.ai` stays on the generic catalog.
- Not a Codex / Claude / Copilot aggregator.
- Not a Web “one-click login” settings card, and no OAuth redirect port is opened. Device authorization stays the mechanism; the Windows guide merely renders that code in a browser page for hosts without a console.
- Does not `registerConfigurableProviders('xai')`; `llm-pi-ai` already owns that catalog key. This package owns the **live adapter route**.

## Layout

```text
src/index.ts        Cordis plugin: search / login / register the xai route
src/cli.ts          login / status / refresh / daemon
src/bootstrap.ts    local token search, device login, dsh default model
src/onboarding.ts   browser guide for the first-run device login (Windows)
src/oauth.ts        load / refresh / device-code
src/adapter.ts      fetch + SSE chat-completions adapter (retries once on 401)
src/context-budget.ts  project remaining context and trip harness overflow compaction
cordis.patch.yml    profile bundle insert
```

## License

MIT
