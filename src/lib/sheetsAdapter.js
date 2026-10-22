// Runs every action on the Google Apps Script Web App (apps-script/Code.gs).
// The action names and payloads are the same ones localAdapter.js takes, so
// api.js can hand either adapter the same call.

import { CONFIG } from './config.js';
import { getSession, SESSION_KEY } from './localAdapter.js';
import { uid } from './format.js';

/** Fired when the server rejects the session, so the app can sign out. */
export const SESSION_ENDED_EVENT = 'jh:session-ended';

// Safe to send twice: reads change nothing, and these writes carry a
// requestId the server remembers (REPLAY_GUARDED in Code.gs), so a resend
// returns the first result instead of writing a second row.
const RETRYABLE = new Set([
  'bootstrap', 'fullBackup',
  'saveBill', 'addPayment', 'addReturn', 'addAdvance', 'savePurchase',
  'addEmployeeTx', 'saveExpense', 'saveStockLoss', 'saveAsset',
  'saveCheque', 'settleParty',
  'savePurchaseBill', 'addSupplierPayment', 'addSupplierReturn', 'saveSupplier',
  'setOffParty',
  'saveWarehouse', 'saveWhMove', 'saveWhExpense',
  'saveStockCount', 'importBatch', 'listUsers',
  'saveWhParty', 'addWhPartyPayment', 'saveJournal', 'addJournalPayment',
  'syncPush',
]);

// Reads and the offline upload can safely give up on a request that hangs on a
// bad connection: nothing doubles if it did arrive. Other writes wait it out.
const TIMEOUT_MS = { bootstrap: 90000, fullBackup: 90000, syncPush: 120000 };

async function post(body) {
  const ms = TIMEOUT_MS[body.action];
  const ctrl = ms && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  let res;
  try {
    // text/plain keeps this a "simple" request: Apps Script cannot answer the
    // CORS preflight that application/json would trigger.
    res = await fetch(CONFIG.appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl?.signal,
    });
  } catch (err) {
    // A timed-out request reads as a lost connection, but is not tried again:
    // a second wait as long would leave the screen hanging.
    if (err?.name !== 'AbortError') throw err;
    const t = new TypeError('Request timed out');
    t.timedOut = true;
    throw t;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}. Please try again.`);
  try {
    return await res.json();
  } catch {
    // An HTML page instead of JSON: usually a deployment that is not set to
    // "Anyone" access, or a URL that is not the /exec one.
    throw new Error('The server sent back something unexpected. Check the Apps Script deployment URL and its access setting.');
  }
}

/** A request id nobody else can predict — the server replays results by it. */
function requestId() {
  try {
    if (globalThis.crypto?.randomUUID) return `req_${globalThis.crypto.randomUUID()}`;
  } catch { /* not a secure context */ }
  return uid('req');
}

// Columns that hold numbers. Everything else on a record is text.
const NUMBER_KEYS = new Set([
  'creditLimit', 'defaultDueDays', 'conversionRate', 'costPrice', 'openingStock', 'lowStockAlert', 'price',
  'subtotal', 'roundOff', 'totalAmount', 'qty', 'costPriceAtSale', 'lineTotal', 'amount', 'valueAdjusted',
  'applied', 'monthlySalary', 'estimatedValue', 'value', 'openingBalance', 'deliveredQty', 'receivedQty', 'rate',
]);

/**
 * Text that Sheets stored as a number comes back as one — a party called
 * "786", a bill note of "12". The screens sort and search names as text, and a
 * number there throws. A current backend already sends text; this keeps an
 * older deployment from breaking the dashboard.
 */
function textFields(db) {
  if (!db || typeof db !== 'object') return db;
  Object.keys(db).forEach((k) => {
    if (!Array.isArray(db[k])) return;
    db[k].forEach((row) => {
      if (!row || typeof row !== 'object') return;
      Object.keys(row).forEach((f) => {
        if (typeof row[f] === 'number' && !NUMBER_KEYS.has(f)) row[f] = String(row[f]);
      });
    });
  });
  return db;
}

export async function sheetsCall(action, payload = {}, { requestId: rid } = {}) {
  if (!CONFIG.appsScriptUrl) throw new Error('No Apps Script URL is set in src/lib/config.js.');

  const body = { action, payload, token: getSession()?.token || '', requestId: rid || requestId() };

  let out;
  try {
    out = await post(body);
  } catch (err) {
    // Only a lost connection is worth a second try, and only for calls that
    // cannot double up.
    if (!(err instanceof TypeError) || err.timedOut || !RETRYABLE.has(action)) throw offline(err);
    try {
      out = await post(body);
    } catch (err2) {
      throw offline(err2);
    }
  }

  if (!out?.ok) {
    const message = out?.error || 'Something went wrong on the server. Please try again.';
    if (/session has expired/i.test(message)) {
      try { localStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    }
    throw new Error(message);
  }
  return action === 'bootstrap' || action === 'fullBackup' ? textFields(out.data) : out.data;
}

/** A lost connection, marked so the desktop app can fall back to its offline copy. */
function offline(err) {
  if (!(err instanceof TypeError)) return err;
  const out = new Error('Could not reach the server. Check the internet connection and try again.');
  out.offline = true;
  return out;
}
