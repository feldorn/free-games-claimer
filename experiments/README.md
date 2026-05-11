# Camoufox PoC — methodology and run guide

This directory holds the **experiment branch's** PoC scaffolding for testing whether [Camoufox](https://github.com/daijro/camoufox) (a Firefox fork that spoofs fingerprint signals at the C++ engine level) defeats AliExpress's AWSC slider gate where patchright cannot. **Nothing here is production code.** The PoC's only purpose is to answer one question with data: does engine-level fingerprint spoofing measurably improve AWSC outcomes from a containerized self-hosted setup?

The premise — and the rejected alternatives that aren't being PoC'd — is documented in the branch's [Bot detection section of the README](../README.md#bot-detection--what-works-what-doesnt) and the [parent issue thread](https://github.com/feldorn/free-games-claimer/issues/28).

## Why this is on a branch and not main

The honest framing in the README admits that JS-level fingerprint shims hit a hardware-signal ceiling. Camoufox's pitch is that engine-level spoofing operates *below* the JS layer, so the signals AWSC reads (WebGL strings, audio context, navigator props) are spoofed as ground truth rather than injected at runtime. Whether that holds against AWSC's current detector set is an empirical question — we run the PoC, capture results, then decide whether to integrate. If the PoC produces meaningful improvement, the branch merges to `main` with a Camoufox engine option for AliExpress (and possibly Epic). If the PoC produces no improvement, the docs commits cherry-pick to `main` and the rest of the branch is abandoned (with the results doc preserved as the public record).

## Important: jo-inc/camofox-browser is REST-API-driven, not Playwright

The image we're using (`ghcr.io/jo-inc/camofox-browser`) wraps Camoufox in a REST API server (Node.js, port 9377) rather than exposing a Playwright-compatible CDP/BiDi endpoint. The PoC runner drives the browser via HTTP. This is a PoC choice — if engine integration eventually ships, it would more likely link Camoufox in directly via Playwright's `firefox.launch(executablePath: …)`. The REST-API path here is the cheapest way to get evidence one way or the other.

OpenAPI spec: visit `http://localhost:9377/api` once the sidecar is running.

## Prerequisites

Bring up the sidecar from this branch:

```sh
docker compose -f docker-compose.yml -f docker-compose.experiments.yml up -d camoufox
docker logs fgc-camoufox-poc | tail -10  # confirm "browser pre-warmed"
```

The compose overlay publishes:
- **9377/tcp** — REST API (host) / hostname `camoufox` (FGC container's network)
- **5901/tcp** — raw VNC (host 5901 → container 5900). Connect with any VNC viewer (TigerVNC, RealVNC).
- **6081/tcp** — noVNC in-browser client (host 6081 → container 6080). Open `http://localhost:6081/vnc.html` to drive Camoufox in your browser. **Requires `VNC_BIND=0.0.0.0` in the sidecar's env**, which the overlay already sets — the image's noVNC binds to `127.0.0.1` inside the container by default, which makes a published port a no-op without that override.

(Raw VNC at 5900 already binds to all interfaces inside the container; only noVNC needs the bind override. If you tried `localhost:5901` with a browser and got "can't connect," that's why — use a VNC client for 5901, or the noVNC URL above for browser-based.)

Quick sanity check from the host:

```sh
curl -s http://localhost:9377/health
# { "ok": true, "engine": "camoufox", "browserConnected": true, ... }
```

## Tiers of testing

### Tier 0 — manual VNC observation (~30 min, no code)

Connect a VNC viewer to `localhost:5901` (native VNC client) or `http://localhost:6081/vnc.html` (in-browser noVNC) to drive Camoufox by hand. Useful for eyeballing AWSC behavior side-by-side with the existing patchright noVNC at `localhost:6080`.

> ⚠ **VNC will be blank until you create a tab via the API.** The `jo-inc/camofox-browser` image pre-warms Camoufox at startup but doesn't open a visible browser window. Until the first `POST /tabs` call, the Xvfb display is just a black screen (verified by `xwininfo -root -children` showing only a 10×10 placeholder window). Connect VNC, *then* run the two curl commands below — the visible Navigator window appears as soon as the tab is created, and the page renders inside it after navigate.

```sh
# 1. Create a tab — visible browser window appears in VNC now
TAB=$(curl -s -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"poc","sessionKey":"poc-test"}' | jq -r .tabId)

# 2. Navigate the tab — the AliExpress page renders inside the visible browser
curl -s -X POST "http://localhost:9377/tabs/$TAB/navigate" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"poc","url":"https://m.aliexpress.com/p/coin-index/index.html","waitUntil":"domcontentloaded"}'
```

In the VNC viewer you'll see Camoufox (Firefox-shaped UI) navigate to AliExpress in a 1366×688 window in the top-left of the 1920×1080 Xvfb area (the surrounding black margin is just empty desktop — not a rendering problem). Click "Sign in" and proceed with your AliExpress login as normal; VNC mirrors everything Camoufox is doing. Record the outcome shape (no-gate / soft-slider / harder challenge / outright refusal) in [`docs/camoufox-poc-results.md`](../docs/camoufox-poc-results.md).

If Camoufox visibly walks through where patchright slider-gates, Tier 1 is the next step. If Camoufox sees the same slider, the experiment is essentially over — the ceiling is real and Tier 1 won't change the answer.

### Tier 1 — scripted comparison (1–2 hours)

Programmatic side-by-side: same flow on patchright (existing `aliexpress.js`) and on Camoufox (`experiments/camoufox-aliexpress.js`), repeated N times, outcomes captured to `docs/camoufox-poc-results.md`.

```sh
# Patchright baseline (existing flow — record outcomes by hand)
node aliexpress.js
# or trigger via panel Run-Now on the AliExpress card

# Camoufox runs (rows append automatically to results doc)
SCENARIO=C-cold-no-cookies RUNS=5 node experiments/camoufox-aliexpress.js
SCENARIO=D-cookies        RUNS=5 node experiments/camoufox-aliexpress.js
SCENARIO=E-rotated-fp     RUNS=5 node experiments/camoufox-aliexpress.js
```

Run each scenario at least 5 times across two different calendar days to characterise variance.

#### Running from inside the FGC container vs from the host

The runner defaults to `CAMOFOX_URL=http://camoufox:9377` (the sidecar's hostname on the FGC compose network) and reads `CAMOFOX_API_KEY=poc-trace-token` (matching the value the compose overlay sets on the sidecar — required for trace-download endpoints, since FGC → camoufox is a non-loopback request).

Run it from inside the FGC container:

```sh
docker compose -f docker-compose.yml -f docker-compose.experiments.yml exec free-games-claimer \
  env CAMOFOX_API_KEY=poc-trace-token \
  node experiments/camoufox-aliexpress.js
```

Or from the host, override the URL:

```sh
CAMOFOX_URL=http://localhost:9377 \
CAMOFOX_API_KEY=poc-trace-token \
SCENARIO=C-cold-no-cookies \
node experiments/camoufox-aliexpress.js
```

(Running from the host requires Node 20+ for native `fetch`. From the FGC container, the runtime ships with what the image carries.)

#### What each run captures

Per-run artifact directory: `data/camoufox-poc/<scenario>/run-<N>-<timestamp>/`

| File | Content |
|---|---|
| `manifest.json` | Outcome classification + timing + paths to everything else. Read this first. |
| `pre-fingerprint.json` | Full JS-evaluated fingerprint at `about:blank` *before* any site sees us — UA, WebGL (vendor / renderer / unmasked / extensions), audio context (sampleRate, latency, channel count), screen, hardwareConcurrency, deviceMemory, timezone, navigator props, plugins, mimeTypes, `userAgentData`, performance metrics. This is the ground truth of what Camoufox claims to be. |
| `post-state.json` | Same probe re-run *after* navigate + settle. Captures any cookies AliExpress set, localStorage size, iframes that appeared (AWSC iframes show up here), body text snippet, performance.navigation timing (redirect count, TTFB, load times). |
| `screenshot-1.png` | Fullpage screenshot at +5s after navigate. |
| `screenshot-2.png` | Fullpage screenshot at +10s after navigate (often identical to #1 for unauthenticated loads, but useful when AWSC takes longer to render). |
| `snapshot.json` | Accessibility tree of the page — structured text content, useful for grepping for AWSC challenge strings. |
| `navigate.json` | API response from the navigate call. |
| `traces.json` | Index of Playwright traces produced. May be empty for short non-interactive runs. |
| `traces/<file>.zip` | Playwright trace exports if any. Open with `playwright show-trace <file>.zip` for a full DevTools-like replay (network, screenshots, DOM at each step). |
| `camoufox-logs.txt` | Sidecar container stdout during the run window. Falls back to manual-capture instructions if `docker` CLI isn't reachable. |

#### Running the same scenario across multiple runs

Each invocation handles N runs; user/session IDs include the scenario + run number for trace filtering:

```sh
# Inside FGC container, with auth key for traces
SCENARIO=C-cold-no-cookies RUNS=5 \
CAMOFOX_API_KEY=poc-trace-token \
docker compose -f docker-compose.yml -f docker-compose.experiments.yml exec free-games-claimer \
  node experiments/camoufox-aliexpress.js
```

Variance characterization: 5 runs per scenario across 2 calendar days = 10 data points per cell. Each run takes ~20s (most of which is `SETTLE_MS_2`, configurable via env).

## The five test scenarios

These are the rows in the results doc:

| ID | Engine | State | Notes |
|---|---|---|---|
| A | patchright | Cold start, no cookies | Baseline. Establishes "what AWSC does to a fresh containerized session." |
| B | patchright | Cookies imported | Establishes how AWSC re-evaluates a cookied session in patchright. |
| C | Camoufox | Cold start, no cookies | Direct counter to (A). Does engine-level spoofing change cold-start scoring? |
| D | Camoufox | Cookies imported | Counter to (B). Does cookie re-eval go differently when the engine fingerprint is engine-spoofed rather than JS-spoofed? |
| E | Camoufox | Cookies imported, fingerprint rotated | Cookies seeded from a session originally tied to a different fingerprint. Tests how strict the cookie-fingerprint binding is on AWSC's side. |

For each scenario, capture: outcome (no-gate / soft-slider / harder-challenge / login-refused / login-redirect), screenshot of any captcha shown (auto-saved by runner), the snapshot text classifier's verdict, run timing.

## Cookie import via the API (for scenarios D and E)

```sh
curl -s -X POST "http://localhost:9377/sessions/poc/cookies" \
  -H 'Content-Type: application/json' \
  -d @cookies.json
```

The `cookies.json` payload should match Camoufox's expected schema (look at `/api` OpenAPI spec for exact shape). For most cookie-editor exports a small reshape is needed.

## Decision gates

After the runs are complete:

- **C and D meaningfully outperform A and B** (e.g. C reaches no-gate or auto-pass where A always sees slider): the engine-level approach has measurable value. Open a sub-PR adding `ALIEXPRESS_ENGINE=camoufox` (or similar) opt-in to `aliexpress.js`. Consider extending to Epic in a follow-up.
- **C and D produce the same outcomes as A and B**: the ceiling is hardware/account-bound, not JS-injection-bound. Write up the finding in `docs/camoufox-poc-results.md`. Cherry-pick the docs commits to main; abandon the engine integration. Close the experiment.
- **C/D outperform but only on cookie-imported runs (D > B; C ≈ A)**: middle outcome — Camoufox helps with re-evaluation gating but not cold-start scoring. Probably not worth the engine-port investment for one store; document and revisit only if a second store hits the same bottleneck.

## Caveats to remember while testing

- **Account-level scoring (Category C)**: if your AWSC account has been flagged from prior automation, the slider will appear regardless of engine. To distinguish engine effects from account effects, ideally test against an account that hasn't been recently slammed with login attempts — or at minimum, separate "first run of the day" outcomes from subsequent ones.
- **Camoufox is actively counter-patched by anti-bot vendors.** A positive result today doesn't guarantee a positive result in 6 months. The engine-port decision should weigh this maintenance-tail.
- **Different content served to Firefox.** Some sites serve different markup or different captcha implementations to Firefox vs Chrome. This is part of "does it work?" — not a separate bug to fix.
- **Don't conflate "passes the slider" with "claim succeeds."** AliExpress's web channel is being deprecated by upstream regardless of fingerprint quality. Even a perfect fingerprint may eventually hit "feature removed from web." Capture outcomes at each stage so you can see where the failure actually lands.

## What this PoC explicitly does NOT test

- Migration of the whole project to Firefox/Camoufox.
- Camoufox on stores other than AliExpress (Epic, GOG, Steam, etc.) — those tests are downstream of this one validating.
- Android emulator path for AliExpress.
- chromedp sidecars or Cloud BaaS.

These are documented in the README's "what we won't build and why" subsection. Don't re-litigate them inside this PoC.

## Tier 0 baseline already established

Before AliExpress account-specific testing begins, the basic infrastructure has been verified end-to-end on the experiment branch (see [`docs/camoufox-poc-results.md`](../docs/camoufox-poc-results.md) — Tier 0 section): image pulls clean, server starts, REST API responds, tab/navigate/screenshot cycle works, cold AliExpress nav redirects to login page with no AWSC challenge on first hit. Account-specific testing (the actual question this PoC answers) is on the user side.
