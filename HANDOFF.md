# Handoff — 1 September 2026

State of play when this moved from a Cowork session to Claude Code. `CLAUDE.md` holds the durable
project knowledge; this file is the current situation and dies once the install is live.

## Where things stand

Built and tested end to end. Two commits on `main`, 40 files, all three suites green:

- 27 unit tests over the policy engine and grant codes
- 24 smoke checks driving the real extension in Chromium
- 9 checks proving a managed policy actually force-installs the signed `.crx` from a locally served
  `docs/` — that last one covers the CRX3 signature, the derived extension ID, `update.xml`, and the
  `ExtensionSettings` policy together

Everything is already configured for `pxpilot/family-timekeeper`. The update URL agrees across
`docs/update.xml`, `install/1-install-policy.reg` and `release.sh`.

**Extension ID:** `mfapfgenhahkmhgnflaggaehogaepgad`
**Pages URL:** `https://pxpilot.github.io/family-timekeeper/`

## The one thing that's blocked

`git push` never reached GitHub from the Cowork sandbox:

```
remote: access denied by the git proxy: pxpilot/family-timekeeper is not in
this session's authorized repository set, so the proxy will not inject a
credential for it.
```

That sandbox routes GitHub traffic through an egress proxy that strips the `Authorization` header and
substitutes its own credential, only for allowlisted repos. A personal access token was tried and could
not work — **it has been revoked; do not go looking for it.** From a normal Claude Code session on the
parent's own machine this is a non-issue.

The GitHub repo exists and is **empty**. Nothing has ever been pushed.

## Next steps, in order

1. **Push.** From the repo root:
   ```bash
   git push -u origin main
   ```
   `origin` is already set to `https://github.com/pxpilot/family-timekeeper.git`.

2. **Enable Pages.** Repo → Settings → Pages → Source: `Deploy from a branch`, branch `main`,
   folder `/docs`. Wait for the build.

3. **Verify hosting before touching the laptop.** Both must work anonymously (try a private window):
   - `https://pxpilot.github.io/family-timekeeper/update.xml` returns the XML
   - `https://pxpilot.github.io/family-timekeeper/timekeeper.crx` downloads and starts with `Cr24`

   If either 404s, Pages hasn't built or the folder source is wrong. Do not proceed until both pass —
   a wrong URL here surfaces later as a silent no-install with no error anywhere.

4. **Install on the son's Windows laptop.** Merge `install/1-install-policy.reg` as administrator,
   fully quit Chrome (check the tray), reopen. Verify at `chrome://policy` and `chrome://extensions` —
   the extension should have no Remove button.

5. **Set the parent passphrase** in the extension's settings page, on that laptop, before he uses it.
   No recovery if forgotten; clearing storage is the only reset and it wipes the day's counters.

6. **Put `tools/parent-code.html` on the parent's phone.** Never on the son's laptop — anyone with that
   file and the passphrase can mint unlimited time.

7. **Make his Windows account a standard user, not an administrator.** Highest-value step in the whole
   project. Without it he can merge `install/2-uninstall-policy.reg` himself in thirty seconds and every
   other protection is theatre.

## Decisions made, and why

- **Self-hosted on Pages rather than the Chrome Web Store.** Free and immediate; the store's $5 unlisted
  route is still open and `install/configure.py` would repoint everything. Store hosting would be more
  robust (Chrome trusts it unconditionally) if this ever gets fiddly.
- **Force-install via `HKEY_LOCAL_MACHINE`, not `HKEY_CURRENT_USER`.** The per-user hive is editable by
  that user, which would hand him the off switch. Consequence: the policy applies to every account on the
  machine, the parent's included.
- **Grant codes are offline HMAC, not a server.** No infrastructure to run or pay for, works when the
  parent is out of the house, nothing to leak. Cost: the parent must have the tool page to hand.
- **Time is only billed while focused and visible.** A YouTube tab left open behind homework shouldn't
  burn his budget. Makes the numbers feel fair, which matters if this is to survive contact with him.
- **The block page reports the longest-lasting barrier.** Deliberate and tested — see `CLAUDE.md`.

## Watch out for

- The signing key is **not in the repo** and not in git history. It exists only in the parent's local
  working copy (`install/timekeeper-key.pem`) and whatever backup they made. Lose it and the extension
  gets a new ID, which means a new policy file and a fresh install on his laptop. Confirm they have a
  backup before doing anything clever with the repo.
- `docs/` is generated output that is committed on purpose — Pages serves it. Don't gitignore it.
- If the version in `manifest.json` and the one advertised in `docs/update.xml` ever disagree, Chrome
  silently won't update. `release.sh` guards against this; hand-repacking doesn't.
