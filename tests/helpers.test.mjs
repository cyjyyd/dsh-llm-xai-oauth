import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeRequest, reasoningEffort } from '../lib/serialize.js'
import { mapFinishReason, mapUsage, translate } from '../lib/translate.js'
import { normalizeTokens } from '../lib/oauth.js'
import { resolveAdapterOptions } from '../lib/index.js'
test('reasoningEffort maps max to xhigh and rejects unknown levels', () => {
  assert.equal(reasoningEffort('high'), 'high')
  assert.equal(reasoningEffort('max'), 'xhigh')
  assert.throws(() => reasoningEffort('ultra'), /does not support/)
})

test('serializeRequest streams chat-completions with tools and effort', () => {
  const body = serializeRequest({
    provider: 'xai',
    model: 'grok-4.6',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    tools: [{
      name: 'bash',
      description: 'run a command',
      parameters: { type: 'object', properties: {} },
    }],
    reasoningEffort: 'high',
  })
  assert.equal(body.stream, true)
  assert.equal(body.model, 'grok-4.6')
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools?.[0]?.function.name, 'bash')
  assert.deepEqual(body.messages[0], { role: 'user', content: 'hi' })
})

test('translate turns reasoning and tool-call SSE into harness chunks', async () => {
  async function* payloads() {
    yield JSON.stringify({
      choices: [{ delta: { reasoning_content: 'think' } }],
    })
    yield JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"x":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
    })
    yield '[DONE]'
  }
  const chunks = []
  for await (const chunk of translate(payloads())) chunks.push(chunk)
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), true)
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), true)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(mapFinishReason('stop').kind, 'stop')
  assert.equal(mapUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }).inputTokens, 8)
})

test('normalizeTokens reads grok-bridge and grok-cli shapes', () => {
  const bridge = normalizeTokens({
    access_token: 'abc',
    refresh_token: 'ref',
    expires_at: Date.now() + 60_000,
  }, 'grok-bridge')
  assert.equal(bridge?.accessToken, 'abc')
  const cli = normalizeTokens({
    'https://auth.x.ai::user': {
      key: 'tok',
      refresh_token: 'r',
      expires_at: 1787770000,
    },
  }, 'grok-cli')
  assert.equal(cli?.accessToken, 'tok')
  assert.ok((cli?.expiresAt ?? 0) > 1e12)
})

test('resolveAdapterOptions defaults to the Grok subscription proxy', () => {
  const options = resolveAdapterOptions({})
  assert.equal(options.baseURL, 'https://cli-chat-proxy.grok.com/v1')
  assert.equal(options.models[0]?.id, 'grok-4.6')
  assert.equal(options.defaults.reasoningEffort, 'high')
})

import { catalogModelFromListing, mergeXaiCatalog } from '../lib/adapter.js'

test('catalogModelFromListing keeps grok-4.6 xhigh and grok-4.5 high-only', () => {
  const grok46 = catalogModelFromListing({
    id: 'grok-4.6',
    name: 'Grok 4.6',
    context_window: 500000,
    reasoning_effort: 'high',
    reasoning_efforts: [
      { id: 'xhigh', value: 'xhigh', default: false },
      { id: 'high', value: 'high', default: true },
      { id: 'medium', value: 'medium' },
      { id: 'low', value: 'low' },
    ],
  })
  assert.equal(grok46?.id, 'grok-4.6')
  assert.deepEqual(grok46?.reasoningEfforts, ['off', 'xhigh', 'high', 'medium', 'low'])
  assert.equal(grok46?.defaultEffort, 'high')

  const grok45 = catalogModelFromListing({
    id: 'grok-4.5',
    name: 'Grok 4.5',
    context_window: 500000,
    reasoning_efforts: [
      { id: 'high', default: true },
      { id: 'medium' },
      { id: 'low' },
    ],
  })
  assert.equal(grok45?.reasoningEfforts?.includes('xhigh'), false)
  assert.equal(grok45?.defaultEffort, 'high')
})

test('mergeXaiCatalog prefers the live listing over the static fallback', () => {
  const merged = mergeXaiCatalog(
    [{ id: 'grok-4.6', name: 'Grok 4.6', reasoningEfforts: ['off', 'high'] }, { id: 'grok-4.3', name: 'Grok 4.3' }],
    [{ id: 'grok-4.6', name: 'Grok 4.6', reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }, { id: 'grok-4.5', name: 'Grok 4.5' }],
  )
  assert.equal(merged.map(model => model.id).join(','), 'grok-4.6,grok-4.5')
  assert.equal(merged[0]?.reasoningEfforts?.includes('xhigh'), true)
})
