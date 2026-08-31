// Shared crypto for passphrase auth and offline grant codes.
// Mirrored byte-for-byte in tools/parent-code.html — change both together.

const ITER = 200_000;
const CODE_SALT = 'family-timekeeper/v1/grant';

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

async function pbkdf2(passphrase, salt, bits = 256) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: ITER, hash: 'SHA-256' },
    base,
    bits,
  );
}

/** Hash for storing/checking the parent passphrase (per-install random salt). */
export async function hashPassphrase(passphrase, salt) {
  return toHex(await pbkdf2(passphrase, `family-timekeeper/v1/auth/${salt}`));
}

export async function verifyPassphrase(passphrase, auth) {
  if (!auth?.hash || !auth?.salt) return false;
  const h = await hashPassphrase(passphrase, auth.salt);
  // Constant-time-ish compare.
  if (h.length !== auth.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ auth.hash.charCodeAt(i);
  return diff === 0;
}

/**
 * Six-digit grant code. Deterministic from (passphrase, challenge, site, minutes),
 * so the parent can generate it entirely offline on any device.
 */
export async function grantCode(passphrase, challenge, site, minutes) {
  const keyBits = await pbkdf2(passphrase, CODE_SALT);
  const key = await crypto.subtle.importKey('raw', keyBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = `${String(challenge).trim().toUpperCase()}|${site}|${minutes}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  const n = ((sig[0] & 0x7f) << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Short, unambiguous challenge string the kid reads out loud. */
export function newChallenge() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => alphabet[b % alphabet.length]).join('');
}
