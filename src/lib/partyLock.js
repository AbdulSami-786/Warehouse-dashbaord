// A party's ledger can carry its own password. Unlocking lasts ten minutes
// in this tab only, and wrong guesses are throttled per party.

const UNLOCK_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const LOCK_MS = 60 * 1000;
const TRIES_KEY = 'jh_party_lock_attempts';
const unlocked = new Map();

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const saltedHash = (password, salt) => sha256(`${salt || ''}:${password || ''}`);

export function isLocked(party) {
  return !!party?.lockHash;
}

function isUnlocked(partyId) {
  const until = unlocked.get(partyId);
  if (!until) return false;
  if (Date.now() >= until) {
    unlocked.delete(partyId);
    return false;
  }
  return true;
}

export function canOpen(party) {
  return !isLocked(party) || isUnlocked(party.id);
}

export function markUnlocked(partyId) {
  unlocked.set(partyId, Date.now() + UNLOCK_MS);
}

export function relock(partyId) {
  unlocked.delete(partyId);
}

export function relockAll() {
  unlocked.clear();
}

function tries() {
  try { return JSON.parse(localStorage.getItem(TRIES_KEY) || '{}') || {}; } catch { return {}; }
}

function saveTries(t) {
  try { localStorage.setItem(TRIES_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

function waitFor(partyId) {
  const rec = tries()[partyId];
  if (!rec || rec.count < MAX_TRIES) return 0;
  const left = rec.at + LOCK_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export async function tryUnlock(party, password) {
  const wait = waitFor(party.id);
  if (wait > 0) throw new Error(`Too many wrong tries. Try again in ${wait} seconds.`);
  const ok = (await saltedHash(password, party.lockSalt)) === party.lockHash;
  const all = tries();
  if (ok) {
    delete all[party.id];
    saveTries(all);
    unlocked.set(party.id, Date.now() + UNLOCK_MS);
    return true;
  }
  const rec = all[party.id] || { count: 0, at: 0 };
  if (rec.count >= MAX_TRIES && rec.at + LOCK_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_TRIES) rec.at = Date.now();
  all[party.id] = rec;
  saveTries(all);
  return false;
}
