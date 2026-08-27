import { spawn } from 'node:child_process'

/**
 * Best-effort open of the device-login page. Disabled with
 * GROK_BRIDGE_NO_BROWSER=1 so SSH / CI / headless hosts print the URL instead.
 */
export function openBrowser(url: string): boolean {
  if (process.env.GROK_BRIDGE_NO_BROWSER === '1' || process.env.GROK_BRIDGE_NO_BROWSER === 'true') {
    return false
  }
  try {
    const [cmd, args] = process.platform === 'darwin'
      ? ['open', [url]] as const
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]] as const
        : ['xdg-open', [url]] as const
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
