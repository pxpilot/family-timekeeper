#!/usr/bin/env python3
"""Point every file at your GitHub Pages URL, in one shot.

    python3 install/configure.py --owner saar --repo family-timekeeper

Rewrites the update URL in install/1-install-policy.reg and release.sh, then
repacks docs/ so update.xml advertises the same address. Safe to re-run — it
replaces whatever URL is currently in place, including the placeholder.
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.path.join(ROOT, "install", "timekeeper-key.pem")
REG = os.path.join(ROOT, "install", "1-install-policy.reg")
RELEASE = os.path.join(ROOT, "release.sh")
MANIFEST = os.path.join(ROOT, "manifest.json")


def sub_file(path: str, pattern: str, repl: str) -> bool:
    with open(path, encoding="utf-8") as f:
        before = f.read()
    after = re.sub(pattern, repl, before)
    if after != before:
        with open(path, "w", encoding="utf-8") as f:
            f.write(after)
        return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", required=True, help="your GitHub username")
    ap.add_argument("--repo", default="family-timekeeper")
    ap.add_argument("--version", help="defaults to the version in manifest.json")
    args = ap.parse_args()

    base = f"https://{args.owner}.github.io/{args.repo}"
    update_url = f"{base}/update.xml"

    import json
    version = args.version or json.load(open(MANIFEST, encoding="utf-8"))["version"]

    if not os.path.exists(KEY):
        sys.exit(f"Missing {KEY} — restore the signing key from your backup first.")

    changed = []
    if sub_file(REG, r'"update_url"="[^"]*"', f'"update_url"="{update_url}"'):
        changed.append(os.path.relpath(REG, ROOT))
    if sub_file(RELEASE, r'BASE_URL="[^"]*"', f'BASE_URL="{base}"'):
        changed.append(os.path.relpath(RELEASE, ROOT))

    subprocess.run(
        [sys.executable, os.path.join(ROOT, "install", "pack_crx.py"),
         ROOT, KEY, os.path.join(ROOT, "docs"), version, base],
        check=True,
    )
    changed.append("docs/update.xml")

    print()
    print("Updated: " + ", ".join(changed))
    print(f"Update URL: {update_url}")
    print()
    print("Next: commit and push, enable Pages on the repo (Settings -> Pages,")
    print("      source = main branch, /docs folder), then confirm that URL loads.")


if __name__ == "__main__":
    main()
