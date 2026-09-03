/**
 * Project the next xAI prompt from the last provider usage so a request that
 * no longer fits the catalog context window fails as CONTEXT_WINDOW_EXCEEDED
 * *before* the proxy returns a generic HTTP 400. Harness overflow compaction
 * only retries that code.
 */
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Same four-characters-per-token density the harness token meter uses. */
const CHARS_PER_TOKEN = 4

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return textTokens(block.text)
    case 'tool-call':
      return textTokens(block.name) + textTokens(block.arguments)
    case 'tool-result':
      return block.content.reduce((sum, inner) => sum + blockTokens(inner), 0)
    default:
      return textTokens(JSON.stringify(block))
  }
}

/**
 * Cheap, stable size of one chat-completions request. Used only as a ratio
 * against the previous request so provider-reported prompt tokens can be
 * scaled after history grows or compaction shrinks it.
 */
export function estimateRequestTokens(
  options: Pick<GenerateOptions, 'system' | 'messages' | 'tools'>,
): number {
  let tokens = options.system === undefined ? 0 : textTokens(options.system)
  if (options.tools !== undefined && options.tools.length > 0) {
    tokens += textTokens(JSON.stringify(options.tools))
  }
  for (const message of options.messages) {
    for (const block of message.content) tokens += blockTokens(block)
  }
  return tokens
}

/** Prompt-side tokens from a provider usage sample (cached + uncached + writes). */
export function promptTokensFromUsage(usage: {
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/**
 * Scale the last provider-reported prompt by how the serialized request grew
 * or shrank. Compaction drops the heuristic, so the projection falls with it.
 */
export function projectPromptTokens(
  lastPromptTokens: number,
  lastEstimate: number,
  currentEstimate: number,
): number {
  if (!(lastPromptTokens >= 0) || !(currentEstimate >= 0)) return lastPromptTokens
  if (lastEstimate <= 0) return lastPromptTokens
  return Math.max(0, Math.round(lastPromptTokens * (currentEstimate / lastEstimate)))
}

export type GeneratePurpose = 'compaction' | 'session-title'

/** True when the projected prompt no longer fits the catalog context window. */
export function shouldTriggerCompaction(
  promptTokens: number,
  contextWindow: number,
  minRemaining = 0,
  requestedMax = 0,
): boolean {
  if (!Number.isFinite(promptTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false
  }
  if (promptTokens >= contextWindow) return true
  const remaining = contextWindow - promptTokens
  if (remaining < minRemaining) return true
  return requestedMax > 0 && remaining < requestedMax
}

export interface RequestBudgetPlan {
  overflow: boolean
  /** When set, serialize this completion cap instead of the caller value. */
  maxTokens?: number
}

/**
 * Decide whether the next xAI call should fail into harness overflow
 * compaction, clamp `max_tokens`, or pass through unchanged.
 *
 * Compaction / session-title calls never trip overflow: they are how the
 * harness recovers, and they still clamp so the summarizer fits.
 */
export function planRequestBudget(input: {
  promptTokens: number | undefined
  contextWindow: number
  requestedMax: number
  minRemaining: number
  purpose?: GeneratePurpose
}): RequestBudgetPlan {
  const { promptTokens, contextWindow, requestedMax, minRemaining, purpose } = input
  if (promptTokens === undefined) return { overflow: false }
  const recover = purpose === 'compaction' || purpose === 'session-title'
  if (
    !recover
    && shouldTriggerCompaction(promptTokens, contextWindow, minRemaining, requestedMax)
  ) {
    return { overflow: true }
  }
  const remaining = contextWindow - promptTokens
  if (remaining < requestedMax) {
    return { overflow: false, maxTokens: Math.max(minRemaining, remaining) }
  }
  return { overflow: false }
}

export interface LastPromptBudget {
  promptTokens: number
  estimate: number
}

/**
 * Project the current request's prompt from the last successful sample.
 * `undefined` when this session has not yet reported usage.
 */
export function projectedPromptTokens(
  last: LastPromptBudget | undefined,
  currentEstimate: number,
): number | undefined {
  if (last === undefined) return undefined
  return projectPromptTokens(last.promptTokens, last.estimate, currentEstimate)
}
