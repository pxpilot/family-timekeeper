// End-to-end proof that the hosting path works.
//
// Serves docs/ over HTTP exactly as GitHub Pages would, hands Chromium a
// managed-policy file that force-installs from that update.xml, and checks the
// extension actually lands and boots — with no --load-extension flag anywhere.
//
// This covers what the unit and smoke tests cannot: the CRX3 signature, the ID
// derived from the signing key, the update manifest, and the ExtensionSettings
// policy that the Windows .reg is the direct equivalent of.
//
// Chromium is driven directly rather than through Playwright here: Playwright's
// default flags disable extensions and background networking (both fatal to a
// policy install), and navigating an automated page to a chrome-extension:// URL
// under a policy install closes the page. Reading the browser's own log is more
// faithful and far less brittle.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docs = path.join(root, 'docs');
const EXT_ID = fs.readFileSync(path.join(root, 'install/EXTENSION_ID.txt'), 'utf8').trim();
const PORT = Number(process.env.TK_PORT || 8899);
const CHROME = process.env.TK_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const POLICY_DIRS = ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed'];

const fails = [];
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(label);
};

for (const f of ['update.xml', 'timekeeper.crx']) {
  if (!fs.existsSync(path.join(docs, f))) {
    console.error(`docs/${f} is missing — run install/pack_crx.py first.`);
    process.exit(1);
  }
}

// --- 1. a static host that behaves like GitHub Pages ------------------------
const TYPES = { '.xml': 'text/xml', '.crx': 'application/octet-stream', '.html': 'text/html', '.zip': 'application/zip' };
const served = [];
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const file = path.join(docs, rel);
  if (!file.startsWith(docs) || !fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  served.push(rel);
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

// --- 2. managed policy — the Linux equivalent of 1-install-policy.reg -------
const policy = {
  ExtensionSettings: {
    '*': { installation_mode: 'blocked' },
    [EXT_ID]: {
      installation_mode: 'force_installed',
      update_url: `http://localhost:${PORT}/update.xml`,
      toolbar_pin: 'force_pinned',
    },
  },
  IncognitoModeAvailability: 1,
  BrowserGuestModeEnabled: false,
  BlockExternalExtensions: true,
};
const written = [];
for (const d of POLICY_DIRS) {
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'timekeeper.json'), JSON.stringify(policy, null, 2));
    written.push(d);
  } catch { /* not writable here; another dir may still work */ }
}
ok('managed policy written', written.length > 0, written.join(', ') || 'no writable policy dir — needs root');

// --- 3. launch, wait for the install, read the browser's own log ------------
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-fi-'));
const extDir = path.join(userDataDir, 'Default', 'Extensions', EXT_ID);
let log = '';

const chrome = spawn(CHROME, [
  '--no-sandbox',
  '--headless=new',
  `--user-data-dir=${userDataDir}`,
  '--enable-logging=stderr',
  '--v=1',
  '--extensions-update-frequency=1',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (b) => { log += b.toString(); });

const bootRe = new RegExp(`extension id:\\s+${EXT_ID}[\\s\\S]{0,240}?BLESSED_EXTENSION`);
const deadline = Date.now() + 60_000;
let booted = false;
while (Date.now() < deadline) {
  if (fs.existsSync(extDir) && bootRe.test(log)) { booted = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
chrome.kill('SIGTERM');
await new Promise((r) => chrome.once('exit', r));

// --- 4. assertions ----------------------------------------------------------
const installed = fs.existsSync(extDir);
const updateReq = (log.match(/update\.xml\?[^\s"]*/) || [''])[0];

ok('Chromium fetched update.xml', served.includes('update.xml'), served.join(', ') || 'nothing fetched');
ok('Chromium treated it as a policy install, not a store install',
  /installedby%3Dpolicy/.test(updateReq) && /installsource%3Dnotfromwebstore/.test(updateReq),
  updateReq.slice(-70));
ok('Chromium downloaded the .crx', served.includes('timekeeper.crx'));
ok('the CRX3 signature was accepted and the package unpacked', installed,
  installed ? fs.readdirSync(extDir).join(', ') : 'never appeared on disk');
ok('the service worker booted as a blessed extension context', booted, EXT_ID);

if (installed) {
  const versionDir = fs.readdirSync(extDir)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, versionDir, 'manifest.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok('the installed build is the version update.xml advertised',
    manifest.version === expected.version, manifest.version);
  ok('the signing key is embedded, pinning the extension ID', !!manifest.key);
  ok('the installed build carries no stray permissions',
    JSON.stringify(manifest.permissions) === JSON.stringify(expected.permissions),
    manifest.permissions.join(', '));
}

// --- 5. clean up ------------------------------------------------------------
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
for (const d of written) fs.rmSync(path.join(d, 'timekeeper.json'), { force: true });

console.log(fails.length
  ? `\n${fails.length} check(s) failed: ${fails.join(', ')}`
  : '\nForce-install path verified end to end');
process.exit(fails.length ? 1 : 0);
