# Camoufox PoC — results

**Status**: 🧪 in progress
**Branch**: `experiment/camoufox-poc`
**Question**: Does engine-level fingerprint spoofing (Camoufox) measurably improve AWSC outcomes for AliExpress over patchright in a containerized self-hosted setup?
**Methodology**: see [experiments/README.md](../experiments/README.md)

This file is the public record of what we tried and what happened. Filled in during testing. Survives in repo regardless of outcome (per the experiment plan) so future readers don't have to re-run the same experiment to know the answer.

---

## Environment

- **Test box**: _(fill in: Linux Mint NUC, kernel, RAM)_
- **Container runtime**: _(docker version)_
- **AliExpress account state**: _(fill in: account age, prior automation history if known, currently flagged or clean)_
- **Patchright version pinned in fork**: _(check `package.json`)_
- **Camoufox image / version**: _(fill in once verified — `jo-inc/camofox-browser:<tag>` or local Camoufox binary)_
- **Test dates**: _(fill in: e.g. 2026-05-10 → 2026-05-11)_

## Tier 0 — manual sidecar test

_Fill in after running the steps in `experiments/README.md` Tier 0._

- Camoufox image pulls cleanly: ☐
- VNC connection works (port 5901): ☐
- Browser visibly Firefox-based (vs Chromium): ☐
- AliExpress mobile coin URL loads: ☐
- AWSC challenge presented: ☐ (slider / harder challenge / no-gate / login-fail / other)
- Visual A/B vs patchright run on the same account: ☐ (better / same / worse)

**Verdict from Tier 0**: _(fill in. If Camoufox visibly walks through where patchright slider-gates, proceed to Tier 1. If Camoufox sees the same slider, the experiment is essentially over — record the finding and skip Tier 1.)_

## Tier 1 — scripted comparison

Each row is one run. Run each scenario at least 5 times across 2+ calendar days to characterize variance.

| Timestamp | Scenario | Run | Outcome | Elapsed | Screenshot |
|---|---|---|---|---|---|

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

**Verdict**: _(fill in)_

**Date verdict reached**: _(fill in)_

**Action taken**: _(fill in: e.g. "merged branch with Camoufox engine option behind ALIEXPRESS_ENGINE=camoufox flag" / "cherry-picked 16b5818 (docs) to main, closed experiment branch as not-merging" / etc.)_

## Notes / observations / surprises

_Free-form. Document anything that wasn't on the original methodology — e.g. "Camoufox image takes 90s to start cold," "AWSC slider behaves visibly different in Firefox vs Chromium even when both fail," "discovered jo-inc/camofox-browser exposes a REST API not a CDP endpoint, switched to local-binary mode," etc._
