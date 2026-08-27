import { defaultOAuthConfig, pollDeviceAuth, startDeviceAuth } from './oauth.js'

const config = defaultOAuthConfig()
const device = await startDeviceAuth(config)
process.stdout.write(`xAI device login\n`)
process.stdout.write(`Open: ${device.verificationUri}\n`)
process.stdout.write(`Code: ${device.userCode}\n`)
const tokens = await pollDeviceAuth(config, device)
process.stdout.write(`Logged in. Access token saved to ${config.authFile} (${tokens.source}).\n`)
