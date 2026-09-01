# Family Timekeeper — setup on your son's Windows laptop

Extension ID: `mfapfgenhahkmhgnflaggaehogaepgad`
(That ID is derived from `install/timekeeper-key.pem`. Keep that key file — losing it means a new ID and a reinstall.)

---

## What's in the box

| Path | What it is |
|---|---|
| `manifest.json`, `src/` | The extension itself |
| `docs/timekeeper.crx` | Signed package, served by GitHub Pages |
| `docs/update.xml` | Tells Chrome where the .crx is and what version it is |
| `install/1-install-policy.reg` | Force-installs it and closes the obvious workarounds |
| `install/2-uninstall-policy.reg` | Undoes all of that |
| `install/timekeeper-key.pem` | **Private key. Not in the repo. Keep it off his laptop.** |
| `install/configure.py` | Repoints everything at a different Pages URL |
| `release.sh` | Tests, repacks and re-signs a new version |
| `tools/parent-code.html` | Your offline code generator — keep it on *your* devices |
| `test/` | Unit, smoke and force-install tests |

---

## Step 1 — Hosting (already done)

The package is served from **https://pxpilot.github.io/family-timekeeper/**, and
`install/1-install-policy.reg` already points at it. Nothing to edit.

If you ever move it — a different repo, or the Chrome Web Store — run
`python3 install/configure.py --owner <user> --repo <repo>` and it rewrites the `.reg`, `release.sh` and
`update.xml` together so they can't drift apart.

Note the repo has to stay **public**: Chrome fetches the update manifest anonymously. That's fine — the
`.crx` holds no secrets and is inert without your passphrase, and the signing key is not in the repo.

## Step 2 — Merge the policy file

On his laptop, as an administrator: right-click `install/1-install-policy.reg` → **Merge** → approve.

Fully quit Chrome (check the tray, not just the window) and reopen it.

## Step 3 — Verify

- `chrome://policy` → **Reload policies**. `ExtensionSettings` should be listed with no error.
- `chrome://extensions` → Family Timekeeper is present, and there's **no Remove button** — just
  "Installed by your administrator". If Remove is still there, the policy didn't apply: you merged into
  the wrong hive, or Chrome wasn't fully restarted.
- The blue clock icon should be pinned to the toolbar.

## Step 4 — Set your passphrase, on his laptop, before he uses it

The extension opens its settings page on first install. Set the parent passphrase there. Two things
depend on it: unlocking the settings, and generating the extra-time codes. Pick something he has never
watched you type. There is no recovery — if you forget it, you clear the extension's storage and set it
again, which also clears the day's counters.

Then set the limits: daily minutes per site, allowed hours per weekday, and the session cap.
The defaults are 45/20/20 minutes, 15:30–20:30 Sun–Thu, 10:00–21:00 Fri–Sat, 20 minutes at a stretch
with a 10-minute break.

## Step 5 — Keep `tools/parent-code.html` on your phone

Open it once so it's cached; it works fully offline and sends nothing anywhere. When he asks for more
time he'll read you a 6-character code; you type it in with the site and the minutes, and read the
6-digit number back. Each code works once, for exactly that site and that number of minutes, and expires
in 15 minutes. **Never open this file on his laptop** — the passphrase is the whole security model.

---

## Changing the code later

Shipping a new version:

```bash
# bump "version" in manifest.json first — Chrome only updates when it goes up
./release.sh 1.0.1
git commit -am "v1.0.1" && git push
```

`release.sh` refuses to run if the version doesn't match `manifest.json` or the signing key is missing,
and runs the full test suite before packing — so a broken build can't quietly reach his laptop. Chrome
picks up the new version within about five hours, or immediately from `chrome://extensions` → Update.

```bash
node --test test/engine.test.mjs test/crypto.test.mjs   # 27 unit tests
node test/smoke.mjs                                     # 24 checks in a real Chromium
sudo node test/forceinstall.mjs                         # 9 checks on the install path
```

The last one is the one that would have caught a bad `.crx`: it serves `docs/` over HTTP the way Pages
does, applies a managed policy, and confirms Chromium actually force-installs and boots the extension.

---

## What this actually stops, and what it doesn't

Worth being straight with yourself about the boundary.

**It holds against:** uninstalling or disabling the extension, incognito, a second Chrome profile,
guest mode, installing a "unblocker" extension, editing the options without the passphrase, replaying an
old unlock code, and — because usage is checked against a monotonic guard — winding the system clock
back to buy a fresh day.

**It does not stop:** Microsoft Edge, Firefox, or any other browser. That's the big one, and it's the
first thing he'll try. Also: his phone, a friend's laptop, a school Chromebook, and the YouTube app if
it's installed.

Three things close most of that gap, roughly in order of effort:

1. **Make his Windows account a standard user, not an administrator.** This is the single highest-value
   step. Without it he can merge `2-uninstall-policy.reg` himself in about thirty seconds, and none of
   the above matters. It also stops him changing the system clock and installing another browser.
2. **Windows Family Safety** (Settings → Accounts → Family) does app-level limits, so you can cap or
   block Edge and Firefox by name. It's the natural partner to this extension rather than a replacement —
   it can't tell YouTube from a homework site inside Chrome, which is exactly what this does.
3. **NextDNS or Pi-hole on the home router**, blocking the three domains outside the allowed hours. That
   catches every browser and every device on the network at once. It can't do per-site minute budgets,
   so it complements this rather than replacing it. He can beat it with mobile data.

None of this is airtight, and a determined teenager with time and a search engine will eventually find
an edge. The realistic goal is to make the easy paths closed and the remaining paths effortful enough
that they're a choice he'd have to make deliberately — which is a conversation, not a config file.

---

## Troubleshooting

**"Remove" is still available on chrome://extensions.** The policy isn't applied. Check
`chrome://policy` for `ExtensionSettings`; if it's absent you merged into `HKEY_CURRENT_USER` instead of
`HKEY_LOCAL_MACHINE`, or Chrome didn't restart.

**Extension shows as "corrupted" or won't install.** The `.crx` was re-zipped or edited after signing.
Repack with `pack_crx.py`; don't unzip and rezip it by hand.

**Timer doesn't count down.** The countdown only advances while the tab is focused and visible, and
pauses when Windows goes idle for a minute. That's intentional — a YouTube tab left open behind homework
shouldn't burn his budget.

**Embeds show a placeholder even when time is left.** That means the site is blocked for another reason
— outside hours, or a forced break. Click the toolbar icon to see which.

**He's locked out at a time you didn't expect.** Toolbar icon → Parent settings → unlock → the Today
panel shows exactly which barrier is up for each site, and "Grant now" gives immediate minutes without
the code dance.
