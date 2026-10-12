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
export async function openBrowser(url: string): Promise<boolean> {
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
    return await new Promise<boolean>(resolve => {
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    })
  } catch {
    return false
  }
}
