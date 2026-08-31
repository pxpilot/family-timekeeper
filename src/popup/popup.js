import { MIN, fmtDuration, fmtClock } from '../lib/engine.js';

const REASON = {
  outside_hours: 'outside hours',
  daily_limit: 'budget spent',
  on_break: 'on a break',
  disabled: 'switched off',
};

const r = await chrome.runtime.sendMessage({ type: 'status' });

document.getElementById('list').innerHTML = Object.values(r.status).map((s) => {
  const cls = !s.allowed ? 'bad' : s.remainingMs < 5 * MIN ? 'warn' : 'ok';
  const main = s.allowed ? fmtDuration(s.remainingMs) : REASON[s.reason];
  const note = s.allowed
    ? `used ${fmtDuration(s.usedMs)}`
    : s.resumesAt ? `back ${fmtClock(s.resumesAt)}` : '';
  return `<div class="r ${cls}"><span>${s.label}<br><span class="sub">${note}</span></span><b>${main}</b></div>`;
}).join('');

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
