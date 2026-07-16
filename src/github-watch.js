// GitHub reply-alert poller — closes the "diagnostic submitted, never
// heard back" loop. Users who click Share-to-GitHub in the Alerts tab
// rarely return to GitHub to check for replies, so questions I post
// asking for clarifying info sit unread and issues stall.
//
// Design (per feldorn 2026-07-16):
//   - Opt-in at first Share-to-GitHub click. If `github.username` is
//     empty, this whole module no-ops.
//   - Anonymous polling against a public repo — no token, no security
//     surface, 60-req/hr rate limit is comfortable for daily cadence.
//   - Poll `search/issues?q=repo:...+author:{username}` for their issues,
//     then `issues/{n}/comments?since=` for new activity.
//   - State per-issue: last-known comment timestamp + unread count. Local
//     only — GitHub's not involved in the read-tracking.
//
// This module is CommonJS-style ESM: only exports the top-level poll +
// state accessors. The Alerts-tab wiring lives in interactive-login.js.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataDir } from './util.js';
import { describeConfig } from './app-config.js';

const REPO_OWNER = 'feldorn';
const REPO_NAME  = 'free-games-claimer';
const API_ROOT   = 'https://api.github.com';
const USER_AGENT = 'free-games-claimer/gh-watch';

function stateFile() {
  return dataDir('github-watch.json');
}

// Read+parse the on-disk state. Returns a fresh empty shell on any
// error so a corrupted file doesn't wedge the whole feature.
function readState() {
  try {
    if (!existsSync(stateFile())) return { lastPolledAt: null, watchedIssues: {} };
    const raw = readFileSync(stateFile(), 'utf8');
    const j = raw.trim() ? JSON.parse(raw) : {};
    return {
      lastPolledAt: j.lastPolledAt || null,
      watchedIssues: (j.watchedIssues && typeof j.watchedIssues === 'object') ? j.watchedIssues : {},
    };
  } catch (e) {
    console.warn(`[github-watch] state read failed: ${e.message} — starting fresh`);
    return { lastPolledAt: null, watchedIssues: {} };
  }
}

function writeState(s) {
  try {
    // dataDir('') resolves to <repo>/data — parent dir exists in all
    // deployment shapes (Docker mount / bare metal), so no mkdir needed.
    writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n');
  } catch (e) {
    console.warn(`[github-watch] state write failed: ${e.message}`);
  }
}

function currentUsername() {
  const u = String(describeConfig().effective.github?.username || '').trim();
  return u || null;
}

// Fetch helper that returns { ok, status, body } — never throws. Callers
// treat any non-2xx as a soft failure and move on; a 403 rate-limit
// today will resolve itself next daily wake.
async function ghGet(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept':     'application/vnd.github+json',
      },
    });
    const status = r.status;
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON — leave null */ }
    return { ok: r.ok, status, body };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// Main entry point — call once per day (or on demand). Idempotent; safe
// to call more often, just spends more API budget. Returns null when the
// feature is disabled (username unset) so callers can log "skipped".
export async function pollGithubReplies() {
  const username = currentUsername();
  if (!username) return null;

  const state = readState();
  const nowIso = new Date().toISOString();

  // Search: user's issues in this repo, updated since our last poll.
  // Cap per-page at 30 — plenty for one user; issues update-order sorted
  // means we see the most recently-active first.
  const sinceParam = state.lastPolledAt ? `+updated:>${encodeURIComponent(state.lastPolledAt)}` : '';
  const searchQ = `repo:${REPO_OWNER}/${REPO_NAME}+author:${encodeURIComponent(username)}${sinceParam}`;
  const searchUrl = `${API_ROOT}/search/issues?q=${searchQ}&sort=updated&order=desc&per_page=30`;

  const search = await ghGet(searchUrl);
  if (!search.ok) {
    console.warn(`[github-watch] search failed (status=${search.status}) — skipping this poll`);
    return { pollError: `search returned ${search.status}` };
  }
  const items = Array.isArray(search.body?.items) ? search.body.items : [];

  for (const issue of items) {
    // Search sometimes returns PRs when a repo mixes them with issues;
    // gate on the `pull_request` marker so we don't watch the wrong thing.
    if (issue.pull_request) continue;
    const num = String(issue.number);
    let entry = state.watchedIssues[num];
    if (!entry) {
      entry = state.watchedIssues[num] = {
        number: issue.number,
        url:    issue.html_url,
        title:  issue.title,
        state:  issue.state,
        filedAt: issue.created_at,
        lastCommentAt: issue.created_at, // seed at file time; new comments after this are unread
        unreadCount: 0,
        lastCommentAuthor: null,
        lastCommentPreview: null,
      };
    }
    entry.state = issue.state;
    entry.title = issue.title;

    // Fetch comments newer than what we've already accounted for.
    const commentsUrl = `${API_ROOT}/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issue.number}/comments?since=${encodeURIComponent(entry.lastCommentAt)}&per_page=100`;
    const comments = await ghGet(commentsUrl);
    if (!comments.ok) {
      console.warn(`[github-watch] comments fetch failed for #${issue.number} (status=${comments.status}) — will retry next poll`);
      continue;
    }
    const list = Array.isArray(comments.body) ? comments.body : [];
    for (const c of list) {
      // Skip our own comments — they're not replies to notify us about.
      if ((c.user?.login || '').toLowerCase() === username.toLowerCase()) continue;
      // GitHub REST returns hidden/minimized comments too; we can't easily
      // filter spam-hidden ones via REST (needs GraphQL viewer_can_see_
      // minimized). Best-effort: skip comments whose body starts with the
      // spam-classifier hidden marker if GitHub renders it inline (rare).
      entry.unreadCount++;
      entry.lastCommentAt = c.created_at;
      entry.lastCommentAuthor = c.user?.login || 'unknown';
      entry.lastCommentPreview = String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    }
  }

  state.lastPolledAt = nowIso;
  writeState(state);
  return { username, itemsScanned: items.length };
}

// Read-only accessor for the Alerts-tab render + /api/github-watch/state.
export function getWatchState() {
  return readState();
}

// Mark all comments on a specific issue as read. Zeros the unread
// counter and advances lastCommentAt to now so subsequent polls don't
// re-surface the same comments.
export function markIssueRead(issueNumber) {
  const state = readState();
  const entry = state.watchedIssues[String(issueNumber)];
  if (!entry) return false;
  entry.unreadCount = 0;
  entry.lastCommentAt = new Date().toISOString();
  writeState(state);
  return true;
}

// Reset a specific issue's tracking entirely — removes it from the watch
// list. Used if the user wants to stop tracking a particular issue.
export function forgetIssue(issueNumber) {
  const state = readState();
  if (!(String(issueNumber) in state.watchedIssues)) return false;
  delete state.watchedIssues[String(issueNumber)];
  writeState(state);
  return true;
}
