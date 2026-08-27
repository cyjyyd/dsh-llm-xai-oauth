/**
 * Interactive xAI device-code login, shared by the CLI and plugin bootstrap.
 */
import { openBrowser } from './browser.js'
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

export function loginDisabledByEnv(): boolean {
  const value = process.env.DSH_XAI_OAUTH_NO_LOGIN
  return value === '1' || value === 'true'
}
