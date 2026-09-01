#!/usr/bin/env bash
# Repack, re-sign and stage a new version for GitHub Pages.
#
#   ./release.sh 1.0.1
#
# Bump "version" in manifest.json first — Chrome only takes an update when the
# version number goes up. Then commit and push; Chrome picks it up within about
# five hours, or immediately from chrome://extensions -> Update.
set -euo pipefail

VERSION="${1:-}"
KEY="install/timekeeper-key.pem"
BASE_URL="https://pxpilot.github.io/family-timekeeper"

if [[ -z "$VERSION" ]]; then
  echo "usage: ./release.sh <version>   e.g. ./release.sh 1.0.1" >&2
  exit 1
fi

if [[ ! -f "$KEY" ]]; then
  echo "Missing $KEY — that's the signing key, and it is deliberately not in this repo." >&2
  echo "Restore it from your backup, or the rebuilt extension gets a different ID." >&2
  exit 1
fi

MANIFEST_VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
if [[ "$MANIFEST_VERSION" != "$VERSION" ]]; then
  echo "manifest.json says $MANIFEST_VERSION but you asked for $VERSION." >&2
  echo "Bump the version in manifest.json first." >&2
  exit 1
fi

echo "== tests =="
node --test test/engine.test.mjs test/crypto.test.mjs
node test/smoke.mjs

echo "== pack =="
python3 install/pack_crx.py . "$KEY" docs "$VERSION" "$BASE_URL"

echo
echo "Staged in docs/. Commit and push, then verify:"
echo "  $BASE_URL/update.xml"
