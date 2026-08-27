import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireContentPart, WireMessage, WireRequest, WireTool } from './types.js'

export type ImageDataByAttachmentId = ReadonlyMap<string, string>
export type XaiReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

export interface RequestDefaults {
  reasoningEffort?: XaiReasoningEffort
}

function imageDataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`
}

function contentParts(blocks: readonly ContentBlock[], images: ImageDataByAttachmentId): WireContentPart[] {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
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
    } else if (block.type === 'tool-result') {
      parts.push(...contentParts(block.content, images))
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

function flattenText(blocks: ContentBlock[]): string {
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

function serializeAssistant(message: Message): WireMessage {
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

export function serializeMessages(
  messages: Message[],
  images: ImageDataByAttachmentId = new Map(),
): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
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
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const regularHasImage = contentHasImage(regular)
    if (regular.length > 0 || toolResults.length === 0) {
      wire.push({
        role: 'user',
        content: regularHasImage ? contentParts(regular, images) : flattenText(regular),
      })
    }
    for (const result of toolResults) {
      const resultHasImage = contentHasImage(result.content)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: resultHasImage
          ? contentParts(result.content, images)
          : flattenText(result.content) || '(no output)',
      })
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
