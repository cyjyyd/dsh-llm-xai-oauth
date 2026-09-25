/**
 * Register an `xai` LLM route that authenticates with SuperGrok / X Premium
 * OAuth tokens. On start the plugin searches the machine for a reusable
 * grok-bridge / Grok CLI token, falls back to the xAI device-code login on a
 * TTY, then writes `agent-default-model` so `/model` and new agents land on
 * Grok. Connection facts resolve per request from the optional
 * `llm-xai-oauth` settings section; the access token is refreshed from
 * ~/.grok-bridge/auth.json just before each call.
 *
 * @module dsh-llm-xai-oauth
 */
import type { Context } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection } from './dsh-compat.js'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  XaiAdapter,
  catalogModelFromListing,
  mergeXaiCatalog,
} from './adapter.js'
import type { XaiCatalogModel, XaiConnectionOptions } from './adapter.js'
import { bootstrapXaiOAuth } from './bootstrap.js'
import {
  DEFAULT_CLIENT_MODE,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_UPSTREAM_BASE,
  defaultOAuthConfig,
  getAccessToken,
  refreshAccessTokenAfterUnauthorized,
  proxyDispatcher,
} from './oauth.js'
import type { XaiReasoningEffort } from './serialize.js'
import { fetch as undiciFetch } from 'undici'

export { XaiAdapter } from './adapter.js'
export type { XaiAdapterOptions, XaiCatalogModel, XaiConnectionOptions } from './adapter.js'
export {
  estimateRequestTokens,
  projectPromptTokens,
  projectedPromptTokens,
  promptTokensFromUsage,
  planRequestBudget,
  shouldTriggerCompaction,
} from './context-budget.js'
export { httpErrorCode } from './adapter.js'
export {
  DEFAULT_AUTH_BASE,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPE,
  DEFAULT_UPSTREAM_BASE,
  getAccessToken,
  refreshAccessTokenAfterUnauthorized,
  refreshStoredTokens,
  tokenNeedsRefresh,
  loadCanonicalTokens,
  loadStoredTokens,
} from './oauth.js'
export { main as cliMain, runRefreshDaemon } from './cli.js'
export { bootstrapXaiOAuth } from './bootstrap.js'
export { searchLocalTokens } from './discover.js'
export { applyDshDefaultModel, defaultModelSelection } from './dsh-defaults.js'

export const name = 'llm-xai-oauth'
export const inject = ['llm']

const NS = 'llm-xai-oauth'
const PROVIDER = 'xai'

const DEFAULT_MODELS: XaiCatalogModel[] = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    contextWindow: 500_000,
    maxTokens: 64_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: 500_000,
    maxTokens: 64_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    contextWindow: 1_000_000,
    maxTokens: 30_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['off', 'low', 'medium', 'high'],
  },
]

export interface Config {
  /** Subscription proxy used with OAuth (default cli-chat-proxy.grok.com/v1). */
  baseURL?: string
  /** Metered API fallback, unused while OAuth tokens exist. */
  apiBaseURL?: string
  clientVersion?: string
  clientMode?: string
  reasoningEffort?: XaiReasoningEffort
  maxTokens?: number
  defaultContextWindow?: number
  models?: XaiCatalogModel[]
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.array(z.union(['off', 'low', 'medium', 'high', 'xhigh'])),
})

/**
 * Mark a field volatile and keep the caller's view of the schema.
 *
 * On dsh 0.1.7 a volatile field updates this running instance without
 * remounting it, and it is the only kind of field the settings forms edit.
 * `.volatile()` returns a different schema type on each schemastery version,
 * so the marker is applied for its runtime effect and the original schema is
 * what callers see. `plainConfig` dereferences the resulting reference.
 */
function live<S extends z>(schema: S): S {
  const marker = (schema as S & { volatile?: () => S }).volatile
  return typeof marker === 'function' ? marker.call(schema) : schema
}

export const Config: z = z.object({
  baseURL: live(z.string()),
  apiBaseURL: live(z.string()),
  clientVersion: live(z.string()),
  clientMode: live(z.string()),
  reasoningEffort: live(z.union(['off', 'low', 'medium', 'high', 'xhigh'])),
  maxTokens: live(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS)),
  defaultContextWindow: live(z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)),
  models: live(z.array(catalogModel)),
  streamIdleTimeoutMs: live(z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)),
  retryPolicy: live(RetryPolicySchema),
})

function resolveModels(models: readonly XaiCatalogModel[] | undefined): XaiCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-xai-oauth: catalog model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-xai-oauth: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined || model.inputModalities.length === 0
        ? { inputModalities: ['text', 'image'] as const }
        : { inputModalities: [...model.inputModalities] },
      ...model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
        ? {}
        : { reasoningEfforts: [...model.reasoningEfforts] },
    }
  })
}

/**
 * Read one config snapshot.
 *
 * A volatile field (0.1.7) contributes its current snapshot, including an
 * absent one, which is what lets a settings edit reach the next request. A
 * plain field contributes only a value that is actually present, so a 0.1.5
 * section entry does not restate every schema default as if the user set it.
 */
export function plainConfig(config: Config): Config {
  const read = (key: keyof Config): Partial<Config> => {
    const value = config[key]
    if (isVolatile(value)) {
      const current = value.get()
      return current === undefined ? {} : { [key]: current }
    }
    return value === undefined ? {} : { [key]: value }
  }
  return {
    ...read('baseURL'),
    ...read('apiBaseURL'),
    ...read('clientVersion'),
    ...read('clientMode'),
    ...read('reasoningEffort'),
    ...read('maxTokens'),
    ...read('defaultContextWindow'),
    ...read('models'),
    ...read('streamIdleTimeoutMs'),
    ...read('retryPolicy'),
  }
}

export function resolveAdapterOptions(config: Config): XaiConnectionOptions {
  const environment = process.env
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return {
    baseURL: config.baseURL
      ?? environment.GROK_UPSTREAM_BASE
      ?? DEFAULT_UPSTREAM_BASE,
    clientVersion: config.clientVersion ?? environment.GROK_CLIENT_VERSION ?? DEFAULT_CLIENT_VERSION,
    clientMode: config.clientMode ?? environment.GROK_CLIENT_MODE ?? DEFAULT_CLIENT_MODE,
    defaults: {
      reasoningEffort: config.reasoningEffort ?? 'high',
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-xai-oauth: retryPolicy'),
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const oauth = defaultOAuthConfig()
  const ready = bootstrapXaiOAuth(oauth, ctx).catch((error: unknown) => {
    ctx.logger.warn('llm-xai-oauth: startup token search / login did not finish')
    ctx.logger.warn(error)
    return undefined
  })

  let current: () => Config = () => plainConfig(config)
  let lastRaw: Config | undefined
  let lastGood: XaiConnectionOptions | undefined
  const options = (): XaiConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-xai-oauth: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveAccessToken = async (): Promise<string> => {
    await ready
    try {
      return await getAccessToken(oauth)
    } catch (error) {
      throw new LlmError(
        error instanceof Error ? error.message : 'xAI OAuth token is unavailable',
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }
  }

  const refreshAccessToken = async (): Promise<string> => {
    await ready
    try {
      return await refreshAccessTokenAfterUnauthorized(oauth)
    } catch (error) {
      throw new LlmError(
        error instanceof Error ? error.message : 'xAI OAuth token refresh failed',
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }
  }

  let liveCatalog: XaiCatalogModel[] | undefined
  const adapter = new XaiAdapter({
    options,
    resolveAccessToken,
    refreshAccessToken,
    resolveAttachments: () => ctx.get('attachments'),
    liveCatalog: () => liveCatalog,
  })
  // Do not registerConfigurableProviders('xai'): llm-pi-ai already advertises
  // the catalog key. This plugin owns the live adapter route instead, which is
  // what /model and agent-default-model dispatch through.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  void ready.then(() => refreshLiveCatalog()).catch((error: unknown) => {
    ctx.logger.warn('llm-xai-oauth: live SuperGrok catalog unavailable; using the static fallback')
    ctx.logger.warn(error)
  })

  async function refreshLiveCatalog(): Promise<void> {
    const connection = options()
    const token = await resolveAccessToken()
    const dispatcher = proxyDispatcher()
    const response = await undiciFetch(`${connection.baseURL.replace(/\/$/u, '')}/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-grok-client-version': connection.clientVersion,
        'x-grok-client-mode': connection.clientMode,
      },
      signal: AbortSignal.timeout(15_000),
      ...dispatcher === undefined ? {} : { dispatcher },
    })
    if (!response.ok) {
      throw new Error(`xAI /models failed (HTTP ${response.status})`)
    }
    const payload = await response.json() as unknown
    const rows = payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload) ? payload : []
    const listed = rows
      .map(catalogModelFromListing)
      .filter((model): model is XaiCatalogModel => model !== undefined)
    if (listed.length === 0) return
    liveCatalog = mergeXaiCatalog(connection.models, listed)
  }
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // 0.1.5: the settings section is the live source, and a committed change
  // re-registers the route when the retry policy moved. 0.1.7 has no section;
  // the same re-registration listens for the loader's volatile update.
  installSettingsSection(ctx, NS, Config, plainConfig(config), {
    setSource: (source) => {
      current = () => plainConfig(source() as Config)
    },
    onChange: ensureRegistrationFacts,
  })
  // Declared by the 0.1.7 loader only; 0.1.5 never emits it, and the listener
  // is harmlessly dormant there. The event name is absent from that host's
  // cordis augmentation, so the call is widened rather than asserted.
  ;(ctx as { on: (event: string, listener: () => void) => void }).on('loader/volatile-update', ensureRegistrationFacts)

  // 0.1.7 builds a settings page per plugin unless the plugin opts out. This
  // one has no custom page, and the call is a no-op where `configure` is absent.
  const settingsHost = ctx as {
    inject?: (services: readonly string[], callback: (child: Context) => void) => void
  }
  settingsHost.inject?.(['settings'], (child) => {
    const forms = (child as { settings?: { configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void } }).settings
    if (typeof forms?.configure !== 'function') return
    child.effect(() => forms.configure!({ auto: false }, (ctx as { fiber?: unknown }).fiber))
  })

  await ready
}

export default { name, inject, Config, apply }
