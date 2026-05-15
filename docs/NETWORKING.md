← [Back to README](../README.md)

# Networking

Reverse-proxy configurations for serving the panel and noVNC behind your own domain.

---

## Reverse-Proxy Setup

The interactive-login panel can be served behind a reverse proxy. There are three
common deployment shapes, each with its own env vars. Pick the one that matches
how your proxy routes traffic — the others stay unset.

| Shape | Example | Env vars |
|---|---|---|
| **Direct access** (no proxy) | `http://localhost:7080`<br>`http://localhost:6080` (noVNC) | none |
| **Same-host subdomain** | `https://fgc.example.com:7080` (panel)<br>`https://fgc.example.com:6080` (noVNC) | none |
| **Same-host subfolder** | `https://example.com/free-games` (panel)<br>`https://example.com/free-games/novnc/` (noVNC) | `BASE_PATH`, `PUBLIC_URL` |
| **Split-subdomain** | `https://fgc.example.com` (panel)<br>`https://browser.example.com` (noVNC) | `NOVNC_URL` |

`BASE_PATH` and `NOVNC_URL` are mutually exclusive — if `NOVNC_URL` is set it
wins; otherwise `BASE_PATH` (when set) builds the noVNC URL on the same host
under that prefix; otherwise the panel embeds noVNC at `<panel-host>:6080`.

### Subdomain (simplest)

No special configuration needed on the app side. Point your reverse proxy at
`http://fgc:7080/` and `http://fgc:6080/` for the panel and noVNC respectively.

### Split-subdomain

When the panel and noVNC live on different hostnames (e.g. Traefik routes
`fgc.example.com` to the panel and `browser.example.com` to noVNC), set
`NOVNC_URL` so the panel's "Show browser" iframe and "Pop out ↗" button know
where to find the noVNC viewer.

```yaml
environment:
  - NOVNC_URL=https://browser.example.com
```

The value should point at the directory containing `vnc.html` — the panel
appends `/vnc.html?autoconnect=true&resize=scale` itself. **Don't set
`NOVNC_URL` if you're using `BASE_PATH`** — the same-host subfolder case
already handles noVNC routing and `NOVNC_URL` would override it incorrectly.

### Subfolder

Set `BASE_PATH` to the prefix and `PUBLIC_URL` to the full external URL:

```yaml
environment:
  - BASE_PATH=/free-games
  - PUBLIC_URL=https://example.com/free-games
```

The app will:
- Strip `BASE_PATH` from incoming request URLs before routing.
- Build all client-side URLs (`fetch`, noVNC iframe `src`) with the prefix.
- Include `PUBLIC_URL` in notifications so tap-targets land on the panel.

Example SWAG / nginx config (save as `free-games.subfolder.conf` in
`proxy-confs/`). **Important**: `proxy_pass` must not have a trailing slash —
the app handles prefix stripping itself. The `^~` modifier ensures this
location wins over any regex locations elsewhere in your nginx config.

```nginx
location ^~ /free-games/ {
    # auth_request /auth-1;   # optional Organizr / Authelia
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 7080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
}

location ^~ /free-games/novnc/ {
    # auth_request /auth-1;
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 6080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    rewrite /free-games/novnc/(.*) /$1 break;
}

# noVNC hard-codes its WebSocket at /websockify (origin root), so we expose it
# there too. Without this block the VNC viewer loads but can't connect.
location = /websockify {
    # auth_request /auth-1;
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 6080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
}
```

The `/novnc/` block strips the prefix via `rewrite` (not `proxy_pass` trailing
slash — that doesn't reliably pass subpaths in this setup) so noVNC sees
`/vnc.html`, `/app/styles/base.css`, etc. at the root path it expects. The
`/websockify` block handles the WebSocket upgrade — noVNC's JS hard-codes this
path relative to the origin root, so we proxy it there rather than fighting
the noVNC URL config. Your `proxy.conf` must pass `Upgrade` / `Connection`
headers for the WebSocket to work (SWAG's default `proxy.conf` already does).

### Proxy-specific gotchas

<details>
<summary><strong>Nginx Proxy Manager (NPM)</strong></summary>

NPM is GUI-driven — configuration lives in toggles on the proxy host's
**Details** tab rather than a config file. Two settings trip almost everyone up:

- **Asset Caching → off.** When on, NPM injects its `assets.conf` block
  (long `expires` + `Cache-Control: public, max-age=31536000`) into every
  location on the host. That caches noVNC's JS and CSS chain at the proxy
  edge and silently breaks the WebSocket bootstrap. Typical DevTools symptom:
  `vnc.html` 304, `base.css` 401, `websockify` 404. Confirmed cause in
  [#13](https://github.com/feldorn/free-games-claimer/issues/13).
- **WebSockets Support → on.** noVNC carries actual VNC traffic over a
  WebSocket upgrade at `/websockify`. Without this toggle NPM strips the
  upgrade headers and the viewer mounts but never connects.

Force SSL and HTTP/2 are fine to leave on.

**Pre-flight (any shape):** Confirm every hostname you use in `PUBLIC_URL` / `NOVNC_URL` / proxy-host config **actually resolves** to your proxy. For split-subdomain setups in particular it's easy to add the proxy host in NPM, point your env vars at it, and forget to create the DNS A/CNAME record — symptoms then look like a generic "noVNC won't load" but the real issue is that the request never reaches NPM. Quick check: `dig +short no-vnc.your-domain` (or whatever the noVNC hostname is) should return your proxy's IP. If it returns nothing, fix DNS before chasing toggles.

**By shape:**

- **Split-subdomain** — two proxy hosts. Panel host → port 7080. noVNC host
  → port 6080. No custom locations on either — the whole subdomain forwards
  straight to one port. Both subdomains need their own DNS records.
- **Subfolder** — works via NPM's **Custom locations** tab; mirror the
  SWAG/nginx example above (one location for `<base>/` → 7080, one for
  `<base>/novnc/` with a rewrite → 6080, one for `/websockify` → 6080).
  Walkthrough in [#13](https://github.com/feldorn/free-games-claimer/issues/13).
- **Subdomain (single host)** — one proxy host pointing at port 7080. noVNC
  embeds at `<host>:6080` directly, so port 6080 must be published and
  reachable from outside the proxy.

</details>
