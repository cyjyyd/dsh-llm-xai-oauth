import { spawn } from 'node:child_process'

/**
 * Whether this host may launch a browser at all. Set GROK_BRIDGE_NO_BROWSER=1
 * on SSH / CI / headless hosts so the login prints its URL instead.
 */
export function browserAllowed(): boolean {
  return process.env.GROK_BRIDGE_NO_BROWSER !== '1' && process.env.GROK_BRIDGE_NO_BROWSER !== 'true'
}

/**
 * Best-effort open of the device-login page. Disabled with
 * GROK_BRIDGE_NO_BROWSER=1 so SSH / CI / headless hosts print the URL instead.
 */
export function openBrowser(url: string): boolean {
  if (!browserAllowed()) {
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
