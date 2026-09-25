import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { WireContentPart, WireMessage, WireRequest, WireTool } from './types.js'

/**
 * One model-visible message, read structurally so the same build serves both
 * hosts this plugin declares:
 *
 * - dsh 0.1.5-rc carries a tool result as a `tool-result` block inside a
 *   user-role message (`toolCallId` lives on the block).
 * - dsh 0.1.7-rc.1 carries it as its own `tool`-role message (`toolCallId`
 *   lives on the message) and may also hand adapters a `developer` message.
 *
 * `GenerateOptions.messages` is also wider than durable `Message` on 0.1.7
 * (request-only user inputs have no id), so this does not import `Message`.
 */
interface RequestMessage {
  role: string
  content: readonly ContentBlock[]
  toolCallId?: string
  isError?: boolean
}

export type ImageDataByAttachmentId = ReadonlyMap<string, string>
export type XaiReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

export interface RequestDefaults {
  reasoningEffort?: XaiReasoningEffort
}

function imageDataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`
}

/**
 * A 0.1.5 tool result nested inside a user message. 0.1.7 has no such block,
 * so this reads the fields structurally and never narrows `ContentBlock`:
 * a type predicate would have to be assignable to every block in the union,
 * which a shape the current host does not declare can never be.
 */
function legacyToolResult(block: ContentBlock): { toolCallId: string; content: readonly ContentBlock[] } | undefined {
  const record = block as { type?: unknown; toolCallId?: unknown; content?: unknown }
  if (record.type !== 'tool-result') return undefined
  if (typeof record.toolCallId !== 'string' || !Array.isArray(record.content)) return undefined
  return { toolCallId: record.toolCallId, content: record.content as readonly ContentBlock[] }
}

function visibleText(blocks: readonly ContentBlock[]): string {
  return flattenText(blocks.filter(block => {
    if (block.type !== 'image') return true
    return (block as { offloaded?: unknown }).offloaded !== true
  }))
}

function contentParts(blocks: readonly ContentBlock[], images: ImageDataByAttachmentId): WireContentPart[] {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      // 0.1.7 marks an occurrence the harness already replaced with
      // placeholder text. The flag is absent on 0.1.5, where every image is
      // still bytes. Sending bytes for a marked one would undo that decision.
      if ((block as { offloaded?: unknown }).offloaded === true) continue
      const base64 = images.get(block.attachment.attachmentId)
      if (base64 === undefined) {
        throw new LlmError(
          `xAI image serialization has no bytes for attachment "${block.attachment.attachmentId}"`,
          'UNSUPPORTED_CONTENT',
        )
      }
      parts.push({
        type: 'image_url',
        image_url: { url: imageDataUrl(block.attachment.mediaType, base64) },
      })
    } else {
      const legacy = legacyToolResult(block)
      if (legacy !== undefined) parts.push(...contentParts(legacy.content, images))
    }
  }
  return parts
}

function assertRoleTextOnly(role: 'system' | 'assistant', blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      `The xAI chat-completions adapter cannot represent an image in a ${role} message.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function reasoningEffort(effort: string): Exclude<XaiReasoningEffort, 'off'> | 'off' {
  if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort
  }
  if (effort === 'max') return 'xhigh'
  throw new LlmError(`xAI does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

function serializeAssistant(message: RequestMessage): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: text,
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

function toolWireMessage(
  toolCallId: string,
  content: readonly ContentBlock[],
  images: ImageDataByAttachmentId,
): WireMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: contentHasImage(content)
      ? contentParts(content, images)
      : flattenText(content) || '(no output)',
  }
}

/**
 * Translate harness messages onto the OpenAI-compatible wire shape.
 *
 * Both hosts this plugin runs on leave `GenerateOptions.system` undefined for
 * a loop-built request and carry the rendered prompt as a leading
 * `system`-role message. `serializeRequest` still prepends `options.system`
 * when a hand-built one-shot sets it.
 *
 * Tool results differ by host and both shapes are read here: 0.1.5 nests a
 * `tool-result` block in a user message, 0.1.7 sends a `tool`-role message.
 * Either way the wire is an OpenAI `tool` message keyed by the call id.
 *
 * `file` blocks and offloaded images are projected to text by the harness
 * before dispatch, and `developer` messages (0.1.7 tool-set changes) have no
 * producer yet. Unknown roles and block types fall through as a no-op.
 */
export function serializeMessages(
  messages: readonly RequestMessage[],
  images: ImageDataByAttachmentId = new Map(),
): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'developer') continue
    if (message.role === 'system') {
      assertRoleTextOnly('system', message.content)
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertRoleTextOnly('assistant', message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    if (message.role === 'tool') {
      const toolCallId = message.toolCallId
      if (toolCallId === undefined || toolCallId.length === 0) {
        throw new LlmError('xAI tool result is missing its tool call id', 'INVALID_REQUEST')
      }
      wire.push(toolWireMessage(toolCallId, message.content, images))
      continue
    }
    const legacyResults = message.content.flatMap(block => {
      const legacy = legacyToolResult(block)
      return legacy === undefined ? [] : [legacy]
    })
    const regular = message.content.filter(block => legacyToolResult(block) === undefined)
    const regularHasImage = contentHasImage(regular)
    if (regular.length > 0 || legacyResults.length === 0) {
      wire.push({
        role: 'user',
        content: regularHasImage ? contentParts(regular, images) : visibleText(regular),
      })
    }
    for (const result of legacyResults) {
      wire.push(toolWireMessage(result.toolCallId, result.content, images))
    }
  }
  return wire
}

export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  images: ImageDataByAttachmentId = new Map(),
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages, images))
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const effort = options.purpose === 'session-title'
    ? 'off'
    : options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : reasoningEffort(String(options.reasoningEffort))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...effort !== undefined && effort !== 'off' ? { reasoning_effort: effort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
