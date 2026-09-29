/**
 * Interactive xAI device-code login, shared by the CLI and plugin bootstrap.
 */
import { openBrowser, browserAllowed } from './browser.js'
import { prefersVisualOnboarding } from './onboarding.js'
import { pollDeviceAuth, startDeviceAuth } from './oauth.js'
import type { DeviceCode, OAuthConfig, StoredTokens } from './oauth.js'

export interface LoginSink {
  write(text: string): void
}

export interface LoginOptions {
  sink?: LoginSink
  open?: (url: string) => boolean
  signal?: AbortSignal
}

const stderrSink: LoginSink = {
  write(text: string): void {
    process.stderr.write(text)
  },
}

export function formatLoginPrompt(device: DeviceCode): string {
  const lines = [
    'xAI device login (SuperGrok / X Premium)',
    `Open: ${device.verificationUri}`,
    `Code: ${device.userCode}`,
    'Waiting for authorization in the browser…',
    '',
  ]
  return lines.join('\n')
}

export async function runDeviceLogin(
  config: OAuthConfig,
  options: LoginOptions = {},
): Promise<StoredTokens> {
  const sink = options.sink ?? stderrSink
  const opener = options.open ?? openBrowser
  const device = await startDeviceAuth(config, options.signal)
  sink.write(formatLoginPrompt(device))
  if (opener(device.verificationUri)) {
    sink.write('Opened the login page in your browser.\n')
  }
  const tokens = await pollDeviceAuth(config, device, options.signal)
  sink.write(`Logged in. Access token saved to ${config.authFile} (${tokens.source}).\n`)
  return tokens
}

export function canPromptLogin(): boolean {
  return process.stdout.isTTY === true || process.stderr.isTTY === true
}

/**
 * Pick the login surface for this host.
 *
 * Windows is served by the visual guide because the desktop client does not
 * attach a console: the terminal-only flow would never print its code. Every
 * other host keeps the terminal flow, and a host that cannot open a browser
 * at all still needs one — the guide renders the URL on stderr.
 */
export function loginPrefersVisual(
  options: { visual?: boolean; platform?: NodeJS.Platform } = {},
): boolean {
  const visual = options.visual ?? prefersVisualOnboarding(options.platform ?? process.platform)
  return visual && browserAllowed()
}

export function loginDisabledByEnv(): boolean {
  const value = process.env.DSH_XAI_OAUTH_NO_LOGIN
  return value === '1' || value === 'true'
}
