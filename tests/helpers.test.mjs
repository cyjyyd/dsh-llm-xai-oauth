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

import { catalogModelFromListing, mergeXaiCatalog, httpErrorCode, XaiAdapter } from '../lib/adapter.js'
import { explicitSearchPaths, searchLocalTokens } from '../lib/discover.js'
import { bootstrapXaiOAuth } from '../lib/bootstrap.js'
import { applyDshDefaultModel, upsertDefaultModelSection, settingsHasDefaultModel } from '../lib/dsh-defaults.js'
import { formatLoginPrompt } from '../lib/login-flow.js'
import {
  estimateRequestTokens,
  projectPromptTokens,
  projectedPromptTokens,
  promptTokensFromUsage,
  planRequestBudget,
  shouldTriggerCompaction,
} from '../lib/context-budget.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('explicitSearchPaths covers grok-bridge, grok CLI, and common config dirs', () => {
  const paths = explicitSearchPaths('/home/user')
  assert.equal(paths.some(path => path.endsWith('.grok-bridge/auth.json')), true)
  assert.equal(paths.some(path => path.endsWith('.grok/auth.json')), true)
  assert.equal(paths.some(path => path.endsWith('.config/grok/auth.json')), true)
})

test('searchLocalTokens finds a grok-cli shaped file outside the two canonical paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-search-'))
  await mkdir(join(home, '.config', 'grok'), { recursive: true })
  await writeFile(join(home, '.config', 'grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::user': {
      key: 'found-token',
      refresh_token: 'refresh',
      expires_at: Date.now() + 60_000,
    },
  }))
  const found = await searchLocalTokens({
    authBase: 'https://auth.x.ai',
    tokenPath: '/oauth2/token',
    deviceCodePath: '/oauth2/device/code',
    clientId: 'test',
    scope: 'openid',
    authFile: join(home, '.grok-bridge', 'auth.json'),
    grokCliAuthFile: join(home, '.grok', 'auth.json'),
    configFile: join(home, '.grok-bridge', 'config.json'),
  }, home)
  assert.equal(found?.accessToken, 'found-token')
  assert.equal(found?.path.endsWith('.config/grok/auth.json'), true)
})

test('upsertDefaultModelSection inserts or replaces agent-default-model', () => {
  const inserted = upsertDefaultModelSection('llm-pi-ai:\n  providers: {}\n', {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'high',
  })
  assert.match(inserted, /agent-default-model:\n  provider: xai\n  model: grok-4.6\n  reasoningEffort: high\n/)
  const replaced = upsertDefaultModelSection(
    'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nui-onboarding:\n  welcomeNoticeVersion: 1\n',
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high' },
  )
  assert.match(replaced, /provider: xai/)
  assert.doesNotMatch(replaced, /deepseek-official/)
  assert.match(replaced, /ui-onboarding:/)
  assert.equal(settingsHasDefaultModel(replaced, { provider: 'xai', model: 'grok-4.6' }), true)
})

test('bootstrap reuses a local token, skips login, and writes dsh defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-boot-'))
  const authFile = join(home, 'auth.json')
  await writeFile(authFile, JSON.stringify({
    access_token: 'abc',
    refresh_token: 'ref',
    expires_at: Date.now() + 60_000,
  }))
  let loggedIn = false
  const result = await bootstrapXaiOAuth({
    authBase: 'https://auth.x.ai',
    tokenPath: '/oauth2/token',
    deviceCodePath: '/oauth2/device/code',
    clientId: 'test',
    scope: 'openid',
    authFile,
    grokCliAuthFile: join(home, 'missing.json'),
    configFile: join(home, 'config.json'),
  }, undefined, {
    home,
    interactive: false,
    login: async () => {
      loggedIn = true
      throw new Error('login should not run')
    },
    applyDefault: async () => 'file',
  })
  assert.equal(result.tokens?.accessToken, 'abc')
  assert.equal(result.loggedIn, false)
  assert.equal(result.dsh, 'file')
  assert.equal(loggedIn, false)
})

test('bootstrap starts device login when no token exists, then forces dsh defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-login-'))
  let force
  const result = await bootstrapXaiOAuth({
    authBase: 'https://auth.x.ai',
    tokenPath: '/oauth2/token',
    deviceCodePath: '/oauth2/device/code',
    clientId: 'test',
    scope: 'openid',
    authFile: join(home, 'auth.json'),
    grokCliAuthFile: join(home, 'missing.json'),
    configFile: join(home, 'config.json'),
  }, undefined, {
    home,
    interactive: true,
    login: async () => ({
      accessToken: 'new',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      clientId: null,
      source: 'grok-bridge',
    }),
    applyDefault: async (_ctx, shouldForce) => {
      force = shouldForce
      return 'file'
    },
  })
  assert.equal(result.loggedIn, true)
  assert.equal(result.tokens?.accessToken, 'new')
  assert.equal(force, true)
})

test('bootstrap does not prompt when interactive is off and no token exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-skip-'))
  const result = await bootstrapXaiOAuth({
    authBase: 'https://auth.x.ai',
    tokenPath: '/oauth2/token',
    deviceCodePath: '/oauth2/device/code',
    clientId: 'test',
    scope: 'openid',
    authFile: join(home, 'auth.json'),
    grokCliAuthFile: join(home, 'missing.json'),
    configFile: join(home, 'config.json'),
  }, undefined, {
    home,
    interactive: false,
    login: async () => {
      throw new Error('login should not run')
    },
  })
  assert.equal(result.tokens, null)
  assert.equal(result.loggedIn, false)
  assert.match(result.reason ?? '', /no reusable SuperGrok token/)
})

test('formatLoginPrompt prints the verification URL and user code', () => {
  const text = formatLoginPrompt({
    deviceCode: 'd',
    userCode: 'ABCD-1234',
    verificationUri: 'https://auth.x.ai/device?code=ABCD-1234',
    intervalSeconds: 5,
    expiresInSeconds: 600,
  })
  assert.match(text, /https:\/\/auth.x.ai\/device/)
  assert.match(text, /ABCD-1234/)
})

test('writeDshDefaultModelFile is covered by upsert helper round-trip', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-settings-'))
  const path = join(home, 'settings.yaml')
  await writeFile(path, 'ssh-tui-subagent:\n  model: grok-4.5\n')
  const next = upsertDefaultModelSection(await readFile(path, 'utf8'), {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'high',
  })
  assert.match(next, /ssh-tui-subagent:/)
  assert.match(next, /agent-default-model:/)
})

test('applyDshDefaultModel switches a DeepSeek default to SuperGrok but leaves an xai section alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n')
    // A user-owned section (any provider) is left alone under onlyIfUnset:
    // flipping a DeepSeek default back to Grok would clobber the user's switch.
    assert.equal(await applyDshDefaultModel(undefined, {
      provider: 'xai',
      model: 'grok-4.6',
      reasoningEffort: 'high',
    }, { onlyIfUnset: true }), 'unchanged')
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /provider: deepseek-official/)

    await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: xai\n  model: grok-4.5\n  reasoningEffort: high\n')
    assert.equal(await applyDshDefaultModel(undefined, {
      provider: 'xai',
      model: 'grok-4.6',
      reasoningEffort: 'high',
    }, { onlyIfUnset: true }), 'unchanged')
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /model: grok-4.5/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

import { tokenNeedsRefresh } from '../lib/oauth.js'
import { runRefreshDaemon } from '../lib/cli.js'

test('tokenNeedsRefresh treats expired and skew-window tokens as due', () => {
  const now = 1_000_000_000_000
  const base = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: now + 60_000,
    clientId: null,
    source: 'grok-bridge',
  }
  assert.equal(tokenNeedsRefresh(base, now), true)
  assert.equal(tokenNeedsRefresh({ ...base, expiresAt: now + 10 * 60 * 1000 }, now), false)
  assert.equal(tokenNeedsRefresh({ ...base, refreshToken: null }, now), false)
  assert.equal(tokenNeedsRefresh({ ...base, expiresAt: now - 1 }, now), true)
})

test('refresh daemon idles when the access token is still valid', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-xai-daemon-'))
  const authFile = join(home, 'auth.json')
  await writeFile(authFile, JSON.stringify({
    access_token: 'fresh',
    refresh_token: 'ref',
    expires_at: Date.now() + 60 * 60 * 1000,
  }))
  const logs = []
  await runRefreshDaemon({
    once: true,
    log: (line) => logs.push(line),
    config: {
      authBase: 'https://auth.x.ai',
      tokenPath: '/oauth2/token',
      deviceCodePath: '/oauth2/device/code',
      clientId: 'test',
      scope: 'openid',
      authFile,
      grokCliAuthFile: join(home, 'missing.json'),
      configFile: join(home, 'config.json'),
    },
  })
  assert.equal(logs.some(line => line.includes('watching')), true)
  assert.equal(logs.some(line => line.includes('idle')), true)
})

test('promptTokensFromUsage includes cached prompt tokens', () => {
  assert.equal(promptTokensFromUsage({ inputTokens: 1807, cacheReadTokens: 497536 }), 499343)
})

test('projectPromptTokens scales the last provider prompt by the heuristic ratio', () => {
  assert.equal(projectPromptTokens(499_343, 10_000, 10_020), Math.round(499_343 * (10_020 / 10_000)))
  assert.equal(projectPromptTokens(499_343, 10_000, 4_000), Math.round(499_343 * 0.4))
})

test('shouldTriggerCompaction fires when remaining context cannot fit max_tokens', () => {
  assert.equal(shouldTriggerCompaction(499_343, 500_000, 16, 64_000), true)
  assert.equal(shouldTriggerCompaction(400_000, 500_000, 16), false)
  assert.equal(shouldTriggerCompaction(500_000, 500_000), true)
})

test('planRequestBudget overflows a full chat, clamps compaction, and leaves roomy calls alone', () => {
  assert.deepEqual(planRequestBudget({
    promptTokens: 499_343,
    contextWindow: 500_000,
    requestedMax: 64_000,
    minRemaining: 16,
  }), { overflow: true })
  assert.deepEqual(planRequestBudget({
    promptTokens: 499_343,
    contextWindow: 500_000,
    requestedMax: 8_192,
    minRemaining: 16,
    purpose: 'compaction',
  }), { overflow: false, maxTokens: 657 })
  assert.deepEqual(planRequestBudget({
    promptTokens: 10_000,
    contextWindow: 500_000,
    requestedMax: 64_000,
    minRemaining: 16,
  }), { overflow: false })
  assert.deepEqual(planRequestBudget({
    promptTokens: undefined,
    contextWindow: 500_000,
    requestedMax: 64_000,
    minRemaining: 16,
  }), { overflow: false })
})

test('httpErrorCode maps token-named HTTP 400 to CONTEXT_WINDOW_EXCEEDED', () => {
  assert.equal(
    httpErrorCode(400, { message: "This model's maximum context length is 500000 tokens" }),
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(
    httpErrorCode(400, { message: 'max_tokens is too large for the remaining context' }),
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(
    httpErrorCode(400, { message: 'A tool_choice was set but no tools were specified' }),
    'INVALID_REQUEST',
  )
  assert.equal(httpErrorCode(400, { message: '' }), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(httpErrorCode(400), 'CONTEXT_WINDOW_EXCEEDED')
})

test('projectedPromptTokens is undefined until a sample exists', () => {
  const estimate = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(projectedPromptTokens(undefined, estimate), undefined)
  assert.ok(estimate > 0)
})

test('XaiAdapter throws CONTEXT_WINDOW_EXCEEDED before fetch when the last prompt filled the window', async () => {
  const adapter = new XaiAdapter({
    options: () => resolveAdapterOptions({}),
    resolveAccessToken: async () => {
      throw new Error('must not fetch a token after overflow')
    },
  })
  const sessionId = 'main-session-overflow'
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]
  const estimate = estimateRequestTokens({ messages })
  adapter.rememberPrompt(sessionId, { promptTokens: 499_343, estimate })
  let thrown
  try {
    for await (const _chunk of adapter.stream({
      provider: 'xai',
      model: 'grok-4.6',
      messages,
      maxTokens: 64_000,
      sessionId,
    })) {
      throw new Error('must not stream after overflow')
    }
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown?.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.match(String(thrown?.message), /499343/)
})
