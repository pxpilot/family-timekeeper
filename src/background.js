// Family Timekeeper — service worker.
// Owns the clock, the storage, the block rules, and the grant flow.

import {
  SITES, SITE_KEYS, MIN, defaultConfig, defaultState, rollover, evaluate,
  credit, applyGrant, siteOfUrl, nextMidnight,
} from './lib/engine.js';
import { verifyPassphrase, hashPassphrase, newChallenge, randomHex } from './lib/crypto.js';

const RULE_MAIN = 1000;
const RULE_SUB = 2000;
const BEAT_MAX_MS = 8_000;      // never credit more than this per heartbeat
const NONCE_TTL_MS = 15 * MIN;

let cache = null;               // { config, state }
let loading = null;
let idleState = 'active';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function load() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    const got = await chrome.storage.local.get(['config', 'state']);
    const config = mergeConfig(got.config);
    const state = mergeState(got.state);
    rollover(state, Date.now());
    cache = { config, state };
    loading = null;
    return cache;
  })();
  return loading;
}

function mergeConfig(stored) {
  const base = defaultConfig();
  if (!stored) return base;
  const out = { ...base, ...stored };
  out.auth = { ...base.auth, ...(stored.auth || {}) };
  out.session = { ...base.session, ...(stored.session || {}) };
  out.schedule = { ...base.schedule, ...(stored.schedule || {}) };
  out.sites = { ...base.sites };
  for (const k of SITE_KEYS) out.sites[k] = { ...base.sites[k], ...((stored.sites || {})[k] || {}) };
  return out;
}

function mergeState(stored) {
  const base = defaultState();
  if (!stored) return base;
  const out = { ...base, ...stored };
  out.usageMs = { ...base.usageMs, ...(stored.usageMs || {}) };
  out.grantMs = { ...base.grantMs, ...(stored.grantMs || {}) };
  out.session = { ...base.session };
  for (const k of SITE_KEYS) out.session[k] = { ...base.session[k], ...((stored.session || {})[k] || {}) };
  return out;
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (cache) await chrome.storage.local.set({ state: cache.state });
  }, 2_000);
}

async function saveNow() {
  if (!cache) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await chrome.storage.local.set({ config: cache.config, state: cache.state });
}

// ---------------------------------------------------------------------------
// Block rules
// ---------------------------------------------------------------------------

function statusAll(now = Date.now()) {
  const { config, state } = cache;
  const out = {};
  for (const k of SITE_KEYS) out[k] = { key: k, label: SITES[k].label, ...evaluate(config, state, k, now) };
  return out;
}

async function syncRules() {
  const st = statusAll();
  const add = [];
  SITE_KEYS.forEach((k, i) => {
    if (st[k].allowed) return;
    add.push({
      id: RULE_MAIN + i,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { extensionPath: `/src/blocked/blocked.html?site=${k}` },
      },
      condition: { requestDomains: SITES[k].domains, resourceTypes: ['main_frame'] },
    });
    add.push({
      id: RULE_SUB + i,
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: SITES[k].embedDomains,
        resourceTypes: ['sub_frame', 'media', 'xmlhttprequest', 'script'],
      },
    });
  });
  const removeRuleIds = SITE_KEYS.flatMap((_, i) => [RULE_MAIN + i, RULE_SUB + i]);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: add });
  return st;
}

async function bounceOpenTabs(st) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const t of tabs) {
    if (!t.url || !t.id) continue;
    const k = siteOfUrl(t.url);
    if (!k || st[k].allowed) continue;
    try {
      await chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`src/blocked/blocked.html?site=${k}`) });
    } catch { /* tab gone */ }
  }
}

async function broadcast(st) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, { type: 'tk:status', status: st }).catch(() => {});
  }
}

async function refresh({ bounce = true } = {}) {
  await load();
  rollover(cache.state, Date.now());
  const st = await syncRules();
  if (bounce) await bounceOpenTabs(st);
  await updateBadge(st);
  broadcast(st);
  saveSoon();
  return st;
}

async function updateBadge(st) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const k = tab?.url ? siteOfUrl(tab.url) : null;
    if (!k) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const s = st[k];
    const text = s.allowed ? String(Math.ceil(s.remainingMs / MIN)) : '×';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({
      color: !s.allowed ? '#b42318' : s.remainingMs < 5 * MIN ? '#b54708' : '#175cd3',
    });
  } catch { /* no window */ }
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

const beats = new Map(); // port -> { site, last }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tk') return;
  beats.set(port, { site: null, last: 0 });
  port.onDisconnect.addListener(() => beats.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'beat') return;
    await load();
    const now = Date.now();
    rollover(cache.state, now);
    const rec = beats.get(port);
    if (!rec) return;
    const site = msg.site;
    const focused = !!msg.active && idleState === 'active';

    if (rec.site === site && rec.last && focused) {
      const delta = Math.min(now - rec.last, BEAT_MAX_MS);
      if (delta > 0) {
        const before = evaluate(cache.config, cache.state, site, now).allowed;
        credit(cache.config, cache.state, site, delta, now);
        const after = evaluate(cache.config, cache.state, site, now).allowed;
        saveSoon();
        if (before && !after) { await refresh(); return; }
      }
    }
    rec.site = site;
    rec.last = focused ? now : 0;

    const st = statusAll(now);
    try { port.postMessage({ type: 'tk:status', status: st }); } catch {}
    updateBadge(st);
  });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const handlers = {
  async status() {
    await load();
    rollover(cache.state, Date.now());
    return { status: statusAll(), config: publicConfig(), enrolled: !!cache.config.auth.hash };
  },

  async challenge({ site }) {
    await load();
    const now = Date.now();
    const cur = cache.state.nonce;
    if (!cur || cur.site !== site || now > cur.expiresAt) {
      cache.state.nonce = { value: newChallenge(), site, expiresAt: now + NONCE_TTL_MS };
      await saveNow();
    }
    return { challenge: cache.state.nonce.value, expiresAt: cache.state.nonce.expiresAt };
  },

  async redeem({ site, minutes, code }) {
    await load();
    const now = Date.now();
    const n = cache.state.nonce;
    minutes = Math.max(1, Math.min(cache.config.grantMaxMinutes, parseInt(minutes, 10) || 0));
    if (!n || n.site !== site || now > n.expiresAt) return { ok: false, error: 'Code request expired — ask again.' };
    if ((cache.state.redeemFails || 0) >= 8) return { ok: false, error: 'Too many wrong codes. Try again after the next reset.' };

    const ok = await checkGrantCode(n.value, site, minutes, String(code || '').trim());
    if (!ok) {
      cache.state.redeemFails = (cache.state.redeemFails || 0) + 1;
      await saveNow();
      return { ok: false, error: 'That code is not right.' };
    }
    applyGrant(cache.state, site, minutes);
    cache.state.nonce = null;
    cache.state.redeemFails = 0;
    await saveNow();
    await refresh({ bounce: false });
    return { ok: true, minutes };
  },

  async enroll({ passphrase }) {
    await load();
    if (cache.config.auth.hash) return { ok: false, error: 'Already set up.' };
    if (!passphrase || passphrase.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
    const salt = randomHex(16);
    cache.config.auth = { salt, hash: await hashPassphrase(passphrase, salt) };
    cache.config.verifier = await buildVerifier(passphrase);
    await saveNow();
    return { ok: true };
  },

  async unlock({ passphrase }) {
    await load();
    const ok = await verifyPassphrase(passphrase, cache.config.auth);
    if (ok) unlockedUntil = Date.now() + 10 * MIN;
    return { ok };
  },

  async getConfig() {
    await load();
    if (Date.now() > unlockedUntil) return { ok: false, error: 'locked' };
    return { ok: true, config: cache.config, state: cache.state };
  },

  async setConfig({ config }) {
    await load();
    if (Date.now() > unlockedUntil) return { ok: false, error: 'locked' };
    const keep = cache.config.auth;
    const keepV = cache.config.verifier;
    cache.config = mergeConfig({ ...config, auth: keep, verifier: keepV });
    await saveNow();
    await refresh();
    return { ok: true };
  },

  async grantNow({ site, minutes }) {
    await load();
    if (Date.now() > unlockedUntil) return { ok: false, error: 'locked' };
    applyGrant(cache.state, site, Math.max(1, parseInt(minutes, 10) || 0));
    await saveNow();
    await refresh({ bounce: false });
    return { ok: true };
  },

  async resetToday() {
    await load();
    if (Date.now() > unlockedUntil) return { ok: false, error: 'locked' };
    cache.state = defaultState(Date.now());
    await saveNow();
    await refresh({ bounce: false });
    return { ok: true };
  },
};

let unlockedUntil = 0;

// The verifier lets the worker check a grant code without holding the passphrase.
// It stores HMAC material derived from the passphrase at enrollment time.
async function buildVerifier(passphrase) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('family-timekeeper/v1/grant'), iterations: 200_000, hash: 'SHA-256' },
    base, 256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkGrantCode(challenge, site, minutes, code) {
  await load();
  const hex = cache.config.verifier;
  if (!hex) return false;
  const raw = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = new TextEncoder().encode(`${String(challenge).toUpperCase()}|${site}|${minutes}`);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const n = ((sig[0] & 0x7f) << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3];
  const expect = String(n % 1_000_000).padStart(6, '0');
  return expect === code;
}

function publicConfig() {
  const c = cache.config;
  return {
    warnAtMinutes: c.warnAtMinutes,
    grantMaxMinutes: c.grantMaxMinutes,
    session: c.session,
    meterEmbeds: c.meterEmbeds,
    sites: c.sites,
    schedule: c.schedule,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await load();
  await saveNow();
  await refresh();
  if (details.reason === 'install' && !cache.config.auth.hash) {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => refresh());

chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') refresh(); });

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((s) => { idleState = s; });

chrome.tabs.onActivated.addListener(async () => { await load(); updateBadge(statusAll()); });
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'loading' || !tab.url) return;
  const k = siteOfUrl(tab.url);
  if (!k) return;
  await load();
  rollover(cache.state, Date.now());
  const st = statusAll();
  if (!st[k].allowed) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`src/blocked/blocked.html?site=${k}`) }).catch(() => {});
  }
  updateBadge(st);
});

// Re-arm at the next midnight so the day flips even if the machine sleeps through it.
(async () => {
  await load();
  chrome.alarms.create('midnight', { when: nextMidnight(Date.now()) + 2000 });
})();
