import { SITES, SITE_KEYS, MIN, fmtDuration, parseHM } from '../lib/engine.js';

const $ = (id) => document.getElementById(id);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let config = null;

function show(pane) {
  for (const id of ['enroll', 'lock', 'app']) $(id).hidden = id !== pane;
}

async function boot() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  if (!s.enrolled) { show('enroll'); return; }
  const g = await chrome.runtime.sendMessage({ type: 'getConfig' });
  if (g.ok) { config = g.config; show('app'); paint(); } else { show('lock'); $('pw').focus(); }
}

$('enrollBtn').addEventListener('click', async () => {
  const a = $('p1').value, b = $('p2').value;
  const err = $('enrollErr');
  err.hidden = true;
  if (a !== b) { err.textContent = "Those don't match."; err.hidden = false; return; }
  const r = await chrome.runtime.sendMessage({ type: 'enroll', passphrase: a });
  if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
  await chrome.runtime.sendMessage({ type: 'unlock', passphrase: a });
  boot();
});

$('unlockBtn').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'unlock', passphrase: $('pw').value });
  if (r.ok) boot();
  else { $('lockErr').textContent = 'Wrong passphrase.'; $('lockErr').hidden = false; }
});
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlockBtn').click(); });

function paint() {
  $('budgets').innerHTML = SITE_KEYS.map((k) => `
    <tr>
      <td>${SITES[k].label}</td>
      <td><input type="checkbox" data-en="${k}" ${config.sites[k].enabled ? 'checked' : ''}> on</td>
      <td><input type="number" min="0" max="600" data-min="${k}" value="${config.sites[k].dailyMinutes}"><span class="unit">min/day</span></td>
    </tr>`).join('');

  $('schedule').innerHTML = DAYS.map((d, i) => `
    <tr>
      <td>${d}</td>
      <td><input type="text" data-day="${i}" value="${fmtWindows(config.schedule.windows[i])}" placeholder="15:30-20:30"></td>
    </tr>`).join('');

  $('sMax').value = config.session.maxMinutes;
  $('sBreak').value = config.session.breakMinutes;
  $('gMax').value = config.grantMaxMinutes;
  $('mEmb').checked = config.meterEmbeds !== false;

  $('qSite').innerHTML = SITE_KEYS.map((k) => `<option value="${k}">${SITES[k].label}</option>`).join('');
  $('qMins').innerHTML = [5, 10, 15, 20, 30, 45, 60].map((m) => `<option value="${m}">${m} min</option>`).join('');
  $('qMins').value = '15';

  paintStatus();
}

function fmtWindows(w) {
  return (w || []).map(([a, b]) => `${a}-${b}`).join(', ');
}

function parseWindows(text) {
  const out = [];
  for (const chunk of String(text).split(',')) {
    const t = chunk.trim();
    if (!t) continue;
    const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(t);
    if (!m) throw new Error(`"${t}" isn't a time range like 15:30-20:30`);
    const a = parseHM(m[1]), b = parseHM(m[2]);
    if (a === null || b === null) throw new Error(`"${t}" isn't a valid time`);
    if (b <= a) throw new Error(`"${t}" ends before it starts`);
    out.push([m[1].padStart(5, '0'), m[2].padStart(5, '0')]);
  }
  return out;
}

async function paintStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'status' });
  $('todayLine').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  $('status').innerHTML = Object.values(r.status).map((s) => {
    const cls = !s.allowed ? 's-bad' : s.remainingMs < 5 * MIN ? 's-warn' : 's-ok';
    const detail = s.allowed
      ? `${fmtDuration(s.remainingMs)} left`
      : ({ outside_hours: 'outside hours', daily_limit: 'budget spent', on_break: 'on break', disabled: 'off' })[s.reason];
    return `<div class="${cls}"><span>${s.label} · used ${fmtDuration(s.usedMs)}</span><b>${detail}</b></div>`;
  }).join('');
}

$('qGrant').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'grantNow', site: $('qSite').value, minutes: +$('qMins').value });
  paintStatus();
});

$('qReset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resetToday' });
  paintStatus();
});

$('save').addEventListener('click', async () => {
  try {
    for (const k of SITE_KEYS) {
      config.sites[k].enabled = document.querySelector(`[data-en="${k}"]`).checked;
      config.sites[k].dailyMinutes = Math.max(0, +document.querySelector(`[data-min="${k}"]`).value || 0);
    }
    config.schedule.windows = DAYS.map((_, i) => parseWindows(document.querySelector(`[data-day="${i}"]`).value));
    config.session.maxMinutes = Math.max(1, +$('sMax').value || 20);
    config.session.breakMinutes = Math.max(1, +$('sBreak').value || 10);
    config.grantMaxMinutes = Math.max(5, +$('gMax').value || 60);
    config.meterEmbeds = $('mEmb').checked;
  } catch (e) {
    alert(e.message);
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'setConfig', config });
  if (!r.ok) { alert(r.error === 'locked' ? 'Session timed out — reload and unlock again.' : r.error); return; }
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 2200);
  paintStatus();
});

boot();
setInterval(() => { if (!$('app').hidden) paintStatus(); }, 15_000);
