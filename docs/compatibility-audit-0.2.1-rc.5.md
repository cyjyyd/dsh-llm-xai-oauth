# Compatibility audit — dsh 0.2.1-rc.5

Target: `@deepseek-ai/dsh@0.2.1-rc.5` (npm `latest` at the time of audit).
Base: `0.2.1-rc.2`, the release this plugin last verified (`dsh-llm-xai-oauth@0.1.9`).
Plugin version under audit: `0.2.0`.

## Method

1. Enumerated every `@deepseek-ai/dsh-*` package this plugin declares as a peer
   (`dsh-llm`, `dsh-settings`, `dsh-attachment`, `dsh-launch-environment`,
   `dsh-timeout`, `dsh-invariants`) plus the packages that carry the contracts it
   depends on (`dsh-app-boot`, `dsh-base`, `dsh-config-editor`, `dsh-web-app`,
   `dsh-agent-default-model`, the `dsh` CLI itself).
2. Downloaded the `0.2.1-rc.2` and `0.2.1-rc.5` tarballs and compared them file
   by file with SHA-256, excluding `package.json` (whose `version` always
   differs).
3. Diffed each `package.json` with `version` removed, to isolate real dependency
   and peer-range moves from the release bump.
4. Re-ran typecheck and the full suite against an installed `0.2.1-rc.5` tree.

Artifact hashes were deliberately not used as a change signal: every package is
republished per rc with a new `version`, so every tarball hash differs even when
the code is byte-identical.

## Findings

### Code: no changes in any plugin-facing package

| Package | Files changed rc.2 → rc.5 | `package.json` (version removed) |
| --- | --- | --- |
| `dsh-llm` | 0 | dependency versions only |
| `dsh-settings` | 0 | dependency + peer versions only |
| `dsh-attachment` | 0 | peer versions only |
| `dsh-launch-environment` | 0 | identical |
| `dsh-timeout` | 0 | identical |
| `dsh-app-boot` | 0 | dependency + peer versions only |
| `dsh-base` | 0 | — |
| `dsh-config-editor` | 0 | — |
| `dsh-web-app` | 0 | — |
| `dsh-agent-default-model` | 0 | — |
| `dsh` (CLI) | 0 | 78 dependency versions bumped |

Every peer move is the same mechanical bump, e.g. `dsh-brand` and `dsh-session`
from `0.2.1-rc.2` to `0.2.1-rc.5`. No adapter signature, no schema, no settings
surface and no compatibility-gate logic changed across this span.

Consequence: the contracts verified for `0.2.1-rc.2` still hold, and the existing
`>=0.2.1-rc.2 <0.2.2-0` comparator already admits `rc.3`, `rc.4` and `rc.5`. The
manifest therefore needs no new comparator; only the verified-release list grows.

### `dsh-invariants` still has no 0.2.1 line

The package is frozen at `0.2.0-rc.2` while every sibling publishes `0.2.1-rc.5`.
This plugin imports exactly one type from it (`InvariantInstaller`), so:

- the devDependency stays at `0.2.0-rc.2`, the only version that exists;
- the peer range keeps both the `0.2.0-rc.2` a host actually installs and the
  `0.2.1-rc.5` runtime the gate checks. The OR-list satisfies both readers at
  once, because npm validates the range against the installed package version
  while `evaluatePluginCompatibility` validates it against the runtime version.

### Contracts re-checked explicitly

- **Adapter**: `imageRequestTarget` (added in `0.2.1-rc.2`) still has its base
  implementation that preserves the normalized image; this route sends the
  stored bytes unchanged, so the default remains correct and is not overridden.
  `resolveModel` still reports `context.contextWindow`, so grok-4.7 keeps its
  500K window instead of a generic default.
- **Compatibility gate**: `unmetRequirements` is unchanged from `rc.2`, including
  `engines.dsh`-first precedence. This package still deliberately declares no
  `engines.dsh`, so the single peer declaration covers every host back to
  `0.1.5-rc.1`. A test runs the shipped gate rather than a re-implementation.
- **Settings**: `dsh-settings` is file-identical, so the `0.1.5` section path, the
  `0.1.7`/`0.2.x` volatile-Config path and the `configure({ auto: false })`
  opt-out are unchanged.
- **Timeout**: `idleWatchdog` is file-identical; the sequential `next()` usage and
  the stalled-SSE regression test still pass.
- **Engines**: the `dsh` packages declare no Node engine, so the plugin's
  `>=22.19` is unaffected. `cordis ~4.0.5` is inside the declared `^4.0.1`;
  `schemastery ~3.18.5` is inside `^3.18.2` and resolves to a single hoisted copy.

## Verification

Same sources, typecheck plus suite:

| dsh host | typecheck | tests |
| --- | --- | --- |
| `0.2.1-rc.5` | pass | 56/56 |
| `0.2.0-rc.2` | pass | 55 pass, 1 skipped |
| `0.1.7-rc.2` | pass | 55 pass, 1 skipped |
| `0.1.5-rc.3` | pass | 55 pass, 1 skipped |

The skipped case is the real-gate test, skipped with a printed reason on hosts
whose tree does not contain `dsh-app-boot` (it arrives there only transitively).

## Residual risk

- The audit covers the plugin's contract surface, not the desktop client's
  rendering of model pickers or settings pages; those live in packages that did
  not change in this span but were not exercised end to end.
- `rc.3` and `rc.4` are inferred compatible from the file-identical comparison
  rather than run individually; `rc.5` was run.
- No real xAI authorization is performed by the suite.
