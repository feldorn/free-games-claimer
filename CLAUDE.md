# CLAUDE.md — session-bootstrap for feldorn/free-games-claimer

## What this is

- **feldorn/free-games-claimer** — Chris's actively-maintained fork of the upstream `vogler/free-games-claimer` (dev branch).
- Automated free-game claimer + rewards farmer for Amazon Prime Gaming, Epic Games Store, FAB, GOG, Steam, plus Microsoft Rewards points; watch-only notifiers for IndieGala, PSN, Xbox, Fanatical, Humble, Lenovo Legion Key Drops, Ubisoft.
- Ships an always-on control panel at :7080 (Sessions / Stats / Schedule / Logs / Discoveries / Alerts / Settings tabs) plus noVNC at :6080 for manual captcha/login handoff.
- Node.js + patchright (anti-detect Chromium) inside a Docker container, driven by `src/panel/panel.js` (the panel + scheduler engine).
- Upstream is largely dormant on the game-claiming code — Chris's fork is feature-lead against every fgc-alike found in 2025-2026. Contributor `mateusfn98` has landed 5 refactoring PRs (#125, #136, #138, #139, #140).

## Who's Chris

- GitHub: `feldorn`. Runs the code as a self-hoster on a Linux/Docker box.
- Tests changes by pulling from GitHub → GHCR builds a new `:latest` → he pulls into his live container. See "Release rhythm" for the loop.
- Rare exceptions: for large multi-file features he'll authorize local hot-patches (`fgc-local:vX.Y.Z-test` image) before pushing.
- Prefers push-to-git for testing, one clean commit per logical change, small PRs.

## Current live state (update at end of each session)

- **Version shipped:** v2.12.9 → HEAD may be past this; check `package.json` and latest git tag.
- **Container:** `ghcr.io/feldorn/free-games-claimer:latest`, running from `~/docker/docker-compose.yml`. Compose service name = `free-games-claimer`.
- **Open PRs:** none.
- **Open issues:** rolling. See `gh issue list --state open` and the 2-week close rule below.
- **v2.12 backlog:** shipped as helper infrastructure only, awaiting live-account data collection. Plan file at `~/.claude/plans/v2.12-live-account-followups.md`.

## Operating model in one paragraph

You are working directly on Chris's repo. When you make a code change: edit locally → `git commit` (push to `main` via `git push origin main` when he asks) → tag `vX.Y.Z` → push tag → GHCR CI builds `:latest` and `:vX.Y.Z` images (~10-12 min) → Chris's compose auto-pulls or you run `docker compose pull free-games-claimer && docker compose up -d free-games-claimer` at `~/docker/`. Branch protection blocks force-push to `main`; use `git revert` if you need to undo something shipped. The user's docker daemon is on this same host — you can `docker` freely without SSH.

## Repo layout (post-PR #139, since 2026-08-04)

```
src/
  panel/panel.js         ← THE monolith. ~9500 lines. Panel HTTP server,
                           HTML template, scheduler loops, run orchestration.
                           Was `interactive-login.js` in the repo root pre-#139.
  platforms/             ← per-site runner scripts, spawned as child processes
    prime-gaming.js  epic-games.js  fab.js  gog.js  steam.js
    microsoft.js  ubisoft.js  aliexpress.js  fanatical.js
    humble-bundle.js  lenovo-gaming.js
    indiegala.js  psn-watcher.js  xbox-watcher.js  (all v2.11.0 new)
  sites.js              ← THE SITE REGISTRY. Single source of truth for every
                           service (id, script path, claimOrder, coverage badge,
                           configFields, checkLogin, defaultActive). Every panel
                           feature that touches "the list of services" reads
                           this. Adding a new site = one registry entry + one
                           runner file.
  config.js             ← flat `cfg` object built at module load from
                           env vars + data/config.json. Read via `import { cfg }`.
                           Beware stale snapshots — see landmine list.
  app-config.js         ← Settings-panel plumbing: describeConfig(),
                           patchConfig() writes data/config.json, schema.
  paths.js              ← DATA_DIR/ROOT_DIR/dataDir()/rootDir()/platformFile()
                           (PR #140). Zero local imports — safe for
                           bootstrap-cycle callers.
  util.js               ← notify(), log, jsonDb, matchKey, stripGpTail,
                           datetime, handleSIGINT, notifications-journal writer.
  browser.js            ← launchContext factory + gotoWithRetry helper.
  gamerpower.js         ← GamerPower + FGF discovery source loaders.
  freegamefindings.js   ← Reddit r/FreeGameFindings JSON API.
  discoveries.js        ← unified watcher-state loader for Discoveries tab
                           (folds watcher state files into aggregation pipeline).
  captcha.js            ← 2Captcha helper (opt-in; call sites not wired).
  pending-steam-keys.js ← Prime → Steam auto-redeem queue.
  github-watch.js       ← in-panel GitHub-reply alerts (v2.8.70).

test/                   ← minimal: currently just claim-cmd.js
docs/                   ← docs the panel and README link to
data/                   ← runtime state (mounted volume). NOT in repo.
```

## Key runtime data files (`data/` inside the container, bind-mounted from `~/docker/free-games-claimer/`)

- `config.json` — user's Settings-tab overrides
- `epic-games.json`, `gog.json`, `steam.json`, `prime-gaming.json`, `fab.json` — per-service claim DBs (`{user: {game_id: {title, status, time, ...}}}`)
- `scheduler-state.json` — main-chain last-completion timestamp + pause state
- `ms-schedule-today.json` — MS Rewards random-pick within today's window
- `discoveries-state.json` — user's ignore/manually-claimed markers
- `notifications-log.json` — v2.11.0+ notification journal (rolling 500)
- `pending-steam-keys.json` — Prime → Steam auto-redeem queue
- `*-watch.json` — per-watcher tracked-items state (indiegala, psn, xbox, fanatical, humble-bundle, lenovo-gaming, ubisoft)

## Release rhythm

1. **Edit + commit locally.** One clean commit per logical change, imperative subject, body explains why.
2. **`git push origin main`.** Branch-protected — no force-push. Use `git revert` to unshipped.
3. **`git tag vX.Y.Z && git push origin vX.Y.Z`.** ALWAYS tag releases — the update-check banner reads `/tags`, without a pushed tag users never see the update. Filed in `feedback_always_tag_releases`.
4. **Wait for GHCR builds.** Both `main` and the tag trigger separate ~10-12 min builds. `gh run list --limit 3` shows status. Watch with `gh run watch <id> --exit-status --interval 60 &` (backgrounded).
5. **Pull + recreate the local container** when green:
   ```
   cd ~/docker && docker compose pull free-games-claimer && docker compose up -d free-games-claimer
   sleep 6 && docker logs free-games-claimer 2>&1 | grep "Free Games Claimer v" | tail -1
   ```
6. **CHANGELOG entry required** for every user-visible change. `## What's new in X.Y.Z` at the top, explains the *why* not just the *what*.
7. **Version = single-sourced from `package.json`**. Never hardcode elsewhere. Filed in `feedback_single_version_source`.

## Issue queue workflow

Sweep with:
```
gh pr list --state open --json number,title
gh issue list --state open --json number,title,createdAt,comments --limit 40
gh api repos/feldorn/free-games-claimer/issues/comments?sort=created&direction=desc
gh api graphql -f query='query { repository(owner:"feldorn",name:"free-games-claimer") { discussions(first:20, orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { number title updatedAt author{login} comments(last:1){nodes{author{login} createdAt}} } } } }'
```

**Sweeps MUST include Discussions.** `gh issue list` doesn't show them. Missed JxPv2's D#46 for 5 weeks by relying on issue-only sweeps. Filed in `feedback_sweep_includes_discussions`.

**2-week silent-reporter close rule (standing convention).** For each open issue, compute `daysSilent` from last non-`feldorn` comment (or issue creation if the reporter never replied). At 14 days silent, close with a wrap-up comment recapping the diagnosis and offering to re-open on recurrence. Use `--reason "not planned"` on `gh issue close`. When posting the close comment, ALWAYS include the specific diagnosis so the record survives and future duplicates can be de-duped. If OTHER users (not the original reporter) are actively engaged (see #127 with Steggl), the 2-week clock is against the ISSUE's staleness, not the original reporter's silence — evaluate whether the recent engagement is productive; if yes, don't close.

**When triaging a new report,** always check the reporter's account age via `gh api users/<login> --jq '{created_at, public_repos, followers}'`. Fresh throwaway accounts posting ZIP attachments = phishing pattern. Never open the attachment; minimize as SPAM via GraphQL if warranted. Filed in `feedback_verify_comment_authors`.

## Landmines (do not repeat these — file pointers in `~/.claude/projects/-home-chris-Projects-free-games-claimer/memory/`)

These have all bitten the codebase. Read the memory file before touching the corresponding surface:

- **PANEL_HTML is a giant backtick template literal** (`feedback_panel_html_no_backticks`). Regex escapes (`\d`, `\s`, `\/`) get eaten by template evaluation — double them (`\\d`, `\\s`, `\\/`). Bare backticks in comments or strings terminate PANEL_HTML early — Node crashes at import. Regressed 4 times so far.
- **`disabled` attribute means different things pre- vs post-click** (`feedback_disabled_state_context`). Pre-click = state signal (already-owned). Post-click = loading spinner. Never use `disabled` as a success signal in a post-click race.
- **Diagnostic-scanner `script` is a DISPLAY name, not a site id** (`feedback_diag_script_is_display_name`). `_currentSection` is captured from `─── Section (vN) ───` headers → `"Epic Games"`. `lastRunSuccess`, `sites.js`, per-service DBs all use kebab-case ids (`"epic-games"`). `toLowerCase()` does NOT bridge the gap. Use `_resolveSiteIdFromScript()` or the stored `siteId`. Broke Tier-2 auto-dismiss for 68 days (v2.8.78 → v2.12.5).
- **MS Store redeem is client-side buynowui, not the old PrepareRedeem API** (`project_ms_store_buynowui_flow`). Watch iframe URL slug transitions (`redeemnow` → `redeem-confirm` → `redeem-success`). Validation is silent — an invalid or consumed code just refuses to enable the Next button, no error network response to hook.
- **`PG_RETRY_PENDING` retry-path assumes consumed on silent refusal** (`project_pg_retry_pending_semantics`). `isRetry:true` + validation timeout + no body-text hint → mark `claimed and redeemed`. Do NOT tighten this to require explicit evidence — regresses the auto-heal for the common case. Fresh-code first attempt stays conservative.
- **Stale `cfg` in the panel** (`feedback_stale_cfg_use_describeconfig`). `cfg` is a module-load snapshot. Panel readers must live-read via `describeConfig().effective`. Subprocesses (spawned scrapers) are fine — they start with fresh `cfg`.
- **`stripGpTail` multi-word Giveaway variants** (`feedback_stripgptail_multi_word_giveaway`). Regex must accept `(Steam) Key Giveaway`, `(Epic Games) Beta Giveaway`, `Giveaways` (plural). Bug shape: silently missed dedupes.
- **No local shadows of shared helpers** (`feedback_no_local_shadow_of_shared_helper`). If `src/util.js` exports it, import it — never redefine locally. Silent divergence causes daily notify loops.
- **PANEL_HTML data via `${JSON.stringify(...)}`** (`feedback_panel_html_template_substitution`). Node-only symbols crash client JS. Wrap helper calls inside PANEL_HTML explicitly.
- **`Playwright error string is a comma-list literal**, not alternation form (`feedback_playwright_error_regex_traps`). Guard on `"Target page, context or browser has been closed"` verbatim + `"Target crashed"` for arm64 renderer.
- **Pushover strips HTML** (`feedback_pushover_bare_domains`). No `<a href>`. Put full URL as literal plain text. Use `"GOG"` not `"gog.com"` (auto-linkifies to homepage). Regressed 3+ times.
- **Sweep both code paths on locator fixes** (`feedback_check_both_code_paths`). Per-script `auth()` + `src/sites.js checkLogin()` are separate paths. Missed once, cost a follow-up v2.8.37.
- **`disabled` PANEL_HTML native `confirm()`/`alert()`/`prompt()`** (`feedback_no_native_confirm`). Auto-cancels under pop-up blockers / iframe / noVNC. Use custom modals.
- **`docker cp` doesn't reload the running panel** (`feedback_docker_cp_no_reload`). Files on disk ≠ in-memory Node module. Rebuild image or restart process. Syntax-check ≠ hot-patched.
- **Missed runs need manual recovery, not auto-fire** (`feedback_missed_runs_manual_recovery`). Past-target wakes mark missed and rely on user's manual trigger.
- **Notify-only over auto-claim for fragile UIs** (`feedback_notify_only_pattern`). New storefronts get watcher + apprise, not scripted claim.
- **Opt-in for changes affecting existing deploys** (`feedback_opt_in_for_existing_deploys`). Default = old behavior, env flag opts into the new.
- **Composite time inputs, not raw seconds** (`feedback_composite_time_inputs`). UI uses d/h/m boxes; storage stays seconds.
- **Schedule UI must match runtime** (`feedback_schedule_displays_match_runtime`). Don't show LOOP when MS-anchored; surface time+window always.
- **Independent timing → independent scheduler loops** (`feedback_independent_schedules`). No lock on shared state.
- **Aggregate log lines**, don't per-item spam mature libraries (`feedback_aggregate_log_verbosity`). Reserve ✗ for real failures.
- **stripGpTail must be shared helper**, and the panel had a local shadow that silently diverged for 6+ days causing a daily-notify loop — check both places (v2.10.1 fix).
- **Verify GraphQL discussion IDs same-session** (`feedback_verify_graphql_discussion_id`). Reused IDs leak comments to random repos.
- **Check jsconfig before removing @types/\*** (`feedback_check_jsconfig_before_removing_devdeps`). `checkJs:true` uses them even with no runtime import.
- **`gh issue list updatedAt` is ambiguous** (`feedback_issue_list_updated_ambiguous`). Always check actual last commenter, not just the timestamp.

## Key project-context files (also in memory dir)

- `project_upstream_state` — vogler resumed EG patches 2026-06-04 after 5-month gap; P-Adamiec Python Remaster is real; Discussion #587 is canonical v2.0.x rollup link.
- `project_phase0_engine_refactor` — engine refactor (issue #11) shipped, framework validated through 2.2.0; Humble + Fanatical added on new framework with zero engine touches.
- `project_issue2_slider` — v2.8.55 AliExpress slider awareness fix (`awaitUserCaptchaSolve`); downstream work gated on marker data.
- `project_ms_rewards_new_ui` — Tailwind rewrite (`#dailyset` on /dashboard, `#exploreonbing` on /earn), `.rotate-180` chevron for collapse state, `.bg-statusSuccessRewardsBg` for locale-portable completed detection, mobile earning REMOVED (skip pre-login via sessionSawNewUi from desktop).
- `project_claim_script_order` — Prime FIRST (its Prime→GOG/Epic/LG keys redeem same-day), MS LAST (internal wait-until-window). Ordered via `claimOrder` field in registry.
- `project_steam_db_and_dlc_guard` — Steam DB shape + DLC-without-base-game skip via `.game_area_dlc_bubble` (v2.8.77).
- `project_transient_diagnostic_filter` — v2.8.78 Tier-2. Count:1 + prior success → transientLikely, banner suppressed, auto-dismissed on next success.
- `project_gh_reply_alerts` — v2.8.70 anonymous REST poll by `github.username`, no PAT, silent no-op when unset.
- `project_alerts_and_diagnostic_flow` — 5 sections (Pending redeems / Stale sessions / Discoveries / GitHub replies / Errors) fed by `/api/alerts/summary` + `/api/diagnostics/list`.
- `project_v212_deferred` — MS quizzes/punch/streak + CAPTCHA wiring; plan file at `~/.claude/plans/v2.12-live-account-followups.md`.

## User's local infrastructure

- Compose file: `~/docker/docker-compose.yml` (66KB, multi-service stack). `free-games-claimer` service around line 1697.
- `.env` at `~/docker/.env` sourced by compose. Includes `DOCKER_DIR=/home/chris/docker`, `PUID`, `PGID`, `TZ`, `NOTIFY` (Pushover URL), `EG_*`, `PG_*` credentials.
- Data volume bind-mount: `/home/chris/docker/free-games-claimer/:/fgc/data`.
- Reverse proxy: SWAG at `media.feldorn.com/free-games/` (subfolder proxy). Config nuances filed in `reference_swag_subfolder` + `reference_npm_novnc_asset_caching`.
- Container name: `free-games-claimer`.

## Convention hits (do these on every session)

- **Never commit** the untracked `restart_claude.sh` at repo root. Stage files explicitly, not `git add .`. Filed in `project_feedback_file`.
- **Push to git for testing** — no long-lived local-only edits. Chris's live container pulls from `:latest`. Filed in `feedback_commit_and_push`.
- **Commit message body ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.**
- **Every release tags AND pushes the tag.** Users see the update-check banner only if a tag exists.
- **CHANGELOG entry** in same commit as the change.
- **Aggregate log lines** on repeat-every-run patterns (per `feedback_aggregate_log_verbosity`). Individual-item lines only when the item needs action.
- **`gh` for GitHub operations**, not curl to the REST API directly.

## Reference: current site registry (as of v2.11.9)

- Claimers (auto-claim): `prime-gaming` (order 2), `gog` (2.5), `epic-games` (3), `fab` (3.5), `steam` (4), `aliexpress` (5, deprecating).
- Watchers (notify-only): `ubisoft` (6), `humble-bundle` (7), `fanatical` (8), `psn-watcher` (8.3), `xbox-watcher` (8.4), `indiegala` (8.5).
- Points/coins: `microsoft` (9 — runs last because internal wait-until-window), `microsoft-mobile` (sub-service of microsoft).
- Watch-only scheduled: `lenovo-gaming` (10 — dynamic per-drop wakes).

## Reference: env vars added in v2.11.0

`PG_STEAM_AUTOREDEEM`, `INDIEGALA_ACTIVE`, `PSN_ACTIVE`, `XBOX_ACTIVE`, `INDIEGALA_PAGE_URL`, `CAPTCHA_PROVIDER`, `CAPTCHA_API_KEY`, `STEAM_POINTS_SHOP_WEEKLY`.

## Reference: env vars added in v2.12.x

`PG_RETRY_PENDING` (v2.12.3) — opt-in; re-attempts stuck MS Store / Xbox codes in `data/prime-gaming.json` after each Prime run. Requires both a `.env` entry AND a matching `- PG_RETRY_PENDING=${PG_RETRY_PENDING:-}` line in the compose file's `environment:` block (compose doesn't propagate `.env` implicitly).

## Session hygiene

- **Start of session:** read `project_current_status` memory FIRST — it's the rolling handoff doc with shipped version, in-flight forks, open issue queue, and recent decisions. Then `git status` for uncommitted work; `gh pr list && gh issue list` for anything new since the status snapshot.
- **Continuously during the session (not just at end):** update `project_current_status` on every ship, every issue close/open, every fork or background task spawned, every multi-turn decision. Also update this file's "Current live state" block when the shipped version, open-PR count, or landmine list changes. See `feedback_always_record_current_status`.
- **New landmine hit:** file it in memory AND add one bullet to the Landmines section here.
