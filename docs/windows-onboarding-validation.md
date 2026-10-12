# Windows first-run OAuth regression validation

Base: a3b2b9e2343f2c65102775a5c5b41abe2ba4d3fa (0.1.7).

CI runs Node 22 on ubuntu-latest and windows-latest, without disabling browser
selection globally. Browser launches are replaced inside tests; OAuth requests
use undici MockAgent with network access disabled. Credential files and token
search roots are temporary directories. No real authorization is performed.

Existing helpers already cover platform overrides, HTML escaping, random-path
access boundaries and expired status; the new onboarding suite complements them.

Automated coverage:
- No-TTY Windows selection, browser-disabled policy, native platform default.
- Mock device grant, waiting and authorized status, HTTP headers, authorization
  button routing and HTTP method constraints.
- Token persistence only to a temporary path; no token secrets in state output.
- Browser spawn/error events and guide/auth-page URL fallback.
- Success and denial cleanup: subsequent connections to the guide are refused.
- Bootstrap without a console: automatic Windows visual selection (explicit
  visual selection on Linux), mocked default-model update and server cleanup.

Two defects exposed by these regressions are fixed: async process-spawn errors
previously returned success; state JSON omitted title/body consumed by page paint.
The authorization button now uses the injectable opener and returns 503 on launch
failure, while announcing the manual authorization URL.

Local validation: Linux, Node 22.23.3 and Node 24.19.0: 50/50 tests passed.
Windows CI has been configured but has not been executed by this patch delivery.

Manual Windows Desktop validation still required, using a fresh disposable
profile and the currently supported DSH release:
1. Start without a visible console: guide opens in the default browser, code is
   readable, copy button and authorization button work, waiting state updates.
2. Check a missing/blocked default browser: verify whether Desktop makes the
   announced URL accessible. stderr fallback alone does not prove this.
3. With a disposable account/profile, finish authorization and verify visible
   success text, Desktop resumes, credentials survive restart, guide port closes.
4. Check cancellation/expired grant presentation and retry from Desktop.

Process spawn success proves the OS accepted the launcher, not that a browser
window became visible. Browser policy denial after spawn, visual layout,
clipboard permissions and Desktop integration remain manual checks.

No package version, compatibility range or DSH dependency changes. No npm publish.

Apply the supplied patch from the repository root:

    git apply --check xai-windows-onboarding.patch
    git apply xai-windows-onboarding.patch
    npm install --no-audit --no-fund
    npm test

Targeted run after building:

    npm run build
    node --test tests/onboarding.test.mjs

Follow-up verification (2026-10-12):
- The Linux Node 22/24 result above is the earlier 50/50 run. On Windows, the
  existing portable Node 22.23.3 passed npm run typecheck, the targeted
  generated-page JavaScript regression (1/1), and the complete suite (53/53).
  The 53rd test is the main-title synchronization regression; the earlier
  52/52 evidence is retained.
- The regression executes the generated page script with a simulated DOM and
  fetch responses. Its ACK assertion verifies script behavior only; it is not
  an end-to-end browser ACK.
- The workflow configures Node 22 CI on Ubuntu and Windows. This local handoff
  did not execute GitHub Actions; CI results must be read from the workflow run.