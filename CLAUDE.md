# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A Manifest V3 Chrome extension that limits a specific child's time on YouTube, TikTok and Instagram
on one Windows laptop. Not a product — a household tool with exactly one user (the parent, `pxpilot`)
and one subject. Optimise for *the parent can understand and repair this in six months*, not for
generality.

Force-installed via Windows registry policy so it cannot be disabled from `chrome://extensions`.
Hosted on GitHub Pages at `https://pxpilot.github.io/family-timekeeper/`.

## Layout

```
manifest.json          MV3 manifest. The "key" field pins the extension ID — never remove it.
src/lib/engine.js      All policy logic, as pure functions. No chrome.* here, ever.
src/lib/crypto.js      Passphrase hashing + grant-code derivation.
src/background.js      Service worker: storage, metering, DNR rules, message handlers.
src/content/tracker.js Runs on the three sites: heartbeats, countdown pill, warnings.
src/content/embeds.js  Runs everywhere else: neutralises embeds, meters embed viewing.
src/blocked/           The page a blocked navigation lands on, incl. the ask-for-time flow.
src/options/           Parent settings, gated by passphrase.
src/popup/             Toolbar popup: time left per site.
tools/parent-code.html Standalone offline generator for grant codes. Parent's device only.
install/               Signing, policy .reg files, configure script.
docs/                  GitHub Pages root: update.xml + the signed .crx.
test/                  Unit, smoke and force-install suites.
```

## Invariants — breaking any of these breaks the install

1. **`install/timekeeper-key.pem` is never committed.** It is in `.gitignore`. The extension ID is
   derived from it, so leaking it lets anyone sign a package carrying this ID. It lives only in the
   parent's local copy and their backup.
2. **`src/lib/engine.js` stays free of `chrome.*`.** That is what makes it testable under plain node.
   Anything needing browser APIs belongs in `background.js`.
3. **The grant-code derivation is duplicated in `src/lib/crypto.js` and `tools/parent-code.html`.**
   The parent tool must run standalone offline, so it cannot import. Change both together;
   `test/crypto.test.mjs` asserts they still agree.
4. **The service worker never stores the passphrase** — only `config.verifier`, the PBKDF2 output.
   Keep it that way.
5. **DNR rules must fail closed.** They are dynamic rules that persist across worker restarts, so a
   dead worker leaves the sites blocked rather than open. Do not move blocking into the worker's
   runtime path.
6. **Chrome only updates on a version increase.** Bump `manifest.json` `version` before repacking.
7. **Never edit or re-zip the `.crx`.** That invalidates the CRX3 signature. Always go through
   `install/pack_crx.py` (or `release.sh`).

## Commands

```bash
node --test test/engine.test.mjs test/crypto.test.mjs   # 27 unit tests, no browser
node test/smoke.mjs                                     # 24 checks, real Chromium
sudo node test/forceinstall.mjs                         # 9 checks, real policy install

./release.sh 1.0.1                                      # test + repack + sign into docs/
python3 install/configure.py --owner X --repo Y         # repoint every file at a new Pages URL
```

`TK_CHROME` overrides the Chromium binary path. All three suites run in CI (`.github/workflows/test.yml`).

## How the pieces actually work

**Deciding.** `evaluate(config, state, site, now)` returns one of `ok | disabled | outside_hours |
daily_limit | on_break`. When several barriers are up at once it deliberately reports the one that
*lasts longest* — saying "back in 10 minutes" when the daily budget is gone would be a lie to a child.
This is tested; don't "simplify" it back to first-match.

**Counting.** Content scripts open a long-lived port and heartbeat every 5s with
`visibilityState === 'visible' && document.hasFocus()`. The worker bills the gap between heartbeats,
capped at `BEAT_MAX_MS` (8s) so a suspended worker can't be charged for an hour. Only one document has
focus at a time, so multiple tabs can't double-bill. `chrome.idle` is a second guard.

**Blocking.** Dynamic `declarativeNetRequest` rules, rebuilt on every state change: `main_frame`
redirects to the block page, `sub_frame`/`media`/`script` to those domains are dropped (that's what
kills embeds at the network layer). `embeds.js` then swaps the dead iframe for a placeholder.

**Granting time.** Block page shows a 6-char challenge. Parent's offline tool computes
`HMAC-SHA256(PBKDF2(passphrase), "CHALLENGE|site|minutes")` truncated to 6 digits. One use, bound to
that site and minute count, 15-minute expiry, 8 wrong attempts then locked until reset.

**Anti-tamper.** `rollover()` refuses to grant a fresh day if the wall clock jumped backwards more than
5 minutes, and records the attempt in `state.log`. Small NTP corrections are tolerated.

## Gotchas discovered the hard way

- **Playwright's default flags break policy installs.** `--disable-extensions` blocks it outright and
  `--disable-background-networking` stops the updater ever fetching `update.xml`. Both fail *silently*.
  `test/forceinstall.mjs` drives Chromium directly and reads its log for this reason.
- **Navigating an automated page to a `chrome-extension://` URL under a policy install closes the page.**
  Don't try to assert via page automation there; assert on the log and the unpacked files.
- Chromium reads Linux policy from `/etc/chromium/policies/managed/`; Chrome from
  `/etc/opt/chrome/policies/managed/`. The test writes both.
- `pack_crx.py` excludes `docs/` from the zip, or the package would contain a copy of itself.
- The repo must stay **public** — Chrome fetches `update.xml` anonymously.

## Conventions

- Plain ES modules, no build step, no bundler, no dependencies at runtime. Playwright is a dev
  dependency for tests only. Keep it that way — the parent has to be able to read this code.
- Comments explain *why*, not what. Several exist specifically to stop a future reader "fixing"
  deliberate behaviour.
- User-facing copy is addressed to a child and should stay calm and non-punitive. The block page says
  what happens next and when, never scolds.
- Times are local. The household is in Israel (Asia/Jerusalem); the school week is Sunday–Thursday,
  which is why the default schedule looks unusual. Run tests with `TZ=Asia/Jerusalem`.

## Known gaps, if asked to extend

- `engine.js` supports **per-site schedule overrides** (`config.sites[k].windows`) but the options UI
  only edits the global schedule. Wiring that up is the most obvious next feature.
- `warnAtMinutes` and `meterEmbeds` thresholds aren't all editable in the UI.
- Embed metering is a proxy: it bills while an embed is ≥50% in the viewport and the page has focus.
  Defensible, not exact. `config.meterEmbeds` turns it off.
- No usage history — only today's counters. A parent asking "how much last week?" cannot be answered.
- Nothing covers other browsers. That's by design; see the honest-limits section of INSTALL.md.
