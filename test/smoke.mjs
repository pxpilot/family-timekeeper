// Loads the unpacked extension into a real Chromium and checks that:
//  - the manifest parses and the extension registers
//  - the service worker boots with no uncaught errors
//  - defaults are persisted and block rules install
//  - the block page renders, settings save, and the grant flow round-trips
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
const PASS = 'test-passphrase-123';
const fails = [];
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() > end) return false;
    await sleep(250);
  }
}

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath: process.env.TK_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  bypassCSP: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});

const errors = [];
ctx.on('weberror', (e) => errors.push(String(e.error())));

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
sw.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const extId = new URL(sw.url()).host;
ok('service worker started', !!sw, extId);

const stored = await until(async () => {
  const got = await sw.evaluate(() => chrome.storage.local.get(['config', 'state']));
  return got?.config?.sites?.youtube && got?.state?.dayKey;
});
ok('defaults persisted to storage', stored);

const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
ok('dynamic block rules installed', Array.isArray(rules) && rules.length > 0, `${rules.length} rules`);
const mainRule = rules.find((r) => r.action?.type === 'redirect');
ok('main-frame rule redirects to the block page',
  !!mainRule && /blocked\.html/.test(mainRule.action.redirect.extensionPath || ''),
  mainRule?.action?.redirect?.extensionPath);
const subRule = rules.find((r) => r.action?.type === 'block');
ok('sub-frame rule blocks embeds',
  !!subRule && subRule.condition.resourceTypes.includes('sub_frame'),
  subRule?.condition?.requestDomains?.join(','));

// --- block page ------------------------------------------------------------
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/src/blocked/blocked.html?site=tiktok`);
ok('block page renders', await until(async () => (await page.textContent('#headline'))?.trim()));
const head = (await page.textContent('#headline')).trim();
const reason = (await page.textContent('#reason')).trim();
ok('block page explains itself', /TikTok|minutes|midnight|opens|break/i.test(`${head} ${reason}`), `${head} / ${reason}`);
ok('block page lists the other sites', /YouTube/.test(await page.textContent('#others')));
await page.close();

// --- enrollment ------------------------------------------------------------
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/src/options/options.html`);
ok('options opens on the enrollment step', await until(() => opt.isVisible('#enroll')));
await opt.fill('#p1', PASS);
await opt.fill('#p2', PASS);
await opt.click('#enrollBtn');
ok('enrollment unlocks the settings pane', await until(() => opt.isVisible('#app'), 25_000));

// A wrong passphrase must not unlock a fresh session.
const wrong = await opt.evaluate((p) => chrome.runtime.sendMessage({ type: 'unlock', passphrase: p }), 'nope');
ok('a wrong passphrase is rejected', wrong?.ok === false);

// --- settings round-trip ---------------------------------------------------
await opt.evaluate(async () => {
  const g = await chrome.runtime.sendMessage({ type: 'getConfig' });
  const c = g.config;
  c.schedule.windows = Array.from({ length: 7 }, () => [['00:00', '23:59']]);
  c.sites.tiktok.dailyMinutes = 0;      // spent for the day
  c.sites.youtube.dailyMinutes = 45;
  await chrome.runtime.sendMessage({ type: 'setConfig', config: c });
});
const saved = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
ok('settings save and take effect', saved.status.tiktok.reason === 'daily_limit', saved.status.tiktok.reason);
ok('an unaffected site stays allowed', saved.status.youtube.allowed === true, saved.status.youtube.reason);

// --- grant round-trip ------------------------------------------------------
const grant = await opt.evaluate(async (pass) => {
  const ch = await chrome.runtime.sendMessage({ type: 'challenge', site: 'tiktok' });
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('family-timekeeper/v1/grant'), iterations: 200000, hash: 'SHA-256' }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${ch.challenge}|tiktok|15`)));
  const n = ((sig[0] & 0x7f) << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3];
  const code = String(n % 1000000).padStart(6, '0');
  const bad = await chrome.runtime.sendMessage({ type: 'redeem', site: 'tiktok', minutes: 15, code: '000000' });
  const wrongMins = await chrome.runtime.sendMessage({ type: 'redeem', site: 'tiktok', minutes: 30, code });
  const good = await chrome.runtime.sendMessage({ type: 'redeem', site: 'tiktok', minutes: 15, code });
  const replay = await chrome.runtime.sendMessage({ type: 'redeem', site: 'tiktok', minutes: 15, code });
  const after = await chrome.runtime.sendMessage({ type: 'status' });
  return { challenge: ch.challenge, bad, wrongMins, good, replay, tiktok: after.status.tiktok };
}, PASS);

ok('a challenge is issued', /^[A-Z2-9]{6}$/.test(grant.challenge || ''), grant.challenge);
ok('a wrong code is rejected', grant.bad?.ok === false, grant.bad?.error);
ok('a code minted for other minutes is rejected', grant.wrongMins?.ok === false);
ok('the right code is accepted', grant.good?.ok === true, JSON.stringify(grant.good));
ok('the code cannot be replayed', grant.replay?.ok === false, grant.replay?.error);
ok('the grant adds 15 minutes', grant.tiktok.budgetMs === 15 * 60000, `${grant.tiktok.budgetMs}ms`);
ok('the grant unblocks the site', grant.tiktok.allowed === true, grant.tiktok.reason);

// --- metering protocol -----------------------------------------------------
const meter = await opt.evaluate(async () => {
  const before = (await chrome.runtime.sendMessage({ type: 'status' })).status.youtube.usedMs;
  const port = chrome.runtime.connect({ name: 'tk' });
  const beat = (active) => port.postMessage({ type: 'beat', site: 'youtube', active });
  beat(true);
  await new Promise((r) => setTimeout(r, 1500));
  beat(true);
  await new Promise((r) => setTimeout(r, 400));
  const mid = (await chrome.runtime.sendMessage({ type: 'status' })).status.youtube.usedMs;

  // An unfocused beat must not be billed.
  beat(false);
  await new Promise((r) => setTimeout(r, 1500));
  beat(false);
  await new Promise((r) => setTimeout(r, 400));
  const end = (await chrome.runtime.sendMessage({ type: 'status' })).status.youtube.usedMs;
  port.disconnect();
  return { before, mid, end };
});
ok('focused time is billed to the site', meter.mid - meter.before >= 1200 && meter.mid - meter.before <= 2500,
  `${meter.mid - meter.before}ms billed`);
ok('unfocused time is not billed', meter.end === meter.mid, `${meter.end - meter.mid}ms leaked`);

// --- popup -----------------------------------------------------------------
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
ok('popup renders all three sites', await until(async () => {
  const t = await pop.textContent('#list');
  return /YouTube/.test(t) && /TikTok/.test(t) && /Instagram/.test(t);
}));

ok('no uncaught errors in the extension', errors.length === 0, errors.slice(0, 4).join(' | '));

await ctx.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} check(s) failed: ${fails.join(', ')}` : '\nAll smoke checks passed');
process.exit(fails.length ? 1 : 0);
