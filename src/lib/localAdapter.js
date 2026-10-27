// The whole database lives in this browser's localStorage. Every action the
// dashboard can take is one case of perform() below; nothing goes over the
// network.

import { CONFIG, PAYMENT_METHODS } from './config.js';
import { r2, today, addDays, uid, phoneKey, nameKey, dayOf } from './format.js';
import {
  billState, billTotals, isOpeningBill, payableNow, lineDelivered, lineReceived, supplierBalance,
  MOVE_TYPES, warehouseStockMap, itemStock, journalClaims,
} from './calc.js';
import { accessOf, stripCostData, COST_PAGES, PAGES } from './permissions.js';

export const SESSION_KEY = 'jh_session';

// Where the database is kept. Normally this browser's localStorage under
// 'jh_db_v1'; the desktop app's offline mode (hybridAdapter.js) points it at
// its own copy of the Sheet, kept in a file.
let DB_KEY = 'jh_db_v1';
let dbStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
};

export function setDbStore(key, store) {
  DB_KEY = key;
  if (store) dbStore = store;
  current = null;
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyDb() {
  return {
    parties: [], items: [], partyItemPrices: [], bills: [], billItems: [], payments: [], returns: [],
    cheques: [], partyAdvances: [], purchases: [], employees: [], employeeTx: [], expenses: [],
    stockLoss: [], assets: [], activityLog: [], users: [], partyLedgerLinks: [], suppliers: [],
    purchaseBills: [], supplierPayments: [], supplierReturns: [],
    warehouses: [], whMoves: [], whMoveLines: [], whExpenses: [], whParties: [], whPartyPayments: [], journal: [], journalPayments: [],
    settings: {
      shopName: CONFIG.defaultShopName, phone: '', address: '', email: '', logoUrl: '',
      roundingRule: 'nearest1', priceAlertThreshold: 15, defaultCreditDays: 7, customMethods: [],
    },
    billCounter: {},
    docCounter: {},
  };
}

function readDb() {
  try {
    const raw = dbStore.get(DB_KEY);
    if (raw) return { ...emptyDb(), ...JSON.parse(raw) };
  } catch (err) {
    console.error('Local DB read failed, starting fresh', err);
  }
  return null;
}

function writeDb(db) {
  try {
    dbStore.set(DB_KEY, JSON.stringify(db));
  } catch {
    throw new Error('Could not save to this device’s storage. It may be full, or the browser is in private mode. Free up space or export a backup, then try again.');
  }
  return db;
}

let current = null;

function load() {
  current = readDb();
  if (current) seedAdmin(current);
  else {
    current = emptyDb();
    seedAdmin(current);
    writeDb(current);
  }
  return current;
}

function save() {
  const out = writeDb(current);
  try { window.dispatchEvent(new CustomEvent('jh:data-changed')); } catch { /* not in a browser */ }
  return out;
}

/** Older local data has an 'admin' and no super admin: that account becomes one. */
function ensureSuper(db) {
  if (db.users.some((u) => u.role === 'superadmin')) return;
  const pick = db.users.find((u) => u.username === 'admin') || db.users[0];
  if (pick) pick.role = 'superadmin';
}

function meOf(db) {
  ensureSuper(db);
  const u = db.users.find((x) => x.username === getSession()?.username) || db.users.find((x) => x.role === 'superadmin');
  return u ? accessOf(u) : null;
}

// Set while an import runs, so a bill may keep the number it had in the file.
let importing = false;
const IMPORT_ACTIONS = new Set(['saveParty', 'saveItem', 'saveSupplier', 'saveEmployee', 'saveExpense', 'saveAsset', 'saveBill',
  'savePurchaseBill', 'saveWarehouse', 'saveWhMove', 'saveWhExpense', 'saveWhParty']);

/** Where each kind of journal entry's owner lives in the database. */
const JOURNAL_KINDS = { party: 'parties', supplier: 'suppliers', whParty: 'whParties' };

/**
 * A journal entry's fields: {label, value, payment} rows the user made up,
 * blanks dropped. `payment` is an optional amount that counts toward the
 * entry's money total.
 */
function cleanJournalFields(list) {
  let rows = list;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  return (Array.isArray(rows) ? rows : [])
    .map((f) => {
      const row = { label: String(f?.label || '').trim(), value: String(f?.value || '').trim() };
      const pay = Number(f?.payment);
      if (f?.payment !== '' && f?.payment != null && !Number.isFinite(pay)) throw new Error('A payment amount must be a number');
      if (pay < 0) throw new Error('A payment amount cannot be negative');
      if (pay > 0) row.payment = r2(pay);
      return row;
    })
    .filter((f) => f.label || f.value || f.payment);
}

/** The money total of a journal entry's rows. */
const journalTotal = (fields) => r2(fields.reduce((s, f) => s + (Number(f.payment) || 0), 0));

/** Money on a warehouse party's khata is for those who see cost prices (MONEY_ACTIONS in Code.gs). */
function assertSeesMoney(db) {
  const me = meOf(db);
  if (me && !me.seesCost) throw new Error('Only an admin can record money or rates.');
}

/** Movements typed before a party existed carry only its name: link them to it. */
function linkMovesByName(db, party) {
  let n = 0;
  db.whMoves.forEach((m) => {
    if ((m.type === 'in' || m.type === 'out') && !m.partyId && nameKey(m.partyName) && nameKey(m.partyName) === nameKey(party.name)) {
      m.partyId = party.id;
      n += 1;
    }
  });
  return n;
}
const publicUser = (u) => ({ ...accessOf(u), id: u.id, pages: u.role === 'superadmin' ? null : accessOf(u).pages, status: u.status === 'disabled' ? 'disabled' : 'active', createdAt: u.createdAt || '' });

/** An imported bill's own number, refused if another bill already has it. */
function importBillNo(db, p) {
  const own = importing ? String(p.billNo || '').trim() : '';
  if (own && db.bills.some((b) => String(b.billNo) === own)) throw new Error(`Bill ${own} is already in the system`);
  return own;
}

function seedAdmin(db) {
  if (!db.users.length) {
    db.users.push({
      id: uid('usr'), username: 'admin', role: 'superadmin', status: 'active', name: 'Owner',
      // SHA-256 of "admin123" — change it from Settings after first login
      passwordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
    });
  }
}

/* ------------------------------------------------------------ Login lock */

const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ATTEMPTS_KEY = 'jh_login_attempts';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function attempts() {
  try { return JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '{}') || {}; } catch { return {}; }
}

function lockRemaining(key) {
  const rec = attempts()[key];
  if (!rec || rec.count < MAX_ATTEMPTS) return 0;
  const left = rec.lockedAt + LOCK_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function recordFailure(key) {
  const all = attempts();
  const rec = all[key] || { count: 0, lockedAt: 0 };
  if (rec.count >= MAX_ATTEMPTS && rec.lockedAt + LOCK_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedAt = Date.now();
  all[key] = rec;
  localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(all));
}

function clearFailures(key) {
  const all = attempts();
  delete all[key];
  localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(all));
}

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s?.token) return null;
    if (!s.expiresAt || Date.now() >= s.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- Helpers */

/** Every row recording the same physical cheque: same party, number and bank. */
function chequeSiblings(cheques, chq) {
  const k = (s) => String(s || '').trim().toLowerCase();
  if (!k(chq.chequeNo)) return [chq];
  return cheques.filter((x) => x.id === chq.id ||
    (x.partyId === chq.partyId && k(x.chequeNo) === k(chq.chequeNo) && k(x.bankName) === k(chq.bankName)));
}

function log(db, entityType, entityId, action, description, oldValue = null, newValue = null) {
  db.activityLog.unshift({
    id: uid('log'), entityType, entityId, action, description,
    oldValue: oldValue ? JSON.stringify(oldValue) : '',
    newValue: newValue ? JSON.stringify(newValue) : '',
    user: getSession()?.username || 'system',
    timestamp: new Date().toISOString(),
  });
}

function nextBillNo(db) {
  const y = new Date().getFullYear();
  db.billCounter = db.billCounter || {};
  // A copy of the Sheet arrives without the counter: carry on from the
  // highest number already issued this year.
  let max = db.billCounter[y] || 0;
  for (const b of db.bills) {
    const m = /^(\d{4})-(\d+)$/.exec(String(b.billNo || ''));
    if (m && Number(m[1]) === y) max = Math.max(max, Number(m[2]));
  }
  db.billCounter[y] = max + 1;
  return `${y}-${String(db.billCounter[y]).padStart(4, '0')}`;
}

const openingBillOf = (db, partyId) => db.bills.find((b) => b.partyId === partyId && isOpeningBill(b) && b.status !== 'voided');

/** Refuse a change that would leave the opening bill with less than has already been paid against it. */
function assertOpeningBill(db, partyId, amount) {
  const bill = openingBillOf(db, partyId);
  if (!bill) return;
  const st = billState(bill, db);
  const covered = r2(st.paid + st.pendingCheques + st.returned);
  if (covered > amount + 0.004) {
    throw new Error(amount > 0
      ? `${covered.toFixed(2)} has already been received against the opening balance, so it cannot be set below that. Reverse a payment first.`
      : 'Payments are already recorded against the opening balance, so it cannot be removed. Reverse them first.');
  }
}

/** Create, change or cancel the bill that carries a party's previous balance. */
function writeOpeningBill(db, partyId, amount, date) {
  const bill = openingBillOf(db, partyId);
  const on = String(date || '').slice(0, 10);
  if (bill) {
    const before = { ...bill };
    if (amount > 0) {
      Object.assign(bill, { subtotal: amount, roundOff: 0, totalAmount: amount, date: on || bill.date, dueDate: on || bill.date });
    } else {
      Object.assign(bill, { status: 'voided', voidReason: 'Opening balance removed', voidedAt: new Date().toISOString() });
    }
    log(db, 'bill', bill.id, 'edit', amount > 0 ? `Opening balance changed to ${amount}` : 'Opening balance removed', before, bill);
    return;
  }
  if (!(amount > 0)) return;
  const date_ = on || today();
  const n = db.bills.filter((b) => isOpeningBill(b)).length + 1;
  const rec = {
    id: uid('bil'), billNo: `OB-${String(n).padStart(4, '0')}`, partyId, date: date_,
    subtotal: amount, roundOff: 0, totalAmount: amount, status: 'due', dueDate: date_,
    note: 'Balance brought forward from the previous books', createdAt: new Date().toISOString(),
    delivery: 'delivered', isOpening: true,
  };
  db.bills.push(rec);
  log(db, 'bill', rec.id, 'create', `Opening balance ${amount}`);
}

function nextPurchaseNo(purchaseBills = [], date = today()) {
  const year = String(date).slice(0, 4) || String(new Date().getFullYear());
  let max = 0;
  for (const b of purchaseBills) {
    const m = /^PUR-(\d{4})-(\d+)$/.exec(String(b.purchaseNo || ''));
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  }
  return `PUR-${year}-${String(max + 1).padStart(4, '0')}`;
}

/** Next GRN-2026-0001 style number for a warehouse document. */
export function nextDocNo(moves = [], prefix, date = today()) {
  const year = String(date).slice(0, 4) || String(new Date().getFullYear());
  const re = new RegExp(`^${prefix}-(\\d{4})-(\\d+)$`);
  let max = 0;
  for (const m of moves) {
    const x = re.exec(String(m.docNo || ''));
    if (x && x[1] === year) max = Math.max(max, Number(x[2]));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

/** The item's latest purchase that brought goods in — its cost comes from it. */
function latestPurchase(db, itemId) {
  const voided = new Set(db.purchaseBills.filter((b) => b.status === 'voided').map((b) => b.id));
  let best = null;
  for (const p of db.purchases) {
    if (p.itemId !== itemId || voided.has(p.purchaseBillId)) continue;
    if (!best || String(p.date) >= String(best.date)) best = p;
  }
  return best;
}

function refreshItemCost(db, itemId) {
  const item = db.items.find((i) => i.id === itemId);
  if (!item) return;
  const last = latestPurchase(db, itemId);
  if (last) {
    item.costPrice = r2(last.costPrice);
    item.lastPurchaseDate = last.date;
  } else item.lastPurchaseDate = '';
}

function recomputePurchaseBill(db, bill) {
  bill.totalAmount = r2(db.purchases.filter((p) => p.purchaseBillId === bill.id)
    .reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.costPrice) || 0), 0));
}

function suppliedQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Quantity must be a number');
  return n;
}

/** Keep a bill's whole-bill delivery flag in step with its lines. */
function syncDeliveryFlag(db, bill) {
  const all = db.billItems.filter((l) => l.billId === bill.id)
    .every((l) => lineDelivered(l, bill) >= (Number(l.qty) || 0) - 0.0001);
  const next = all ? 'delivered' : 'pending';
  if (next === 'delivered' && bill.delivery !== 'delivered') bill.deliveredAt = new Date().toISOString();
  if (next === 'pending') bill.deliveredAt = '';
  bill.delivery = next;
}

/** Refuse an edit that leaves goods returned to the supplier that were never bought. */
function assertReturnsCovered(db, billId, line, newItemId, newQty) {
  const returned = db.supplierReturns
    .filter((r) => r.purchaseBillId === billId && r.itemId === line.itemId)
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);
  if (!returned) return;
  const others = db.purchases
    .filter((p) => p.purchaseBillId === billId && p.itemId === line.itemId && p.id !== line.id)
    .reduce((s, p) => s + (Number(p.qty) || 0), 0);
  if (others + (newItemId === line.itemId ? newQty : 0) < returned - 0.0001) {
    throw new Error(`${returned} of this item was already returned to the supplier from this purchase. Delete that return first.`);
  }
}

/** Methods the system writes itself (see RESERVED_METHODS in Code.gs). */
const RESERVED_METHODS = ['Advance', 'Set-off'];

function assertMethod(method) {
  if (RESERVED_METHODS.includes(String(method || ''))) {
    throw new Error(`"${method}" is recorded by the system itself. Choose how the money was actually paid.`);
  }
}

/** Give money taken from a party's advances back, newest advance first. */
function restoreAdvance(db, partyId, amount) {
  let left = r2(amount);
  const mine = db.partyAdvances.filter((a) => a.partyId === partyId && (Number(a.applied) || 0) > 0);
  for (let i = mine.length - 1; i >= 0 && left > 0.004; i--) {
    const back = r2(Math.min(Number(mine[i].applied) || 0, left));
    mine[i].applied = r2((Number(mine[i].applied) || 0) - back);
    left = r2(left - back);
  }
}

// A short pause that makes the browser-only mode feel like a real save. The
// desktop app turns it off: there, saving to this computer should be instant.
let pause = 90;
export function setLocalPause(ms) { pause = ms; }
const settle = () => (pause > 0 ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve());

// Actions run one at a time, like the server's lock: two quick clicks cannot
// interleave their reads and writes.
let chain = Promise.resolve();

export async function localCall(action, payload = {}) {
  const run = chain.then(() => perform(action, payload));
  chain = run.catch(() => {});
  return run;
}

/* ---------------------------------------------------------------- Actions */

async function perform(action, p = {}) {
  await settle();
  const db = load();
  switch (action) {
    case 'login': {
      const username = String(p.username || '').toLowerCase();
      const wait = lockRemaining(username);
      if (wait > 0) throw new Error(`Too many failed attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      const hash = await sha256(p.password || '');
      const user = db.users.find((u) => u.username.toLowerCase() === username);
      if (user?.status === 'disabled') throw new Error('This account is switched off. Ask the super admin.');
      if (!user || user.passwordHash !== hash) {
        recordFailure(username);
        throw new Error('Invalid username or password');
      }
      clearFailures(username);
      const session = {
        token: uid('tok'), ...(ensureSuper(db), accessOf(user)), expiresAt: Date.now() + SESSION_TTL_MS,
        defaultPassword: String(p.password || '') === 'admin123',
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    }

    case 'logout':
      return { ok: true };

    case 'changePassword': {
      const user = db.users.find((u) => u.username === getSession()?.username) || db.users[0];
      if (user.passwordHash !== (await sha256(p.oldPassword || ''))) throw new Error('Current password is incorrect');
      if (!p.newPassword || p.newPassword.length < 6) throw new Error('New password must be at least 6 characters');
      if (p.newPassword === 'admin123') throw new Error('Choose a password other than the default one');
      user.passwordHash = await sha256(p.newPassword);
      log(db, 'user', user.id, 'edit', 'Password changed');
      save();
      const s = getSession();
      return s ? { ok: true, ...s, defaultPassword: false } : { ok: true };
    }

    case 'bootstrap':
    case 'fullBackup': {
      const { users, ...rest } = db;
      const me = meOf(db);
      if (action === 'fullBackup' && me?.role === 'staff') throw new Error('Only an admin can do this.');
      const out = action === 'bootstrap' ? { ...rest, methods: methodsOf(db), me } : rest;
      return me && !me.seesCost ? stripCostData(out) : out;
    }

    /* ----- Parties ----- */
    case 'saveParty': {
      if (!String(p.name || '').trim()) throw new Error('Party name is required');
      const dup = db.parties.find((x) => x.id !== p.id && nameKey(x.name) === nameKey(p.name));
      if (dup) throw new Error(`A party called "${dup.name}" already exists. Use a different name, or open the existing one.`);
      const ph = phoneKey(p.phone);
      const phDup = ph && db.parties.find((x) => x.id !== p.id && phoneKey(x.phone) === ph);
      if (phDup) throw new Error(`This mobile number is already registered on party "${phDup.name}".`);
      // The balance from the paper books lives on a bill of its own, not on the party.
      const { openingBalance, openingDate, ...fields } = p;
      const opening = openingBalance === undefined ? null : r2(openingBalance === '' || openingBalance === null ? 0 : Number(openingBalance));
      if (opening !== null && (!Number.isFinite(opening) || opening < 0)) throw new Error('Opening balance must be zero or more');
      if (p.id) {
        const i = db.parties.findIndex((x) => x.id === p.id);
        if (i < 0) throw new Error('Party not found');
        if (opening !== null) assertOpeningBill(db, p.id, opening);
        const before = { ...db.parties[i] };
        db.parties[i] = { ...before, ...fields };
        if (opening !== null) writeOpeningBill(db, p.id, opening, openingDate);
        log(db, 'party', p.id, 'edit', `Edited party "${p.name}"`, before, db.parties[i]);
        save();
        return db.parties[i];
      }
      const rec = {
        id: uid('pty'), name: p.name.trim(), phone: p.phone || '', address: p.address || '',
        creditLimit: Number(p.creditLimit) || 0,
        defaultDueDays: Number(p.defaultDueDays) || db.settings.defaultCreditDays,
        status: 'active', createdAt: new Date().toISOString(),
      };
      db.parties.push(rec);
      if (opening) writeOpeningBill(db, rec.id, opening, openingDate);
      log(db, 'party', rec.id, 'create', `Added party "${rec.name}"${opening ? ` with opening balance ${opening}` : ''}`);
      save();
      return rec;
    }

    case 'setPartyLock':
    case 'setWhPartyLock': {
      const wh = action === 'setWhPartyLock';
      const party = (wh ? db.whParties : db.parties).find((x) => x.id === p.partyId);
      if (!party) throw new Error('Party not found');
      const next = String(p.password || '');
      if (next && next.length < 4) throw new Error('Party password must be at least 4 characters');
      if (party.lockHash) {
        const cur = String(p.currentPassword || '');
        const partyOk = (await sha256(`${party.lockSalt || ''}:${cur}`)) === party.lockHash;
        const user = db.users.find((u) => u.username === getSession()?.username) || db.users[0];
        const loginOk = user && (await sha256(cur)) === user.passwordHash;
        if (!partyOk && !loginOk) throw new Error('Current password is wrong. Enter this party’s password, or your login password.');
      }
      const before = { ...party };
      if (next) {
        party.lockSalt = uid('slt');
        party.lockHash = await sha256(`${party.lockSalt}:${next}`);
      } else {
        party.lockSalt = '';
        party.lockHash = '';
      }
      log(db, wh ? 'warehouse party' : 'party', party.id, 'edit', next
        ? before.lockHash ? `Changed ledger password for "${party.name}"` : `Locked ledger of "${party.name}" with a password`
        : `Removed ledger password from "${party.name}"`);
      save();
      return { ok: true, locked: !!next };
    }

    case 'archiveParty':
      return toggleArchive(db, db.parties, p.id, 'party', 'Party');

    /* ----- Items ----- */
    case 'saveItem': {
      if (!String(p.name || '').trim()) throw new Error('Item name is required');
      const dup = db.items.find((x) => x.id !== p.id && nameKey(x.name) === nameKey(p.name));
      if (dup) throw new Error(`An item called "${dup.name}" already exists. Use a different name, or edit the existing one.`);
      if (p.id) {
        const i = db.items.findIndex((x) => x.id === p.id);
        if (i < 0) throw new Error('Item not found');
        const before = { ...db.items[i] };
        db.items[i] = { ...before, ...p };
        log(db, 'item', p.id, 'edit', `Edited item "${p.name}"`, before, db.items[i]);
        save();
        return db.items[i];
      }
      const rec = {
        id: uid('itm'), name: p.name.trim(), baseUnit: p.baseUnit || 'Piece', altUnit: p.altUnit || '',
        conversionRate: Number(p.conversionRate) || 0, category: p.category || '',
        costPrice: Number(p.costPrice) || 0, lastPurchaseDate: '', openingStock: Number(p.openingStock) || 0,
        lowStockAlert: Number(p.lowStockAlert) || 0, status: 'active',
      };
      db.items.push(rec);
      log(db, 'item', rec.id, 'create', `Added item "${rec.name}"`);
      save();
      return rec;
    }

    case 'archiveItem':
      return toggleArchive(db, db.items, p.id, 'item', 'Item');

    /* ----- Bills ----- */
    case 'saveBill': {
      if (!p.partyId) throw new Error('Select a party');
      if (!p.lines?.length) throw new Error('Add at least one item');
      if (!db.parties.some((x) => x.id === p.partyId)) throw new Error('Party not found');
      p.lines.forEach((l, i) => {
        const q = Number(l.qty);
        const price = Number(l.price);
        if (!Number.isFinite(q) || q <= 0) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
        if (!Number.isFinite(price) || price < 0) throw new Error(`Line ${i + 1}: price must be zero or more`);
        if (!db.items.some((it) => it.id === l.itemId)) throw new Error(`Line ${i + 1}: item not found`);
        if (l.warehouseId && !db.warehouses.some((w) => w.id === l.warehouseId)) throw new Error(`Line ${i + 1}: warehouse not found`);
      });
      const totals = billTotals(p.lines.map((l) => ({ qty: Number(l.qty), price: Number(l.price) })), db.settings.roundingRule);
      const editing = !!p.id;
      let bill;
      const deliveredBefore = new Map();
      // Same checks as saveBill in Code.gs, all before anything is written.
      let covered = 0;
      if (editing) {
        const old = db.bills.find((b) => b.id === p.id);
        if (!old) throw new Error('Bill not found');
        if (old.status === 'voided') throw new Error('A voided bill cannot be edited');
        const st = billState(old, db);
        const paidSoFar = r2(st.paid + st.pendingCheques);
        covered = r2(paidSoFar + st.returned);
        if (covered > r2(totals.total) + 0.004) {
          throw new Error(`This bill already has ${paidSoFar.toFixed(2)} paid${st.returned > 0 ? ` and ${st.returned.toFixed(2)} returned` : ''} against it, so it cannot be reduced to ${totals.total.toFixed(2)}. Reverse a payment first.`);
        }
        if (p.partyId !== old.partyId && db.payments.some((x) => x.billId === p.id)) {
          throw new Error('This bill has payments recorded against it, so it cannot be moved to another party. Void it and write a new bill for the right party instead.');
        }
      }
      assertBillWarehouseStock(db, p.lines, p.id);
      let payTotal = 0;
      (p.payments || []).forEach((pay) => {
        if (!(Number(pay.amount) > 0)) return;
        assertMethod(pay.method);
        payTotal = r2(payTotal + r2(pay.amount));
      });
      const wantAdvance = Number(p.advanceApplied) > 0 ? r2(p.advanceApplied) : 0;
      if (wantAdvance > 0) {
        const available = r2(db.partyAdvances.filter((a) => a.partyId === p.partyId)
          .reduce((s, a) => s + Math.max(0, (Number(a.amount) || 0) - (Number(a.applied) || 0)), 0));
        if (wantAdvance > available + 0.004) throw new Error(`Advance applied (${wantAdvance.toFixed(2)}) exceeds this party’s available advance of ${available.toFixed(2)}.`);
      }
      const room = r2(totals.total - covered);
      if (r2(payTotal + wantAdvance) > room + 0.004) {
        throw new Error(`Payments of ${r2(payTotal + wantAdvance).toFixed(2)} are more than ${editing ? 'is left to pay on this bill' : 'the bill total'} (${room.toFixed(2)}). Reduce a payment, or record the extra as an advance from the party ledger.`);
      }
      if (editing) {
        const i = db.bills.findIndex((b) => b.id === p.id);
        const before = { ...db.bills[i] };
        bill = {
          ...before, partyId: p.partyId, date: p.date, subtotal: totals.subtotal, roundOff: totals.roundOff,
          totalAmount: totals.total, dueDate: p.dueDate, note: p.note || '',
          delivery: p.delivery || before.delivery || 'pending',
        };
        db.bills[i] = bill;
        db.billItems.filter((l) => l.billId === p.id).forEach((l) => {
          deliveredBefore.set(l.itemId, (deliveredBefore.get(l.itemId) || 0) + lineDelivered(l, before));
        });
        db.billItems = db.billItems.filter((l) => l.billId !== p.id);
        log(db, 'bill', bill.id, 'edit', `Edited Bill ${bill.billNo}`, before, bill);
      } else {
        bill = {
          id: uid('bil'), billNo: importBillNo(db, p) || nextBillNo(db), partyId: p.partyId, date: p.date || today(),
          subtotal: totals.subtotal, roundOff: totals.roundOff, totalAmount: totals.total, status: 'due',
          dueDate: p.dueDate || addDays(p.date || today(), db.settings.defaultCreditDays),
          note: p.note || '', createdAt: new Date().toISOString(),
          delivery: p.delivery === 'pending' ? 'pending' : 'delivered',
        };
        db.bills.push(bill);
        log(db, 'bill', bill.id, 'create', `Created Bill ${bill.billNo}`);
      }
      p.lines.forEach((l) => {
        const item = db.items.find((it) => it.id === l.itemId);
        const q = Number(l.qty) || 0;
        let delivered = suppliedQty(l.deliveredQty);
        if (delivered === null) {
          if (p.delivery === 'delivered' || (!editing && p.delivery !== 'pending')) delivered = q;
          else {
            delivered = Math.min(q, deliveredBefore.get(l.itemId) || 0);
            deliveredBefore.set(l.itemId, r2((deliveredBefore.get(l.itemId) || 0) - delivered));
          }
        }
        if (delivered < 0 || delivered > q + 0.0001) throw new Error(`${item?.name || 'Item'}: delivered quantity must be between 0 and ${q}`);
        db.billItems.push({
          id: uid('bli'), billId: bill.id, itemId: l.itemId, qty: q, unit: l.unit || item?.baseUnit || 'Piece',
          price: r2(l.price), costPriceAtSale: r2(l.costPriceAtSale ?? item?.costPrice ?? 0),
          lineTotal: r2((Number(l.qty) || 0) * (Number(l.price) || 0)), deliveredQty: r2(delivered),
          warehouseId: l.warehouseId || '',
        });
        db.partyItemPrices.push({
          id: uid('pip'), partyId: bill.partyId, itemId: l.itemId, price: r2(l.price),
          unit: l.unit || item?.baseUnit || 'Piece', date: bill.date,
        });
      });
      (p.payments || []).forEach((pay) => {
        if (!(Number(pay.amount) > 0)) return;
        const rec = { id: uid('pay'), billId: bill.id, partyId: bill.partyId, method: pay.method, amount: r2(pay.amount), date: bill.date, note: pay.note || '', reversed: false };
        db.payments.push(rec);
        if (pay.method === 'Cheque' && pay.cheque) db.cheques.push(chequeRow(pay.cheque, { billId: bill.id, partyId: bill.partyId, paymentId: rec.id, amount: pay.amount, date: bill.date }));
      });
      if (Number(p.advanceApplied) > 0) {
        let want = Number(p.advanceApplied);
        db.partyAdvances.filter((a) => a.partyId === bill.partyId).forEach((a) => {
          if (want <= 0) return;
          const avail = (Number(a.amount) || 0) - (Number(a.applied) || 0);
          if (avail <= 0) return;
          const use = Math.min(avail, want);
          a.applied = r2((Number(a.applied) || 0) + use);
          want = r2(want - use);
        });
        db.payments.push({ id: uid('pay'), billId: bill.id, partyId: bill.partyId, method: 'Advance', amount: r2(p.advanceApplied), date: bill.date, note: 'Advance applied', reversed: false });
      }
      syncDeliveryFlag(db, bill);
      save();
      return bill;
    }

    case 'setDelivery': {
      const bill = db.bills.find((b) => b.id === p.id);
      if (!bill) throw new Error('Bill not found');
      if (p.delivery !== 'pending' && p.delivery !== 'delivered') throw new Error('Delivery must be pending or delivered');
      if (bill.status === 'voided') throw new Error('A voided bill cannot be delivered');
      const before = { ...bill };
      bill.delivery = p.delivery;
      bill.deliveredAt = p.delivery === 'delivered' ? new Date().toISOString() : '';
      db.billItems.filter((l) => l.billId === bill.id).forEach((l) => {
        l.deliveredQty = (p.delivery === 'delivered' && Number(l.qty)) || 0;
      });
      log(db, 'bill', bill.id, 'edit', `Bill ${bill.billNo} marked ${p.delivery}`, before, bill);
      save();
      return bill;
    }

    case 'setLineDelivery': {
      const bill = db.bills.find((b) => b.id === p.billId);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('A voided bill cannot be delivered');
      const changes = p.lines || [];
      if (!changes.length) throw new Error('Nothing to update');
      const before = { ...bill };
      const done = changes.map((c) => {
        const line = db.billItems.find((l) => l.id === c.id && l.billId === bill.id);
        if (!line) throw new Error('Bill line not found');
        const q = Number(line.qty) || 0;
        const v = suppliedQty(c.deliveredQty);
        if (v === null || v < 0 || v > q + 0.0001) {
          throw new Error(`${db.items.find((i) => i.id === line.itemId)?.name || 'Item'}: delivered quantity must be between 0 and ${q}`);
        }
        return [line, r2(v)];
      });
      done.forEach(([line, v]) => { line.deliveredQty = v; });
      syncDeliveryFlag(db, bill);
      const lines = db.billItems.filter((l) => l.billId === bill.id);
      const sent = r2(lines.reduce((s, l) => s + lineDelivered(l, bill), 0));
      const total = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
      log(db, 'bill', bill.id, 'edit', `Bill ${bill.billNo} delivery updated: ${sent} of ${total} delivered`, before, bill);
      save();
      return bill;
    }

    /**
     * Hand over goods from a warehouse. The quantity delivered comes off that
     * warehouse's stock: a line sent from elsewhere is split, and the delivered
     * part becomes its own line against the warehouse. The bill total is
     * unchanged. Mirrors deliverFromWarehouse in Code.gs.
     */
    case 'deliverFromWarehouse': {
      const bill = db.bills.find((b) => b.id === p.billId);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('A voided bill cannot be delivered');
      const wh = db.warehouses.find((w) => w.id === p.warehouseId);
      if (!wh) throw new Error('Select a warehouse');
      if (wh.status === 'archived') throw new Error(`Warehouse "${wh.name}" is archived. Restore it first.`);
      const changes = (p.lines || []).filter((c) => Number(c.qty) > 0);
      if (!changes.length) throw new Error('Nothing to deliver');
      const before = { ...bill };
      const stock = warehouseStockMap(db).get(wh.id) || new Map();
      const want = new Map();
      const seen = new Set();
      const plan = changes.map((c) => {
        const line = db.billItems.find((l) => l.id === c.id && l.billId === bill.id);
        if (!line) throw new Error('Bill line not found');
        if (seen.has(line.id)) throw new Error('A line was listed twice');
        seen.add(line.id);
        const item = db.items.find((i) => i.id === line.itemId);
        const q = r2(Number(c.qty));
        const left = r2((Number(line.qty) || 0) - lineDelivered(line, bill));
        if (!Number.isFinite(q) || q > left + 0.0001) throw new Error(`${item?.name || 'Item'}: only ${left} still to deliver`);
        // Goods already booked against this warehouse are already off its stock.
        if ((line.warehouseId || '') !== wh.id) want.set(line.itemId, r2((want.get(line.itemId) || 0) + q));
        return [line, q];
      });
      for (const [itemId, q] of want) {
        const have = stock.get(itemId) || 0;
        if (q > have + 0.0001) {
          const item = db.items.find((i) => i.id === itemId);
          throw new Error(`${item?.name || 'Item'}: only ${have} ${item?.baseUnit || ''} in ${wh.name}, cannot deliver ${q} from it.`.replace(/\s+,/, ','));
        }
      }
      plan.forEach(([line, q]) => {
        const total = Number(line.qty) || 0;
        const done = lineDelivered(line, bill);
        if ((line.warehouseId || '') === wh.id) { line.deliveredQty = r2(done + q); return; }
        if (done < 0.0001 && q >= total - 0.0001) { line.warehouseId = wh.id; line.deliveredQty = r2(total); return; }
        line.qty = r2(total - q);
        line.lineTotal = r2(line.qty * (Number(line.price) || 0));
        line.deliveredQty = r2(done);
        db.billItems.push({
          ...line, id: uid('bli'), qty: q, lineTotal: r2(q * (Number(line.price) || 0)), deliveredQty: q, warehouseId: wh.id,
        });
      });
      syncDeliveryFlag(db, bill);
      const sent = r2(plan.reduce((s, [, q]) => s + q, 0));
      log(db, 'bill', bill.id, 'edit', `Bill ${bill.billNo}: ${sent} delivered from ${wh.name}`, before, bill);
      save();
      return bill;
    }

    case 'voidBill': {
      const bill = db.bills.find((b) => b.id === p.id);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('This bill is already voided');
      const before = { ...bill };
      bill.status = 'voided';
      bill.voidReason = p.reason || '';
      bill.voidedAt = new Date().toISOString();
      log(db, 'bill', bill.id, 'void', `Voided Bill ${bill.billNo}${p.reason ? ` — ${p.reason}` : ''}`, before, bill);
      save();
      return bill;
    }

    // Removes the bill for good, with its lines, payments, cheques and returns.
    case 'deleteBill': {
      const i = db.bills.findIndex((b) => b.id === p.id);
      if (i < 0) throw new Error('Bill not found');
      const bill = db.bills[i];
      const pays = db.payments.filter((x) => x.billId === bill.id);
      if (pays.some((x) => x.method === 'Set-off')) {
        throw new Error('Part of this bill was cleared by a set-off. Delete that set-off payment first, then delete the bill.');
      }
      const payIds = new Set(pays.map((x) => x.id));
      // Money taken from the party's advance goes back to it.
      pays.forEach((x) => { if (x.method === 'Advance' && !x.isAdvance && !x.reversed) restoreAdvance(db, x.partyId, x.amount); });
      const cheques = db.cheques.filter((c) => c.billId === bill.id || payIds.has(c.paymentId));
      const returns = db.returns.filter((r) => r.billId === bill.id);
      db.cheques = db.cheques.filter((c) => !cheques.includes(c));
      db.payments = db.payments.filter((x) => !payIds.has(x.id));
      db.returns = db.returns.filter((r) => r.billId !== bill.id);
      db.billItems = db.billItems.filter((l) => l.billId !== bill.id);
      db.bills.splice(i, 1);
      log(db, 'bill', bill.id, 'delete', `Deleted Bill ${bill.billNo}` +
        (pays.length ? `, ${pays.length} payment${pays.length === 1 ? '' : 's'}` : '') +
        (cheques.length ? `, ${cheques.length} cheque${cheques.length === 1 ? '' : 's'}` : '') +
        (returns.length ? `, ${returns.length} return${returns.length === 1 ? '' : 's'}` : '') +
        (p.reason ? ` — ${p.reason}` : ''), bill, null);
      save();
      return { ok: true, payments: pays.length, cheques: cheques.length, returns: returns.length };
    }

    /* ----- Payments ----- */
    case 'addPayment': {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a payment amount');
      assertMethod(p.method);
      const bill = db.bills.find((b) => b.id === p.billId);
      if (!bill) throw new Error('Bill not found');
      // The bill decides whose money this is, whatever the request says.
      p.partyId = bill.partyId;
      if (bill.status === 'voided') throw new Error('A voided bill cannot take a payment');
      const st = billState(bill, db);
      const room = payableNow(st);
      if (r2(amount) > r2(room) + 0.004) {
        throw new Error(`Payment exceeds the amount due (${room.toFixed(2)}${st.pendingCheques > 0 ? `, after ${st.pendingCheques.toFixed(2)} in uncleared cheques` : ''}). Record the extra as an advance instead.`);
      }
      const rec = { id: uid('pay'), billId: p.billId, partyId: p.partyId, method: p.method || 'Cash', amount: r2(p.amount), date: p.date || today(), note: p.note || '', reversed: false };
      db.payments.push(rec);
      if (p.method === 'Cheque' && p.cheque) db.cheques.push(chequeRow(p.cheque, { billId: p.billId, partyId: p.partyId, paymentId: rec.id, amount: p.amount, date: rec.date }));
      log(db, 'payment', rec.id, 'create', `Payment received${bill ? ` for Bill ${bill.billNo}` : ''} — ${rec.method}`);
      save();
      return rec;
    }

    case 'reversePayment': {
      const pay = db.payments.find((x) => x.id === p.id);
      if (!pay) throw new Error('Payment not found');
      if (pay.reversed) throw new Error('This payment is already reversed');
      const before = { ...pay };
      pay.reversed = true;
      pay.reversedAt = new Date().toISOString();
      pay.reverseReason = p.reason || '';
      // A bill paid from an advance: the money goes back to the advance.
      if (pay.method === 'Advance' && !pay.isAdvance) restoreAdvance(db, pay.partyId, pay.amount);
      log(db, 'payment', pay.id, 'reverse', `Reversed payment of ${pay.amount} (${pay.method})${p.reason ? ` — ${p.reason}` : ''}`, before, pay);
      save();
      return pay;
    }

    case 'deletePayment': {
      const i = db.payments.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Payment not found');
      const pay = db.payments[i];
      if (pay.isAdvance && !p.orphan) throw new Error('This is an advance receipt. Delete the advance itself from the Advances list, which removes this receipt with it and keeps the party’s advance balance correct.');
      const killed = db.cheques.filter((c) => c.paymentId === pay.id).map((c) => c.chequeNo || c.id);
      db.cheques = db.cheques.filter((c) => c.paymentId !== pay.id);
      db.payments.splice(i, 1);
      if (pay.method === 'Advance' && !pay.isAdvance && !pay.reversed) restoreAdvance(db, pay.partyId, pay.amount);
      log(db, 'payment', pay.id, 'delete', `Deleted payment of ${pay.amount} (${pay.method})` +
        (killed.length ? ` and cheque ${killed.join(', ')}` : '') + (p.reason ? ` — ${p.reason}` : ''), pay, null);
      save();
      return { ok: true, deletedCheques: killed.length };
    }

    case 'updatePayment': {
      const pay = db.payments.find((x) => x.id === p.id);
      if (!pay) throw new Error('Payment not found');
      if (pay.reversed) throw new Error('A reversed payment cannot be edited');
      const hasCheque = db.cheques.some((c) => c.paymentId === pay.id);
      const amountChanges = p.amount !== undefined && r2(p.amount) !== r2(pay.amount);
      const methodChanges = p.method !== undefined && p.method !== pay.method;
      if (RESERVED_METHODS.includes(pay.method) && (amountChanges || methodChanges)) {
        throw new Error(`This payment was made ${pay.method === 'Advance' ? 'from the party’s advance' : 'by set-off'}. Only its date and note can be edited; delete it to undo it.`);
      }
      if (methodChanges) {
        assertMethod(p.method);
        if (hasCheque) throw new Error('A cheque payment keeps its method. Delete it and record the payment again instead.');
        if (p.method === 'Cheque') throw new Error('Record a cheque as a new payment, so its number and bank are kept.');
      }
      const before = { ...pay };
      if (p.amount !== undefined) {
        const amt = Number(p.amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter a payment amount');
        if (pay.billId) {
          const bill = db.bills.find((b) => b.id === pay.billId);
          if (bill) {
            const st = billState(bill, { payments: db.payments.filter((x) => x.id !== pay.id), returns: db.returns, cheques: db.cheques });
            const room = payableNow(st);
            if (r2(amt) > room + 0.004) {
              throw new Error(`Payment exceeds the amount due (${room.toFixed(2)}${st.pendingCheques > 0 ? `, after ${st.pendingCheques.toFixed(2)} in uncleared cheques` : ''}). Record the extra as an advance instead.`);
            }
          }
        }
        pay.amount = r2(amt);
        db.cheques.forEach((c) => { if (c.paymentId === pay.id) { c.amount = pay.amount; } });
      }
      if (p.method !== undefined) pay.method = p.method;
      if (p.date !== undefined) pay.date = p.date;
      if (p.note !== undefined) pay.note = p.note || '';
      log(db, 'payment', pay.id, 'edit', 'Edited payment', before, pay);
      save();
      return pay;
    }

    case 'settleParty': {
      const total = Number(p.amount);
      if (!Number.isFinite(total) || total <= 0) throw new Error('Enter a payment amount');
      if (!p.partyId) throw new Error('Select a party');
      if (!db.parties.some((x) => x.id === p.partyId)) throw new Error('Party not found');
      assertMethod(p.method);
      const date = p.date || today();
      const method = p.method || 'Cash';
      const chequeFor = (paymentId, amount) => {
        if (method !== 'Cheque') return;
        db.cheques.push({ ...chequeRow(p.cheque || {}, { billId: '', partyId: p.partyId, paymentId, amount, date }), statusChangedAt: '' });
      };
      const bills = db.bills.filter((b) => b.partyId === p.partyId && b.status !== 'voided')
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.billNo).localeCompare(String(b.billNo)));
      let left = r2(total);
      const applied = [];
      const journalApplied = [];
      const groupId = uid('grp');
      // Bills and the journal's "to collect" entries share one queue, oldest first
      // (a bill comes before a journal entry of the same day). A cheque is not cash,
      // so it only ever settles bills.
      const queue = bills.map((b) => ({ kind: 'bill', date: String(b.date || ''), order: String(b.billNo || ''), b }));
      if (method !== 'Cheque') {
        journalClaims('party', p.partyId, db)
          .filter((e) => e.direction === 'take' && e.outstanding > 0.004)
          .forEach((e) => queue.push({ kind: 'journal', date: String(e.date || ''), order: String(e.createdAt || ''), e }));
      }
      queue.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.order.localeCompare(b.order) : a.kind === 'bill' ? -1 : 1));
      for (const item of queue) {
        if (left <= 0.004) break;
        if (item.kind === 'journal') {
          const use = r2(Math.min(item.e.outstanding, left));
          db.journalPayments.push({
            id: uid('jpy'), journalId: item.e.id, kind: 'party', partyId: p.partyId, direction: 'in', amount: use,
            date, method, note: p.note || 'Account payment', createdAt: new Date().toISOString(), createdBy: getSession()?.username || 'system', groupId,
          });
          journalApplied.push({ journalId: item.e.id, title: item.e.title || 'Journal entry', amount: use });
          left = r2(left - use);
          continue;
        }
        const b = item.b;
        const st = billState(b, { payments: db.payments, returns: db.returns, cheques: db.cheques });
        // What is payable now: a cheque waiting to clear already covers its share.
        const due = payableNow(st);
        if (due <= 0.004) continue;
        const use = r2(Math.min(due, left));
        const id = uid('pay');
        db.payments.push({ id, billId: b.id, partyId: p.partyId, method, amount: use, date, note: p.note || 'Account payment', reversed: false, reversedAt: '', reverseReason: '', isAdvance: false, groupId });
        chequeFor(id, use);
        applied.push({ billId: b.id, billNo: b.billNo, amount: use });
        left = r2(left - use);
      }
      let advance = 0;
      if (left > 0.004) {
        advance = left;
        db.partyAdvances.push({ id: uid('adv'), partyId: p.partyId, amount: advance, applied: 0, dateReceived: date, method, note: p.note || 'Overpayment held as advance' });
        const id = uid('pay');
        db.payments.push({ id, billId: '', partyId: p.partyId, method, amount: advance, date, note: 'Advance received', reversed: false, reversedAt: '', reverseReason: '', isAdvance: true, groupId });
        chequeFor(id, advance);
      }
      log(db, 'payment', p.partyId, 'create', `Account payment ${r2(total)} — settled ${applied.length} bill${applied.length === 1 ? '' : 's'}`
        + (journalApplied.length ? `, ${r2(journalApplied.reduce((s, x) => s + x.amount, 0))} against the journal` : '')
        + (advance > 0 ? `, ${advance} held as advance` : ''));
      save();
      return { applied, journalApplied, advance, total: r2(total) };
    }

    /* ----- Returns ----- */
    case 'addReturn': {
      const bill = db.bills.find((b) => b.id === p.billId);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('A voided bill cannot take a return');
      const q = Number(p.qty) || 0;
      if (q <= 0) throw new Error('Return quantity must be greater than zero');
      const sold = db.billItems.filter((l) => l.billId === p.billId && l.itemId === p.itemId).reduce((s, l) => s + (Number(l.qty) || 0), 0);
      if (!sold) throw new Error('That item is not on this bill');
      const already = db.returns.filter((r) => r.billId === p.billId && r.itemId === p.itemId).reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const qtyLeft = r2(sold - already);
      if (q > qtyLeft + 0.0001) throw new Error(`Only ${qtyLeft} of that item is left to return (${sold} sold, ${already} already returned).`);
      const value = r2(p.valueAdjusted);
      if (value < 0) throw new Error('Return value cannot be negative');
      const returnedValue = db.returns.filter((r) => r.billId === p.billId).reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0);
      const valueLeft = r2(r2(bill.totalAmount) - returnedValue);
      if (value > valueLeft + 0.004) throw new Error(`Return value cannot exceed what is left on the bill (${valueLeft.toFixed(2)}).`);
      const rec = { id: uid('ret'), billId: p.billId, itemId: p.itemId, qty: Number(p.qty) || 0, valueAdjusted: r2(p.valueAdjusted), restock: !!p.restock, date: p.date || today(), note: p.note || '' };
      db.returns.push(rec);
      log(db, 'return', rec.id, 'create', `Return against Bill ${bill.billNo} — value ${rec.valueAdjusted}`);
      save();
      return rec;
    }

    /* ----- Cheques ----- */
    case 'saveCheque': {
      if (p.id) {
        const i = db.cheques.findIndex((c) => c.id === p.id);
        if (i < 0) throw new Error('Cheque not found');
        db.cheques[i] = { ...db.cheques[i], ...p };
        save();
        return db.cheques[i];
      }
      const rec = { id: uid('chq'), status: 'pending', ...p, amount: r2(p.amount) };
      db.cheques.push(rec);
      log(db, 'cheque', rec.id, 'create', `Cheque ${rec.chequeNo} recorded`);
      save();
      return rec;
    }

    case 'setChequeStatus': {
      const chq = db.cheques.find((c) => c.id === p.id);
      if (!chq) throw new Error('Cheque not found');
      const before = { ...chq };
      const at = new Date().toISOString();
      const rows = chequeSiblings(db.cheques, chq);
      if (p.status !== 'bounced') {
        rows.filter((c) => c.status === 'bounced' && c.paymentId).forEach((c) => {
          const pay = db.payments.find((x) => x.id === c.paymentId);
          const bill = pay && !pay.reversed && pay.billId && db.bills.find((b) => b.id === pay.billId);
          if (!bill) return;
          const room = payableNow(billState(bill, db));
          if (r2(pay.amount) > room + 0.004) {
            throw new Error(`Bill ${bill.billNo} has only ${room.toFixed(2)} left to pay, so this bounced cheque of ${r2(pay.amount).toFixed(2)} cannot be revived. Record the money as a new payment instead.`);
          }
        });
      }
      rows.forEach((c) => {
        c.status = p.status;
        c.statusChangedAt = at;
      });
      log(db, 'cheque', chq.id, 'edit', `Cheque ${chq.chequeNo} marked ${p.status}` + (rows.length > 1 ? ` (${rows.length} bill entries)` : ''), before, chq);
      save();
      return chq;
    }

    case 'deleteCheque': {
      const i = db.cheques.findIndex((c) => c.id === p.id);
      if (i < 0) throw new Error('Cheque not found');
      const chq = db.cheques[i];
      db.cheques.splice(i, 1);
      log(db, 'cheque', chq.id, 'delete', `Deleted cheque ${chq.chequeNo || ''} of ${chq.amount}` + (p.reason ? ` — ${p.reason}` : ''), chq, null);
      save();
      return { ok: true };
    }

    /* ----- Advances ----- */
    case 'addAdvance': {
      if (!(Number(p.amount) > 0)) throw new Error('Enter an advance amount');
      const rec = { id: uid('adv'), partyId: p.partyId, amount: r2(p.amount), applied: 0, dateReceived: p.dateReceived || today(), method: p.method || 'Cash', note: p.note || '' };
      db.partyAdvances.push(rec);
      const payId = uid('pay');
      db.payments.push({ id: payId, billId: null, partyId: p.partyId, method: rec.method, amount: rec.amount, date: rec.dateReceived, note: 'Advance received', reversed: false, isAdvance: true });
      if (rec.method === 'Cheque') {
        db.cheques.push({ ...chequeRow(p.cheque || {}, { billId: '', partyId: p.partyId, paymentId: payId, amount: rec.amount, date: rec.dateReceived }), statusChangedAt: '' });
      }
      log(db, 'advance', rec.id, 'create', `Advance received ${rec.amount}`);
      save();
      return rec;
    }

    case 'deleteAdvance': {
      const i = db.partyAdvances.findIndex((a) => a.id === p.id);
      if (i < 0) throw new Error('Advance not found');
      const adv = db.partyAdvances[i];
      const amount = r2(adv.amount);
      const applied = r2(adv.applied);
      const receipts = db.payments.filter((x) => x.isAdvance && x.partyId === adv.partyId && r2(x.amount) === amount);
      const receipt = receipts.length === 1 ? receipts[0] : receipts.find((x) => dayOf(x.date) === dayOf(adv.dateReceived)) || receipts[0];
      const reopened = [];
      let budget = applied;
      const spent = new Set();
      if (applied > 0.004) {
        for (const x of db.payments) {
          if (budget <= 0.004) break;
          if (x.partyId !== adv.partyId || x.method !== 'Advance' || x.reversed) continue;
          const bill = db.bills.find((b) => b.id === x.billId);
          reopened.push({ billId: x.billId, billNo: bill?.billNo || '', amount: r2(x.amount) });
          spent.add(x.id);
          budget = r2(budget - r2(x.amount));
        }
      }
      const gone = new Set(spent);
      if (receipt) gone.add(receipt.id);
      db.cheques = db.cheques.filter((c) => !gone.has(c.paymentId));
      db.payments = db.payments.filter((x) => !gone.has(x.id));
      db.partyAdvances.splice(i, 1);
      const party = db.parties.find((x) => x.id === adv.partyId);
      log(db, 'advance', adv.id, 'delete', `Deleted advance of ${amount} for ${party?.name || 'party'}` +
        (reopened.length ? ` — reopened ${reopened.length} bill${reopened.length === 1 ? '' : 's'}` : '') +
        (p.reason ? ` — ${p.reason}` : ''), adv, null);
      save();
      return { ok: true, amount, reopened, reopenedValue: r2(reopened.reduce((s, x) => s + x.amount, 0)) };
    }

    /* ----- Purchases ----- */
    case 'savePurchase': {
      const rec = { id: uid('pur'), itemId: p.itemId, supplierName: p.supplierName || '', qty: Number(p.qty) || 0, costPrice: r2(p.costPrice), date: p.date || today(), note: p.note || '', method: p.method || 'Cash' };
      db.purchases.push(rec);
      const item = db.items.find((i) => i.id === p.itemId);
      if (item) {
        item.costPrice = rec.costPrice;
        item.lastPurchaseDate = rec.date;
      }
      log(db, 'purchase', rec.id, 'create', `Purchased ${rec.qty} × ${item?.name || 'item'} @ ${rec.costPrice}`);
      save();
      return rec;
    }

    case 'updatePurchase': {
      const rec = db.purchases.find((x) => x.id === p.id);
      if (!rec) throw new Error('Purchase not found');
      const bill = rec.purchaseBillId ? db.purchaseBills.find((b) => b.id === rec.purchaseBillId) : null;
      if (bill?.status === 'voided') throw new Error('This purchase was cancelled and cannot be edited');
      const itemId = p.itemId || rec.itemId;
      if (!db.items.some((i) => i.id === itemId)) throw new Error('Select an item');
      const q = Number(p.qty);
      if (!(q > 0)) throw new Error('Quantity must be greater than zero');
      const cost = Number(p.costPrice);
      if (!(cost >= 0)) throw new Error('Cost price must be zero or more');
      if (bill) assertReturnsCovered(db, bill.id, rec, itemId, q);
      const before = { ...rec };
      const wasLatest = latestPurchase(db, rec.itemId)?.id === rec.id;
      const given = suppliedQty(p.receivedQty);
      const hadAll = lineReceived(rec) >= (Number(rec.qty) || 0) - 0.0001;
      const received = given !== null ? given : hadAll ? q : Math.min(q, lineReceived(rec));
      if (received < 0 || received > q + 0.0001) throw new Error(`Received quantity must be between 0 and ${q}`);
      rec.receivedQty = r2(received);
      rec.itemId = itemId;
      rec.qty = q;
      rec.costPrice = r2(cost);
      if (p.note !== undefined) rec.note = p.note || '';
      if (!bill) {
        if (p.supplierName !== undefined) rec.supplierName = p.supplierName || '';
        if (p.date) rec.date = p.date;
        if (p.method) rec.method = p.method;
      }
      if (bill) recomputePurchaseBill(db, bill);
      if (wasLatest) refreshItemCost(db, before.itemId);
      if (latestPurchase(db, itemId)?.id === rec.id) refreshItemCost(db, itemId);
      const item = db.items.find((i) => i.id === itemId);
      log(db, 'purchase', rec.id, 'edit', `Edited purchase: ${rec.qty} × ${item?.name || 'item'} @ ${rec.costPrice}` + (bill ? ` (${bill.purchaseNo})` : ''), before, rec);
      save();
      return rec;
    }

    case 'deletePurchase': {
      const i = db.purchases.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Purchase not found');
      const rec = db.purchases[i];
      const bill = rec.purchaseBillId ? db.purchaseBills.find((b) => b.id === rec.purchaseBillId) : null;
      if (bill) assertReturnsCovered(db, bill.id, rec, rec.itemId, 0);
      const wasLatest = latestPurchase(db, rec.itemId)?.id === rec.id;
      db.purchases.splice(i, 1);
      let billRemoved = false;
      if (bill) {
        if (db.purchases.some((x) => x.purchaseBillId === bill.id)) recomputePurchaseBill(db, bill);
        else {
          db.supplierPayments.forEach((sp) => {
            if (sp.purchaseBillId === bill.id) { sp.purchaseBillId = ''; }
          });
          db.purchaseBills = db.purchaseBills.filter((b) => b.id !== bill.id);
          billRemoved = true;
        }
      }
      if (wasLatest) refreshItemCost(db, rec.itemId);
      const item = db.items.find((x) => x.id === rec.itemId);
      log(db, 'purchase', rec.id, 'delete', `Deleted purchase: ${rec.qty} × ${item?.name || 'item'} @ ${rec.costPrice}` +
        (bill ? (billRemoved ? ` — purchase ${bill.purchaseNo} removed` : ` from ${bill.purchaseNo}`) : '') +
        (p.reason ? ` — ${p.reason}` : ''), rec, null);
      save();
      return { ok: true, billRemoved };
    }

    /* ----- Suppliers ----- */
    case 'saveSupplier': {
      if (!String(p.name || '').trim()) throw new Error('Supplier name is required');
      const dup = db.suppliers.find((s) => s.id !== p.id && nameKey(s.name) === nameKey(p.name));
      if (dup) throw new Error(`A supplier called "${dup.name}" already exists. Use a different name, or open the existing one.`);
      const fields = { name: p.name.trim(), phone: p.phone || '', address: p.address || '', openingBalance: r2(p.openingBalance) };
      if (p.id) {
        const i = db.suppliers.findIndex((s) => s.id === p.id);
        if (i < 0) throw new Error('Supplier not found');
        const before = { ...db.suppliers[i] };
        db.suppliers[i] = { ...before, ...fields };
        log(db, 'supplier', p.id, 'edit', `Edited supplier "${fields.name}"`, before, db.suppliers[i]);
        save();
        return db.suppliers[i];
      }
      const rec = { id: uid('sup'), ...fields, status: 'active', createdAt: new Date().toISOString() };
      db.suppliers.push(rec);
      log(db, 'supplier', rec.id, 'create', `Added supplier "${rec.name}"`);
      save();
      return rec;
    }

    case 'archiveSupplier':
      return toggleArchive(db, db.suppliers, p.id, 'supplier', 'Supplier');

    case 'linkPartySupplier': {
      const party = db.parties.find((x) => x.id === p.partyId);
      if (!party) throw new Error('Party not found');
      const linked = db.suppliers.find((s) => s.partyId === party.id);
      if (p.supplierId) {
        const sup = db.suppliers.find((s) => s.id === p.supplierId);
        if (!sup) throw new Error('Supplier not found');
        if (linked && linked.id !== sup.id) throw new Error(`"${party.name}" is already linked to supplier "${linked.name}".`);
        if (sup.partyId && sup.partyId !== party.id) throw new Error(`Supplier "${sup.name}" is already linked to another party.`);
        if (sup.partyId !== party.id) {
          sup.partyId = party.id;
          log(db, 'supplier', sup.id, 'edit', `Linked supplier "${sup.name}" to party "${party.name}"`);
          save();
        }
        return sup;
      }
      if (linked) {
        if (linked.status === 'archived') { linked.status = 'active'; save(); }
        return linked;
      }
      const same = db.suppliers.find((s) => nameKey(s.name) === nameKey(party.name));
      if (same && same.partyId) throw new Error(`Supplier "${same.name}" is already linked to another party.`);
      if (same) {
        same.partyId = party.id;
        if (same.status === 'archived') same.status = 'active';
        log(db, 'supplier', same.id, 'edit', `Linked supplier "${same.name}" to party "${party.name}"`);
        save();
        return same;
      }
      const rec = { id: uid('sup'), name: party.name, phone: party.phone || '', address: party.address || '', openingBalance: 0, status: 'active', createdAt: new Date().toISOString(), partyId: party.id };
      db.suppliers.push(rec);
      log(db, 'supplier', rec.id, 'create', `Party "${party.name}" set up as a supplier`);
      save();
      return rec;
    }

    case 'setOffParty': {
      const party = db.parties.find((x) => x.id === p.partyId);
      if (!party) throw new Error('Party not found');
      const sup = db.suppliers.find((s) => s.partyId === party.id);
      if (!sup) throw new Error('Nothing has been bought from this party yet');
      const amount = r2(p.amount);
      if (!(amount > 0)) throw new Error('Enter an amount to set off');
      const dues = db.bills.filter((b) => b.partyId === party.id && b.status !== 'voided')
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.billNo).localeCompare(String(b.billNo)))
        .map((b) => [b, payableNow(billState(b, { payments: db.payments, returns: db.returns, cheques: db.cheques }))]);
      const receivable = r2(dues.reduce((s, x) => s + x[1], 0));
      const payable = r2(supplierBalance(sup.id, db));
      if (amount > receivable + 0.004) throw new Error(`Set-off cannot be more than ${party.name} owes on sales (${receivable.toFixed(2)}).`);
      if (amount > payable + 0.004) throw new Error(`Set-off cannot be more than you owe ${party.name} on purchases (${Math.max(0, payable).toFixed(2)}).`);
      const date = p.date || today();
      const note = p.note || 'Set off against purchases';
      let left = amount;
      const applied = [];
      for (const [b, due] of dues) {
        if (left <= 0.004) break;
        if (due <= 0.004) continue;
        const use = r2(Math.min(due, left));
        db.payments.push({ id: uid('pay'), billId: b.id, partyId: party.id, method: 'Set-off', amount: use, date, note, reversed: false, reversedAt: '', reverseReason: '', isAdvance: false });
        applied.push({ billId: b.id, billNo: b.billNo, amount: use });
        left = r2(left - use);
      }
      db.supplierPayments.push({ id: uid('spy'), supplierId: sup.id, purchaseBillId: '', method: 'Set-off', amount, date, note, isAdvance: false });
      log(db, 'payment', party.id, 'create', `Set off ${amount} between sales and purchases of "${party.name}"`);
      save();
      return { applied, amount };
    }

    case 'savePurchaseBill': {
      const sup = db.suppliers.find((s) => s.id === p.supplierId);
      if (!sup) throw new Error('Select a supplier');
      const lines = p.lines || [];
      if (!lines.length) throw new Error('Add at least one item');
      lines.forEach((l, i) => {
        if (!db.items.some((it) => it.id === l.itemId)) throw new Error(`Line ${i + 1}: item not found`);
        if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
        if (!(Number(l.costPrice) >= 0)) throw new Error(`Line ${i + 1}: price must be zero or more`);
      });
      const total = r2(lines.reduce((s, l) => s + Number(l.qty) * Number(l.costPrice), 0));
      const paidNow = r2(p.paidNow);
      if (paidNow < 0) throw new Error('Amount paid cannot be negative');
      if (paidNow > total + 0.004) throw new Error(`Amount paid (${paidNow}) is more than the bill total (${total}). Record the extra as a separate payment to the supplier.`);
      const date = p.date || today();
      const received = lines.map((l) => {
        const q = Number(l.qty);
        const given = suppliedQty(l.receivedQty);
        const v = given !== null ? given : p.received === false ? 0 : q;
        if (v < 0 || v > q + 0.0001) throw new Error(`Received quantity must be between 0 and ${q}`);
        return r2(v);
      });
      const bill = { id: uid('pbl'), purchaseNo: nextPurchaseNo(db.purchaseBills, date), supplierId: sup.id, invoiceNo: String(p.invoiceNo || '').trim(), date, totalAmount: total, note: p.note || '', status: 'active', createdAt: new Date().toISOString(), voidReason: '', voidedAt: '' };
      db.purchaseBills.push(bill);
      lines.forEach((l, i) => {
        const rec = { id: uid('pur'), itemId: l.itemId, supplierName: sup.name, qty: Number(l.qty), costPrice: r2(l.costPrice), date, note: '', method: '', supplierId: sup.id, purchaseBillId: bill.id, receivedQty: received[i] };
        db.purchases.push(rec);
        const item = db.items.find((it) => it.id === l.itemId);
        if (item) { item.costPrice = rec.costPrice; item.lastPurchaseDate = date; }
      });
      if (paidNow > 0) {
        const pay = { id: uid('spy'), supplierId: sup.id, purchaseBillId: bill.id, method: p.method || 'Cash', amount: paidNow, date, note: 'Paid at purchase' };
        db.supplierPayments.push(pay);
      }
      log(db, 'purchaseBill', bill.id, 'create', `Purchase ${bill.purchaseNo} from ${sup.name} — ${total}` + (paidNow > 0 ? `, paid ${paidNow} (${p.method || 'Cash'})` : ''));
      save();
      return bill;
    }

    case 'setPurchaseReceipt': {
      const bill = db.purchaseBills.find((b) => b.id === p.purchaseBillId);
      if (!bill) throw new Error('Purchase bill not found');
      if (bill.status === 'voided') throw new Error('This purchase was cancelled');
      const changes = p.lines || [];
      if (!changes.length) throw new Error('Nothing to update');
      const done = changes.map((c) => {
        const line = db.purchases.find((x) => x.id === c.id && x.purchaseBillId === bill.id);
        if (!line) throw new Error('Purchase line not found');
        const q = Number(line.qty) || 0;
        const v = suppliedQty(c.receivedQty);
        if (v === null || v < 0 || v > q + 0.0001) {
          throw new Error(`${db.items.find((i) => i.id === line.itemId)?.name || 'Item'}: received quantity must be between 0 and ${q}`);
        }
        return [line, r2(v)];
      });
      done.forEach(([line, v]) => { line.receivedQty = v; });
      const lines = db.purchases.filter((x) => x.purchaseBillId === bill.id);
      const got = r2(lines.reduce((s, l) => s + lineReceived(l), 0));
      const total = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
      log(db, 'purchaseBill', bill.id, 'edit', `Purchase ${bill.purchaseNo} receiving updated: ${got} of ${total} received`);
      save();
      return bill;
    }

    case 'voidPurchaseBill': {
      const bill = db.purchaseBills.find((b) => b.id === p.id);
      if (!bill) throw new Error('Purchase bill not found');
      if (bill.status === 'voided') throw new Error('This purchase is already cancelled');
      if (db.supplierReturns.some((r) => r.purchaseBillId === bill.id)) throw new Error('Goods from this purchase were returned to the supplier. Delete those returns first, then cancel the purchase.');
      const before = { ...bill };
      bill.status = 'voided';
      bill.voidReason = p.reason || '';
      bill.voidedAt = new Date().toISOString();
      log(db, 'purchaseBill', bill.id, 'void', `Cancelled purchase ${bill.purchaseNo}${p.reason ? ` — ${p.reason}` : ''}`, before, bill);
      save();
      return bill;
    }

    case 'addSupplierPayment': {
      if (!db.suppliers.some((s) => s.id === p.supplierId)) throw new Error('Select a supplier');
      const amount = r2(p.amount);
      if (!(amount > 0)) throw new Error('Enter a payment amount');
      if (!p.isAdvance && p.purchaseBillId && !db.purchaseBills.some((b) => b.id === p.purchaseBillId && b.supplierId === p.supplierId)) {
        throw new Error('Purchase bill not found for this supplier');
      }
      const isAdvance = !!p.isAdvance;
      const rec = { id: uid('spy'), supplierId: p.supplierId, purchaseBillId: isAdvance ? '' : p.purchaseBillId || '', method: p.method || 'Cash', amount, date: p.date || today(), note: p.note || '', isAdvance };
      db.supplierPayments.push(rec);
      const sup = db.suppliers.find((s) => s.id === p.supplierId);
      log(db, 'supplierPayment', rec.id, 'create', `${isAdvance ? 'Advance' : 'Paid'} ${amount} to ${sup?.name || 'supplier'} — ${rec.method}`);
      save();
      return rec;
    }

    case 'deleteSupplierPayment': {
      const i = db.supplierPayments.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Payment not found');
      const pay = db.supplierPayments[i];
      db.supplierPayments.splice(i, 1);
      log(db, 'supplierPayment', pay.id, 'delete', `Deleted payment of ${pay.amount} (${pay.method}) to supplier` + (p.reason ? ` — ${p.reason}` : ''), pay, null);
      save();
      return { ok: true };
    }

    case 'addSupplierReturn': {
      if (!db.suppliers.some((s) => s.id === p.supplierId)) throw new Error('Select a supplier');
      if (!db.items.some((i) => i.id === p.itemId)) throw new Error('Select an item');
      const q = Number(p.qty);
      if (!(q > 0)) throw new Error('Return quantity must be greater than zero');
      const value = r2(p.value);
      if (value < 0) throw new Error('Return value cannot be negative');
      if (p.purchaseBillId) {
        const bill = db.purchaseBills.find((b) => b.id === p.purchaseBillId && b.supplierId === p.supplierId);
        if (!bill) throw new Error('Purchase bill not found for this supplier');
        if (bill.status === 'voided') throw new Error('That purchase was cancelled');
        const bought = db.purchases.filter((x) => x.purchaseBillId === bill.id && x.itemId === p.itemId).reduce((s, x) => s + (Number(x.qty) || 0), 0);
        if (!bought) throw new Error('That item is not on this purchase bill');
        const already = db.supplierReturns.filter((x) => x.purchaseBillId === bill.id && x.itemId === p.itemId).reduce((s, x) => s + (Number(x.qty) || 0), 0);
        if (q > r2(bought - already) + 0.0001) throw new Error(`Only ${r2(bought - already)} of that item is left to return (${bought} bought, ${already} already returned).`);
      }
      const rec = { id: uid('srt'), supplierId: p.supplierId, purchaseBillId: p.purchaseBillId || '', itemId: p.itemId, qty: q, value, date: p.date || today(), note: p.note || '' };
      db.supplierReturns.push(rec);
      const item = db.items.find((i) => i.id === p.itemId);
      log(db, 'supplierReturn', rec.id, 'create', `Returned ${q} × ${item?.name || 'item'} to supplier — value ${value}`);
      save();
      return rec;
    }

    case 'deleteSupplierReturn': {
      const i = db.supplierReturns.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Return not found');
      const ret = db.supplierReturns[i];
      db.supplierReturns.splice(i, 1);
      log(db, 'supplierReturn', ret.id, 'delete', `Deleted return to supplier (value ${ret.value})`, ret, null);
      save();
      return { ok: true };
    }

    /* ----- Employees ----- */
    case 'saveEmployee': {
      if (!String(p.name || '').trim()) throw new Error('Employee name is required');
      if (p.id) {
        const i = db.employees.findIndex((e) => e.id === p.id);
        if (i < 0) throw new Error('Employee not found');
        const before = { ...db.employees[i] };
        db.employees[i] = { ...before, ...p };
        log(db, 'employee', p.id, 'edit', `Edited employee "${p.name}"`, before, db.employees[i]);
        save();
        return db.employees[i];
      }
      const rec = { id: uid('emp'), name: p.name.trim(), phone: p.phone || '', role: p.role || '', monthlySalary: r2(p.monthlySalary), joinDate: p.joinDate || today(), status: 'active' };
      db.employees.push(rec);
      log(db, 'employee', rec.id, 'create', `Added employee "${rec.name}"`);
      save();
      return rec;
    }

    case 'addEmployeeTx': {
      if (!(Number(p.amount) > 0)) throw new Error('Enter an amount');
      const rec = { id: uid('etx'), employeeId: p.employeeId, type: p.type || 'salary', amount: r2(p.amount), date: p.date || today(), note: p.note || '', method: p.method || 'Cash' };
      db.employeeTx.push(rec);
      const emp = db.employees.find((e) => e.id === p.employeeId);
      log(db, 'employeeTx', rec.id, 'create', `${rec.type} ${rec.amount} to ${emp?.name || 'employee'}`);
      save();
      return rec;
    }

    /* ----- Expenses, stock loss, assets ----- */
    case 'saveExpense': {
      const rec = { id: uid('exp'), category: p.category || 'Miscellaneous', amount: r2(p.amount), date: p.date || today(), note: p.note || '', method: p.method || 'Cash', linkedStockLossId: p.linkedStockLossId || '' };
      db.expenses.push(rec);
      log(db, 'expense', rec.id, 'create', `Expense ${rec.category} — ${rec.amount}`);
      save();
      return rec;
    }

    case 'saveStockLoss': {
      const lossId = uid('stl');
      const expId = uid('exp');
      const item = db.items.find((i) => i.id === p.itemId);
      const loss = { id: lossId, itemId: p.itemId, qty: Number(p.qty) || 0, reason: p.reason || 'Damaged', estimatedValue: r2(p.estimatedValue), date: p.date || today(), note: p.note || '', linkedExpenseId: expId };
      db.stockLoss.push(loss);
      db.expenses.push({ id: expId, category: 'Stock Loss', amount: r2(p.estimatedValue), date: loss.date, note: `${item?.name || 'Item'} × ${loss.qty} — ${loss.reason}`, method: '', linkedStockLossId: lossId });
      log(db, 'stockLoss', lossId, 'create', `Stock loss: ${loss.qty} × ${item?.name || 'item'} (${loss.reason})`);
      save();
      return loss;
    }

    case 'saveAsset': {
      const rec = { id: uid('ast'), name: p.name, value: r2(p.value), date: p.date || today(), note: p.note || '' };
      db.assets.push(rec);
      log(db, 'asset', rec.id, 'create', `Asset added "${rec.name}"`);
      save();
      return rec;
    }

    case 'saveSettings': {
      if (Array.isArray(p.customMethods)) {
        const clash = p.customMethods.find((m) => [...PAYMENT_METHODS, ...RESERVED_METHODS].some((x) => x.toLowerCase() === String(m).trim().toLowerCase()));
        if (clash) throw new Error(`"${clash}" is already a payment method, or is used by the system.`);
      }
      const before = { ...db.settings };
      db.settings = { ...db.settings, ...p };
      log(db, 'settings', 'settings', 'edit', 'Settings updated', before, db.settings);
      save();
      return db.settings;
    }

    /* ----- Shared ledger links ----- */
    case 'createShareLink':
    case 'createWhShareLink': {
      const wh = action === 'createWhShareLink';
      if (wh) assertSeesMoney(db);
      if (!p.password || p.password.length < 6) throw new Error('Set a password of at least 6 characters');
      if (!(wh ? db.whParties : db.parties).some((x) => x.id === p.partyId)) throw new Error('Party not found');
      const token = uid('shr');
      const hash = await sha256(p.password);
      db.partyLedgerLinks = db.partyLedgerLinks.filter((l) => l.partyId !== p.partyId);
      db.partyLedgerLinks.push({ partyId: p.partyId, token, passwordHash: hash, active: true, createdAt: new Date().toISOString() });
      log(db, wh ? 'warehouse party' : 'shareLink', p.partyId, 'create', 'Shared ledger link created');
      save();
      return { token };
    }

    case 'revokeShareLink':
    case 'revokeWhShareLink': {
      const wh = action === 'revokeWhShareLink';
      if (wh) assertSeesMoney(db);
      if (!(wh ? db.whParties : db.parties).some((x) => x.id === p.partyId)) throw new Error('Party not found');
      db.partyLedgerLinks = db.partyLedgerLinks.filter((l) => l.partyId !== p.partyId);
      log(db, wh ? 'warehouse party' : 'shareLink', p.partyId, 'void', 'Shared ledger link revoked');
      save();
      return { ok: true };
    }

    case 'openSharedLedger': {
      const key = `share:${p.token}`;
      const wait = lockRemaining(key);
      if (wait > 0) throw new Error(`Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      const link = db.partyLedgerLinks.find((l) => l.token === p.token && l.active);
      if (!link) throw new Error('This link is no longer valid');
      if ((await sha256(p.password || '')) !== link.passwordHash) {
        recordFailure(key);
        throw new Error('Incorrect password');
      }
      clearFailures(key);
      const whParty = db.whParties.find((x) => x.id === link.partyId);
      if (whParty) {
        const moves = db.whMoves.filter((m) => m.partyId === whParty.id);
        const ids = new Set(moves.map((m) => m.id));
        return {
          kind: 'warehouse',
          party: { name: whParty.name, phone: whParty.phone, city: whParty.city },
          shopName: db.settings.shopName,
          openingBalance: Number(whParty.openingBalance) || 0,
          moves: moves.map((m) => ({ id: m.id, docNo: m.docNo, type: m.type, date: m.date, reference: m.reference, vehicleNo: m.vehicleNo, status: m.status })),
          lines: db.whMoveLines.filter((l) => ids.has(l.moveId)).map((l) => ({
            id: l.id, moveId: l.moveId, qty: l.qty, unit: l.unit, rate: l.rate, note: l.note,
            itemName: db.items.find((i) => i.id === l.itemId)?.name || 'Item',
          })),
          payments: db.whPartyPayments.filter((x) => x.partyId === whParty.id)
            .map((x) => ({ id: x.id, direction: x.direction, amount: x.amount, date: x.date, method: x.method, note: x.note })),
        };
      }
      const party = db.parties.find((x) => x.id === link.partyId);
      const bills = db.bills.filter((b) => b.partyId === link.partyId);
      const ids = new Set(bills.map((b) => b.id));
      return {
        party: { name: party?.name, phone: party?.phone },
        shopName: db.settings.shopName,
        bills,
        billItems: db.billItems.filter((l) => ids.has(l.billId)).map((l) => ({
          id: l.id, billId: l.billId, itemId: l.itemId, qty: l.qty, unit: l.unit, price: l.price,
          itemName: db.items.find((i) => i.id === l.itemId)?.name || 'Item',
        })),
        payments: db.payments.filter((x) => x.partyId === link.partyId),
        returns: db.returns.filter((x) => ids.has(x.billId)),
        cheques: db.cheques.filter((x) => x.partyId === link.partyId),
        partyAdvances: db.partyAdvances.filter((x) => x.partyId === link.partyId),
        // Every journal entry of this party, with its fields; those with money also join the statement.
        journal: (db.journal || [])
          .filter((x) => x.kind === 'party' && x.partyId === link.partyId)
          .map((x) => ({ id: x.id, kind: x.kind, partyId: x.partyId, date: x.date, title: x.title, fields: x.fields, direction: x.direction, amount: x.amount, createdAt: x.createdAt })),
        journalPayments: (db.journalPayments || [])
          .filter((x) => x.kind === 'party' && x.partyId === link.partyId)
          .map((x) => ({ id: x.id, journalId: x.journalId, amount: x.amount, date: x.date, method: x.method, note: x.note, groupId: x.groupId, createdAt: x.createdAt })),
      };
    }

    /* ----- Warehouses ----- */
    case 'saveWarehouse': {
      if (!String(p.name || '').trim()) throw new Error('Warehouse name is required');
      const dup = db.warehouses.find((w) => w.id !== p.id && nameKey(w.name) === nameKey(p.name));
      if (dup) throw new Error(`A warehouse called "${dup.name}" already exists.`);
      const fields = {
        name: String(p.name).trim(), code: String(p.code || '').trim().toUpperCase(),
        location: p.location || '', manager: p.manager || '', phone: p.phone || '',
        capacity: p.capacity || '', note: p.note || '',
      };
      if (p.id) {
        const i = db.warehouses.findIndex((w) => w.id === p.id);
        if (i < 0) throw new Error('Warehouse not found');
        const before = { ...db.warehouses[i] };
        db.warehouses[i] = { ...before, ...fields };
        log(db, 'warehouse', p.id, 'edit', `Edited warehouse "${fields.name}"`, before, db.warehouses[i]);
        save();
        return db.warehouses[i];
      }
      const rec = { id: uid('whs'), ...fields, status: 'active', createdAt: new Date().toISOString() };
      db.warehouses.push(rec);
      log(db, 'warehouse', rec.id, 'create', `Added warehouse "${rec.name}"`);
      save();
      return rec;
    }

    case 'archiveWarehouse':
      return toggleArchive(db, db.warehouses, p.id, 'warehouse', 'Warehouse');

    case 'saveWhMove': {
      const meta = MOVE_TYPES[p.type];
      if (!meta) throw new Error('Choose what kind of movement this is');
      const wh = db.warehouses.find((w) => w.id === p.warehouseId);
      if (!wh) throw new Error('Select a warehouse');
      if (wh.status === 'archived') throw new Error(`Warehouse "${wh.name}" is archived. Restore it first.`);
      let dest = null;
      if (p.type === 'transfer') {
        dest = db.warehouses.find((w) => w.id === p.toWarehouseId);
        if (!dest) throw new Error('Select the warehouse the goods are going to');
        if (dest.id === wh.id) throw new Error('A transfer needs two different warehouses');
        if (dest.status === 'archived') throw new Error(`Warehouse "${dest.name}" is archived. Restore it first.`);
      }
      const lines = (p.lines || []).filter((l) => l.itemId);
      if (!lines.length) throw new Error('Add at least one item');
      lines.forEach((l, i) => {
        if (!db.items.some((it) => it.id === l.itemId)) throw new Error(`Line ${i + 1}: item not found`);
        if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
        if (l.rate !== undefined && l.rate !== '' && !(Number(l.rate) >= 0)) throw new Error(`Line ${i + 1}: rate must be zero or more`);
      });
      let party = null;
      if (p.partyId) {
        if (p.type !== 'in' && p.type !== 'out') throw new Error('Only stock in and stock out have a party');
        party = db.whParties.find((x) => x.id === p.partyId);
        if (!party) throw new Error('Party not found');
        if (party.status === 'archived') throw new Error(`Party "${party.name}" is archived. Restore it first.`);
      }
      // Goods leaving a warehouse must be there to leave.
      if (meta.sign < 0) assertWarehouseHas(db, wh, lines);
      // Goods sent from the shop into a warehouse must be on the shop's shelves.
      if (p.type === 'from-shop') assertShopHas(db, lines);
      const date = p.date || today();
      const move = {
        id: uid('whm'), docNo: nextDocNo(db.whMoves, meta.prefix, date), type: p.type,
        warehouseId: wh.id, toWarehouseId: dest ? dest.id : '', date,
        partyName: party ? party.name : String(p.partyName || '').trim(), reference: String(p.reference || '').trim(),
        vehicleNo: String(p.vehicleNo || '').trim(), driverName: String(p.driverName || '').trim(),
        reason: p.reason || '', note: p.note || '', status: 'active',
        createdAt: new Date().toISOString(), createdBy: getSession()?.username || 'system',
        voidReason: '', voidedAt: '', partyId: party ? party.id : '',
      };
      db.whMoves.push(move);
      const takesRates = meOf(db)?.seesCost !== false;
      lines.forEach((l) => {
        const item = db.items.find((it) => it.id === l.itemId);
        const row = {
          id: uid('wml'), moveId: move.id, itemId: l.itemId, qty: r2(l.qty),
          unit: l.unit || item?.baseUnit || 'Piece', rate: !takesRates || l.rate === '' || l.rate === undefined || l.rate === null ? '' : r2(l.rate),
          note: l.note || '',
        };
        db.whMoveLines.push(row);
      });
      const qtyText = r2(lines.reduce((s, l) => s + Number(l.qty), 0));
      log(db, 'warehouse', move.id, 'create', `${meta.label} ${move.docNo} — ${wh.name}${dest ? ` → ${dest.name}` : ''}, ${lines.length} item${lines.length === 1 ? '' : 's'} (${qtyText})`);
      save();
      return move;
    }

    case 'voidWhMove': {
      const move = db.whMoves.find((m) => m.id === p.id);
      if (!move) throw new Error('Movement not found');
      if (move.status === 'voided') throw new Error('This movement is already cancelled');
      // Cancelling goods that came IN takes them back out — they must still be there.
      const lines = db.whMoveLines.filter((l) => l.moveId === move.id);
      const meta = MOVE_TYPES[move.type] || {};
      const receiver = move.type === 'transfer'
        ? db.warehouses.find((w) => w.id === move.toWarehouseId)
        : meta.sign > 0 ? db.warehouses.find((w) => w.id === move.warehouseId) : null;
      if (receiver) assertWarehouseHas(db, receiver, lines, 'cancel');
      // Cancelling goods sent to the shop takes them back off the shop's shelves.
      if (move.type === 'to-shop') assertShopHas(db, lines, 'cancel');
      const before = { ...move };
      move.status = 'voided';
      move.voidReason = p.reason || '';
      move.voidedAt = new Date().toISOString();
      log(db, 'warehouse', move.id, 'void', `Cancelled ${meta.label || 'movement'} ${move.docNo}${p.reason ? ` — ${p.reason}` : ''}`, before, move);
      save();
      return move;
    }

    case 'saveWhExpense': {
      const wh = db.warehouses.find((w) => w.id === p.warehouseId);
      if (!wh) throw new Error('Select a warehouse');
      if (!(Number(p.amount) > 0)) throw new Error('Enter an amount');
      const rec = { id: uid('wex'), warehouseId: wh.id, category: p.category || 'Miscellaneous', amount: r2(p.amount), date: p.date || today(), method: p.method || 'Cash', note: p.note || '' };
      db.whExpenses.push(rec);
      log(db, 'warehouse', rec.id, 'create', `Warehouse expense ${rec.category} — ${rec.amount} (${wh.name})`);
      save();
      return rec;
    }

    case 'deleteWhExpense': {
      const i = db.whExpenses.findIndex((e) => e.id === p.id);
      if (i < 0) throw new Error('Expense not found');
      const rec = db.whExpenses[i];
      db.whExpenses.splice(i, 1);
      log(db, 'warehouse', rec.id, 'delete', `Deleted warehouse expense ${rec.category} — ${rec.amount}` + (p.reason ? ` — ${p.reason}` : ''), rec, null);
      save();
      return { ok: true };
    }

    case 'setWhMoveRates': {
      assertSeesMoney(db);
      const move = db.whMoves.find((m) => m.id === p.id);
      if (!move) throw new Error('Movement not found');
      if (move.status === 'voided') throw new Error('This movement is cancelled');
      const changes = p.rates || [];
      if (!changes.length) throw new Error('Nothing to change');
      const isBlank = (v) => v === '' || v === null || v === undefined;
      changes.forEach((c, n) => {
        if (!db.whMoveLines.some((l) => l.id === c.id && l.moveId === move.id)) throw new Error(`Line ${n + 1} is not part of ${move.docNo}`);
        if (!isBlank(c.rate) && !(Number(c.rate) >= 0)) throw new Error(`Line ${n + 1}: rate must be zero or more`);
      });
      changes.forEach((c) => {
        const l = db.whMoveLines.find((x) => x.id === c.id);
        l.rate = isBlank(c.rate) ? '' : r2(c.rate);
      });
      log(db, 'warehouse rates', move.id, 'edit', `Rates updated on ${move.docNo}${move.partyName ? ` (${move.partyName})` : ''}`);
      save();
      return { ok: true };
    }

    /* ----- Warehouse parties (see the same actions in Code.gs) ----- */
    case 'saveWhParty': {
      const name = String(p.name || '').trim();
      if (!name) throw new Error('Party name is required');
      const dup = db.whParties.find((x) => x.id !== p.id && nameKey(x.name) === nameKey(name));
      if (dup) throw new Error(`A warehouse party called "${dup.name}" already exists. Use a different name, or open the existing one.`);
      const ph = phoneKey(p.phone);
      const phDup = ph && db.whParties.find((x) => x.id !== p.id && phoneKey(x.phone) === ph);
      if (phDup) throw new Error(`This mobile number is already on warehouse party "${phDup.name}".`);
      const fields = {
        name, phone: String(p.phone || '').trim(), city: String(p.city || '').trim(),
        address: String(p.address || '').trim(), note: String(p.note || '').trim(),
      };
      if (meOf(db)?.seesCost !== false && p.openingBalance !== undefined) {
        const opening = p.openingBalance === '' || p.openingBalance === null ? 0 : Number(p.openingBalance);
        if (!Number.isFinite(opening)) throw new Error('Opening balance must be a number');
        fields.openingBalance = r2(opening);
      }
      if (p.id) {
        const i = db.whParties.findIndex((x) => x.id === p.id);
        if (i < 0) throw new Error('Party not found');
        const before = { ...db.whParties[i] };
        db.whParties[i] = { ...before, ...fields };
        log(db, 'warehouse party', p.id, 'edit', `Edited warehouse party "${name}"`, before, db.whParties[i]);
        save();
        return db.whParties[i];
      }
      const rec = {
        id: uid('whp'), ...fields, openingBalance: fields.openingBalance || 0, status: 'active',
        createdAt: new Date().toISOString(), lockHash: '', lockSalt: '',
      };
      db.whParties.push(rec);
      const linked = linkMovesByName(db, rec);
      log(db, 'warehouse party', rec.id, 'create', `Added warehouse party "${rec.name}"`
        + (linked ? ` — ${linked} earlier movement${linked === 1 ? '' : 's'} linked by name` : ''));
      save();
      return rec;
    }

    case 'archiveWhParty':
      return toggleArchive(db, db.whParties, p.id, 'warehouse party', 'Party');

    case 'addWhPartyPayment': {
      assertSeesMoney(db);
      const party = db.whParties.find((x) => x.id === p.partyId);
      if (!party) throw new Error('Party not found');
      if (p.direction !== 'paid' && p.direction !== 'received') throw new Error('Choose whether you paid them or they paid you');
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero');
      const method = String(p.method || 'Cash');
      assertMethod(method);
      const rec = {
        id: uid('wpp'), partyId: party.id, direction: p.direction, amount: r2(amount), date: p.date || today(),
        method, note: String(p.note || '').trim(), createdAt: new Date().toISOString(), createdBy: getSession()?.username || 'system',
      };
      db.whPartyPayments.push(rec);
      log(db, 'warehouse payment', rec.id, 'create', `${rec.direction === 'paid' ? `Paid ${rec.amount} to` : `Received ${rec.amount} from`} warehouse party "${party.name}" (${method})`);
      save();
      return rec;
    }

    case 'deleteWhPartyPayment': {
      assertSeesMoney(db);
      const i = db.whPartyPayments.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Payment not found');
      const rec = db.whPartyPayments[i];
      const party = db.whParties.find((x) => x.id === rec.partyId);
      db.whPartyPayments.splice(i, 1);
      log(db, 'warehouse payment', rec.id, 'delete', `Deleted ${rec.direction === 'paid' ? 'payment' : 'receipt'} of ${rec.amount}${party ? ` — ${party.name}` : ''}${p.reason ? ` — ${p.reason}` : ''}`, rec, null);
      save();
      return { ok: true };
    }

    /* ----- Journal: notes on any ledger, with an optional money total (see Code.gs) ----- */
    case 'saveJournal': {
      const table = JOURNAL_KINDS[p.kind];
      if (!table) throw new Error('Unknown ledger type');
      const owner = db[table].find((x) => x.id === p.partyId);
      if (!owner) throw new Error('Party not found');
      const fields = cleanJournalFields(p.fields);
      const title = String(p.title || '').trim();
      if (!title && !fields.length) throw new Error('Write at least a title or one field');
      const amount = journalTotal(fields);
      const direction = p.direction === 'give' ? 'give' : 'take';
      const existing = p.id ? db.journal.find((x) => x.id === p.id) : null;
      if (p.id && !existing) throw new Error('Journal entry not found');
      // Money on a supplier's or warehouse party's ledger is for those who see cost prices.
      if (p.kind !== 'party' && (amount > 0 || Number(existing?.amount) > 0)) assertSeesMoney(db);
      const settled = existing
        ? db.journalPayments.filter((x) => x.journalId === existing.id).reduce((s, x) => r2(s + x.amount), 0) : 0;
      if (settled > 0) {
        if (amount < settled - 0.004) throw new Error(`${settled} has already been ${existing.direction === 'take' ? 'collected' : 'paid'} on this entry, so the total cannot go below that. Delete a payment first.`);
        if (amount > 0 && direction !== existing.direction) throw new Error('Payments are already recorded on this entry, so it cannot switch between take and give. Delete them first.');
      }
      const data = {
        date: p.date || today(), title, fields: JSON.stringify(fields), amount, direction: amount > 0 ? direction : '',
        updatedAt: new Date().toISOString(),
      };
      if (existing) {
        const i = db.journal.indexOf(existing);
        db.journal[i] = { ...existing, ...data };
        log(db, 'journal', p.id, 'edit', `Edited journal entry — ${owner.name}`);
        save();
        return db.journal[i];
      }
      const rec = { id: uid('jrn'), kind: p.kind, partyId: owner.id, ...data, createdAt: data.updatedAt, createdBy: getSession()?.username || 'system' };
      db.journal.push(rec);
      log(db, 'journal', rec.id, 'create', `Added journal entry — ${owner.name}${amount > 0 ? ` (${direction === 'take' ? 'to take' : 'to give'} ${amount})` : ''}`);
      save();
      return rec;
    }

    case 'deleteJournal': {
      const i = db.journal.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Journal entry not found');
      const rec = db.journal[i];
      if (db.journalPayments.some((x) => x.journalId === rec.id)) {
        throw new Error('Money has been recorded on this entry. Delete its payments first, then delete the entry.');
      }
      const owner = db[JOURNAL_KINDS[rec.kind]]?.find((x) => x.id === rec.partyId);
      db.journal.splice(i, 1);
      log(db, 'journal', rec.id, 'delete', `Deleted journal entry${owner ? ` — ${owner.name}` : ''}`, rec, null);
      save();
      return { ok: true };
    }

    // Money collected on, or paid out of, a journal entry. It reduces what the entry still has to take or give.
    case 'addJournalPayment': {
      const entry = db.journal.find((x) => x.id === p.journalId);
      if (!entry) throw new Error('Journal entry not found');
      const claim = journalClaims(entry.kind, entry.partyId, db).find((x) => x.id === entry.id);
      if (!claim) throw new Error('This entry has no payment to collect or give');
      if (entry.kind !== 'party') assertSeesMoney(db);
      const amount = r2(Number(p.amount));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero');
      if (amount > claim.outstanding + 0.004) throw new Error(`Only ${claim.outstanding} is left on this entry.`);
      const method = String(p.method || 'Cash');
      assertMethod(method);
      const owner = db[JOURNAL_KINDS[entry.kind]]?.find((x) => x.id === entry.partyId);
      const take = entry.direction === 'take';
      const rec = {
        id: uid('jpy'), journalId: entry.id, kind: entry.kind, partyId: entry.partyId, direction: take ? 'in' : 'out',
        amount, date: p.date || today(), method, note: String(p.note || '').trim(),
        createdAt: new Date().toISOString(), createdBy: getSession()?.username || 'system',
      };
      db.journalPayments.push(rec);
      log(db, 'journal payment', rec.id, 'create', `${take ? `Collected ${amount} from` : `Paid ${amount} to`} "${owner?.name || 'party'}" from the journal (${method})`);
      save();
      return rec;
    }

    case 'deleteJournalPayment': {
      const i = db.journalPayments.findIndex((x) => x.id === p.id);
      if (i < 0) throw new Error('Payment not found');
      const rec = db.journalPayments[i];
      if (rec.kind !== 'party') assertSeesMoney(db);
      db.journalPayments.splice(i, 1);
      log(db, 'journal payment', rec.id, 'delete', `Deleted journal ${rec.direction === 'in' ? 'collection' : 'payment'} of ${rec.amount}${p.reason ? ` — ${p.reason}` : ''}`, rec, null);
      save();
      return { ok: true };
    }

    /* ----- Stock count, users, import (see the same actions in Code.gs) ----- */
    case 'saveStockCount': {
      const wh = db.warehouses.find((w) => w.id === p.warehouseId);
      if (!wh) throw new Error('Select a warehouse');
      const stock = warehouseStockMap(db).get(wh.id) || new Map();
      const ins = [];
      const outs = [];
      (p.counts || []).forEach((c, i) => {
        const counted = Number(c.counted);
        if (c.counted === '' || c.counted == null || !Number.isFinite(counted) || counted < 0) throw new Error(`Line ${i + 1}: enter the quantity counted (0 or more)`);
        const diff = r2(counted - (stock.get(c.itemId) || 0));
        if (diff > 0.0001) ins.push({ itemId: c.itemId, qty: diff, note: `Counted ${counted}` });
        else if (diff < -0.0001) outs.push({ itemId: c.itemId, qty: -diff, note: `Counted ${counted}` });
      });
      if (!ins.length && !outs.length) throw new Error('Every count matches the books — nothing to adjust.');
      const base = { warehouseId: wh.id, date: p.date || today(), reason: 'Stock count', note: p.note || 'Physical stock count' };
      const moves = [];
      if (outs.length) moves.push(await perform('saveWhMove', { ...base, type: 'adjust-out', lines: outs }));
      if (ins.length) moves.push(await perform('saveWhMove', { ...base, type: 'adjust-in', lines: ins }));
      return { moves, shortages: outs.length, surpluses: ins.length };
    }

    case 'listUsers':
      ensureSuper(db);
      return db.users.map(publicUser);

    case 'saveUser': {
      const username = String(p.username || '').trim();
      if (!/^[A-Za-z0-9._@-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters or numbers, with no spaces.');
      if (db.users.some((u) => u.id !== p.id && u.username.toLowerCase() === username.toLowerCase())) throw new Error(`The username "${username}" is already taken.`);
      const role = ['superadmin', 'admin', 'staff'].includes(p.role) ? p.role : 'staff';
      const keys = new Set(PAGES.map((x) => x.key));
      const pages = role === 'superadmin' || p.pages == null ? null
        : p.pages.filter((k) => keys.has(k) && !(role === 'staff' && COST_PAGES.has(k)));
      if (role === 'staff' && !(pages || []).length) throw new Error('Give this user at least one page.');
      const password = String(p.password || '');
      if (password && password.length < 6) throw new Error('Password must be at least 6 characters');
      const fields = { username, name: String(p.name || '').trim() || username, role, pages, status: p.status === 'disabled' ? 'disabled' : 'active' };
      const me = getSession()?.username;
      if (p.id) {
        const u = db.users.find((x) => x.id === p.id);
        if (!u) throw new Error('User not found');
        if (u.username === me && (role !== 'superadmin' || fields.status === 'disabled')) throw new Error('You cannot remove your own super admin access. Ask another super admin.');
        Object.assign(u, fields);
        if (password) u.passwordHash = await sha256(password);
        log(db, 'user', u.id, 'edit', `Edited user "${username}" (${role})`);
        save();
        return publicUser(u);
      }
      if (!password) throw new Error('Set a password for the new user');
      const rec = { id: uid('usr'), ...fields, passwordHash: await sha256(password), createdAt: new Date().toISOString() };
      db.users.push(rec);
      log(db, 'user', rec.id, 'create', `Added user "${username}" (${role})`);
      save();
      return publicUser(rec);
    }

    case 'deleteUser': {
      const u = db.users.find((x) => x.id === p.id);
      if (!u) throw new Error('User not found');
      if (u.username === getSession()?.username) throw new Error('You cannot delete your own account.');
      if (u.role === 'superadmin' && db.users.filter((x) => x.role === 'superadmin').length <= 1) throw new Error('This is the only super admin.');
      db.users = db.users.filter((x) => x.id !== p.id);
      log(db, 'user', p.id, 'delete', `Deleted user "${u.username}"`);
      save();
      return { ok: true };
    }

    case 'importBatch': {
      const ops = p.ops || [];
      if (!ops.length) throw new Error('Nothing to import');
      importing = true;
      const results = [];
      try {
        for (const op of ops) {
          try {
            if (!IMPORT_ACTIONS.has(op?.action)) throw new Error('This kind of record cannot be imported');
            const rec = await perform(op.action, op.payload || {});
            results.push({ ok: true, ref: op.ref || '', id: rec?.id || '' });
          } catch (err) {
            results.push({ ok: false, ref: op?.ref || '', error: err.message });
          }
        }
      } finally {
        importing = false;
      }
      // Each row saved on its own, so the log goes on the latest copy.
      const fresh = load();
      log(fresh, 'system', 'import', 'create', `Imported ${results.filter((r) => r.ok).length} of ${ops.length} ${p.label || 'records'} from a file`);
      save();
      return { results };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function toggleArchive(db, list, id, type, label) {
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error(`${label} not found`);
  rec.status = rec.status === 'archived' ? 'active' : 'archived';
  log(db, type, rec.id, 'edit', `${rec.status === 'archived' ? 'Archived' : 'Restored'} ${type} "${rec.name}"`);
  save();
  return rec;
}

function chequeRow(c, { billId, partyId, paymentId, amount, date }) {
  return {
    id: uid('chq'), billId, partyId, paymentId,
    chequeNo: c.chequeNo || '', bankName: c.bankName || '', accountHolder: c.accountHolder || '',
    dateIssued: c.dateIssued || date, dateDue: c.dateDue || date, status: 'pending',
    amount: r2(amount), note: c.note || '',
  };
}

/** Refuse a movement that would take a warehouse below zero on any item. */
function assertWarehouseHas(db, wh, lines, verb = 'send') {
  const stock = warehouseStockMap(db).get(wh.id) || new Map();
  const want = new Map();
  lines.forEach((l) => want.set(l.itemId, r2((want.get(l.itemId) || 0) + Number(l.qty))));
  for (const [itemId, q] of want) {
    const have = stock.get(itemId) || 0;
    if (q > have + 0.0001) {
      const item = db.items.find((i) => i.id === itemId);
      throw new Error(verb === 'cancel'
        ? `${item?.name || 'Item'}: only ${have} left in ${wh.name}, so this movement cannot be cancelled — the goods have already moved on.`
        : `${item?.name || 'Item'}: only ${have} ${item?.baseUnit || ''} in ${wh.name}, cannot ${verb} ${q}.`.replace(/\s+,/, ','));
    }
  }
}

/**
 * Refuse a bill whose warehouse lines take more than the warehouse holds.
 * A bill being edited gets back what it took before, since its old lines are replaced.
 */
function assertBillWarehouseStock(db, lines, ownBillId) {
  const want = new Map();
  lines.forEach((l) => {
    if (!l.warehouseId) return;
    const k = `${l.warehouseId}|${l.itemId}`;
    want.set(k, r2((want.get(k) || 0) + Number(l.qty)));
  });
  if (!want.size) return;
  const stock = warehouseStockMap({ ...db, billItems: db.billItems.filter((l) => !ownBillId || l.billId !== ownBillId) });
  for (const [k, q] of want) {
    const [whId, itemId] = k.split('|');
    const have = stock.get(whId)?.get(itemId) || 0;
    if (q > have + 0.0001) {
      const item = db.items.find((i) => i.id === itemId);
      const wh = db.warehouses.find((w) => w.id === whId);
      throw new Error(`${item?.name || 'Item'}: only ${have} ${item?.baseUnit || ''} in ${wh?.name || 'the warehouse'}, cannot sell ${q} from it.`.replace(/\s+,/, ','));
    }
  }
}

/** Refuse a movement that would take the shop's stock of an item below zero. */
function assertShopHas(db, lines, verb = 'send') {
  const want = new Map();
  lines.forEach((l) => want.set(l.itemId, r2((want.get(l.itemId) || 0) + Number(l.qty))));
  for (const [itemId, q] of want) {
    const have = itemStock(itemId, db);
    if (q > have + 0.0001) {
      const item = db.items.find((i) => i.id === itemId);
      throw new Error(verb === 'cancel'
        ? `${item?.name || 'Item'}: only ${have} left in the shop, so this movement cannot be cancelled — the goods have already been used.`
        : `${item?.name || 'Item'}: only ${have} ${item?.baseUnit || ''} in the shop, cannot send ${q}.`.replace(/\s+,/, ','));
    }
  }
}

function methodsOf(db) {
  return [...PAYMENT_METHODS, ...(db.settings.customMethods || [])];
}

/** Erase everything stored on this device (Settings → Danger Zone). */
export function wipeLocal() {
  dbStore.remove(DB_KEY);
  current = null;
}
