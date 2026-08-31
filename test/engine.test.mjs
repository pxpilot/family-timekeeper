import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN, defaultConfig, defaultState, evaluate, credit, rollover, applyGrant,
  windowStatus, parseHM, siteOfUrl, dayKeyOf,
} from '../src/lib/engine.js';

// A fixed local wall time helper: build a Date from local components.
const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function fresh(now) {
  const config = defaultConfig();
  // Deterministic schedule for tests: every day 15:00–20:00.
  config.schedule.windows = Array.from({ length: 7 }, () => [['15:00', '20:00']]);
  config.sites.youtube.dailyMinutes = 45;
  config.sites.tiktok.dailyMinutes = 20;
  config.sites.instagram.dailyMinutes = 20;
  config.session = { maxMinutes: 20, breakMinutes: 10 };
  return { config, state: defaultState(now) };
}

test('parseHM accepts and rejects correctly', () => {
  assert.equal(parseHM('15:30'), 930);
  assert.equal(parseHM('00:00'), 0);
  assert.equal(parseHM('9:05'), 545);
  assert.equal(parseHM('24:00'), null);
  assert.equal(parseHM('12:60'), null);
  assert.equal(parseHM('nope'), null);
});

test('siteOfUrl maps hosts, and does not over-match lookalikes', () => {
  assert.equal(siteOfUrl('https://www.youtube.com/watch?v=x'), 'youtube');
  assert.equal(siteOfUrl('https://m.youtube.com/'), 'youtube');
  assert.equal(siteOfUrl('https://youtu.be/abc'), 'youtube');
  assert.equal(siteOfUrl('https://www.tiktok.com/@a/video/1'), 'tiktok');
  assert.equal(siteOfUrl('https://www.instagram.com/reels/'), 'instagram');
  assert.equal(siteOfUrl('https://notyoutube.com/'), null);
  assert.equal(siteOfUrl('https://youtube.com.evil.example/'), null);
  assert.equal(siteOfUrl('not a url'), null);
});

test('inside an allowed window with budget left, the site is allowed', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.remainingMs, 45 * MIN);
});

test('outside the window it is blocked, and reports the next opening', () => {
  const now = at(2026, 9, 1, 9, 0);
  const { config, state } = fresh(now);
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'outside_hours');
  assert.equal(r.resumesAt, at(2026, 9, 1, 15, 0));
});

test('after the window closes, next opening rolls to tomorrow', () => {
  const now = at(2026, 9, 1, 21, 30);
  const { config, state } = fresh(now);
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.reason, 'outside_hours');
  assert.equal(r.resumesAt, at(2026, 9, 2, 15, 0));
});

test('a day with no windows is blocked all day and skips to the next open day', () => {
  const now = at(2026, 9, 1, 16, 0); // Tuesday
  const { config, state } = fresh(now);
  config.schedule.windows[new Date(now).getDay()] = [];
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'outside_hours');
  assert.equal(r.resumesAt, at(2026, 9, 2, 15, 0));
});

test('boundary: allowed at the opening minute, blocked at the closing minute', () => {
  const { config, state } = fresh(at(2026, 9, 1, 15, 0));
  assert.equal(windowStatus(config, 'youtube', at(2026, 9, 1, 14, 59, 59)).inside, false);
  assert.equal(windowStatus(config, 'youtube', at(2026, 9, 1, 15, 0, 0)).inside, true);
  assert.equal(windowStatus(config, 'youtube', at(2026, 9, 1, 19, 59, 59)).inside, true);
  assert.equal(windowStatus(config, 'youtube', at(2026, 9, 1, 20, 0, 0)).inside, false);
});

test('spending the whole budget flips to daily_limit', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  // Feed it in 5-minute chunks with breaks long enough to avoid the session cap.
  let t = now;
  for (let i = 0; i < 9; i++) {
    credit(config, state, 'youtube', 5 * MIN, t);
    t += 15 * MIN; // gap >= breakMinutes resets the session counter
  }
  const r = evaluate(config, state, 'youtube', t);
  assert.equal(r.usedMs, 45 * MIN);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily_limit');
});

test('a continuous stretch past the session cap forces a break', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  let t = now;
  for (let i = 0; i < 4; i++) { t += 5 * MIN; credit(config, state, 'youtube', 5 * MIN, t); }
  const r = evaluate(config, state, 'youtube', t);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'on_break');
  assert.equal(r.resumesAt, t + 10 * MIN);
  // Budget is not consumed by the break itself.
  assert.equal(r.remainingMs, 25 * MIN);
  // Once the break elapses, it is allowed again.
  const after = evaluate(config, state, 'youtube', t + 10 * MIN + 1000);
  assert.equal(after.allowed, true);
});

test('a long enough gap resets the session counter so no break is forced', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  let t = now;
  for (let i = 0; i < 3; i++) { t += 5 * MIN; credit(config, state, 'youtube', 5 * MIN, t); }
  t += 12 * MIN; // longer than breakMinutes
  credit(config, state, 'youtube', 5 * MIN, t);
  assert.equal(evaluate(config, state, 'youtube', t).allowed, true);
  assert.equal(state.session.youtube.activeMs, 5 * MIN);
});

test('a grant restores access and clears an active forced break', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  let t = now;
  for (let i = 0; i < 4; i++) { t += 5 * MIN; credit(config, state, 'youtube', 5 * MIN, t); }
  assert.equal(evaluate(config, state, 'youtube', t).reason, 'on_break');
  applyGrant(state, 'youtube', 15);
  const r = evaluate(config, state, 'youtube', t);
  assert.equal(r.allowed, true);
  assert.equal(r.budgetMs, 60 * MIN);
});

test('grants do not survive midnight', () => {
  const now = at(2026, 9, 1, 19, 0);
  const { config, state } = fresh(now);
  applyGrant(state, 'youtube', 30);
  credit(config, state, 'youtube', 10 * MIN, now);
  const next = at(2026, 9, 2, 16, 0);
  rollover(state, next);
  const r = evaluate(config, state, 'youtube', next);
  assert.equal(r.usedMs, 0);
  assert.equal(r.budgetMs, 45 * MIN);
});

test('budget does not reset before midnight', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  credit(config, state, 'youtube', 40 * MIN, now);
  rollover(state, at(2026, 9, 1, 23, 59, 30));
  assert.equal(state.usageMs.youtube, 40 * MIN);
});

test('rolling the clock backwards does not hand out a fresh day', () => {
  const evening = at(2026, 9, 1, 19, 0);
  const { config, state } = fresh(evening);
  credit(config, state, 'youtube', 45 * MIN, evening);
  rollover(state, evening);
  assert.equal(evaluate(config, state, 'youtube', evening).reason, 'daily_limit');

  // Kid sets the clock back to yesterday morning.
  const cheat = at(2026, 8, 31, 8, 0);
  rollover(state, cheat);
  assert.equal(state.usageMs.youtube, 45 * MIN, 'usage must be preserved');
  assert.equal(state.dayKey, dayKeyOf(evening), 'day must not flip');
  assert.equal(state.clockAlarms, 1);
});

test('small backwards drift (NTP correction) is tolerated', () => {
  const now = at(2026, 9, 1, 19, 0);
  const { config, state } = fresh(now);
  credit(config, state, 'youtube', 10 * MIN, now);
  rollover(state, now);
  rollover(state, now - 30_000);
  assert.equal(state.clockAlarms, 0);
  assert.equal(state.usageMs.youtube, 10 * MIN);
});

test('a disabled site is always blocked, regardless of hours or budget', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  config.sites.tiktok.enabled = false;
  const r = evaluate(config, state, 'tiktok', now);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(r.remainingMs, 0);
});

test('per-site window override beats the global schedule', () => {
  const now = at(2026, 9, 1, 21, 0);
  const { config, state } = fresh(now);
  config.sites.youtube.windows = Array.from({ length: 7 }, () => [['20:30', '22:00']]);
  assert.equal(evaluate(config, state, 'youtube', now).allowed, true);
  assert.equal(evaluate(config, state, 'tiktok', now).allowed, false);
});

test('budgets are tracked independently per site', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  credit(config, state, 'tiktok', 20 * MIN, now);
  assert.equal(evaluate(config, state, 'tiktok', now).reason, 'daily_limit');
  assert.equal(evaluate(config, state, 'youtube', now).allowed, true);
});

test('`until` never runs past the window close', () => {
  const now = at(2026, 9, 1, 19, 45); // 15 min before close, 45 min of budget
  const { config, state } = fresh(now);
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.until, at(2026, 9, 1, 20, 0));
});

test('a zero-minute budget reads as daily_limit, not as allowed', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  config.sites.instagram.dailyMinutes = 0;
  assert.equal(evaluate(config, state, 'instagram', now).reason, 'daily_limit');
});

test('credit ignores non-positive deltas', () => {
  const now = at(2026, 9, 1, 16, 0);
  const { config, state } = fresh(now);
  credit(config, state, 'youtube', 0, now);
  credit(config, state, 'youtube', -5 * MIN, now);
  assert.equal(state.usageMs.youtube, 0);
});

test('DST spring-forward day still resolves a sane next opening', () => {
  // Israel moves to DST at 02:00 on the last Friday of March.
  const now = at(2027, 3, 26, 3, 0);
  const { config, state } = fresh(now);
  const r = evaluate(config, state, 'youtube', now);
  assert.equal(r.reason, 'outside_hours');
  assert.ok(r.resumesAt > now && r.resumesAt < now + 24 * 60 * MIN);
});
