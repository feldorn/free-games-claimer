← [Back to README](../README.md)

# Home Assistant integration

The panel exposes a single REST endpoint (`/api/hass/sensors`) that returns a flat JSON snapshot of claim stats, session health, and pending action items. Point Home Assistant's built-in [REST integration](https://www.home-assistant.io/integrations/rest/) at it and you get sensors for MS Rewards balance, weekly / monthly / all-time claim counts, pending redeems, stale sessions, and last-run status — no add-on or custom component needed.

---

## What the endpoint returns

`GET http://<panel-host>:7080/api/hass/sensors` returns JSON like:

```json
{
  "ms_balance": 13912,
  "ms_balance_at": "2026-06-15 11:19:00.381",
  "ms_points_this_week": 0,
  "games_this_week": 6,
  "games_this_month": 25,
  "games_all_time": 148,
  "last_claim_at": "2026-06-26 07:30:34.027",
  "last_claim_title": "Space Grunts: Chrono Shard",
  "last_claim_service": "prime-gaming",
  "last_run_at": "2026-06-30 07:30:00.004",
  "last_run_status": "success",
  "last_run_source": "scheduler-main:prime-gaming+epic-games+gog+steam",
  "last_run_duration_sec": 68,
  "pending_prime_redeems": 0,
  "pending_steam_keys": 0,
  "stale_sessions": 0,
  "stale_session_ids": [],
  "pending_errors": 0,
  "captcha_pending": false,
  "captcha_pending_service": null,
  "captcha_pending_label": null,
  "active_services": ["epic-games", "gog", "prime-gaming", "steam"],
  "app_version": "2.8.53",
  "panel_url": "https://fgc.example.com",
  "services": {
    "prime-gaming": { "name": "Prime Gaming", "unit": "games", "this_week": 3, "this_month": 12, "all_time": 87, "last_claim_at": "2026-06-26 07:30:34.027" },
    "microsoft":    { "name": "Microsoft Rewards", "unit": "points", "this_week": 0, "this_month": 3500, "all_time": 13912, "last_claim_at": "2026-06-15 11:19:00.381" }
  }
}
```

The **top-level fields** are the common cases most users want to graph. The **`services` sub-object** breaks out per-service claim history for users who want a sensor per storefront.

---

## Minimal HA configuration

Add this to your `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: FGC
    resource: http://<panel-host>:7080/api/hass/sensors
    scan_interval: 300  # 5 minutes — the panel refreshes state every ~10s so
                        # more frequent polling burns cycles without new data
    value_template: "{{ value_json.games_all_time }}"
    json_attributes:
      - ms_balance
      - ms_balance_at
      - ms_points_this_week
      - games_this_week
      - games_this_month
      - games_all_time
      - last_claim_at
      - last_claim_title
      - last_claim_service
      - last_run_status
      - last_run_at
      - pending_prime_redeems
      - pending_steam_keys
      - stale_sessions
      - stale_session_ids
      - pending_errors
      - captcha_pending
      - services
      - app_version
```

That single REST sensor holds everything; you then create template sensors for each individual field you want to graph or trigger on.

---

## Recommended template sensors

Add to `configuration.yaml` under `template:`:

```yaml
template:
  - sensor:
      - name: FGC MS Rewards Balance
        state: "{{ state_attr('sensor.fgc', 'ms_balance') }}"
        unit_of_measurement: points
        icon: mdi:microsoft
      - name: FGC Games This Week
        state: "{{ state_attr('sensor.fgc', 'games_this_week') }}"
        unit_of_measurement: games
        icon: mdi:controller
      - name: FGC Games This Month
        state: "{{ state_attr('sensor.fgc', 'games_this_month') }}"
        unit_of_measurement: games
      - name: FGC Last Claim
        state: "{{ state_attr('sensor.fgc', 'last_claim_title') }}"
        attributes:
          service: "{{ state_attr('sensor.fgc', 'last_claim_service') }}"
          at: "{{ state_attr('sensor.fgc', 'last_claim_at') }}"
      - name: FGC Pending Redeems
        state: "{{ state_attr('sensor.fgc', 'pending_prime_redeems') + state_attr('sensor.fgc', 'pending_steam_keys') }}"
        unit_of_measurement: codes
        icon: mdi:key-variant
      - name: FGC Stale Sessions
        state: "{{ state_attr('sensor.fgc', 'stale_sessions') }}"
        unit_of_measurement: sessions
        icon: mdi:account-alert

  - binary_sensor:
      - name: FGC Captcha Pending
        state: "{{ state_attr('sensor.fgc', 'captcha_pending') }}"
        device_class: problem
        icon: mdi:robot-confused
      - name: FGC Last Run Ok
        state: "{{ state_attr('sensor.fgc', 'last_run_status') == 'success' }}"
        device_class: problem
      - name: FGC Has Alerts
        state: >-
          {{ state_attr('sensor.fgc', 'pending_prime_redeems') > 0
             or state_attr('sensor.fgc', 'pending_steam_keys') > 0
             or state_attr('sensor.fgc', 'stale_sessions') > 0
             or state_attr('sensor.fgc', 'pending_errors') > 0
             or state_attr('sensor.fgc', 'captcha_pending') }}
        device_class: problem
```

---

## Suggested automations

**Notify when a captcha is pending:**

```yaml
automation:
  - alias: "FGC captcha needs attention"
    trigger:
      - platform: state
        entity_id: binary_sensor.fgc_captcha_pending
        to: 'on'
    action:
      - service: notify.mobile_app
        data:
          title: "Free Games Claimer"
          message: >-
            {{ state_attr('sensor.fgc', 'captcha_pending_service') }}
            needs a captcha solved. Open the panel to solve via noVNC.
          data:
            url: "{{ state_attr('sensor.fgc', 'panel_url') }}"
```

**Alert when a session goes stale:**

```yaml
automation:
  - alias: "FGC session expired"
    trigger:
      - platform: numeric_state
        entity_id: sensor.fgc_stale_sessions
        above: 0
    action:
      - service: notify.mobile_app
        data:
          title: "FGC — session expired"
          message: >-
            {{ state_attr('sensor.fgc', 'stale_session_ids') | join(', ') }}
            need re-login. Panel: {{ state_attr('sensor.fgc', 'panel_url') }}
```

**Weekly claim summary as a Home Assistant notification (Sunday evenings):**

```yaml
automation:
  - alias: "FGC weekly summary"
    trigger:
      - platform: time
        at: '20:00:00'
    condition:
      - condition: time
        weekday:
          - sun
    action:
      - service: notify.mobile_app
        data:
          title: "This week's free games"
          message: >-
            {{ state_attr('sensor.fgc', 'games_this_week') }} games claimed ·
            MS Rewards: {{ state_attr('sensor.fgc', 'ms_balance') }} pts
```

---

## Authentication

The endpoint is **intentionally unauthenticated**, same policy as `/api/health`. The data exposed (MS balance, claim counts, session status) is the same information visible on the panel's Sessions and Stats tabs, and HA's stock REST integration doesn't have a first-class way to provide credentials for pull-mode sensors.

If your panel is publicly reachable and you want the HA endpoint locked down anyway, put a reverse proxy in front (SWAG, Nginx Proxy Manager, Traefik) with either basic auth or an IP allowlist scoped to your HA host. Common local-network setups treat everything behind the router as trusted and don't need this extra layer.

---

## Refresh cadence

The panel's internal state refreshes every ~10 seconds while it's running (session probes, run history, activity feed). `scan_interval: 300` (5 minutes) on the HA side is a comfortable default — new data lands within one HA cycle for anything a user would care about. Set it lower (`60` or `30`) if you want tighter reactivity on the captcha-pending binary sensor at the cost of more polling.

If you set an HA-side `scan_interval` significantly lower than the panel's `~10s` internal refresh, you'll see the same JSON multiple times before it changes. Not harmful, just wasteful.
