import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassphrase, verifyPassphrase, grantCode, newChallenge } from '../src/lib/crypto.js';

const enc = new TextEncoder();

// Reimplementation of the service worker's verifier path, to prove that the
// stored verifier produces the same code as the parent tool's passphrase path.
async function buildVerifier(passphrase) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('family-timekeeper/v1/grant'), iterations: 200_000, hash: 'SHA-256' },
    base, 256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function codeFromVerifier(hex, challenge, site, minutes) {
  const raw = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    enc.encode(`${String(challenge).toUpperCase()}|${site}|${minutes}`)));
  const n = ((sig[0] & 0x7f) << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3];
  return String(n % 1_000_000).padStart(6, '0');
}

test('passphrase hash verifies, and rejects a wrong passphrase', async () => {
  const salt = 'abcd1234';
  const hash = await hashPassphrase('correct horse battery', salt);
  assert.equal(await verifyPassphrase('correct horse battery', { salt, hash }), true);
  assert.equal(await verifyPassphrase('correct horse batteryX', { salt, hash }), false);
  assert.equal(await verifyPassphrase('x', {}), false);
});

test('the worker verifier and the parent tool agree on every code', async () => {
  const pass = 'a-strong-parent-passphrase';
  const verifier = await buildVerifier(pass);
  for (const site of ['youtube', 'tiktok', 'instagram']) {
    for (const mins of [5, 15, 60]) {
      const ch = newChallenge();
      const fromParent = await grantCode(pass, ch, site, mins);
      const fromWorker = await codeFromVerifier(verifier, ch, site, mins);
      assert.equal(fromParent, fromWorker, `${site}/${mins}`);
      assert.match(fromParent, /^\d{6}$/);
    }
  }
});

test('a code is bound to its challenge, site and minute count', async () => {
  const pass = 'pass';
  const base = await grantCode(pass, 'ABC123', 'youtube', 15);
  assert.notEqual(base, await grantCode(pass, 'ABC124', 'youtube', 15));
  assert.notEqual(base, await grantCode(pass, 'ABC123', 'tiktok', 15));
  assert.notEqual(base, await grantCode(pass, 'ABC123', 'youtube', 30));
  assert.notEqual(base, await grantCode('pass2', 'ABC123', 'youtube', 15));
});

test('challenge input is case- and whitespace-insensitive', async () => {
  const a = await grantCode('p', 'abc123', 'youtube', 15);
  const b = await grantCode('p', '  ABC123 ', 'youtube', 15);
  assert.equal(a, b);
});

test('challenges avoid ambiguous characters', () => {
  for (let i = 0; i < 200; i++) assert.match(newChallenge(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});
