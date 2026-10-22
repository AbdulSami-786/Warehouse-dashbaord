// Desktop app only: every save lands on this computer first, so it is instant
// and works without internet; the Google Sheet is brought up to date in the
// background.
//
// Two copies of the data live on disk: "base", what the Sheet held at the last
// download, and "work", base plus everything saved here since. Saves run
// through localAdapter.js against work. A background sync then uploads what
// differs between base and work in one syncPush (Code.gs) — new rows, changed
// fields, removed rows — downloads the Sheet again (so other computers' work
// shows up here), and lays anything saved meanwhile back on top.
//
// Ids are made the same way on both sides, so a bill made here keeps its id on
// the Sheet and its payments still point at it. A bill number another computer
// used meanwhile is renumbered by the server; the change is listed in the
// connection window rather than popping up.
//
// Staff accounts, and the few actions an upload cannot carry (users, settings,
// passwords, share links, imports), still go straight to the server.

import { sheetsCall } from './sheetsAdapter.js';
import { getSession, localCall, setDbStore, setLocalPause, sha256 } from './localAdapter.js';
import { uid } from './format.js';

const disk = typeof window !== 'undefined' ? window.desktopStore : null;

/** Running inside the desktop app (electron/preload.cjs). */
export const isDesktop = !!disk;

if (isDesktop) setLocalPause(0);

// Data key → Sheet tab, for the tabs syncPush writes (its ORDER in Code.gs).
const TABS = {
  parties: 'Parties', suppliers: 'Suppliers', items: 'Items', employees: 'Employees', assets: 'Assets',
  purchaseBills: 'PurchaseBills', purchases: 'Purchases', bills: 'Bills', billItems: 'BillItems',
  partyItemPrices: 'PartyItemPrices', payments: 'Payments', returns: 'Returns', cheques: 'Cheques',
  partyAdvances: 'PartyAdvances', employeeTx: 'EmployeeTransactions', expenses: 'Expenses',
  stockLoss: 'StockLoss', supplierPayments: 'SupplierPayments', supplierReturns: 'SupplierReturns',
  warehouses: 'Warehouses', whParties: 'WhParties', whMoves: 'WarehouseMoves',
  whMoveLines: 'WarehouseMoveLines', whExpenses: 'WarehouseExpenses', whPartyPayments: 'WhPartyPayments',
  journal: 'Journal', journalPayments: 'JournalPayments', activityLog: 'ActivityLog',
};

// These touch what an upload cannot carry (users, settings, share links,
// passwords) or are too big to hold back: they go to the server directly.
const SERVER_ONLY = new Set([
  'changePassword', 'saveSettings', 'setPartyLock', 'setWhPartyLock',
  'createShareLink', 'revokeShareLink', 'createWhShareLink', 'revokeWhShareLink', 'openSharedLedger',
  'listUsers', 'saveUser', 'deleteUser', 'importBatch',
]);

const CREDS_KEY = 'offline-logins';
const userKey = (username, part) => `u-${String(username).toLowerCase()}-${part}`;
const currentUser = () => {
  const s = getSession();
  return s ? String(s.username).toLowerCase() : '';
};

/* ------------------------------------------------------------ Disk */

function readJson(key, fallback) {
  try {
    const raw = disk.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  disk.set(key, JSON.stringify(value));
}

const emptyMeta = () => ({ pending: [], problems: [], notes: [], lastSync: '', lastError: '' });
const readMeta = (u) => ({ ...emptyMeta(), ...readJson(userKey(u, 'meta'), {}) });
const writeMeta = (u, meta) => writeJson(userKey(u, 'meta'), meta);

/** Point localAdapter.js at this user's working copy. */
function useWork(u) {
  setDbStore(userKey(u, 'work'), disk);
}

/** localAdapter.js reads the user from its own users list; the Sheet sends none. */
function withSelf(db, session) {
  db.users = [{
    id: 'usr_self', username: session.username, name: session.name || session.username,
    role: session.role, pages: session.pages ?? null, status: 'active',
  }];
  return db;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------------------------------------ Status */

let status = { online: true, syncing: false, pending: 0, problems: [], notes: [], lastSync: '', lastError: '' };
const listeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

function statusFromMeta(meta) {
  setStatus({
    pending: meta.pending.length, problems: meta.problems, notes: meta.notes,
    lastSync: meta.lastSync, lastError: meta.lastError,
  });
}

/** The connection and upload state right now. */
export const currentSyncStatus = () => status;

/** Follow the connection and upload state; returns an unsubscribe function. */
export function onSyncStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

/** Fired after a background sync brought new data from the Sheet. */
export const DATA_SYNCED_EVENT = 'jh:data-synced';

/** Forget upload problems and notes the user has read. */
export function clearSyncProblems() {
  const u = currentUser();
  if (!u || !disk) return;
  const meta = readMeta(u);
  meta.problems = [];
  meta.notes = [];
  meta.lastError = '';
  writeMeta(u, meta);
  statusFromMeta(meta);
}

/* ------------------------------------------------------------ Comparing copies */

const blank = (v) => (v === undefined || v === null ? '' : String(v));

/** Each record of `after` that is new or changed against `before`, and the ids removed. */
function eachChange(before, after, onNew, onChanged, onGone) {
  for (const [key, tab] of Object.entries(TABS)) {
    const old = new Map((before[key] || []).filter((r) => r?.id).map((r) => [String(r.id), r]));
    const rows = (after[key] || []).filter((r) => r?.id);
    for (const rec of rows) {
      const was = old.get(String(rec.id));
      if (!was) {
        onNew(key, tab, rec);
        continue;
      }
      if (key === 'activityLog') continue;
      const patch = {};
      let changed = false;
      for (const k of Object.keys(rec)) {
        if (k !== 'id' && blank(rec[k]) !== blank(was[k])) {
          patch[k] = rec[k];
          changed = true;
        }
      }
      if (changed) onChanged(key, tab, rec, patch);
    }
    if (key === 'activityLog') continue;
    const kept = new Set(rows.map((r) => String(r.id)));
    for (const id of old.keys()) if (!kept.has(id)) onGone(key, tab, id);
  }
}

/**
 * What changed between two copies, in the shape syncPush takes. Changed rows
 * carry only their changed fields, so an edit made here does not undo a
 * different field someone changed on another computer.
 */
export function changesBetween(base, work, now = new Date().toISOString()) {
  const records = {};
  const deleted = {};
  let count = 0;
  const add = (tab, row) => { (records[tab] = records[tab] || []).push(row); count += 1; };
  eachChange(base, work,
    (key, tab, rec) => add(tab, { ...rec, updatedAt: now }),
    (key, tab, rec, patch) => add(tab, { id: rec.id, ...patch, updatedAt: now }),
    (key, tab, id) => { (deleted[tab] = deleted[tab] || []).push(id); count += 1; });
  return { records, deleted, count };
}

/** `fresh` (a new download) with everything that changed from `before` to `after` laid on top. */
function rebase(fresh, before, after) {
  const out = clone(fresh);
  const index = {};
  const rowsOf = (key) => {
    if (!index[key]) {
      out[key] = out[key] || [];
      index[key] = new Map(out[key].map((r) => [String(r.id), r]));
    }
    return index[key];
  };
  eachChange(before, after,
    (key, tab, rec) => {
      const hit = rowsOf(key).get(String(rec.id));
      if (hit) Object.assign(hit, rec);
      else { out[key].push(clone(rec)); index[key].set(String(rec.id), out[key][out[key].length - 1]); }
    },
    (key, tab, rec, patch) => {
      // Removed on another computer meanwhile: nothing left to change.
      const hit = rowsOf(key).get(String(rec.id));
      if (hit) Object.assign(hit, patch);
    },
    (key, tab, id) => {
      rowsOf(key);
      out[key] = out[key].filter((r) => String(r.id) !== id);
      index[key].delete(id);
    });
  return out;
}

/* ------------------------------------------------------------ One at a time */

// Saves and the disk steps of a sync take turns, so a sync never reads the
// working copy halfway through a save. The network waits happen outside it.
let chain = Promise.resolve();
function turn(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------ Background sync */

const sessionEnded = (err) => /session has expired/i.test(err?.message || '');
const stamp = () => new Date().toISOString();

// More rows than any normal save removes (an edited bill drops its old lines).
const MAX_REMOVALS = 200;

let syncing = null;
let again = false;
let soonTimer = null;
// When the Sheet last came down. A screen reload soon after one needs no new sync.
let lastPull = 0;

/** Download the Sheet and make it the new base, keeping anything saved here meanwhile. */
async function download(u, session) {
  const before = await turn(() => readJson(userKey(u, 'base'), null));
  const fresh = await sheetsCall('bootstrap');
  await turn(() => {
    const now = readJson(userKey(u, 'work'), null);
    // Without a base there is nothing to tell what was saved here: start from the Sheet.
    const work = now && before ? rebase(fresh, before, now) : clone(fresh);
    disk.set(userKey(u, 'base'), JSON.stringify(fresh));
    writeJson(userKey(u, 'work'), withSelf(work, session));
  });
  lastPull = Date.now();
}

/** Upload what is waiting, then download. Quiet: the outcome shows on the badge only. */
async function cycle() {
  const session = getSession();
  if (!session || !disk) return;
  const u = String(session.username).toLowerCase();
  setStatus({ syncing: true });
  try {
    await ready(u, session);
    const snap = await turn(() => {
      const meta = readMeta(u);
      return {
        n: meta.pending.length,
        base: readJson(userKey(u, 'base'), null),
        work: readJson(userKey(u, 'work'), null),
      };
    });
    if (snap.n && snap.base && snap.work) {
      const { records, deleted, count } = changesBetween(snap.base, snap.work);
      // Nothing anyone does here removes this much at once: stop rather than
      // risk clearing the Sheet from a damaged copy.
      const removing = Object.values(deleted).reduce((n, ids) => n + ids.length, 0);
      if (removing > MAX_REMOVALS) {
        throw new Error(`Upload stopped: it would remove ${removing} rows from the Google Sheet. Nothing was changed. Contact support before saving more on this computer.`);
      }
      let res = null;
      if (count) res = await sheetsCall('syncPush', { records, deleted });
      await turn(() => {
        // The Sheet holds that copy now: it is the new starting point.
        disk.set(userKey(u, 'base'), JSON.stringify(snap.work));
        const meta = readMeta(u);
        meta.pending = meta.pending.slice(snap.n);
        const problems = (res?.errors || []).map((e) => ({ at: stamp(), tab: e.tab, id: e.id, error: e.error }));
        if (Object.keys(deleted).length && res && typeof res.deleted !== 'number') {
          problems.push({ at: stamp(), tab: '', id: '', error: 'The server did not remove rows deleted here. Update the Apps Script deployment.' });
        }
        meta.problems = [...meta.problems, ...problems].slice(-50);
        const renumbered = (res?.billNoChanges || []).map((c) => ({ at: stamp(), text: `Bill ${c.from} is now Bill ${c.to} — another computer had used that number.` }));
        meta.notes = [...meta.notes, ...renumbered].slice(-20);
        meta.lastSync = stamp();
        meta.lastError = '';
        writeMeta(u, meta);
        statusFromMeta(meta);
      });
    }
    await download(u, session);
    setStatus({ online: true });
    try { window.dispatchEvent(new Event(DATA_SYNCED_EVENT)); } catch { /* no window */ }
  } catch (err) {
    if (err.offline) setStatus({ online: false });
    else if (!sessionEnded(err)) {
      const meta = readMeta(u);
      meta.lastError = err.message || 'Upload failed';
      writeMeta(u, meta);
      statusFromMeta(meta);
      setStatus({ online: true });
    }
  } finally {
    setStatus({ syncing: false });
  }
}

/**
 * Sync now, or right after the one already running. Resolves when done.
 * Exported for the "Sync now" button.
 */
export function syncNow() {
  if (!isDesktop) return Promise.resolve();
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      again = false;
      await cycle();
    } while (again);
  })().finally(() => { syncing = null; });
  return syncing;
}

/** A sync shortly after a save, so a run of entries goes up together. */
function syncSoon(ms = 800) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { soonTimer = null; syncNow(); }, ms);
}

// Keep the Sheet and this computer in step while the app is open: when the
// connection returns, every 15 seconds while offline or while changes wait,
// and otherwise once a minute to bring in other computers' work.
if (isDesktop) {
  window.addEventListener('online', () => syncSoon(200));
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    if (getSession() && (!status.online || status.pending > 0 || ticks % 4 === 0)) syncNow();
  }, 15000);
}

/* ------------------------------------------------------------ Actions */

async function login(p) {
  const username = String(p.username || '').trim().toLowerCase();
  const creds = readJson(CREDS_KEY, {});
  try {
    const s = await sheetsCall('login', p);
    // Remembered so the same account can sign in here without internet.
    const salt = uid('slt');
    creds[username] = { salt, hash: await sha256(`${salt}:${p.password || ''}`), session: s };
    writeJson(CREDS_KEY, creds);
    setStatus({ online: true });
    return s;
  } catch (err) {
    if (!err.offline) throw err;
    setStatus({ online: false });
    const c = creds[username];
    if (!c) throw new Error('No internet connection. To sign in without internet, this account must have signed in once on this computer while online.');
    if ((await sha256(`${c.salt}:${p.password || ''}`)) !== c.hash) throw new Error('Invalid username or password');
    return c.session;
  }
}

const firstLoads = new Map();

/**
 * This user's copy is on this computer. The first time, that means waiting for
 * the Sheet to download: nothing may be saved onto an empty copy.
 */
function ready(u, session) {
  if (disk.get(userKey(u, 'work')) && disk.get(userKey(u, 'base'))) return Promise.resolve();
  if (!firstLoads.has(u)) {
    const load = download(u, session)
      .then(() => setStatus({ online: true }))
      .catch((err) => {
        if (!err.offline) throw err;
        setStatus({ online: false });
        const none = new Error('No internet connection, and this computer has no copy of the data yet. Connect to the internet once to download it.');
        none.offline = true;
        throw none;
      })
      .finally(() => firstLoads.delete(u));
    firstLoads.set(u, load);
  }
  return firstLoads.get(u);
}

/** Run an action on this computer's working copy. */
async function local(u, session, action, p) {
  await ready(u, session);
  return turn(() => {
    useWork(u);
    return localCall(action, p);
  });
}

async function bootstrap(u, session) {
  statusFromMeta(readMeta(u));
  const fresh = !!firstLoads.get(u) || !disk.get(userKey(u, 'work'));
  await ready(u, session);
  if (!fresh && Date.now() - lastPull > 30000) syncSoon(0);
  return local(u, session, 'bootstrap');
}

/** Straight to the server; then download, so the screen shows the result. */
async function onServer(u, session, action, p) {
  let res;
  try {
    res = await sheetsCall(action, p);
  } catch (err) {
    if (err.offline) {
      setStatus({ online: false });
      throw new Error('No internet connection. This needs the internet — try again once you are back online.');
    }
    throw err;
  }
  setStatus({ online: true });
  if (action === 'changePassword' && p.newPassword) {
    const creds = readJson(CREDS_KEY, {});
    if (creds[u]) {
      creds[u].hash = await sha256(`${creds[u].salt}:${p.newPassword}`);
      creds[u].session = { ...creds[u].session, ...res, defaultPassword: false };
      writeJson(CREDS_KEY, creds);
    }
  }
  // Whatever is waiting here goes up first, then the fresh Sheet comes down.
  await syncNow();
  return res;
}

async function save(u, session, action, p) {
  if (SERVER_ONLY.has(action)) return onServer(u, session, action, p);
  // syncPush is for admins (Code.gs): staff save on the server as before.
  if (session.role === 'staff' || session.seesCost === false) {
    try {
      return await onServer(u, session, action, p);
    } catch (err) {
      if (/No internet/.test(err.message)) {
        throw new Error('No internet connection. Staff accounts can view the books offline, but saving needs the internet (or an admin account).');
      }
      throw err;
    }
  }
  await ready(u, session);
  const res = await turn(async () => {
    useWork(u);
    const out = await localCall(action, p);
    const meta = readMeta(u);
    meta.pending.push({ action, at: stamp() });
    writeMeta(u, meta);
    statusFromMeta(meta);
    return out;
  });
  syncSoon();
  return res;
}

async function perform(action, p) {
  if (action === 'login') return login(p);
  if (action === 'openSharedLedger') return sheetsCall(action, p);
  const session = getSession();
  if (!session) return sheetsCall(action, p);
  const u = String(session.username).toLowerCase();

  if (action === 'logout') {
    try {
      return await sheetsCall('logout');
    } catch (err) {
      if (err.offline) return { ok: true };
      throw err;
    }
  }
  if (action === 'bootstrap') return bootstrap(u, session);
  if (action === 'fullBackup') return local(u, session, action, p);
  if (action === 'listUsers') return sheetsCall(action, p);
  return save(u, session, action, p);
}

export function hybridCall(action, payload = {}) {
  return perform(action, payload);
}
