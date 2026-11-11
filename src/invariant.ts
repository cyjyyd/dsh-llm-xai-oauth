import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-llm-xai-oauth'

export const name = 'llm-xai-oauth-invariant'
export const inject = ['invariants']

/**
 * Structural view of the invariants service.
 *
 * dsh 0.2.2-rc.1 moved the ecosystem to cordis 4.1, while the last published
 * `@deepseek-ai/dsh-invariants` (0.2.0-rc.2) still peers on cordis 4.0.4. A
 * declared dependency on that package therefore makes the tree unresolvable,
 * so this entry depends on the shape it uses instead of the package. The
 * service itself is declared by whichever host mounts `invariants`.
 */
interface InvariantService {
  /** Register one package's install callback and return its disposer. */
  register(name: string, install: () => void): () => void
}

const install = (): void => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(
    (ctx as Context & { invariants: InvariantService }).invariants.register(PACKAGE_NAME, install),
  )
