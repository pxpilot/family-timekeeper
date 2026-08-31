// Runs on youtube / tiktok / instagram pages: meters focused attention and
// shows the countdown + warnings.
(() => {
  const SITE_RE = [
    ['youtube', /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i],
    ['tiktok', /(^|\.)tiktok\.com$/i],
    ['instagram', /(^|\.)instagram\.com$/i],
  ];
  const site = (SITE_RE.find(([, re]) => re.test(location.hostname)) || [])[0];
  if (!site) return;

  const BEAT_MS = 5_000;
  let port = null;
  let pill = null;
  let warned = new Set();
  let warnAt = [10, 5, 1];

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'tk' });
      port.onMessage.addListener((m) => { if (m?.type === 'tk:status') render(m.status[site]); });
      port.onDisconnect.addListener(() => { port = null; });
    } catch { port = null; }
  }

  function beat() {
    if (!port) connect();
    if (!port) return;
    const active = document.visibilityState === 'visible' && document.hasFocus();
    try { port.postMessage({ type: 'beat', site, active }); } catch { port = null; }
  }

  function fmt(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(t / 60), s = t % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function ensurePill() {
    if (pill && document.documentElement.contains(pill)) return pill;
    pill = document.createElement('div');
    pill.id = 'tk-pill';
    pill.setAttribute('role', 'status');
    (document.body || document.documentElement).appendChild(pill);
    return pill;
  }

  function render(s) {
    if (!s) return;
    if (!s.allowed) {
      location.replace(chrome.runtime.getURL(`src/blocked/blocked.html?site=${site}`));
      return;
    }
    const left = Math.min(s.remainingMs, Math.max(0, (s.until || 0) - Date.now()) || s.remainingMs);
    const el = ensurePill();
    el.textContent = `${s.label} · ${fmt(left)} left`;
    el.dataset.level = left < 60_000 ? 'red' : left < 5 * 60_000 ? 'amber' : 'ok';

    const mins = Math.ceil(left / 60_000);
    for (const w of warnAt) {
      if (mins === w && !warned.has(w)) { warned.add(w); toast(`${w} minute${w > 1 ? 's' : ''} left on ${s.label}.`); }
    }
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'tk-toast';
    t.textContent = text;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => t.classList.add('tk-in'), 20);
    setTimeout(() => { t.classList.remove('tk-in'); setTimeout(() => t.remove(), 400); }, 5_000);
  }

  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'tk:status') render(m.status[site]); });

  chrome.runtime.sendMessage({ type: 'status' }).then((r) => {
    if (r?.config?.warnAtMinutes) warnAt = r.config.warnAtMinutes;
    render(r?.status?.[site]);
  }).catch(() => {});

  connect();
  beat();
  setInterval(beat, BEAT_MS);
  window.addEventListener('focus', beat);
  document.addEventListener('visibilitychange', beat);
})();
