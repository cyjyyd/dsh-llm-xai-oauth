/**
 * Plugin-start bootstrap: search the machine for a reusable SuperGrok token,
 * fall back to the xAI device-code login on a TTY, then point dsh at Grok.
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyDshDefaultModel, defaultModelSelection } from './dsh-defaults.js'
import { searchLocalTokens } from './discover.js'
import { canPromptLogin, loginDisabledByEnv, runDeviceLogin } from './login-flow.js'
import { adoptTokens, loadCanonicalTokens } from './oauth.js'
import type { OAuthConfig, StoredTokens } from './oauth.js'

export interface BootstrapResult {
  tokens: StoredTokens | null
  searched: boolean
  loggedIn: boolean
  dsh: 'service' | 'file' | 'unchanged' | 'skipped'
  reason?: string
}

export interface BootstrapOptions {
  login?: (config: OAuthConfig) => Promise<StoredTokens>
  applyDefault?: (
    ctx: Context | undefined,
    force: boolean,
  ) => Promise<'service' | 'file' | 'unchanged'>
  interactive?: boolean
  /** Override the home directory used for the bounded local token search. */
  home?: string
}

function loggerOf(ctx: Context | undefined): { info: (message: string) => void; warn: (message: unknown) => void } {
  if (ctx !== undefined) return ctx.logger
  return {
    info(message: string): void {
      process.stderr.write(`${message}\n`)
    },
    warn(message: unknown): void {
      process.stderr.write(`${String(message)}\n`)
    },
  }
}

async function writeDshDefault(
  ctx: Context | undefined,
  force: boolean,
  applyDefault: BootstrapOptions['applyDefault'],
  log: { warn: (message: unknown) => void },
): Promise<'service' | 'file' | 'unchanged' | 'skipped'> {
  const writer = applyDefault ?? ((pluginCtx, shouldForce) => applyDshDefaultModel(
    pluginCtx,
    defaultModelSelection(),
    { onlyIfUnset: !shouldForce },
  ))
  try {
    return await writer(ctx, force)
  } catch (error: unknown) {
    log.warn('llm-xai-oauth: writing dsh agent-default-model failed')
    log.warn(error)
    return 'skipped'
  }
}

export async function bootstrapXaiOAuth(
  config: OAuthConfig,
  ctx?: Context,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const log = loggerOf(ctx)
  let tokens = await loadCanonicalTokens(config)
  if (tokens === null) {
    const discovered = await searchLocalTokens(config, options.home)
    if (discovered !== null) {
      try {
        tokens = await adoptTokens(config, discovered)
        log.info(`llm-xai-oauth: adopted SuperGrok token from ${discovered.path}`)
      } catch {
        tokens = discovered
        log.warn(`llm-xai-oauth: found a token at ${discovered.path} but could not copy it to ${config.authFile}`)
      }
    }
  }
  if (tokens !== null) {
    log.info(`llm-xai-oauth: reused SuperGrok token from ${tokens.source}`)
    const dsh = await writeDshDefault(ctx, false, options.applyDefault, log)
    return { tokens, searched: true, loggedIn: false, dsh }
  }

  const interactive = options.interactive ?? (canPromptLogin() && !loginDisabledByEnv())
  if (!interactive) {
    const reason = loginDisabledByEnv()
      ? 'DSH_XAI_OAUTH_NO_LOGIN is set; skipped the device-code login'
      : 'no reusable SuperGrok token on this machine and no TTY for device login'
    log.warn(`llm-xai-oauth: ${reason}`)
    return { tokens: null, searched: true, loggedIn: false, dsh: 'skipped', reason }
  }

  log.info('llm-xai-oauth: no reusable token found; starting xAI device login')
  const login = options.login ?? ((oauth: OAuthConfig) => runDeviceLogin(oauth))
  const logged = await login(config)
  const dsh = await writeDshDefault(ctx, true, options.applyDefault, log)
  log.info('llm-xai-oauth: SuperGrok login complete; dsh default model set to xai / grok-4.6')
  return { tokens: logged, searched: true, loggedIn: true, dsh }
}
