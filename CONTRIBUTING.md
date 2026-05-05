# Contribute

## Code: how to create a pull request

1. Fork it ( <https://github.com/vogler/free-games-claimer/fork> ).
1. Create your feature branch (`git checkout -b my-new-feature`).
1. Stage your files (`git add .`).
1. Commit your changes (`git commit -am 'Add some feature'`).
1. Push to the branch (`git push origin my-new-feature`).
1. Create a new pull request ( <https://github.com/vogler/free-games-claimer/compare> ).


## Adding a new collector

The engine routes everything through `src/sites.js` (the registry) plus a per-site runner script. To add a new claim/watch site, two files change: a registry entry and a `<id>.js` runner.

### 1. Register it in `src/sites.js`

Append an entry to the `SITES` array. Required fields:

| Field | Notes |
|---|---|
| `id` | stable identifier (lowercase, hyphenated) — used in config keys, deep links, claim DB filename |
| `name` | human-readable label shown in cards and notifications |
| `script` | runner filename at repo root (`'foo.js'`); `null` for sub-services that share a parent's script |
| `loginUrl` | page to navigate to for interactive login; `null` for no-login services (watchers) |
| `browserDir` | getter (`get browserDir() { return cfg.dir.browser; }`) — most services share the profile; suffix it (`+ '-foo'`) for an isolated profile |
| `defaultActive` | `true` for default-on, `false` for opt-in |
| `activeEnv` | env var name that gates `services.<id>.active` (e.g. `'FOO_ACTIVE'`) |
| `claimDbFile` | `'<id>.json'` if the script writes a claim DB; `null` otherwise (Microsoft, Ubisoft) |
| `scheduleKind` | `'daily-chain'` (runs in the main scheduler chain), `'daily-window'` (own random-pick loop — Microsoft today), or `'watch-only'` |
| `claimOrder` | integer; `getClaimScriptOrder()` sorts ascending |
| `configFields` | array of per-service settings (see step 2) |
| `checkLogin` | `async (page) => ({ loggedIn, user? })` — `null` for watchers |

Optional: `linkedWith` (sibling that shares this entry's toggle and script — e.g. `microsoft` → `microsoft-mobile`); `subtitle` (second-line text in Settings); `contextOptions` (extra Playwright options, e.g. mobile fingerprint via `devices['Pixel 7']`); `features` (named opt-ins consumed by the engine — `'captcha-marker'`, `'ms-window-skip'`, `'batch-redeem-source'`).

### 2. Define `configFields`

Each entry surfaces in Settings → Services. Shape:

```js
{
  key: 'minPrice',                    // path becomes services.<id>.minPrice
  env: 'FOO_MIN_PRICE',
  type: 'number',                     // 'boolean' | 'number' | 'string'
  default: 10,
  label: 'Minimum price',
  hint: 'Filters out shovelware...',  // optional help text under the field
  unit: 'USD',                        // optional unit label
  prefix: '$',                        // optional input prefix
  nullable: true,                     // optional — empty input → null
  coerce: { kind: 'numberOr', fallback: 10 },  // optional, see below
}
```

Coerce descriptors recognized by `src/app-config.js`:

- *(absent on a `boolean` field)* → `toBool`
- *(absent on a `string` field)* → identity
- `{ kind: 'boolDefaultTrue' }` → `toBoolDefaultTrue` (truthy unless explicit `'0'`/`'false'`)
- `{ kind: 'nullableNumber' }` → `null` on empty, otherwise `Number(v)`
- `{ kind: 'numberOr', fallback: N }` → `Number(v) || N`
- `{ kind: 'numberBounded', min: M, fallback: N }` → `Math.max(M, Number(v) || N)`

A new kind needs a case added to `coerceFromDescriptor` in `src/app-config.js`.

### 3. Write the runner script (`<id>.js` at repo root)

Spawned as a standalone Node process by the panel. Use `epic-games.js` or `gog.js` as a starting template. Contract:

- Read settings from `cfg.<field>` (loader flattens registry settings into `cfg` — see `src/config.js`).
- Read credentials directly from `process.env.<NAME>` (credentials stay env-only by design — never put them in the registry).
- Launch the browser via `chromium.launchPersistentContext(cfg.dir.browser, …)` (or your isolated profile if `browserDir` differs).
- Per game/event, write an entry to the claim DB via `jsonDb('<id>.json', {})` from `src/util.js`.
- For human-solvable captchas, wrap the wait in `awaitUserCaptchaSolve(page, { service, captchaCheck, … })` from `src/util.js` — emits the `[CAPTCHA-START]` / `[CAPTCHA-END]` markers the panel watches for, and the user solves via the embedded VNC.

### 4. Claim DB entry shape

The stats aggregator and key redeemers iterate every user and every gameId. The shape:

```js
{
  title: 'Game Name',                 // human-readable
  url: 'https://store.example/game',  // optional, store/event page
  status: 'claimed',                  // any string starting with "claimed" counts as success
  time: '2026-05-04 13:00:00',        // local datetime — use datetime() from util.js
  // For redeemable keys (e.g. Humble/Fanatical hand out Steam keys):
  code: 'XXXXX-YYYYY-ZZZZZ',
  store: 'steampowered.com',          // 'steampowered.com' triggers Steam batch redeem; 'gog.com' triggers GOG batch redeem
}
```

The DB is a `{ user: { gameId: entry } }` map. The redeemers scan every claim DB the registry knows about, so you don't need to register your DB anywhere extra — `claimDbFile` does it.

### 5. Verify

- `npm run lint` passes.
- Container boots, the auto-check reaches your site (visible in `docker logs`).
- Settings → Services renders your row with the configured fields, and toggling them round-trips through the API.
- `Run Now` (or the scheduled main loop) invokes your script.

If you find yourself needing engine changes to make your script work — a new `scheduleKind`, a new `coerce` kind, a new `feature` flag consumer — open an issue describing the gap rather than working around it locally. The whole point of the registry is that *normal* collectors don't need engine touches.


## Building and publishing docker images

Setup the secrets for DOCKERHUB_USERNAME and [DOCKERHUB_TOKEN](https://hub.docker.com/settings/security) in `https://github.com/YOUR_USERNAME/free-games-claimer/settings/secrets/actions` to be able to run the docker.yml workflows.

Check if under Workflow Permissions in `https://github.com/YOUR_USERNAME/free-games-claimer/settings/actions` the radio button is set to "Read and write permissions", otherwise the push to ghcr.io will fail.
