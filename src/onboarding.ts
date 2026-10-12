/**
 * Visual first-run OAuth onboarding.
 *
 * The plugin normally prints the device code to a terminal. Windows users who
 * launch the dsh desktop app never see that stream, so this module serves a
 * one-page guide from a loopback HTTP server and opens it in the default
 * browser instead: the device code, the authorization button, and live status
 * of the pending grant.
 *
 * The page is styled after the official DeepSeek Harness desktop client — the
 * same `#f9fafb` canvas, `#353638` type, white rounded cards and blue accent —
 * and is fully self-contained: no external fonts, images, or scripts, so it
 * renders offline and behind a proxy. The server binds 127.0.0.1 on an
 * ephemeral port and only answers under an unguessable path prefix, so no other
 * local process can read the pending device code.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { openBrowser } from './browser.js'
import { pollDeviceAuth, startDeviceAuth } from './oauth.js'
import type { DeviceCode, OAuthConfig, StoredTokens } from './oauth.js'

export interface OnboardingOptions {
  /** Reuse an existing device grant instead of requesting a new one. */
  device?: DeviceCode
  /** Open the guide in the default browser as soon as it is listening. */
  open?: (url: string) => boolean | Promise<boolean>
  /** Report the guide URL on hosts that cannot open a browser. */
  announce?: (url: string) => void
  signal?: AbortSignal
}

export interface OnboardingHandle {
  url: string
  /** Resolves once the browser-side grant completes and tokens are stored. */
  tokens: Promise<StoredTokens>
  close(): Promise<void>
}

type Status = 'waiting' | 'authorized' | 'error' | 'expired'

interface ViewState {
  status: Status
  userCode: string
  verificationUri: string
  authFile: string
  detail: string
  expiresAt: number
  source?: string
}

const GRANT_ERROR = 'The authorization request failed. Start the login again.'
const TERMINAL_ACK_TIMEOUT_MS = 5_000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * The status line the page polls. Kept out of the HTML so a refresh never
 * re-renders the page and never loses the copy button's state.
 */
function statePayload(state: ViewState): string {
  return jsonForScript({
    status: state.status,
    ...statusCopy(state),
    detail: state.detail,
    source: state.source ?? null,
    authFile: state.authFile,
    expiresAt: state.expiresAt,
  })
}

function statusCopy(state: ViewState): { title: string; body: string } {
  switch (state.status) {
    case 'authorized':
      return {
        title: '已连接，可以关闭此页面了',
        body: `登录凭据已写入 ${state.authFile}。回到 DeepSeek Harness 即可开始使用 Grok。`,
      }
    case 'expired':
      return { title: '设备码已过期', body: '请重新运行登录命令以获取新的设备码。' }
    case 'error':
      return { title: '授权未完成', body: state.detail }
    default:
      return {
        title: '正在等待浏览器授权…',
        body: '在打开的页面中确认授权。这个页面会自动更新，无需手动刷新。',
      }
  }
}

export function renderOnboardingPage(state: ViewState, pathToken: string): string {
  const copy = statusCopy(state)
  const done = state.status === 'authorized'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'">
<title>连接 Grok 订阅 · DeepSeek Harness</title>
<style>
:root{
  --canvas:#f9fafb; --ink:#353638; --muted:#6b7280; --card:#ffffff; --line:#e8eaed;
  --accent:#4a65e8; --accent-strong:#145af3; --accent-soft:#eef2ff;
  --ok:#2f9e63; --ok-soft:#eaf7f0; --danger:#c0392b; --danger-soft:#fdecea;
  --radius:16px; --radius-sm:10px;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --canvas:#1b1c1e; --ink:#ececee; --muted:#9aa0a6; --card:#242628; --line:#33363a;
    --accent:#7c92f5; --accent-strong:#9db0ff; --accent-soft:#2a2f4a;
    --ok:#5cc48c; --ok-soft:#1f2f27; --danger:#f08a80; --danger-soft:#3a2422;
  }
}
*{box-sizing:border-box}
body{
  margin:0; min-height:100vh; background:var(--canvas); color:var(--ink);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,"Helvetica Neue",Arial,sans-serif;
  display:flex; align-items:center; justify-content:center; padding:32px 20px;
  -webkit-font-smoothing:antialiased;
}
main{width:100%; max-width:560px}
.brand{display:flex; align-items:center; gap:10px; margin:0 0 18px 2px}
.brand svg{display:block}
.brand b{font-size:15px; font-weight:600; letter-spacing:.2px}
.badge{
  font-size:11px; line-height:1; padding:5px 9px; border-radius:999px;
  background:var(--accent-soft); color:var(--accent-strong); font-weight:600;
}
.card{
  background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  padding:30px 30px 26px; box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px -12px rgba(16,24,40,.10);
}
h1{margin:0 0 6px; font-size:21px; line-height:1.35; font-weight:600; letter-spacing:.2px}
.sub{margin:0 0 22px; color:var(--muted); font-size:13.5px}
ol{margin:0 0 22px; padding:0; list-style:none; counter-reset:step}
li{counter-increment:step; position:relative; padding:0 0 0 34px; margin:0 0 14px; font-size:14px; color:var(--ink)}
li:last-child{margin-bottom:0}
li::before{
  content:counter(step); position:absolute; left:0; top:1px; width:22px; height:22px;
  border-radius:999px; background:var(--accent-soft); color:var(--accent-strong);
  font-size:11.5px; font-weight:700; display:flex; align-items:center; justify-content:center;
}
li span{display:block; color:var(--muted); font-size:12.5px; margin-top:2px}
.code{
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  border:1px solid var(--line); background:var(--canvas); border-radius:var(--radius-sm);
  padding:14px 14px 14px 18px; margin:0 0 18px;
}
.code small{display:block; color:var(--muted); font-size:11.5px; letter-spacing:.6px; text-transform:uppercase; font-weight:600}
.code b{
  display:block; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:24px; letter-spacing:3px; font-weight:600; margin-top:3px; user-select:all;
}
button{
  font:inherit; cursor:pointer; border-radius:999px; border:1px solid transparent;
  transition:background .15s ease,border-color .15s ease,opacity .15s ease;
}
button:focus-visible{outline:2px solid var(--accent-strong); outline-offset:2px}
.primary{background:var(--accent); color:#fff; padding:11px 20px; font-weight:600; font-size:14px; width:100%}
.primary:hover{background:var(--accent-strong)}
.ghost{background:transparent; color:var(--muted); border-color:var(--line); padding:6px 12px; font-size:12.5px}
.ghost:hover{color:var(--ink); border-color:var(--muted)}
.actions{display:flex; gap:10px; align-items:center}
.actions .primary{flex:1}
.open-feedback{margin:10px 0 0;color:var(--danger);font-size:12.5px}
.open-feedback.ok{color:var(--muted)}
.status{
  display:flex; gap:11px; align-items:flex-start; margin:20px 0 0; padding:14px 16px;
  border-radius:var(--radius-sm); background:var(--canvas); border:1px solid var(--line);
}
.status.ok{background:var(--ok-soft); border-color:transparent}
.status.bad{background:var(--danger-soft); border-color:transparent}
.status strong{display:block; font-size:13.5px; font-weight:600}
.status p{margin:2px 0 0; font-size:12.5px; color:var(--muted); word-break:break-all}
.dot{width:8px; height:8px; border-radius:999px; background:var(--accent); margin-top:7px; flex:none}
.status.ok .dot{background:var(--ok)}
.status.bad .dot{background:var(--danger)}
.status:not(.ok):not(.bad) .dot{animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.status .dot{animation:none}}
footer{margin:16px 2px 0; color:var(--muted); font-size:12px}
footer code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="#4a65e8" d="M10 1.6c1.5 3 3 4.5 6.4 5.4-3.4.9-4.9 2.4-6.4 5.4-1.5-3-3-4.5-6.4-5.4C7 6.1 8.5 4.6 10 1.6Zm0 9.4c1 2 2 3 4.3 3.6-2.3.6-3.3 1.6-4.3 3.6-1-2-2-3-4.3-3.6C8 14 9 13 10 11Z"/></svg>
    <b>DeepSeek Harness</b>
    <span class="badge">Grok 订阅登录</span>
  </div>
  <div class="card">
    <h1 id="page-title">${escapeHtml(copy.title)}</h1>
    <p class="sub">使用 SuperGrok / X Premium 订阅登录 xAI，无需 API Key。</p>
    <ol>
      <li>在浏览器中打开授权页面<span>如果浏览器没有自动打开，点下面的按钮。</span></li>
      <li>确认页面显示的设备码与下方一致<span>设备码：${escapeHtml(state.userCode)}</span></li>
      <li>授权完成后返回这里<span>凭据会自动保存，Harness 下次请求即可生效。</span></li>
    </ol>
    <div class="code">
      <div>
        <small>设备码 / Device code</small>
        <b id="code">${escapeHtml(state.userCode)}</b>
      </div>
      <button class="ghost" id="copy" type="button">复制</button>
    </div>
    <div class="actions">
      <button class="primary" id="open" type="button">${done ? '已授权，重新打开授权页面' : '打开授权页面'}</button>
    </div>
    <p class="open-feedback" id="open-feedback" role="status" aria-live="polite" hidden></p>
    <div class="status${done ? ' ok' : state.status === 'waiting' ? '' : ' bad'}" id="status" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <div>
        <strong id="status-title">${escapeHtml(copy.title)}</strong>
        <p id="status-body">${escapeHtml(copy.body)}</p>
      </div>
    </div>
    <footer>授权页面：<code>${escapeHtml(state.verificationUri)}</code></footer>
  </div>
</main>
<script>
(function(){
  var base=${jsonForScript(pathToken)};
  var last=null;
  function paint(s){
    var box=document.getElementById('status');
    box.className='status'+(s.status==='authorized'?' ok':s.status==='waiting'?'':' bad');
    document.getElementById('page-title').textContent=s.title;
    document.getElementById('status-title').textContent=s.title;
    document.getElementById('status-body').textContent=s.body;
  }
  function poll(){
    fetch(base+'/api/state',{cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('status-unavailable');
      return r.json();
    }).then(function(s){
      if(s.status!==last){last=s.status; paint(s)}
      if(s.status==='waiting'){
        setTimeout(poll,2000);
        return;
      }
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          fetch(base+'/api/terminal-ack',{method:'POST'}).catch(function(){});
        });
      });
    }).catch(function(){setTimeout(poll,4000)});
  }
  document.getElementById('copy').addEventListener('click',function(){
    var text=document.getElementById('code').textContent.trim();
    var button=this;
    function done(){button.textContent='已复制';setTimeout(function(){button.textContent='复制'},1600)}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fallback)}else{fallback()}
    function fallback(){
      var range=document.createRange();range.selectNodeContents(document.getElementById('code'));
      var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      try{document.execCommand('copy');done()}catch(e){button.textContent='请手动复制'}
    }
  });
  var openButton=document.getElementById('open');
  var openFeedback=document.getElementById('open-feedback');
  openButton.addEventListener('click',function(){
    if(openButton.disabled)return;
    openButton.disabled=true;
    openFeedback.hidden=true;
    fetch(base+'/api/open',{method:'POST'}).then(function(response){
      if(!response.ok)throw new Error('browser-open-failed');
      openFeedback.className='open-feedback ok';
      openFeedback.textContent='授权页面已在浏览器中打开。';
      openFeedback.hidden=false;
    }).catch(function(){
      openFeedback.className='open-feedback';
      openFeedback.textContent='无法自动打开授权页面，请手动使用页面下方显示的授权地址。';
      openFeedback.hidden=false;
    }).finally(function(){openButton.disabled=false;});
  });
  poll();
})();
</script>
</body>
</html>
`
}

/**
 * Serve the guide, open it, and resolve once xAI hands back tokens.
 *
 * The device grant is requested before the server starts so the page always
 * renders a valid code, and a failed grant closes the server again instead of
 * leaving a dead page open.
 */
export async function startOnboarding(
  config: OAuthConfig,
  options: OnboardingOptions = {},
): Promise<OnboardingHandle> {
  const device = options.device ?? await startDeviceAuth(config, options.signal)
  const pathToken = randomBytes(16).toString('hex')
  const base = `/${pathToken}`

  let view: ViewState = {
    status: 'waiting',
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    authFile: config.authFile,
    detail: '',
    expiresAt: Date.now() + device.expiresInSeconds * 1000,
  }
  let settleTokens: (tokens: StoredTokens) => void
  let failTokens: (error: unknown) => void
  const tokens = new Promise<StoredTokens>((resolve, reject) => {
    settleTokens = resolve
    failTokens = reject
  })
  // The page may be closed before the grant settles; keep the rejection observed.
  tokens.catch(() => {})

  let resolveTerminalDelivery: () => void = () => {}
  const terminalDelivery = new Promise<void>(resolve => { resolveTerminalDelivery = resolve })
  let terminalAckTimer: ReturnType<typeof setTimeout> | undefined
  let serverClosePromise: Promise<void> | undefined
  let terminalDeliveryFinished = false

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })

  const closeServer = (): Promise<void> => {
    if (serverClosePromise !== undefined) return serverClosePromise
    serverClosePromise = new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return serverClosePromise
  }

  const finishTerminalDelivery = (): void => {
    if (terminalDeliveryFinished) return
    terminalDeliveryFinished = true
    if (terminalAckTimer !== undefined) {
      clearTimeout(terminalAckTimer)
      terminalAckTimer = undefined
    }
    resolveTerminalDelivery()
    void closeServer()
  }

  const scheduleTerminalCleanup = (): void => {
    if (terminalAckTimer !== undefined) return
    terminalAckTimer = setTimeout(finishTerminalDelivery, TERMINAL_ACK_TIMEOUT_MS)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(base)) {
      response.statusCode = 404
      response.end('not found')
      return
    }
    const route = url.pathname.slice(base.length)
    if (route === '' || route === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(renderOnboardingPage(view, base))
      return
    }
    if (route === '/api/state' && request.method === 'GET') {
      const copy = statusCopy(view)
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(statePayload({ ...view, detail: copy.body }))
      return
    }
    if (route === '/api/open' && request.method === 'POST') {
      const opened = await (options.open ?? openBrowser)(device.verificationUri)
      if (!opened) options.announce?.(device.verificationUri)
      response.statusCode = opened ? 204 : 503
      response.end()
      return
    }
    if (route === '/api/terminal-ack' && request.method === 'POST') {
      if (view.status === 'waiting') {
        response.statusCode = 409
        response.end()
        return
      }
      response.statusCode = 204
      response.end(() => finishTerminalDelivery())
      return
    }
    response.statusCode = 404
    response.end('not found')
  }

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('onboarding server did not bind a TCP port'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}${base}/`)
    })
  })

  const close = async (): Promise<void> => {
    if (view.status !== 'waiting') await terminalDelivery
    await closeServer()
  }

  void pollDeviceAuth(config, device, options.signal).then(
    (stored) => {
      view = { ...view, status: 'authorized', source: stored.source }
      scheduleTerminalCleanup()
      settleTokens(stored)
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const expired = /expired/i.test(message)
      view = { ...view, status: expired ? 'expired' : 'error', detail: expired ? '' : message || GRANT_ERROR }
      scheduleTerminalCleanup()
      failTokens(error)
    },
  )

  const opener = options.open ?? openBrowser
  if (!await opener(url)) options.announce?.(url)

  return {
    url,
    tokens,
    close,
  }
}

/**
 * Guide-driven login: equivalent to `runDeviceLogin` but with the browser page
 * carrying the device code, for windows that have no visible terminal.
 */
export async function runVisualDeviceLogin(
  config: OAuthConfig,
  options: OnboardingOptions & { sink?: { write(text: string): void } } = {},
): Promise<StoredTokens> {
  const sink = options.sink ?? {
    write(text: string): void {
      process.stderr.write(text)
    },
  }
  const handle = await startOnboarding(config, {
    ...options,
    announce: options.announce ?? (url => {
      sink.write(`xAI device login: open ${url} to finish signing in.\n`)
    }),
  })
  try {
    const tokens = await handle.tokens
    sink.write(`Logged in. Access token saved to ${config.authFile} (${tokens.source}).\n`)
    return tokens
  } finally {
    await handle.close()
  }
}

/** Windows users launch dsh from the desktop app, which may have no console. */
export function prefersVisualOnboarding(platform = process.platform): boolean {
  return platform === 'win32'
}
