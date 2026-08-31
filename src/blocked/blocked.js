import { fmtDuration, fmtClock, MIN } from '../lib/engine.js';

const site = new URLSearchParams(location.search).get('site') || 'youtube';
const $ = (id) => document.getElementById(id);

const COPY = {
  outside_hours: { glyph: '🌙', head: 'Not right now', line: (s) => `${s.label} opens again at ${fmtClock(s.resumesAt)}.` },
  daily_limit: { glyph: '⏳', head: "That's today's time", line: (s) => `You used all ${Math.round(s.budgetMs / MIN)} minutes. Fresh budget at midnight.` },
  on_break: { glyph: '☕', head: 'Break time', line: (s) => `Back in ${fmtDuration(s.resumesAt - Date.now())}. Stretch, get some water.` },
  disabled: { glyph: '🚫', head: 'Turned off', line: (s) => `${s.label} is switched off on this laptop.` },
  ok: { glyph: '✅', head: 'You’re good', line: () => 'This site is available — reload the page.' },
};

let current = null;

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: 'status' });
  const s = r.status[site];
  current = s;
  const c = COPY[s.reason] || COPY.daily_limit;

  $('glyph').textContent = c.glyph;
  $('headline').textContent = c.head;
  $('reason').textContent = c.line(s);
  document.title = `${s.label} — paused`;

  const rows = [];
  if (s.resumesAt) rows.push(['Available again', fmtClock(s.resumesAt)]);
  rows.push(['Used today', fmtDuration(s.usedMs)]);
  rows.push(["Today's budget", fmtDuration(s.budgetMs)]);
  $('meta').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  const others = Object.values(r.status).filter((x) => x.key !== site);
  $('others').innerHTML = others
    .map((x) => `<div><span>${x.label}</span><b>${x.allowed ? `${fmtDuration(x.remainingMs)} left` : 'paused'}</b></div>`)
    .join('');

  const canAsk = s.reason === 'daily_limit' || s.reason === 'on_break';
  $('ask').hidden = !canAsk;

  const sel = $('minutes');
  if (!sel.options.length) {
    const max = r.config.grantMaxMinutes || 60;
    for (const m of [5, 10, 15, 20, 30, 45, 60].filter((m) => m <= max)) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = `${m} minutes`;
      sel.append(o);
    }
    sel.value = '15';
  }
}

$('askBtn').addEventListener('click', async () => {
  $('askPanel').hidden = false;
  $('askBtn').hidden = true;
  const r = await chrome.runtime.sendMessage({ type: 'challenge', site });
  $('challenge').textContent = r.challenge;
});

$('redeem').addEventListener('click', async () => {
  const btn = $('redeem');
  const err = $('err');
  err.hidden = true;
  btn.disabled = true;
  const r = await chrome.runtime.sendMessage({
    type: 'redeem', site, minutes: $('minutes').value, code: $('code').value,
  });
  btn.disabled = false;
  if (r?.ok) {
    location.replace(`https://${site === 'youtube' ? 'www.youtube.com' : `www.${site}.com`}/`);
  } else {
    err.textContent = r?.error || 'Something went wrong.';
    err.hidden = false;
    $('code').value = '';
    $('code').focus();
  }
});

$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

refresh();
setInterval(refresh, 20_000);
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'tk:status') refresh(); });
