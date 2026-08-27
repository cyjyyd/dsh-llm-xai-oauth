/**
 * Load and refresh the machine's xAI OAuth tokens.
 *
 * Token files follow grok-bridge / official Grok CLI:
 *   ~/.grok-bridge/auth.json
 *   ~/.grok/auth.json
 *
 * Refresh uses the same client id and token endpoint as grok-bridge and
 * pi-ai's xAI OAuth helper, so an existing SuperGrok / X Premium login
 * works without a second browser dance.
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

export const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const DEFAULT_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const DEFAULT_AUTH_BASE = 'https://auth.x.ai'
export const DEFAULT_TOKEN_PATH = '/oauth2/token'
export const DEFAULT_DEVICE_CODE_PATH = '/oauth2/device/code'
export const DEFAULT_UPSTREAM_BASE = 'https://cli-chat-proxy.grok.com/v1'
export const DEFAULT_API_BASE = 'https://api.x.ai/v1'
export const DEFAULT_CLIENT_VERSION = '1.0.0'
export const DEFAULT_CLIENT_MODE = 'cli'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

export interface OAuthConfig {
  authBase: string
  tokenPath: string
  deviceCodePath: string
  clientId: string
  scope: string
  authFile: string
  grokCliAuthFile: string
  configFile: string
}

export interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  clientId: string | null
  source: 'grok-bridge' | 'grok-cli'
}

export interface AccessToken {
  accessToken: string
  mode: 'oauth'
}

let inflightRefresh: Promise<StoredTokens> | undefined

export function defaultOAuthConfig(): OAuthConfig {
  const home = homedir()
  const env = process.env
  const configDir = join(home, '.grok-bridge')
  const fileCfg = readJsonSync(join(configDir, 'config.json')) ?? {}
  return {
    authBase: env.GROK_OAUTH_BASE || stringField(fileCfg, 'authBase') || DEFAULT_AUTH_BASE,
    tokenPath: env.GROK_OAUTH_TOKEN_PATH || stringField(fileCfg, 'tokenPath') || DEFAULT_TOKEN_PATH,
    deviceCodePath: env.GROK_OAUTH_DEVICE_PATH || stringField(fileCfg, 'deviceCodePath') || DEFAULT_DEVICE_CODE_PATH,
    clientId: env.GROK_OAUTH_CLIENT_ID || stringField(fileCfg, 'clientId') || DEFAULT_CLIENT_ID,
    scope: env.GROK_OAUTH_SCOPE || stringField(fileCfg, 'scope') || DEFAULT_SCOPE,
    authFile: join(configDir, 'auth.json'),
    grokCliAuthFile: join(home, '.grok', 'auth.json'),
    configFile: join(configDir, 'config.json'),
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function readJsonSync(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function normalizeTokens(raw: unknown, source: StoredTokens['source']): StoredTokens | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  let candidate = (record.tokens ?? record.credentials ?? record.oauth ?? record) as Record<string, unknown>
  let accessToken = stringField(candidate, 'access_token')
    ?? stringField(candidate, 'accessToken')
    ?? stringField(candidate, 'token')
  if (accessToken === undefined) {
    const entry = Object.values(record).find((value): value is Record<string, unknown> =>
      value !== null
      && typeof value === 'object'
      && typeof (value as { key?: unknown }).key === 'string'
      && ((value as { refresh_token?: unknown }).refresh_token !== undefined
        || (value as { expires_at?: unknown }).expires_at !== undefined))
    if (entry === undefined) return null
    candidate = entry
    accessToken = stringField(entry, 'key')
  }
  if (accessToken === undefined) return null
  const refreshToken = stringField(candidate, 'refresh_token') ?? stringField(candidate, 'refreshToken') ?? null
  let expiresAt: number | null = null
  const rawExpiry = candidate.expires_at ?? candidate.expiresAt
  if (typeof rawExpiry === 'string') expiresAt = Date.parse(rawExpiry) || null
  else if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) {
    expiresAt = rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry
  }
  const clientId = stringField(candidate, 'oidc_client_id') ?? stringField(candidate, 'clientId') ?? null
  return { accessToken, refreshToken, expiresAt, clientId, source }
}

export async function loadStoredTokens(config: OAuthConfig): Promise<StoredTokens | null> {
  const own = normalizeTokens(await readJson(config.authFile), 'grok-bridge')
  if (own !== null) return own
  return normalizeTokens(await readJson(config.grokCliAuthFile), 'grok-cli')
}

export async function saveTokens(
  config: OAuthConfig,
  tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number },
  previousRefreshToken?: string | null,
): Promise<StoredTokens> {
  await mkdir(dirname(config.authFile), { recursive: true, mode: 0o700 })
  const record = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token ?? previousRefreshToken ?? null,
    expires_at: Date.now() + (tokenResponse.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000,
    saved_at: new Date().toISOString(),
  }
  await writeFile(config.authFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  const stored = normalizeTokens(record, 'grok-bridge')
  if (stored === null) throw new Error('dsh-llm-xai-oauth: failed to persist refreshed tokens')
  return stored
}

export function proxyDispatcher(): ProxyAgent | undefined {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (url === undefined || url === '') return undefined
  return new ProxyAgent(url)
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const dispatcher = proxyDispatcher()
  const response = await undiciFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    signal,
    ...dispatcher === undefined ? {} : { dispatcher },
  })
  let body: Record<string, unknown> = {}
  try {
    const parsed = await response.json() as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    body = { error: 'invalid_response' }
  }
  return { ok: response.ok, status: response.status, body }
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  clientId?: string | null,
  signal?: AbortSignal,
): Promise<StoredTokens> {
  const response = await postForm(`${config.authBase}${config.tokenPath}`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId && clientId.length > 0 ? clientId : config.clientId,
  }, signal)
  const access = typeof response.body.access_token === 'string' ? response.body.access_token : ''
  if (!response.ok || access === '') {
    const error = typeof response.body.error === 'string' ? response.body.error : undefined
    const description = typeof response.body.error_description === 'string' ? response.body.error_description : undefined
    throw new Error(
      `xAI OAuth token refresh failed (HTTP ${response.status})${error || description ? `: ${[error, description].filter(Boolean).join(': ')}` : ''}`,
    )
  }
  return saveTokens(config, {
    access_token: access,
    refresh_token: typeof response.body.refresh_token === 'string' ? response.body.refresh_token : undefined,
    expires_in: typeof response.body.expires_in === 'number' ? response.body.expires_in : undefined,
  }, refreshToken)
}

export async function getAccessToken(config: OAuthConfig, signal?: AbortSignal): Promise<string> {
  const tokens = await loadStoredTokens(config)
  if (tokens === null) {
    throw new Error(
      'xAI OAuth is not configured. Run `npx dsh-llm-xai-oauth login`, `grok-bridge login`, or `grok login`.',
    )
  }
  const expiringSoon = tokens.expiresAt !== null && tokens.expiresAt - Date.now() < REFRESH_SKEW_MS
  if (expiringSoon && tokens.refreshToken !== null) {
    if (inflightRefresh === undefined) {
      inflightRefresh = refreshTokens(config, tokens.refreshToken, tokens.clientId, signal)
        .finally(() => { inflightRefresh = undefined })
    }
    return (await inflightRefresh).accessToken
  }
  return tokens.accessToken
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export async function startDeviceAuth(config: OAuthConfig, signal?: AbortSignal): Promise<DeviceCode> {
  const response = await postForm(`${config.authBase}${config.deviceCodePath}`, {
    client_id: config.clientId,
    scope: config.scope,
    referrer: 'dsh',
  }, signal)
  if (!response.ok || typeof response.body.device_code !== 'string') {
    const error = typeof response.body.error === 'string' ? response.body.error : 'unknown error'
    throw new Error(`xAI device authorization failed (HTTP ${response.status}): ${error}`)
  }
  const verification = typeof response.body.verification_uri_complete === 'string'
    ? response.body.verification_uri_complete
    : String(response.body.verification_uri ?? '')
  return {
    deviceCode: response.body.device_code,
    userCode: String(response.body.user_code ?? ''),
    verificationUri: verification,
    intervalSeconds: typeof response.body.interval === 'number' && response.body.interval > 0 ? response.body.interval : 5,
    expiresInSeconds: typeof response.body.expires_in === 'number' ? response.body.expires_in : 600,
  }
}

export async function pollDeviceAuth(
  config: OAuthConfig,
  device: DeviceCode,
  signal?: AbortSignal,
): Promise<StoredTokens> {
  const deadline = Date.now() + device.expiresInSeconds * 1000
  let interval = device.intervalSeconds * 1000
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('Login cancelled')
    await new Promise(resolve => setTimeout(resolve, interval))
    const response = await postForm(`${config.authBase}${config.tokenPath}`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: device.deviceCode,
    }, signal)
    if (response.ok && typeof response.body.access_token === 'string') {
      return saveTokens(config, {
        access_token: response.body.access_token,
        refresh_token: typeof response.body.refresh_token === 'string' ? response.body.refresh_token : undefined,
        expires_in: typeof response.body.expires_in === 'number' ? response.body.expires_in : undefined,
      })
    }
    const error = response.body.error
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += 5000
      continue
    }
    throw new Error(`xAI device login failed: ${String(error ?? `HTTP ${response.status}`)}`)
  }
  throw new Error('xAI device code expired before login completed')
}
