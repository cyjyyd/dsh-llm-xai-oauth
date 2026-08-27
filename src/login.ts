#!/usr/bin/env node
import { applyDshDefaultModel, dshSettingsPath } from './dsh-defaults.js'
import { bootstrapXaiOAuth } from './bootstrap.js'
import { canPromptLogin, runDeviceLogin } from './login-flow.js'
import { defaultOAuthConfig } from './oauth.js'

const config = defaultOAuthConfig()
const force = process.argv.includes('--force')

if (force) {
  await runDeviceLogin(config)
  const written = await applyDshDefaultModel(undefined)
  process.stdout.write(`dsh default model: ${written} (${dshSettingsPath()})\n`)
} else {
  const result = await bootstrapXaiOAuth(config, undefined, {
    interactive: canPromptLogin(),
  })
  if (result.tokens === null) {
    process.stderr.write(`${result.reason ?? 'xAI OAuth is not configured'}\n`)
    process.stderr.write('Re-run with --force from a terminal that can open auth.x.ai.\n')
    process.exitCode = 1
  } else {
    if (!result.loggedIn) {
      process.stdout.write(`Reused SuperGrok token (${result.tokens.source}).\n`)
    }
    process.stdout.write(`dsh default model: ${result.dsh} (${dshSettingsPath()})\n`)
  }
}
