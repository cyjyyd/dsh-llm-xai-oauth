# Compatibility audit — dsh 0.2.2-rc.1

Target: `@deepseek-ai/dsh@0.2.2-rc.1` (npm `latest` at the time of audit).
Base: `0.2.1-rc.5`, the release this plugin last verified (`dsh-llm-xai-oauth@0.2.0`).
Plugin version under audit: `0.3.0`.

This span contains real upstream changes, unlike `0.2.1-rc.2` → `0.2.1-rc.5`,
which only moved version strings. Support below `0.2.1-rc` is dropped in this
release.

## Method

1. Downloaded the `0.2.1-rc.5` and `0.2.2-rc.1` tarballs for every package this
   plugin depends on, plus the packages that carry the contracts it uses.
2. Compared `lib/` trees file by file, then read the type and runtime diffs that
   mattered rather than diffing version strings.
3. Installed `0.2.2-rc.1` and ran typecheck plus the full suite.
4. Re-verified the still-supported `0.2.1-rc.5` after the source changes.

## Findings

### This span has real changes

| Package | What changed |
| --- | --- |
| `dsh-llm` | `cordis` peer `~4.1.0`; `schemastery` `~3.19.0`; `GenerateOptions` is generic over a declared `LlmRequestPurpose`; `LlmModelInfo.badge`; new `llm/models-updated(provider)` event |
| `dsh-settings` | `configure(presentation, owner)` now resolves `owner.ctx.fiber`; forms project `entry.fiber.effectiveConfig` |
| `dsh-attachment` | `AttachmentAdmissionPart` also accepts an already-stored image with `encodedBytes`; `readImage` verification wording |
| `dsh-app-boot` | bundle/platform manifests added; gate logic unchanged (`unmetRequirements` still `engines.dsh`-first, else peers) |
| `dsh-launch-environment`, `dsh-timeout` | no code change |

### `cordis` 4.1 breaks the `dsh-invariants` dependency

`dsh-attachment`, `dsh-llm`, `dsh-settings`, `dsh-launch-environment` and
`dsh-timeout` at `0.2.2-rc.1` all peer on `cordis ~4.1.0`, while the last
published `@deepseek-ai/dsh-invariants` (`0.2.0-rc.2`, the only 0.2.x release)
peers on `~4.0.4`. The two ranges are disjoint, so keeping that package as a
dependency makes the tree unresolvable — `npm install` fails with `ERESOLVE`.

This plugin used it for exactly one type (`InvariantInstaller`) in its optional
`./invariant` entry. That entry now declares the structural service shape it
calls (`register(name, install)`) and the dependency is removed from both
`peerDependencies` and `devDependencies`. Behavior is unchanged; the entry still
registers a no-op installer when a host mounts `invariants`.

### `dsh-settings.configure` moved to `owner.ctx.fiber`

The signature is still `configure(presentation, owner?: Fiber)`, and cordis 4.1
defines `Context.fiber` and `Fiber.ctx` as inverses, so passing the plugin's
`ctx.fiber` resolves to the same fiber under the new implementation. No change
was needed, and the isolated boot below exercises this path.

### `GenerateOptions` became generic

`purpose` is now typed by `LlmRequestPurpose` rather than a literal union. The
serializer's `purpose === 'session-title'` comparison still compiles against the
installed types, so no change was needed.

### New `llm/models-updated` event

`0.2.2-rc.1` declares an event telling consumers to reload `listModels()` after a
provider's catalog changes. This adapter refreshes its live catalog from the
subscription `/models` endpoint at startup, so it now emits
`llm/models-updated` after that assignment. Older supported hosts do not declare
the event; emitting an unknown event is a no-op there.

## Support narrowed

`dsh.compatibility.dsh`, every remaining dsh peer range and `dshReleases` now
describe only:

- `0.2.1-rc.2` … `0.2.1-rc.5` (and the `0.2.1` stable release of that line),
- `0.2.2-rc.1` and newer releases of that line.

Everything below `0.2.1-rc` is gone: `0.1.5-rc.*`, `0.1.7-rc.*`, `0.2.0-rc.*`.
The dead 0.1.5 settings-section shim (`installSettingsSection`,
`SettingsSectionHooks`) was removed with it; the plugin keeps only the
Config-based settings surface every supported host provides. Unverified
prereleases (`0.2.1-rc.1`, the alphas, `0.2.2-alpha.*`) stay rejected.

`schemastery` stays at `^3.18.2`: it resolves to `3.18.5` on a `0.2.1` host and
`3.19.0` on `0.2.2-rc.1`, so one hoisted copy matches whichever host is running.
`cordis` keeps `^4.0.1` as a peer because the supported hosts use both `4.0.5`
and `4.1.0`; the devDependency is `^4.1.0`.

## Verification

| dsh host | typecheck | tests |
| --- | --- | --- |
| `0.2.2-rc.1` (cordis 4.1.0, schemastery 3.19.0) | pass | 56/56 |
| `0.2.1-rc.5` (cordis 4.0.5, schemastery 3.18.5) | pass | 55 pass, 1 skipped |

The skipped case is the real-gate test, which skips with a printed reason on
trees that do not contain `dsh-app-boot`.


## Follow-up: `0.2.2-rc.3`

`0.2.2-rc.2` and `0.2.2-rc.3` were published after this audit. `cordis` stays at
`~4.1.0` and `schemastery` at `~3.19.0`, so the dependency graph is unchanged.

Changes between `rc.1` and `rc.3` that touch this plugin:

| Change | Effect |
| --- | --- |
| `LlmError` constructor narrows its `code` from `string` to `BuiltinLlmFailureCode` (`LLM_FAILURE_CODES` keys or `HTTP_<status>`); adds `LlmError.fromFailure` | `httpErrorCode` now returns `BuiltinLlmFailureCode`, which its branches already produced |
| `dsh-attachment`: `AttachmentError` extends `HarnessError` and gains an identity check | this plugin never constructs or narrows that error; it propagates whatever the store throws |
| `dsh-llm` `content.d.ts`: tool-declaration rebuild wording | documentation only |
| `dsh-app-boot`: optional `dsh.bundle.platforms` (now understanding `wsl`) | this package declares no `platforms`, so every host stays admitted |
| `dsh-app-boot` compatibility gate | byte-identical to `rc.1` (`engines.dsh` first, else peers) |
| `dsh-settings`, `dsh-launch-environment`, `dsh-timeout` | no code change |

`0.2.2-rc.3` is therefore added to the verified release list and the plugin
version becomes `0.3.1`. The range keeps admitting `rc.2` without claiming it was
verified. Typecheck plus all 56 tests pass against `0.2.2-rc.3`; `0.2.1-rc.5`
remains green at 55 passing with the gate test skipped where `dsh-app-boot` is
absent.

## Follow-up: `0.2.2-rc.5`

`0.2.2-rc.4` and `0.2.2-rc.5` add one built-in failure code (`CONTENT_REFUSED`)
to `dsh-llm` and change nothing else: `cordis` stays at `~4.1.0`,
`schemastery` at `~3.19.0`, and every other plugin-facing package is
byte-identical to `rc.3`.

That addition is backward compatible — a new member only widens
`BuiltinLlmFailureCode` — so this plugin needs no source change. It does not map
any xAI response onto `CONTENT_REFUSED`, because the subscription endpoint has
not been observed to return a distinguishable refusal and guessing at its shape
would mislabel ordinary 400s.

`0.2.2-rc.5` is added to the verified release list and the plugin version becomes
`0.3.2`. `rc.4` is admitted by the range without being claimed as verified.
Typecheck and all 56 tests pass against `0.2.2-rc.5`; `0.2.1-rc.5` remains green
at 55 passing with the gate test skipped where `dsh-app-boot` is absent.

## Residual risk

- `dsh-settings.configure` was reviewed from source and exercised only by booting
  a real `0.2.2-rc.1` profile; no automated test asserts the settings-page
  opt-out itself.
- The `llm/models-updated` emit is guarded but has no test; supported `0.2.1`
  hosts ignore the unknown event.
- No real xAI authorization is performed by the suite.
