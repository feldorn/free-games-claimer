# Camoufox PoC — results

**Status**: 🟡 inconclusive-leaning-negative (N=1) — no production integration; branch remains open for further testers
**Verdict date**: 2026-05-11
**Branch**: `experiment/camoufox-poc`
**Question**: Does engine-level fingerprint spoofing (Camoufox) measurably improve AWSC outcomes for AliExpress over patchright in a containerized self-hosted setup?
**Methodology**: see [experiments/README.md](../experiments/README.md)

This file is the public record of what we tried and what happened. Survives in repo regardless of outcome so future readers don't have to re-run the same experiment to know the answer.

## TL;DR

- **One Tier 0 test** on a real AliExpress account (@dabziuebu4egh2 in [#28](https://github.com/feldorn/free-games-claimer/issues/28)) hit the **same AWSC slider** that patchright presents. Engine-level WebGL / audio / nav-prop spoofing did not change the AWSC outcome for that account.
- **In parallel**, the original reporter (@DoSpamu in [#28](https://github.com/feldorn/free-games-claimer/issues/28)) reported that both Epic and AliExpress *self-resolved* after a few days of waiting — textbook **Category C** account-level risk-score decay from the [Bot detection README section](../README.md#bot-detection--what-works-what-doesnt).
- The two data points together are consistent with the "ceiling is account/hardware-bound, not JS-injection-bound" hypothesis the README opens with. The Camoufox engine swap doesn't help in the cases tested.
- **No production integration.** Branch remains open in case a different store hits aggressive fingerprint pressure later or more volunteer testers want to A/B against their own accounts. The honest README framing was cherry-picked to `main` independently in 2.5.5.

---

## Environment

- **Test box**: _(fill in: Linux Mint NUC, kernel, RAM)_
- **Container runtime**: _(docker version)_
- **AliExpress account state**: _(fill in: account age, prior automation history if known, currently flagged or clean)_
- **Patchright version pinned in fork**: _(check `package.json`)_
- **Camoufox image / version**: _(fill in once verified — `jo-inc/camofox-browser:<tag>` or local Camoufox binary)_
- **Test dates**: _(fill in: e.g. 2026-05-10 → 2026-05-11)_

## Tier 0 — infrastructure verification

### Done by branch maintainer (2026-05-09)

Validates that the basics work before account-specific testing begins.

- ✅ **Image pulls cleanly** (`ghcr.io/jo-inc/camofox-browser:latest`, ~600 MB total)
- ✅ **Image starts cleanly** under default config — Camoufox launches under Xvfb in ~1.6s, server pre-warms successfully
- ⚠️ **Image surprised expected wiring**: it's a **REST API server on port 9377** (Node.js, OpenAPI 3.0 spec at `/api`), **not** a Playwright-compatible CDP/BiDi endpoint. Compose overlay and runner script were updated to match. VNC ships disabled by default; needs `ENABLE_VNC=1` to expose port 5900.
- ✅ **Tab create works**: `POST /tabs` with `{userId, sessionKey}` returns a tabId.
- ✅ **Navigate works**: `POST /tabs/:id/navigate` with `{userId, url, waitUntil, timeoutMs}` returns the resolved final URL.
- ✅ **Screenshot works**: `GET /tabs/:id/screenshot?userId=…&fullPage=true` returns a fullsize PNG.
- ✅ **Cold AliExpress navigation succeeded** — `https://m.aliexpress.com/p/coin-index/index.html` redirects to `https://www.aliexpress.com/p/ug-login-page/login.html` (the login page) with **no AWSC slider, no harder-challenge, no bot-detection alarm bells** on a fresh unauthenticated load. Camoufox renders the login page cleanly with the standard email/phone input, Passkey/Google/Facebook buttons, and the "Download the AliExpress app" CTA in the corner.

**Implications for the user-side test**:

- The cold-load behavior (no challenge, redirect to login) **is the same** as what we'd observe with patchright on a non-flagged session. The interesting AWSC behavior happens on the credentials-submit step, not on initial nav. So Tier 1 scenario A vs C should both reach login-redirect cleanly; the divergence will show up when a real account attempts to sign in.
- **The runner script and compose overlay are now wired correctly for the actual API surface.** The user-side tests don't need to debug image-shape questions; they can focus on the AWSC behavior at credentials submit and post-login.
- **VNC works** when `ENABLE_VNC=1` is set (which the overlay does). The VNC viewer is the right place to do Tier 0 visual A/B testing.

### Camoufox engine-level fingerprint findings (from smoke test pre-fingerprint capture)

These are evidence that Camoufox is doing what it claims at the engine level, captured before any AliExpress account is involved:

| Signal | Camoufox value (smoke) | What patchright would show in our container |
|---|---|---|
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0` (rotates: also seen `X11; Ubuntu; Linux x86_64`) | Patchright Chromium on Linux, deterministic per profile |
| WebGL vendor / renderer | `Mozilla` / `Intel(R) HD Graphics 400, or similar` | `Mesa` / `llvmpipe (LLVM …, 256 bits)` — software-rendered, dead giveaway |
| Unmasked WebGL renderer | `Intel(R) HD Graphics 400, or similar` | Same llvmpipe value — patchright can't lie at this layer |
| hardwareConcurrency | `8` (spoofed) | Real container CPU count |
| screen | `2560×1440`, dpr=1 | Container `WIDTH × HEIGHT` env, typically 1920×1080 |
| timezone | `America/Los_Angeles` (rotates) | Container TZ |
| navigator.webdriver | `false` | `false` (patchright also fixes this) |

**Implication**: at least the WebGL signal — the most aggressively-checked fingerprint surface in AWSC's category — is genuinely spoofed at the engine layer. The audio context probe in the fingerprint capture will be the next signal to look at once a Tier 1 run lands; that's the one I claimed in the README would be hardest to fix without real hardware.

**This doesn't yet prove Camoufox defeats AWSC** — it proves Camoufox is presenting different signals than patchright would. Whether AWSC scores those different signals as "trusted" or "still synthetic" is what the account-specific testing answers.

### Per-run instrumentation captured (verified working)

Each Tier 1 run produces a directory under `data/camoufox-poc/<scenario>/run-<N>-<timestamp>/` containing:

- `manifest.json` — outcome classification, timing, paths to all artifacts
- `pre-fingerprint.json` — full JS-evaluated fingerprint at `about:blank` (UA, WebGL, audio context, screen, timezone, navigator props, plugins, mimeTypes, deviceMemory, performance.timing) — what Camoufox **claims to be** before any site sees it
- `post-state.json` — same probe re-run after navigate + settle, capturing post-load cookies, localStorage, iframes (any AWSC iframes will appear here), bodyText snippet, performance.navigation timing
- `screenshot-1.png` — fullpage at +5s after navigate (initial render)
- `screenshot-2.png` — fullpage at +10s after navigate (post-AWSC settle, useful when slider takes longer to render)
- `snapshot.json` — accessibility tree (text content of the page, structured)
- `navigate.json` — API response from the navigate call
- `traces.json` — index of any Playwright traces produced (best-effort; jo-inc may not flush traces for short non-interactive runs)
- `traces/<filename>.zip` — Playwright trace files if produced (open with `playwright show-trace`)
- `camoufox-logs.txt` — sidecar container stdout during the run (best-effort; falls back to instructions if `docker` CLI isn't reachable from where the runner ran)

### Account-specific Tier 0 — pending user

_Fill in after running the steps in `experiments/README.md` Tier 0 against an actual AliExpress account. Branch maintainer doesn't have one._

- Login attempt on Camoufox (via VNC at `localhost:5901`): ☐
- AWSC outcome at credentials submit: ☐ (slider / harder challenge / no-gate / login-fail)
- Same login attempt on patchright (existing fork) — visual A/B: ☐ (better / same / worse)
- Cookie import via `POST /sessions/{userId}/cookies`: ☐ (works / fails)
- Cookie-import + nav back to coin page: ☐ (works / slider / harder)

**Verdict from account-specific Tier 0**: _(fill in. If Camoufox visibly walks through where patchright slider-gates, proceed to Tier 1. If Camoufox sees the same slider, the experiment is essentially over — record the finding and skip Tier 1.)_

## Tier 1 — scripted comparison

Each row is one run. Run each scenario at least 5 times across 2+ calendar days to characterize variance.

| Timestamp | Scenario | Run | Outcome | Elapsed | Final URL | Screenshot |
|---|---|---|---|---|---|---|

_(Rows are appended automatically by `experiments/camoufox-aliexpress.js` when run with `RUNS=N SCENARIO=...`. Manual rows for the patchright baseline are added by hand using the same column shape.)_

### Scenario A — patchright cold start, no cookies

_Run via the existing `aliexpress.js` (or panel Run-Now) on a profile dir freshly emptied of cookies._

_Append rows manually here from `data/run-log` capture or panel logs._

### Scenario B — patchright + cookies imported

_Run via existing flow after a fresh cookie upload via panel Cookie button._

### Scenario C — Camoufox cold start, no cookies

_Run: `SCENARIO=C-cold-no-cookies RUNS=5 node experiments/camoufox-aliexpress.js`_

### Scenario D — Camoufox + cookies imported

_Cookies seeded into the Camoufox profile prior to run. Run: `SCENARIO=D-cookies RUNS=5 node experiments/camoufox-aliexpress.js`_

### Scenario E — Camoufox + cookies imported, fingerprint rotated

_Cookies seeded from a session originally tied to a different Camoufox fingerprint. Run: `SCENARIO=E-rotated-fp RUNS=5 node experiments/camoufox-aliexpress.js`_

## Aggregate outcome rates

Fill in after testing completes. One row per scenario, % of runs landing in each outcome bucket.

| Scenario | runs | no-gate | soft-slider | harder-challenge | login-refused | error |
|---|---|---|---|---|---|---|
| A — patchright cold | | | | | | |
| B — patchright + cookies | | | | | | |
| C — Camoufox cold | | | | | | |
| D — Camoufox + cookies | | | | | | |
| E — Camoufox + cookies + rotated FP | | | | | | |

## Decision

After all five scenarios have ≥5 runs each, evaluate against the gates from the methodology doc:

- **🟢 C and D meaningfully outperform A and B**: integrate Camoufox as opt-in engine for AliExpress (and possibly Epic). Open the integration PR off this branch.
- **🟡 C/D outperform but only on cookied runs (D > B; C ≈ A)**: middle outcome. Document and revisit only if a second store hits the same bottleneck. Don't ship the engine port yet.
- **🔴 C and D match A and B**: ceiling is hardware/account-bound, not JS-injection-bound. Cherry-pick the docs commits to main; abandon the engine integration.

**Verdict** (2026-05-11): 🟡 **N=1 result lands in the middle gate** (Camoufox saw same slider as patchright; not enough data to definitively close 🔴 but enough to defer production integration). DoSpamu's auto-resolution data confirms Category C account-decay is real and is the dominant variable, not engine fingerprint. The engine ceiling for our containerized environment doesn't appear to be the JS-shim layer — Camoufox does present different signals (verified WebGL spoof, etc.) but AWSC doesn't score the difference high enough on the tested account.

**Action taken**:
- Cherry-picked the docs commit (now `500ba16` on main) into the 2.5.5 release — honest bot-detection framing + AliExpress deprecation language lands as user-facing documentation regardless of engine outcome.
- **No production integration of Camoufox.** Engine swap not justified by current data.
- **Branch remains open**: scaffolding (`experiments/`, `docker-compose.experiments.yml`, this results doc) preserved for any subsequent volunteer who wants to A/B against their own account, or for future relevance if a different store starts gating aggressively on engine signals. Anyone re-testing should append a row to the aggregate-outcomes table above + a note in the section below.

## Notes / observations / surprises

- **Camoufox-with-jo-inc-image VNC is empty until the first POST /tabs** (#28). Camoufox pre-warms a 10×10 placeholder window only; the visible 1366×688 Navigator doesn't open until the first tab is created. Tier 0 doc updated to call this out explicitly.
- **AWSC scores account-level risk independently of engine fingerprint**: same account that hit the slider on Camoufox (N=1) had patchright traffic prior to the test, so the account was already weighted as suspicious. Cleanly separating "engine effect" from "account effect" would require testing against a fresh account with no prior automation history, which neither volunteer was willing to set up (understandably).
- **DoSpamu's auto-resolution timing** (~2 days for both Epic and AliExpress to start working) is a useful data point for setting user expectations on `wait it out` as the practical workaround. Folded into the README detection-ceiling section.
- **jo-inc/camofox-browser REST API surface is good** — tab/navigate/screenshot/snapshot/cookie-import/traces all clean. If we ever did integrate this image (Phase 2), the API is the easier shape than wrangling a standalone Camoufox binary + Playwright launch.
