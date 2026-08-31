// Family Timekeeper — policy engine.
// Pure functions only: no chrome.* here, so this file is unit-testable under node.

export const MIN = 60_000;

export const SITES = {
  youtube: {
    label: 'YouTube',
    // requestDomains for declarativeNetRequest (subdomains are matched automatically)
    domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    // extra domains that only ever carry embeds / player traffic
    embedDomains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    hostRe: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i,
  },
  tiktok: {
    label: 'TikTok',
    domains: ['tiktok.com'],
    embedDomains: ['tiktok.com'],
    hostRe: /(^|\.)tiktok\.com$/i,
  },
  instagram: {
    label: 'Instagram',
    domains: ['instagram.com'],
    embedDomains: ['instagram.com', 'cdninstagram.com'],
    hostRe: /(^|\.)instagram\.com$/i,
  },
};

export const SITE_KEYS = Object.keys(SITES);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Israeli school week: Sunday(0)–Thursday(4) are school days, Fri(5)/Sat(6) weekend.
const SCHOOL_DAY = [['15:30', '20:30']];
const WEEKEND_DAY = [['10:00', '21:00']];

export function defaultConfig() {
  return {
    version: 1,
    auth: { salt: null, hash: null }, // set on first run by the parent
    meterEmbeds: true,
    warnAtMinutes: [10, 5, 1],
    grantMaxMinutes: 60,
    session: { maxMinutes: 20, breakMinutes: 10 },
    schedule: {
      // index 0 = Sunday … 6 = Saturday
      windows: [
        SCHOOL_DAY, SCHOOL_DAY, SCHOOL_DAY, SCHOOL_DAY, SCHOOL_DAY,
        WEEKEND_DAY, WEEKEND_DAY,
      ],
    },
    sites: {
      youtube: { enabled: true, dailyMinutes: 45, windows: null },
      tiktok: { enabled: true, dailyMinutes: 20, windows: null },
      instagram: { enabled: true, dailyMinutes: 20, windows: null },
    },
  };
}

export function defaultState(now = Date.now()) {
  const s = {
    dayKey: dayKeyOf(now),
    usageMs: {},
    grantMs: {},
    session: {},
    nonce: null,
    lastWall: now,
    clockAlarms: 0,
    log: [],
  };
  for (const k of SITE_KEYS) {
    s.usageMs[k] = 0;
    s.grantMs[k] = 0;
    s.session[k] = { activeMs: 0, lastActive: 0, breakUntil: 0 };
  }
  return s;
}

// ---------------------------------------------------------------------------
// Time helpers (all local-time, which is what a kid actually experiences)
// ---------------------------------------------------------------------------

export function dayKeyOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseHM(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm).trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesIntoDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function windowsFor(config, siteKey, ts) {
  const site = config.sites[siteKey] || {};
  const dow = new Date(ts).getDay();
  const list = site.windows || config.schedule.windows;
  return (list && list[dow]) || [];
}

/** Is `ts` inside an allowed window? Returns {inside, opensAt|null, closesAt|null} */
export function windowStatus(config, siteKey, ts) {
  const wins = windowsFor(config, siteKey, ts);
  const nowMin = minutesIntoDay(ts);
  const base = startOfDay(ts);

  let closesAt = null;
  for (const [a, b] of wins) {
    const s = parseHM(a), e = parseHM(b);
    if (s === null || e === null || e <= s) continue;
    if (nowMin >= s && nowMin < e) {
      closesAt = base + e * MIN;
      return { inside: true, opensAt: null, closesAt };
    }
  }

  // Next opening: later today, else scan forward up to 7 days.
  for (let d = 0; d <= 7; d++) {
    const probe = base + d * 24 * 60 * MIN;
    const dayWins = windowsFor(config, siteKey, probe + 12 * 60 * MIN);
    for (const [a] of dayWins) {
      const s = parseHM(a);
      if (s === null) continue;
      const at = probe + s * MIN;
      if (at > ts) return { inside: false, opensAt: at, closesAt: null };
    }
  }
  return { inside: false, opensAt: null, closesAt: null };
}

// ---------------------------------------------------------------------------
// Day rollover + clock tamper guard
// ---------------------------------------------------------------------------

/**
 * Advances state to `now`. Resets counters on a real day change.
 * If the wall clock jumps backwards more than `tolMs`, we treat it as tampering:
 * counters are NOT reset and the event is recorded.
 * Mutates and returns state.
 */
export function rollover(state, now = Date.now(), tolMs = 5 * MIN) {
  const backwards = now < state.lastWall - tolMs;
  if (backwards) {
    state.clockAlarms = (state.clockAlarms || 0) + 1;
    state.log = (state.log || []).slice(-49);
    state.log.push({ t: state.lastWall, kind: 'clock_back', to: now });
    // Do not credit the kid with a fresh day; keep the old dayKey and usage.
    state.lastWall = Math.max(state.lastWall, now);
    return state;
  }
  const key = dayKeyOf(now);
  if (key !== state.dayKey) {
    state.dayKey = key;
    for (const k of SITE_KEYS) {
      state.usageMs[k] = 0;
      state.grantMs[k] = 0;
      state.session[k] = { activeMs: 0, lastActive: 0, breakUntil: 0 };
    }
  }
  state.lastWall = now;
  return state;
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * @returns {{allowed:boolean, reason:string, remainingMs:number, budgetMs:number,
 *            usedMs:number, until:number|null, resumesAt:number|null}}
 * reason ∈ ok | disabled | outside_hours | daily_limit | on_break
 */
export function evaluate(config, state, siteKey, now = Date.now()) {
  const site = config.sites[siteKey];
  const sess = state.session[siteKey] || { activeMs: 0, lastActive: 0, breakUntil: 0 };
  const budgetMs = Math.max(0, (site?.dailyMinutes || 0) * MIN) + (state.grantMs[siteKey] || 0);
  const usedMs = state.usageMs[siteKey] || 0;
  const remainingMs = Math.max(0, budgetMs - usedMs);
  const base = { remainingMs, budgetMs, usedMs, until: null, resumesAt: null };

  if (!site || !site.enabled) {
    return { ...base, allowed: false, reason: 'disabled', remainingMs: 0 };
  }

  // Several barriers can be up at once. Report the one that lasts longest —
  // telling a kid "back in 10 minutes" when the daily budget is gone is a lie.
  const w = windowStatus(config, siteKey, now);
  const blockers = [];
  if (!w.inside) blockers.push({ reason: 'outside_hours', resumesAt: w.opensAt });
  if (remainingMs <= 0) blockers.push({ reason: 'daily_limit', resumesAt: nextMidnight(now) });
  if (sess.breakUntil && now < sess.breakUntil) {
    blockers.push({ reason: 'on_break', resumesAt: sess.breakUntil });
  }
  if (blockers.length) {
    blockers.sort((a, b) => (b.resumesAt ?? Infinity) - (a.resumesAt ?? Infinity));
    return { ...base, allowed: false, ...blockers[0] };
  }
  // Allowed. `until` is the soonest of: budget exhaustion, window close, session cap.
  const capMs = Math.max(0, config.session.maxMinutes * MIN - sess.activeMs);
  const ends = [now + remainingMs, now + capMs];
  if (w.closesAt) ends.push(w.closesAt);
  return { ...base, allowed: true, reason: 'ok', until: Math.min(...ends) };
}

export function nextMidnight(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Credit `deltaMs` of focused, visible attention to a site.
 * Handles session accumulation and triggers a forced break when the cap is hit.
 * Mutates and returns state.
 */
export function credit(config, state, siteKey, deltaMs, now = Date.now()) {
  if (!(deltaMs > 0)) return state;
  const sess = state.session[siteKey];
  const breakMs = config.session.breakMinutes * MIN;
  const capMs = config.session.maxMinutes * MIN;

  // A gap at least as long as the required break resets the session counter.
  if (sess.lastActive && now - sess.lastActive >= breakMs) sess.activeMs = 0;

  state.usageMs[siteKey] = (state.usageMs[siteKey] || 0) + deltaMs;
  sess.activeMs += deltaMs;
  sess.lastActive = now;

  if (capMs > 0 && sess.activeMs >= capMs) {
    sess.breakUntil = now + breakMs;
    sess.activeMs = 0;
  }
  return state;
}

/** Add granted extra minutes to a site for the rest of today. */
export function applyGrant(state, siteKey, minutes) {
  state.grantMs[siteKey] = (state.grantMs[siteKey] || 0) + minutes * MIN;
  // A grant also forgives an in-progress forced break.
  if (state.session[siteKey]) state.session[siteKey].breakUntil = 0;
  return state;
}

/** Which host, if any, does this URL belong to? */
export function siteOfUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  for (const k of SITE_KEYS) if (SITES[k].hostRe.test(host)) return k;
  return null;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = dayKeyOf(Date.now());
  const stamp = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (dayKeyOf(ts) === today) return stamp;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[d.getDay()]} ${stamp}`;
}
