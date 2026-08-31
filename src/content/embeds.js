// Runs on every other site: replaces embedded YouTube / TikTok / Instagram
// players with a placeholder while that site is blocked, and (optionally)
// meters embed watching against the same budget.
(() => {
  const MATCHERS = [
    ['youtube', /(^|\/\/|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)(\/|$)/i],
    ['tiktok', /(^|\/\/|\.)tiktok\.com(\/|$)/i],
    ['instagram', /(^|\/\/|\.)instagram\.com(\/|$)/i],
  ];
  const LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

  let status = null;
  let meterEmbeds = true;
  let port = null;
  const visible = new Map(); // element -> site, for elements at least half on screen

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const site = e.target.dataset.tkSite;
      if (!site) continue;
      if (e.isIntersecting && e.intersectionRatio >= 0.5) visible.set(e.target, site);
      else visible.delete(e.target);
    }
  }, { threshold: [0, 0.5, 1] });

  function siteOf(node) {
    const src = node.getAttribute?.('src') || node.getAttribute?.('data-src') || '';
    if (src) {
      const hit = MATCHERS.find(([, re]) => re.test(src));
      if (hit) return hit[0];
    }
    const cls = node.className || '';
    if (typeof cls === 'string') {
      if (/tiktok-embed/.test(cls)) return 'tiktok';
      if (/instagram-media/.test(cls)) return 'instagram';
    }
    return null;
  }

  function placeholder(site, node) {
    const box = document.createElement('div');
    box.className = 'tk-embed-block';
    box.dataset.tkPlaceholder = site;
    const r = node.getBoundingClientRect?.();
    if (r && r.height > 40) box.style.minHeight = `${Math.round(r.height)}px`;
    const s = status?.[site];
    const when = s?.resumesAt ? new Date(s.resumesAt) : null;
    const p = (n) => String(n).padStart(2, '0');
    box.innerHTML =
      `<div class="tk-embed-inner">` +
      `<div class="tk-embed-title">${LABEL[site]} is paused</div>` +
      `<div class="tk-embed-sub">${when ? `Back at ${p(when.getHours())}:${p(when.getMinutes())}` : 'Time is up for today'}</div>` +
      `</div>`;
    return box;
  }

  function sweep() {
    const nodes = document.querySelectorAll(
      'iframe, blockquote.tiktok-embed, blockquote.instagram-media',
    );
    for (const node of nodes) {
      if (node.dataset.tkDone === '1') continue;
      const site = siteOf(node);
      if (!site) continue;
      node.dataset.tkSite = site;
      const blocked = status && status[site] && !status[site].allowed;
      if (blocked) {
        node.dataset.tkDone = '1';
        visible.delete(node);
        try { io.unobserve(node); } catch {}
        node.replaceWith(placeholder(site, node));
      } else if (meterEmbeds) {
        try { io.observe(node); } catch {}
      }
    }
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'tk' });
      port.onMessage.addListener((m) => { if (m?.type === 'tk:status') apply(m.status); });
      port.onDisconnect.addListener(() => { port = null; });
    } catch { port = null; }
  }

  function beat() {
    if (!meterEmbeds) return;
    if (!document.hasFocus() || document.visibilityState !== 'visible') { pulse(null, false); return; }
    const site = [...visible.values()][0] || null;
    pulse(site, !!site);
  }

  function pulse(site, active) {
    if (!site) return;
    if (!port) connect();
    if (!port) return;
    try { port.postMessage({ type: 'beat', site, active }); } catch { port = null; }
  }

  function apply(st) {
    status = st;
    sweep();
  }

  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'tk:status') apply(m.status); });

  chrome.runtime.sendMessage({ type: 'status' }).then((r) => {
    if (r?.config) meterEmbeds = r.config.meterEmbeds !== false;
    apply(r?.status);
  }).catch(() => {});

  const mo = new MutationObserver(() => sweep());
  const start = () => {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    sweep();
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  setInterval(beat, 5_000);
})();
