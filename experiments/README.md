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
- **5901/tcp** — VNC (only useful with `ENABLE_VNC=1`, which the overlay sets)

Quick sanity check from the host:

```sh
curl -s http://localhost:9377/health
# { "ok": true, "engine": "camoufox", "browserConnected": true, ... }
```

## Tiers of testing

### Tier 0 — manual VNC observation (~30 min, no code)

Connect a VNC viewer to `localhost:5901` and drive Camoufox by hand. Useful for eyeballing AWSC behavior side-by-side with the existing patchright noVNC at `localhost:6080`.

```sh
# Open a tab via the API, then watch what happens in VNC
TAB=$(curl -s -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"poc","sessionKey":"poc-test"}' | jq -r .tabId)

curl -s -X POST "http://localhost:9377/tabs/$TAB/navigate" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"poc","url":"https://m.aliexpress.com/p/coin-index/index.html","waitUntil":"domcontentloaded"}'
```

In the VNC viewer you should see Camoufox (Firefox-shaped UI) navigate to AliExpress. Try logging in. Record the outcome shape (no-gate / soft-slider / harder challenge / outright refusal) in `docs/camoufox-poc-results.md`.

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

The runner defaults to `CAMOFOX_URL=http://camoufox:9377` (the sidecar's hostname on the FGC compose network). Run it from inside the FGC container:

```sh
docker compose -f docker-compose.yml -f docker-compose.experiments.yml exec free-games-claimer \
  node experiments/camoufox-aliexpress.js
```

Or from the host, override the URL:

```sh
CAMOFOX_URL=http://localhost:9377 SCENARIO=C-cold-no-cookies node experiments/camoufox-aliexpress.js
```

(Running from the host requires Node 20+ for native `fetch`. From the FGC container, the runtime ships with what the image carries.)

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
