/**
 * Direct-fetch xAI/Grok adapter. Connection facts and the OAuth access token
 * resolve once per request, matching dsh-llm-deepseek so configuration and
 * token refresh reach the next call without a restart.
 */
import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { serializeRequest } from './serialize.js'
import type { ImageDataByAttachmentId, RequestDefaults, XaiReasoningEffort } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'
import type { WireError } from './types.js'
import { proxyDispatcher } from './oauth.js'
import {
  estimateRequestTokens,
  projectedPromptTokens,
  promptTokensFromUsage,
  planRequestBudget,
  type LastPromptBudget,
} from './context-budget.js'

export interface XaiCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ModelModality[]
  reasoningEfforts?: XaiReasoningEffort[]
  defaultEffort?: XaiReasoningEffort
}

export interface XaiConnectionOptions {
  baseURL: string
  clientVersion: string
  clientMode: string
  defaults: RequestDefaults
  maxTokens: number
  defaultContextWindow: number
  models: readonly XaiCatalogModel[]
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
}

export interface XaiAdapterOptions {
  options: () => XaiConnectionOptions
  resolveAccessToken: (connection: XaiConnectionOptions) => Promise<string>
  /** Called after HTTP 401/403 so the next attempt can use a fresh token. */
  refreshAccessToken?: (connection: XaiConnectionOptions) => Promise<string>
  resolveAttachments?: () => AttachmentStore | undefined
  /** Live SuperGrok catalog; when present it outranks the static fallback. */
  liveCatalog?: () => readonly XaiCatalogModel[] | undefined
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const DEFAULT_CONTEXT_WINDOW = 500_000
export const DEFAULT_MAX_TOKENS = 64_000
/** Leave a tiny remainder so compaction, not a 1-token completion, owns a full window. */
export const MIN_COMPLETION_TOKENS = 16
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const EFFORT_NAMES: Record<XaiReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
}

function modelInfo(provider: string, model: XaiCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: [...(model.inputModalities ?? ['text'])],
  }
}

const KNOWN_EFFORTS = new Set<XaiReasoningEffort>(['off', 'low', 'medium', 'high', 'xhigh'])

function asEffort(value: unknown): XaiReasoningEffort | undefined {
  return typeof value === 'string' && KNOWN_EFFORTS.has(value as XaiReasoningEffort)
    ? value as XaiReasoningEffort
    : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Parse one SuperGrok / OpenAI-compatible model listing into a catalog entry. */
export function catalogModelFromListing(value: unknown): XaiCatalogModel | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = stringField(record.id) ?? stringField(record.model)
  if (id === undefined) return undefined
  const effortsRaw = Array.isArray(record.reasoning_efforts) ? record.reasoning_efforts : []
  const efforts: XaiReasoningEffort[] = []
  let listedDefault: XaiReasoningEffort | undefined
  for (const item of effortsRaw) {
    if (typeof item === 'string') {
      const effort = asEffort(item)
      if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort)
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const effort = asEffort(entry.id) ?? asEffort(entry.value)
    if (effort === undefined) continue
    if (!efforts.includes(effort)) efforts.push(effort)
    if (entry.default === true) listedDefault = effort
  }
  if (efforts.length > 0 && !efforts.includes('off')) efforts.unshift('off')
  const defaultEffort = listedDefault
    ?? asEffort(record.reasoning_effort)
    ?? (efforts.includes('high') ? 'high' : efforts.find(effort => effort !== 'off'))
  return {
    id,
    ...stringField(record.name) === undefined ? {} : { name: stringField(record.name) },
    ...stringField(record.description) === undefined ? {} : { description: stringField(record.description) },
    ...numberField(record.context_window) === undefined ? {} : { contextWindow: numberField(record.context_window) },
    ...numberField(record.max_tokens) === undefined && numberField(record.max_output_tokens) === undefined
      ? {}
      : { maxTokens: numberField(record.max_tokens) ?? numberField(record.max_output_tokens) },
    inputModalities: ['text', 'image'],
    ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/** Merge a live `/models` listing over the static fallback catalog. */
export function mergeXaiCatalog(
  fallback: readonly XaiCatalogModel[],
  listed: readonly XaiCatalogModel[],
): XaiCatalogModel[] {
  if (listed.length === 0) return [...fallback]
  const byId = new Map<string, XaiCatalogModel>()
  for (const model of listed) byId.set(model.id, model)
  for (const model of fallback) {
    const live = byId.get(model.id)
    if (live === undefined) continue
    byId.set(model.id, {
      ...model,
      ...live,
      reasoningEfforts: live.reasoningEfforts ?? model.reasoningEfforts,
      defaultEffort: live.defaultEffort ?? model.defaultEffort,
      contextWindow: live.contextWindow ?? model.contextWindow,
      maxTokens: live.maxTokens ?? model.maxTokens,
      name: live.name ?? model.name,
    })
  }
  return [...byId.values()]
}

function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-grok-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    // SuperGrok often returns a generic 400. Only map it to overflow when the
    // body still names remaining/max context, not every mention of "token".
    if (
      /\bmax_tokens\b/i.test(detail)
      || /\b(?:remaining|available)\b.{0,40}\bcontext\b/i.test(detail)
      || /\bcontext\b.{0,40}\b(?:remaining|available)\b/i.test(detail)
    ) {
      return CONTEXT_WINDOW_EXCEEDED_CODE
    }
    // Empty / stripped 400 bodies are the common SuperGrok overflow shape.
    if (detail.trim() === '') return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function contextWindowFor(
  connection: XaiConnectionOptions,
  catalog: readonly XaiCatalogModel[],
  model: string,
): number {
  return catalog.find(entry => entry.id === model)?.contextWindow ?? connection.defaultContextWindow
}

function sessionBudgetKey(options: GenerateOptions): string {
  return options.sessionId === undefined ? '' : String(options.sessionId)
}

function overflowError(promptTokens: number, contextWindow: number, maxTokens: number): LlmError {
  return new LlmError(
    `xAI prompt is ${promptTokens} tokens with max_tokens ${maxTokens}; `
    + `the model context window is ${contextWindow}`,
    CONTEXT_WINDOW_EXCEEDED_CODE,
    { status: 400 },
  )
}

export class XaiAdapter extends LlmAdapter {
  constructor(private readonly config: XaiAdapterOptions) {
    super()
  }

  private readonly lastPrompt = new Map<string, LastPromptBudget>()

  /** Test / recovery hook: seed the last successful prompt sample for a session. */
  rememberPrompt(sessionId: string, budget: LastPromptBudget): void {
    this.lastPrompt.set(sessionId, budget)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'xAI (Grok OAuth)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  private catalog(): readonly XaiCatalogModel[] {
    const live = this.config.liveCatalog?.()
    const fallback = this.config.options().models
    return live === undefined || live.length === 0 ? fallback : live
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog().map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = this.catalog().find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    const efforts = configured?.reasoningEfforts ?? ['off', 'low', 'medium', 'high', 'xhigh']
    const defaultEffort = configured?.defaultEffort
      ?? connection.defaults.reasoningEffort
      ?? 'high'
    const selected = efforts.includes(defaultEffort) ? defaultEffort : efforts[0]
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text', 'image'] as ModelModality[] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: EFFORT_NAMES[id] ?? id })),
        ...selected === undefined ? {} : { defaultEffort: ReasoningEffortId(selected) },
      },
    })
  }

  private assertFitsContext(options: GenerateOptions, connection: XaiConnectionOptions): void {
    const plan = this.planBudget(options, connection)
    if (plan.overflow) {
      throw overflowError(
        plan.promptTokens ?? 0,
        contextWindowFor(connection, this.catalog(), options.model),
        options.maxTokens ?? connection.maxTokens,
      )
    }
  }

  private planBudget(options: GenerateOptions, connection: XaiConnectionOptions) {
    const estimate = estimateRequestTokens(options)
    const promptTokens = projectedPromptTokens(
      this.lastPrompt.get(sessionBudgetKey(options)),
      estimate,
    )
    return {
      estimate,
      promptTokens,
      ...planRequestBudget({
        promptTokens,
        contextWindow: contextWindowFor(connection, this.catalog(), options.model),
        requestedMax: options.maxTokens ?? connection.maxTokens,
        minRemaining: MIN_COMPLETION_TOKENS,
        purpose: options.purpose,
      }),
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    this.assertFitsContext(options, connection)
    let accessToken = await this.config.resolveAccessToken(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const images = await this.resolveImages(options, connection)
    const startRequest = (token: string) => this.request(
      options,
      watchdog.signal,
      connection,
      token,
      images,
      () => { watchdog.pulse() },
    )
    let iterator = startRequest(accessToken)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (
        error instanceof LlmError
        && this.config.refreshAccessToken !== undefined
        && (error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403)
      ) {
        accessToken = await this.config.refreshAccessToken(connection)
        iterator = startRequest(accessToken)[Symbol.asyncIterator]()
        try {
          while (true) {
            const result = await watchdog.next(iterator)
            if (result.done) {
              exhausted = true
              return
            }
            yield result.value
          }
        } catch (retryError: unknown) {
          if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
            throw new LlmError(
              `xAI stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
              'TIMEOUT',
              { cause: retryError },
            )
          }
          if (options.signal?.aborted) {
            throw new LlmError('xAI request aborted by caller', 'ABORTED', { cause: retryError })
          }
          if (retryError instanceof LlmError) throw retryError
          throw new LlmError(`xAI API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: retryError })
        }
      }
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `xAI stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('xAI request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`xAI API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('xAI stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async resolveImages(
    options: GenerateOptions,
    connection: XaiConnectionOptions,
  ): Promise<ImageDataByAttachmentId> {
    const hasImage = options.messages.some(message => contentHasImage(message.content))
    if (!hasImage) return new Map()
    const configured = connection.models.find(entry => entry.id === options.model)
    const modalities = configured?.inputModalities ?? ['text', 'image']
    if (!modalities.includes('image')) {
      throw new LlmError(`xAI model "${options.model}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = this.config.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('xAI image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const refs = new Map<string, ImageAttachmentRef>()
    for (const message of options.messages) collectImageRefs(message.content, refs)
    const images = new Map<string, string>()
    for (const ref of refs.values()) {
      const stored = await attachments.readImage(ref, options.signal)
      images.set(ref.attachmentId, Buffer.from(stored.data).toString('base64'))
    }
    return images
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: XaiConnectionOptions,
    accessToken: string,
    images: ImageDataByAttachmentId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const key = sessionBudgetKey(options)
    const budget = this.planBudget(options, connection)
    if (budget.overflow) {
      throw overflowError(
        budget.promptTokens ?? 0,
        contextWindowFor(connection, this.catalog(), options.model),
        options.maxTokens ?? connection.maxTokens,
      )
    }
    const body = serializeRequest(
      budget.maxTokens === undefined
        ? options
        : { ...options, maxTokens: budget.maxTokens },
      connection.defaults,
      images,
    )
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-grok-client-version': connection.clientVersion,
      'x-grok-client-mode': connection.clientMode,
      ...attributionHeaders(),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
    }
    const dispatcher = proxyDispatcher()
    let response: Response
    try {
      response = await undiciFetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
        ...dispatcher === undefined ? {} : { dispatcher },
      }) as unknown as Response
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(`xAI API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let message = `xAI API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Keep the HTTP status as the failure identity.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) throw new LlmError('xAI API returned no response body', 'EMPTY_RESPONSE')
    for await (const chunk of translate(parseSse(response.body, onComment))) {
      if (chunk.type === 'usage') {
        if (options.purpose !== 'compaction' && options.purpose !== 'session-title') {
          this.lastPrompt.set(key, {
            promptTokens: promptTokensFromUsage(chunk.usage),
            estimate: budget.estimate,
          })
        }
      }
      yield chunk
    }
  }
}
