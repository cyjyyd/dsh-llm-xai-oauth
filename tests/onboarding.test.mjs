import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get } from 'node:http'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { openBrowser } from '../lib/browser.js'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { renderOnboardingPage, startOnboarding, runVisualDeviceLogin } from '../lib/onboarding.js'
import { loginPrefersVisual, canPromptLogin } from '../lib/login-flow.js'

// Real loopback requests exercise native sockets; all OAuth traffic is intercepted.
function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = get(url, { method, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
  })
}
async function waitForTerminalAndAck(url, timeoutMs = 1000) {
  const stateUrl = new URL('api/state', url)
  const ackUrl = new URL('api/terminal-ack', url)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await request(stateUrl).catch(() => undefined)
    if (response?.status === 200 && JSON.parse(response.body).status !== 'waiting') {
      return (await request(ackUrl, 'POST')).status
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('browser did not observe terminal onboarding status')
}
async function fixture(t, tokenReply) {
  const dir = await mkdtemp(join(tmpdir(), 'xai-onboarding-'))
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
  const env = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]))
  for (const key of proxyKeys) delete process.env[key]
  const previous = getGlobalDispatcher()
  const agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  t.after(async () => {
    setGlobalDispatcher(previous)
    await agent.close()
    for (const key of proxyKeys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    await rm(dir, { recursive: true, force: true })
  })
  const config = {
    authBase: 'https://oauth.invalid', deviceCodePath: '/device', tokenPath: '/token',
    clientId: 'test-client', scope: 'test', authFile: join(dir, 'auth.json'),
    grokCliAuthFile: join(dir, 'cli.json'), configFile: join(dir, 'config.json'),
  }
  const pool = agent.get(config.authBase)
  pool.intercept({ path: '/device', method: 'POST' }).reply(200, {
    device_code: 'fake-device', user_code: 'TEST-1234',
    verification_uri: 'https://oauth.invalid/verify', interval: 0.02, expires_in: 60,
  })
  pool.intercept({ path: '/token', method: 'POST', body: body => {
    const form = new URLSearchParams(body)
    assert.equal(form.get('device_code'), 'fake-device')
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
    return true
  } }).reply(tokenReply).persist()
  return { config, agent }
}
const success = { statusCode: 200, data: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 } }

test('onboarding page keeps the main and status titles in sync for terminal states', async () => {
  const waiting = {
    status: 'waiting', title: '正在等待浏览器授权…', body: 'Waiting for approval.',
    userCode: 'TEST-1234', verificationUri: 'https://oauth.invalid/verify',
    authFile: 'temporary-auth.json', detail: '', expiresAt: Date.now() + 60_000,
  }
  const terminalStates = [
    { status: 'authorized', title: '已连接，可以关闭此页面了', body: 'Authorized.' },
    { status: 'error', title: '授权未完成', body: 'Authorization denied.' },
    { status: 'expired', title: '设备码已过期', body: 'The device code expired.' },
  ]

  for (const terminal of terminalStates) {
    const html = renderOnboardingPage(waiting, '/test-token')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    const initialMainTitle = html.match(/<h1 id="page-title">([\s\S]*?)<\/h1>/)?.[1]
    const initialStatusTitle = html.match(/<strong id="status-title">([\s\S]*?)<\/strong>/)?.[1]
    assert.ok(script, 'generated page contains its executable script')
    assert.ok(initialMainTitle, 'generated page exposes the main title element')
    assert.ok(initialStatusTitle, 'generated page exposes the status title element')

    const element = (textContent = '') => ({
      textContent, className: '', hidden: false, disabled: false, addEventListener() {},
    })
    const elements = new Map([
      ['page-title', element(initialMainTitle)],
      ['status', element()],
      ['status-title', element(initialStatusTitle)],
      ['status-body', element()],
      ['copy', element()],
      ['open', element()],
      ['open-feedback', element()],
      ['code', element('TEST-1234')],
    ])
    const states = [
      { status: waiting.status, title: waiting.title, body: waiting.body },
      terminal,
    ]
    let stateCalls = 0
    let terminalAcks = 0
    let scheduledPoll
    const fetchMock = url => {
      if (url === '/test-token/api/state') {
        const state = states[Math.min(stateCalls++, states.length - 1)]
        return Promise.resolve({ ok: true, json: () => Promise.resolve(state) })
      }
      if (url === '/test-token/api/terminal-ack') {
        terminalAcks++
        return Promise.resolve({ ok: true })
      }
      assert.fail(`unexpected request: ${url}`)
    }
    const context = {
      document: { getElementById: id => elements.get(id) },
      fetch: fetchMock,
      setTimeout: callback => { scheduledPoll = callback; return 1 },
      requestAnimationFrame: callback => callback(),
    }

    runInNewContext(script, context)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(elements.get('page-title').textContent, waiting.title)
    assert.equal(elements.get('status-title').textContent, waiting.title)
    assert.equal(typeof scheduledPoll, 'function', 'waiting state schedules the next poll')

    const pollAgain = scheduledPoll
    scheduledPoll = undefined
    pollAgain()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(elements.get('page-title').textContent, terminal.title, `${terminal.status} updates the main title`)
    assert.equal(elements.get('status-title').textContent, terminal.title, `${terminal.status} updates the status title`)
    assert.equal(stateCalls, 2)
    assert.equal(terminalAcks, 1, `${terminal.status} retains the existing terminal ACK behavior`)
  }
})

test('native host with no TTY still chooses visual login on Windows', t => {
  const env = process.env.GROK_BRIDGE_NO_BROWSER
  delete process.env.GROK_BRIDGE_NO_BROWSER
  t.after(() => { if (env === undefined) delete process.env.GROK_BRIDGE_NO_BROWSER; else process.env.GROK_BRIDGE_NO_BROWSER = env })
  for (const stream of [process.stdout, process.stderr]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { value: undefined, configurable: true })
    t.after(() => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor)
      else delete stream.isTTY
    })
  }
  assert.equal(canPromptLogin(), false)
  assert.equal(loginPrefersVisual({ platform: 'win32' }), true)
  assert.equal(loginPrefersVisual(), process.platform === 'win32')
  process.env.GROK_BRIDGE_NO_BROWSER = '1'
  assert.equal(loginPrefersVisual({ platform: 'win32' }), false)
})

test('mock grant progresses waiting -> authorized, stores only temporary credentials', async t => {
  let authorized = false
  const { config } = await fixture(t, () => authorized ? success : { statusCode: 400, data: { error: 'authorization_pending' } })
  const opened = []
  const handle = await startOnboarding(config, { open: url => { opened.push(url); return true } })
  t.after(() => handle.close())
  assert.deepEqual(opened, [handle.url])
  const stateUrl = new URL('api/state', handle.url)
  const waiting = await request(stateUrl)
  assert.equal(JSON.parse(waiting.body).status, 'waiting')
  assert.match(waiting.headers['content-type'], /application\/json/)
  assert.equal(waiting.headers['cache-control'], 'no-store')
  const page = await request(handle.url)
  assert.match(page.body, /TEST-1234/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal((await request(new URL('api/open', handle.url), 'POST')).status, 204)
  assert.equal(opened.at(-1), 'https://oauth.invalid/verify')
  assert.equal((await request(new URL('api/open', handle.url))).status, 404)
  authorized = true
  const tokens = await handle.tokens
  assert.equal(tokens.accessToken, 'fake-access')
  const state = JSON.parse((await request(stateUrl)).body)
  assert.equal(state.status, 'authorized')
  assert.equal(state.authFile, config.authFile)
  assert.equal(typeof state.title, 'string')
  assert.match(state.body, /auth.json/)
  assert.doesNotMatch(JSON.stringify(state), /fake-access|fake-refresh|fake-device/)
  assert.equal((await request(new URL('api/terminal-ack', handle.url), 'POST')).status, 204)
  assert.equal(JSON.parse(await readFile(config.authFile, 'utf8')).access_token, 'fake-access')
  await assert.rejects(access(config.grokCliAuthFile))
  await assert.rejects(access(config.configFile))
  await handle.close()
  await assert.rejects(request(handle.url), { code: 'ECONNREFUSED' })
})

test('visual login keeps terminal status until the browser polls and acknowledges after two seconds', async t => {
  let authorized = false
  const { config } = await fixture(t, () => authorized
    ? success
    : { statusCode: 400, data: { error: 'authorization_pending' } })
  let guideUrl
  let initialStatus
  let finishBrowserPoll
  const browserPoll = new Promise(resolve => { finishBrowserPoll = resolve })
  const login = runVisualDeviceLogin(config, {
    open: async url => {
      guideUrl = url
      const initial = await request(new URL('api/state', url))
      initialStatus = JSON.parse(initial.body).status
      authorized = true
      setTimeout(async () => {
        try {
          const terminal = await request(new URL('api/state', url))
          const status = JSON.parse(terminal.body).status
          const ack = await request(new URL('api/terminal-ack', url), 'POST')
          finishBrowserPoll({ status, ack: ack.status })
        } catch (error) {
          finishBrowserPoll({ error: error?.code ?? 'request-failed' })
        }
      }, 2000)
      return true
    },
    sink: { write: () => {} },
  })
  await login
  const observed = await browserPoll
  assert.equal(initialStatus, 'waiting')
  assert.deepEqual(observed, { status: 'authorized', ack: 204 })
  await assert.rejects(request(guideUrl), { code: 'ECONNREFUSED' })
})

test('terminal server closes within its five-second bound when no page polls or acknowledges', async t => {
  const { config } = await fixture(t, () => success)
  const handle = await startOnboarding(config, { open: () => true })
  t.after(() => handle.close())
  await handle.tokens
  const terminalAt = Date.now()
  await new Promise(resolve => setTimeout(resolve, 5250))
  const elapsed = Date.now() - terminalAt
  await assert.rejects(request(handle.url), { code: 'ECONNREFUSED' })
  assert.ok(elapsed <= 6000, `cleanup took ${elapsed}ms`)
})

for (const outcome of ['authorized', 'denied']) {
  test(`visual wrapper closes HTTP server after ${outcome}, with browser failure fallback`, async t => {
    const { config } = await fixture(t, () => outcome === 'authorized' ? success : { statusCode: 400, data: { error: 'access_denied' } })
    let url
    let browserAck
    const writes = []
    const login = runVisualDeviceLogin(config, {
      open: async value => { url = value; browserAck = waitForTerminalAndAck(value); return false },
      sink: { write: value => writes.push(value) },
    })
    if (outcome === 'authorized') assert.equal((await login).accessToken, 'fake-access')
    else {
      await assert.rejects(login, /access_denied/)
      await assert.rejects(access(config.authFile))
    }
    assert.ok(writes.some(value => value.includes(`open ${url}`)))
    assert.equal(await browserAck, 204)
    await assert.rejects(request(url), { code: 'ECONNREFUSED' })
  })
}

test('authorization button reports failed browser launch and announces manual URL', async t => {
  const { config } = await fixture(t, () => success)
  const announced = []
  const handle = await startOnboarding(config, {
    open: async () => false, announce: url => announced.push(url),
  })
  t.after(() => handle.close())
  assert.deepEqual(announced, [handle.url])
  assert.match((await request(handle.url)).body, /无法自动打开授权页面/)
  assert.equal((await request(new URL('api/open', handle.url), 'POST')).status, 503)
  assert.equal(announced.at(-1), 'https://oauth.invalid/verify')
  await handle.tokens
  assert.equal(await waitForTerminalAndAck(handle.url), 204)
})

for (const event of ['spawn', 'error']) {
  test(`browser opener handles asynchronous ${event} without launching a browser`, async t => {
    const env = process.env.GROK_BRIDGE_NO_BROWSER
    delete process.env.GROK_BRIDGE_NO_BROWSER
    const original = childProcess.spawn
    let unreferenced = false
    childProcess.spawn = (command, args, options) => {
      assert.equal(options.stdio, 'ignore')
      assert.equal(options.detached, true)
      const child = new EventEmitter()
      child.unref = () => { unreferenced = true }
      queueMicrotask(() => child.emit(event, event === 'error' ? new Error('ENOENT') : undefined))
      return child
    }
    syncBuiltinESMExports()
    t.after(() => {
      childProcess.spawn = original
      syncBuiltinESMExports()
      if (env === undefined) delete process.env.GROK_BRIDGE_NO_BROWSER
      else process.env.GROK_BRIDGE_NO_BROWSER = env
    })
    assert.equal(await openBrowser('https://oauth.invalid/verify'), event === 'spawn')
    assert.equal(unreferenced, event === 'spawn')
  })
}

test('first-run bootstrap without a console reaches the visual flow and releases its server', async t => {
  const { bootstrapXaiOAuth } = await import('../lib/bootstrap.js')
  const { dirname } = await import('node:path')
  const { config } = await fixture(t, () => success)
  const keys = ['GROK_BRIDGE_NO_BROWSER', 'DSH_XAI_OAUTH_NO_LOGIN']
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  for (const stream of [process.stdout, process.stderr]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { value: undefined, configurable: true })
    t.after(() => { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete stream.isTTY })
  }
  const original = childProcess.spawn
  let guideUrl
  let browserAck
  childProcess.spawn = (_command, args) => {
    guideUrl = args.at(-1)
    browserAck = waitForTerminalAndAck(guideUrl)
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  syncBuiltinESMExports()
  t.after(() => {
    childProcess.spawn = original
    syncBuiltinESMExports()
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key] }
  })
  let force
  const result = await bootstrapXaiOAuth(config, undefined, {
    home: dirname(config.authFile),
    // Windows exercises automatic native selection; Linux exercises the same branch explicitly.
    ...(process.platform === 'win32' ? {} : { visual: true }),
    applyDefault: async (_ctx, value) => { force = value; return 'file' },
  })
  assert.equal(result.loggedIn, true)
  assert.equal(force, true)
  assert.equal(await browserAck, 204)
  assert.match(guideUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
  await assert.rejects(request(guideUrl), { code: 'ECONNREFUSED' })
})
