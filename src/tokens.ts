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

export type TokenSource = 'grok-bridge' | 'grok-cli' | 'discovered'

export interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  clientId: string | null
  source: TokenSource
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

export function normalizeTokens(raw: unknown, source: TokenSource): StoredTokens | null {
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
