# Family Timekeeper

A Chrome extension (Manifest V3) that puts YouTube, TikTok and Instagram on a leash: per-site daily
minute budgets, allowed-hours windows per weekday, a cap on how long one sitting can run, and the same
rules applied to embeds of those sites on every other page.

Built to be force-installed by Windows policy, so it can't be switched off from `chrome://extensions`.
See **INSTALL.md** for setup.

## How it decides

`src/lib/engine.js` is the whole policy, as pure functions with no `chrome.*` in sight — which is why it
can be unit-tested under plain node. Everything else is plumbing around it.

A site is blocked if any of these is true, and the block page reports whichever barrier lasts *longest*
(telling a kid "back in 10 minutes" when the day's budget is gone would be a lie):

| Barrier | Clears at |
|---|---|
| `disabled` — switched off in settings | never, until you change it |
| `outside_hours` — no allowed window covers now | the next window opening |
| `daily_limit` — budget plus any grants is spent | local midnight |
| `on_break` — one sitting ran past the session cap | end of the break |

## How it counts

The content script on a managed page opens a long-lived port to the service worker and sends a heartbeat
every 5 seconds carrying `visibilityState === 'visible' && document.hasFocus()`. The worker bills the
elapsed time between heartbeats, capped at 8 seconds so a suspended worker can't be charged for an hour.
Only one document can hold focus at a time, so multiple open tabs can't double-bill. `chrome.idle` is a
second guard for a machine that walked away.

Embeds are metered by the same protocol from `embeds.js`, but only while the embed is at least half in
the viewport and the page has focus. That's a proxy, not a truth — turn it off in settings if it feels
unfair.

## How it blocks

Dynamic `declarativeNetRequest` rules, rebuilt whenever the state changes:

- `main_frame` requests to a blocked site redirect to `src/blocked/blocked.html`
- `sub_frame` / `media` / `script` requests to a blocked site's domains are dropped, which kills embeds
  at the network layer; `embeds.js` then swaps the dead iframe for a placeholder card so the page doesn't
  just show a hole

The rules persist across service-worker restarts, so the failure mode is *blocked*, not *open*.

## Extra time, without a server

The kid's block page shows a 6-character challenge. The parent opens `tools/parent-code.html` on their
own phone, types the challenge plus the site and minutes plus their passphrase, and reads back six
digits: `HMAC-SHA256(PBKDF2(passphrase), "CHALLENGE|site|minutes")`, truncated. The worker holds only the
derived key, never the passphrase. A code is bound to one challenge, one site and one minute count, dies
on use, and expires after 15 minutes. Nothing talks to a network.

## Tamper resistance

- Force-installed by policy: no Remove button, no disable toggle
- Settings gated by a PBKDF2-hashed passphrase (200k iterations), 10-minute unlocked session
- Winding the system clock backwards more than 5 minutes does *not* grant a fresh day; it's recorded
  instead. Small NTP corrections are tolerated.
- Incognito, guest mode, extra profiles and other extensions are closed off by the same policy file

The honest limits — other browsers, his phone, an admin account — are covered at the end of INSTALL.md.

## Tests

```bash
node --test test/engine.test.mjs test/crypto.test.mjs   # 27 unit tests, no browser
node test/smoke.mjs                                     # 24 checks in a real Chromium
sudo node test/forceinstall.mjs                         # 9 checks on the install path
```

The **smoke test** drives the real extension: it enrolls a passphrase, saves settings, mints a grant code
the way the parent tool would, redeems it, proves a replay fails, and checks that focused time is billed
and unfocused time isn't.

The **force-install test** covers the part that only breaks in production. It serves `docs/` over HTTP
exactly as GitHub Pages does, writes a managed-policy file (the Linux equivalent of the Windows `.reg`),
launches Chromium with no `--load-extension` flag, and asserts that the browser fetched `update.xml`,
tagged the request `installedby=policy`, accepted the CRX3 signature, unpacked the advertised version, and
booted the service worker. It needs root to write `/etc/chromium/policies/managed`, which is the point:
a green run means the signing key, the extension ID, the update manifest and the policy all agree.

All three run in CI on every push (`.github/workflows/test.yml`).
