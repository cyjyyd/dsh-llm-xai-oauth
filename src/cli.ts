#!/usr/bin/env node
/**
 * CLI for SuperGrok login and the independent token refresher.
 *
 * The dsh plugin only refreshes while a harness process is alive. Access
 * tokens last about an hour, so a machine that sits idle overnight needs
 * this process (or a systemd unit that runs it) to keep
 * ~/.grok-bridge/auth.json valid.
 */
import { applyDshDefaultModel, dshSettingsPath } from './dsh-defaults.js'
import { bootstrapXaiOAuth } from './bootstrap.js'
import { canPromptLogin, runDeviceLogin } from './login-flow.js'
import {
  defaultOAuthConfig,
  loadStoredTokens,
  REFRESH_DAEMON_POLL_MS,
  REFRESH_SKEW_MS,
  refreshStoredTokens,
  tokenNeedsRefresh,
} from './oauth.js'
import type { OAuthConfig, StoredTokens } from './oauth.js'

function usage(sink: NodeJS.WritableStream = process.stdout): void {
  sink.write(`dsh-llm-xai-oauth — SuperGrok / X Premium login and token refresh

Usage:
  dsh-llm-xai-oauth                 search for a token, log in if needed
  dsh-llm-xai-oauth login           same as above
  dsh-llm-xai-oauth login --force   ignore an existing token and re-authorize
  dsh-llm-xai-oauth refresh         refresh now if the access token is due
  dsh-llm-xai-oauth refresh --force refresh even when the token is still valid
  dsh-llm-xai-oauth status          print where the token lives and when it expires
  dsh-llm-xai-oauth daemon          keep refreshing in the background (no dsh)

The daemon writes ~/.grok-bridge/auth.json every time the access token is
within 5 minutes of expiry. Install it with:
  dsh-llm-xai-oauth daemon --install
  dsh-llm-xai-oauth daemon --uninstall

`)
}

function formatExpiry(tokens: StoredTokens, now = Date.now()): string {
  if (tokens.expiresAt === null) return 'expiry unknown'
  const remainMs = tokens.expiresAt - now
  if (remainMs <= 0) return `expired ${Math.ceil(-remainMs / 1000)}s ago`
  const minutes = Math.floor(remainMs / 60_000)
  const seconds = Math.ceil((remainMs % 60_000) / 1000)
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `expires in ${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) return `expires in ${minutes}m ${seconds}s`
  return `expires in ${seconds}s`
}

async function printStatus(): Promise<number> {
  const config = defaultOAuthConfig()
  const tokens = await loadStoredTokens(config)
  if (tokens === null) {
    process.stderr.write('No SuperGrok token on this machine.\n')
    process.stderr.write(`Looked at ${config.authFile} and ${config.grokCliAuthFile}.\n`)
    process.stderr.write('Run: dsh-llm-xai-oauth login\n')
    return 1
  }
  process.stdout.write(`file:     ${config.authFile}\n`)
  process.stdout.write(`source:   ${tokens.source}\n`)
  process.stdout.write(`status:   ${formatExpiry(tokens)}\n`)
  process.stdout.write(`refresh:  ${tokens.refreshToken === null ? 'missing (re-login required)' : 'present'}\n`)
  process.stdout.write(`dsh yaml: ${dshSettingsPath()}\n`)
  return 0
}

async function runLogin(force: boolean): Promise<number> {
  const config = defaultOAuthConfig()
  if (force) {
    await runDeviceLogin(config)
    const written = await applyDshDefaultModel(undefined)
    process.stdout.write(`dsh default model: ${written} (${dshSettingsPath()})\n`)
    return 0
  }
  const result = await bootstrapXaiOAuth(config, undefined, {
    interactive: canPromptLogin(),
  })
  if (result.tokens === null) {
    process.stderr.write(`${result.reason ?? 'xAI OAuth is not configured'}\n`)
    process.stderr.write('Re-run with --force from a terminal that can open auth.x.ai.\n')
    return 1
  }
  if (!result.loggedIn) {
    process.stdout.write(`Reused SuperGrok token (${result.tokens.source}).\n`)
  }
  process.stdout.write(`dsh default model: ${result.dsh} (${dshSettingsPath()})\n`)
  return 0
}

async function runRefresh(force: boolean): Promise<number> {
  const config = defaultOAuthConfig()
  const before = await loadStoredTokens(config)
  if (before === null) {
    process.stderr.write(`${missingHint()}\n`)
    return 1
  }
  if (!force && !tokenNeedsRefresh(before)) {
    process.stdout.write(`Token still valid (${formatExpiry(before)}); nothing to do.\n`)
    process.stdout.write('Pass --force to refresh anyway.\n')
    return 0
  }
  const next = await refreshStoredTokens(config, { force })
  process.stdout.write(`Refreshed. ${formatExpiry(next)} (${config.authFile})\n`)
  return 0
}

function missingHint(): string {
  return 'No SuperGrok token on this machine. Run `dsh-llm-xai-oauth login` first.'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}

function nextWakeMs(tokens: StoredTokens | null, now = Date.now()): number {
  if (tokens === null || tokens.expiresAt === null) return REFRESH_DAEMON_POLL_MS
  const due = tokens.expiresAt - REFRESH_SKEW_MS - now
  if (due <= 0) return 5_000
  return Math.min(Math.max(due, 5_000), REFRESH_DAEMON_POLL_MS)
}

export async function runRefreshDaemon(
  options: {
    signal?: AbortSignal
    once?: boolean
    log?: (line: string) => void
    config?: OAuthConfig
  } = {},
): Promise<void> {
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const config = options.config ?? defaultOAuthConfig()
  log(`dsh-llm-xai-oauth daemon watching ${config.authFile}`)
  while (options.signal?.aborted !== true) {
    try {
      const tokens = await loadStoredTokens(config)
      if (tokens === null) {
        log(missingHint())
      } else if (tokenNeedsRefresh(tokens)) {
        const next = await refreshStoredTokens(config, { signal: options.signal })
        log(`refreshed SuperGrok token; ${formatExpiry(next)}`)
      } else {
        log(`idle; ${formatExpiry(tokens)}`)
      }
    } catch (error: unknown) {
      log(`refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (options.once === true) return
    const tokens = await loadStoredTokens(config)
    try {
      await sleep(nextWakeMs(tokens), options.signal)
    } catch {
      return
    }
  }
}

async function installUserUnit(): Promise<number> {
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { spawnSync } = await import('node:child_process')
  const execPath = process.execPath
  const script = process.argv[1]
  if (script === undefined) {
    process.stderr.write('cannot resolve this CLI path for systemd ExecStart\n')
    return 1
  }
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  await mkdir(unitDir, { recursive: true, mode: 0o755 })
  const unitPath = join(unitDir, 'dsh-llm-xai-oauth.service')
  const unit = `[Unit]
Description=Keep SuperGrok / xAI OAuth access tokens fresh for dsh
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execPath} ${script} daemon
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`
  await writeFile(unitPath, unit, { mode: 0o644 })
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' })
  if (reload.status !== 0) {
    process.stderr.write(`wrote ${unitPath}\n`)
    process.stderr.write('systemctl --user daemon-reload failed; enable the unit yourself.\n')
    if (reload.stderr) process.stderr.write(reload.stderr)
    return 1
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', 'dsh-llm-xai-oauth.service'], { encoding: 'utf8' })
  process.stdout.write(`installed ${unitPath}\n`)
  if (enable.status !== 0) {
    process.stderr.write('enable --now failed; start it with: systemctl --user enable --now dsh-llm-xai-oauth.service\n')
    if (enable.stderr) process.stderr.write(enable.stderr)
    return 1
  }
  process.stdout.write('started dsh-llm-xai-oauth.service (user)\n')
  return 0
}

async function uninstallUserUnit(): Promise<number> {
  const { spawnSync } = await import('node:child_process')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { unlink } = await import('node:fs/promises')
  spawnSync('systemctl', ['--user', 'disable', '--now', 'dsh-llm-xai-oauth.service'], { encoding: 'utf8' })
  const unitPath = join(homedir(), '.config', 'systemd', 'user', 'dsh-llm-xai-oauth.service')
  try {
    await unlink(unitPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' })
  process.stdout.write(`removed ${unitPath}\n`)
  return 0
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    usage()
    return 0
  }
  const command = argv.find(arg => !arg.startsWith('-')) ?? 'login'
  const rest = argv.filter(arg => arg !== command)
  const force = hasFlag(rest, '--force')
  switch (command) {
    case 'login':
      return runLogin(force)
    case 'refresh':
      return runRefresh(force)
    case 'status':
      return printStatus()
    case 'daemon':
      if (hasFlag(rest, '--install')) return installUserUnit()
      if (hasFlag(rest, '--uninstall')) return uninstallUserUnit()
      await runRefreshDaemon()
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n`)
      usage(process.stderr)
      return 1
  }
}

function invokedAsCli(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return entry.endsWith('cli.js') || entry.endsWith('cli.ts')
}

if (invokedAsCli()) {
  try {
    process.exitCode = await main()
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
