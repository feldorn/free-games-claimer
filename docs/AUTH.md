← [Back to README](../README.md)

# Authentication

Automatic login with 2FA, cookie-based session import, and the captcha-pause helper.

---

## Automatic Login / Two-Factor Authentication

If you set email, password, and OTP key, logins happen automatically without prompts. This is optional — sessions persist via cookies and should rarely need re-authentication.

To get OTP keys for automatic 2FA:
- **Epic Games**: [Password & Security](https://www.epicgames.com/account/password) → enable 'third-party authenticator app' → copy 'Manual Entry Key' → set `EG_OTPKEY`
- **Prime Gaming**: Amazon 'Your Account → Login & security' → 2-step verification → Manage → Add new app → 'Can't scan the barcode' → copy the bold key → set `PG_OTPKEY`
- **GOG**: Only offers OTP via email (no key to configure)
- **Steam**: Uses Steam Guard (5-character code prompted in terminal or via VNC)

> **Security note:** Storing passwords and OTP keys as environment variables in plain text is a security risk. Use unique/generated passwords.

---

## Cookie upload

Some sites are hostile to in-container browsers in ways no fingerprint shim can fully fix — AliExpress's AWSC slider, Cloudflare-gated stores, hardware-key MFA, etc. For those, **solve login on your desktop, export the cookies, and paste them into the panel**. The panel writes them into that site's persistent profile and re-runs the session check to confirm login took.

**One-time setup:**

1. Install [EditThisCookie](https://chromewebstore.google.com/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg) or [Cookie-Editor](https://cookie-editor.com/) in your everyday browser.
2. Log in to the target site (e.g. `aliexpress.com`) on your desktop, solve any captcha there.
3. Click the extension on the site's tab, **Export → JSON**, copy the result.
4. In the panel, click **Cookie** on the site's Sessions card, paste the JSON, **Apply**.

The panel applies the cookies to the site's persistent profile via Playwright's `addCookies`, then runs the same `checkLogin` probe the **Check** button uses. If the probe says "logged in", you're done — the next claim run uses the desktop's authenticated session. If the probe still says "not logged in", the cookies you exported probably scope to a different domain (some stores split auth across e.g. `accounts.example.com` and `www.example.com`); export from a tab on the exact domain the site logs into and try again.

**When to use this vs Login:**

- **Login button** — works everywhere the in-container Chromium can complete the flow. Cheapest path; use it first.
- **Cookie button** — fallback when in-container login fails for fingerprint or device-trust reasons. Currently the only practical path for AliExpress on accounts that escalate past the slider.

Cookie upload uses the same browser-busy mutex as Login / Check / Run, so it can't race a concurrent claim. Malformed JSON is rejected before it touches the profile dir.

---

## Captcha pause

> **New in 2.0.2 — feedback wanted.** Wired into GOG's login captcha so far; AliExpress slider and others to follow as we iterate.

When a script hits a captcha it can't auto-solve, it pauses for up to **10 minutes** waiting for you to solve it manually in the noVNC view, then either resumes (if you solved it) or moves on (if you didn't show up). The behaviour is per-service and adapts to whether you've been responding.

### What you see

A push notification arrives on whatever apprise targets are configured (`NOTIFY` env). The body includes the service, a short label for what's blocking, and a **deep link** to the panel:

```
gog captcha: Login captcha — solve now
https://your-panel.example.com/?focus=captcha
```

Tap the link → the panel opens directly to the Sessions tab with the side cards collapsed and the live noVNC iframe mounted, so the next thing you do is solve the slider / hCaptcha / whatever appeared. Solve it → the script detects the captcha is gone (it polls the page once a second) and resumes.

For this to work the panel must be reachable from your phone; set `PUBLIC_URL` (or `panel.publicUrl` in Settings) to the externally-reachable URL of the panel. Without it the notification still fires but won't include a clickable link.

If you're already on the panel when the captcha hits, a red banner appears at the top of *every tab* with the same click target. You don't have to be on Sessions tab to notice.

### What you get if you don't show up

If you don't solve within 10 minutes, the script gives up and **continues with the rest of the run**. You also get a *second* notification — the deferred form — that says "solve later when you can" with the same deep link, so the missed captcha doesn't disappear from your awareness:

```
gog captcha: Login captcha — solve later when you can
https://your-panel.example.com/?focus=captcha
```

The deep link still works any time later — clicking it just won't have anything to solve unless another captcha is currently active.

### Per-service behaviour

State is tracked per service (gog, epic, microsoft, …) and is independent across services. The relevant rules:

- **First captcha for a service in this run** → engagement: notification + 10-minute wait + poll.
- **Subsequent captcha, same service, after you solved the previous one** → engagement again (you've proven responsive — we'll keep asking).
- **Subsequent captcha, same service, after you missed the previous one** → no wait; deferred notification only. The run keeps moving so an absent user isn't holding up the rest of the queue.
- **Different service, fresh start** — independent of the above. GOG being abandoned doesn't affect Epic getting its first chance at engagement.
- **Next run** (scheduled or manual) — fresh state for every service. An absent user gets a new shot next cycle.

### Where it's wired in (2.0.2)

- **GOG** — login captcha (replaced the previous fire-and-forget `notify` with the pause/poll helper).

To add it to another script, see `awaitUserCaptchaSolve(page, opts)` in `src/util.js`. The caller supplies a `captchaCheck` async function that returns `true` while the captcha is on screen — so the helper can poll any site-specific selector.

### Known limitations

- Manual solve via noVNC works for sites that gate on **behaviour** (slide gesture, click challenge, etc.). Sites that gate on **fingerprint** (e.g. AliExpress in our testing) will reject the human-solved slide too because the bot detector fires on the container's browser fingerprint, not the slide itself. For those, [Cookie upload](#cookie-upload) — solve login on your desktop, export cookies, paste into the panel — is the practical workaround. v2.3.1 also persists AliExpress's fingerprint across runs to reduce device-instability flagging; further fingerprint work is tracked in [#2](https://github.com/feldorn/free-games-claimer/issues/2).
- The poll watches for the captcha element to *disappear* and treats that as "solved". Refreshing the page or navigating away also clears the element, so technically a false positive is possible — in practice the surrounding code re-checks login state right after, so a false positive just means we proceed to that check.
