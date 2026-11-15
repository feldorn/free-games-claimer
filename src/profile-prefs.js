// Chromium profile tweaks applied before launchPersistentContext.
// Zero local imports so tests can load it without the util/config cycle.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';

/**
 * Make a persistent profile keep session cookies (no expiry) across launches.
 *
 * Epic stores EPIC_SSO_RM and EPIC_SESSION_AP as session cookies on some
 * accounts. Chromium deletes session cookies at startup unless the profile is
 * set to "Continue where you left off" (session.restore_on_startup = 1), so
 * every run after a panel login got a 401 from Epic (#183). That setting also
 * restores the previous run's tabs, which piled up launch after launch, so
 * Default/Sessions is replaced by an empty FILE: Chromium can't save tabs
 * there, and the session cookies still survive.
 *
 * Best effort: never throws. Leaves an unreadable Preferences file alone.
 *
 * @param {string} profileDir
 * @returns {{ changed: boolean, error?: string }}
 */
export function keepSessionCookies(profileDir) {
  try {
    const def = path.join(profileDir, 'Default');
    mkdirSync(def, { recursive: true });
    let changed = false;

    const prefPath = path.join(def, 'Preferences');
    let prefs = {};
    if (existsSync(prefPath)) {
      try { prefs = JSON.parse(readFileSync(prefPath, 'utf8')); } catch (e) {
        return { changed: false, error: `Preferences unreadable (${e.message})` };
      }
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
        return { changed: false, error: 'Preferences is not a JSON object' };
      }
    }
    if (prefs.session?.restore_on_startup !== 1) {
      prefs.session = { ...(prefs.session && typeof prefs.session === 'object' ? prefs.session : {}), restore_on_startup: 1 };
      writeFileSync(prefPath, JSON.stringify(prefs));
      changed = true;
    }

    const sessions = path.join(def, 'Sessions');
    const st = existsSync(sessions) ? statSync(sessions) : null;
    if (!st || st.isDirectory()) {
      if (st) rmSync(sessions, { recursive: true, force: true });
      writeFileSync(sessions, '');
      changed = true;
    }
    return { changed };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}
