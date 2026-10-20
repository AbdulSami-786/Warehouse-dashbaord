/**
 * ============================================================================
 * SGA Balloon Merchant — Wholesale & Warehouse Dashboard
 * Google Apps Script backend (Web App)
 * ============================================================================
 *
 * Architecture (per PRD section 2):
 *   - One Google Spreadsheet, one tab per entity, header row = schema.
 *   - doPost router: every operation is one `action`.
 *   - LockService around writes only (not whole requests) to prevent race
 *     conditions without making unrelated reads feel slow.
 *   - CacheService for hot reference data (parties, items, settings).
 *   - Batch reads: whole sheet in one call, never row-by-row.
 *
 * SETUP: see SETUP.md in this folder.
 * ============================================================================
 */

/** Cache duration for reference data, in seconds (Perf Guide 1.2). */
var CACHE_SECONDS = 60;

/** Sheet schemas — the header row of each tab. */
var SCHEMA = {
  // lockHash/lockSalt appended: an optional per-party ledger password, stored
  // only as a salted hash. Blank means the ledger opens freely.
  Parties: ['id', 'name', 'phone', 'address', 'creditLimit', 'defaultDueDays', 'status', 'createdAt',
            'lockHash', 'lockSalt'],
  Items: ['id', 'name', 'baseUnit', 'altUnit', 'conversionRate', 'category', 'costPrice',
          'lastPurchaseDate', 'openingStock', 'lowStockAlert', 'status'],
  PartyItemPrices: ['id', 'partyId', 'itemId', 'price', 'unit', 'date'],
  // 'delivery' and 'deliveredAt' are appended, never inserted: readAll maps
  // values by header position, so moving an existing column would silently
  // reassign every value after it on every existing row.
  Bills: ['id', 'billNo', 'partyId', 'date', 'subtotal', 'roundOff', 'totalAmount',
          'status', 'dueDate', 'note', 'createdAt', 'voidReason', 'voidedAt',
          'delivery', 'deliveredAt'],
  // deliveredQty appended: how much of the line has gone out to the customer.
  // Blank on older rows, which then follow the bill's own delivery flag.
  BillItems: ['id', 'billId', 'itemId', 'qty', 'unit', 'price', 'costPriceAtSale', 'lineTotal',
              'deliveredQty'],
  // groupId appended: the parts of one account payment spread over several
  // bills share it, so the ledger can show them as one entry.
  Payments: ['id', 'billId', 'partyId', 'method', 'amount', 'date', 'note', 'reversed',
             'reversedAt', 'reverseReason', 'isAdvance', 'groupId'],
  Returns: ['id', 'billId', 'itemId', 'qty', 'valueAdjusted', 'restock', 'date', 'note'],
  // accountHolder appended: the name printed on the cheque, which is often not
  // the party's own (a relative, a firm, a customer of theirs).
  Cheques: ['id', 'billId', 'partyId', 'paymentId', 'chequeNo', 'bankName', 'dateIssued',
            'dateDue', 'status', 'amount', 'note', 'statusChangedAt', 'accountHolder'],
  PartyAdvances: ['id', 'partyId', 'amount', 'applied', 'dateReceived', 'method', 'note'],
  // supplierId/purchaseBillId appended: a line of a supplier purchase bill.
  // Standalone purchases leave them blank.
  // receivedQty appended after them: how much of the line has arrived. Blank
  // on older rows, which read as fully received.
  Purchases: ['id', 'itemId', 'supplierName', 'qty', 'costPrice', 'date', 'note', 'method',
              'supplierId', 'purchaseBillId', 'receivedQty'],
  // The buying side. A supplier's balance is opening + purchases − payments −
  // returns; below zero is an advance the supplier holds.
  // partyId appended: set when this supplier is a party's buying side — a
  // customer who also sells to the shop.
  Suppliers: ['id', 'name', 'phone', 'address', 'openingBalance', 'status', 'createdAt',
              'partyId'],
  PurchaseBills: ['id', 'purchaseNo', 'supplierId', 'invoiceNo', 'date', 'totalAmount', 'note',
                  'status', 'createdAt', 'voidReason', 'voidedAt'],
  // isAdvance appended: money handed to a supplier before goods arrive.
  SupplierPayments: ['id', 'supplierId', 'purchaseBillId', 'method', 'amount', 'date', 'note',
                     'isAdvance'],
  SupplierReturns: ['id', 'supplierId', 'purchaseBillId', 'itemId', 'qty', 'value', 'date', 'note'],
  Employees: ['id', 'name', 'phone', 'role', 'monthlySalary', 'joinDate', 'status'],
  EmployeeTransactions: ['id', 'employeeId', 'type', 'amount', 'date', 'note', 'method'],
  Expenses: ['id', 'category', 'amount', 'date', 'note', 'method', 'linkedStockLossId'],
  StockLoss: ['id', 'itemId', 'qty', 'reason', 'estimatedValue', 'date', 'note', 'linkedExpenseId'],
  Assets: ['id', 'name', 'value', 'date', 'note'],
  // Warehouse system. A movement is one document (GRN, gate pass, transfer…);
  // its lines carry the items. Stock of a warehouse is never stored — it is
  // the sum of the movements, worked out the same way calc.js does.
  Warehouses: ['id', 'name', 'code', 'location', 'manager', 'phone', 'capacity', 'note', 'status',
               'createdAt'],
  // partyId appended: the warehouse party a stock in came from or a stock out
  // went to. Blank on older rows, which carry only the typed partyName.
  WarehouseMoves: ['id', 'docNo', 'type', 'warehouseId', 'toWarehouseId', 'date', 'partyName',
                   'reference', 'vehicleNo', 'driverName', 'reason', 'note', 'status', 'createdAt',
                   'createdBy', 'voidReason', 'voidedAt', 'partyId'],
  WarehouseMoveLines: ['id', 'moveId', 'itemId', 'qty', 'unit', 'rate', 'note'],
  WarehouseExpenses: ['id', 'warehouseId', 'category', 'amount', 'date', 'method', 'note'],
  // Who goods come from and go to on the warehouse side, each with a khata:
  // goods at their line rates, plus money paid either way. openingBalance
  // above zero means they owe us, below zero that we owe them.
  WhParties: ['id', 'name', 'phone', 'city', 'address', 'openingBalance', 'note', 'status', 'createdAt',
              'lockHash', 'lockSalt'],
  // direction: 'paid' = we paid the party, 'received' = the party paid us.
  WhPartyPayments: ['id', 'partyId', 'direction', 'amount', 'date', 'method', 'note', 'createdAt',
                    'createdBy'],
  ActivityLog: ['id', 'entityType', 'entityId', 'action', 'description', 'oldValue',
                'newValue', 'user', 'timestamp'],
  // pages/status/name/createdAt appended: which screens a user may open (a JSON
  // list; blank means every screen for an admin), and whether the account is on.
  Users: ['id', 'username', 'passwordHash', 'role', 'pages', 'status', 'name', 'createdAt'],
  PartyLedgerLinks: ['partyId', 'token', 'passwordHash', 'salt', 'active', 'createdAt'],
  Settings: ['key', 'value']
};

/** Maps a sheet tab to the JSON key the frontend expects. */
var TAB_TO_KEY = {
  Parties: 'parties',
  Items: 'items',
  PartyItemPrices: 'partyItemPrices',
  Bills: 'bills',
  BillItems: 'billItems',
  Payments: 'payments',
  Returns: 'returns',
  Cheques: 'cheques',
  PartyAdvances: 'partyAdvances',
  Purchases: 'purchases',
  Employees: 'employees',
  EmployeeTransactions: 'employeeTx',
  Expenses: 'expenses',
  StockLoss: 'stockLoss',
  Assets: 'assets',
  ActivityLog: 'activityLog',
  PartyLedgerLinks: 'partyLedgerLinks',
  Suppliers: 'suppliers',
  PurchaseBills: 'purchaseBills',
  SupplierPayments: 'supplierPayments',
  SupplierReturns: 'supplierReturns',
  Warehouses: 'warehouses',
  WarehouseMoves: 'whMoves',
  WarehouseMoveLines: 'whMoveLines',
  WarehouseExpenses: 'whExpenses',
  WhParties: 'whParties',
  WhPartyPayments: 'whPartyPayments'
};

/** Columns stored as numbers. */
var NUMERIC = {
  creditLimit: 1, defaultDueDays: 1, conversionRate: 1, costPrice: 1, openingStock: 1,
  lowStockAlert: 1, price: 1, subtotal: 1, roundOff: 1, totalAmount: 1, qty: 1,
  costPriceAtSale: 1, lineTotal: 1, amount: 1, valueAdjusted: 1, applied: 1,
  monthlySalary: 1, estimatedValue: 1, value: 1, openingBalance: 1
};

/** Columns holding a number, where blank means "not given" rather than 0. */
var NUMERIC_OR_BLANK = { deliveredQty: 1, receivedQty: 1, rate: 1 };

/** Columns whose value is a moment, not just a day: read back with the time. */
var TIMESTAMP = {
  createdAt: 1, timestamp: 1, voidedAt: 1, deliveredAt: 1, reversedAt: 1, statusChangedAt: 1
};

/**
 * A value as it should be written to a cell.
 *
 * Sheets reads a written string the way it reads typing: "=SUM(...)" becomes
 * a formula, "1-2" a date, "786" a number and "03001234567" loses its 0. Every
 * one of those corrupts the record — a formula can even pull in data from
 * elsewhere. A leading apostrophe keeps the cell as exactly the text given,
 * and is not part of the value read back.
 *
 * Numbers stay numbers so the sheet can still be summed by hand.
 */
function cellValue(key, v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean' || typeof v === 'number' || v instanceof Date) return v;
  var s = String(v);
  if (s === '') return '';
  if ((NUMERIC[key] || NUMERIC_OR_BLANK[key]) && /^-?\d+(\.\d+)?$/.test(s.trim())) return Number(s);
  return "'" + s;
}

/** A phone read back as a number lost its 0: 3001234567 -> 03001234567. */
function phoneText(v) {
  var s = String(v === null || v === undefined ? '' : v);
  return /^3\d{9}$/.test(s) ? '0' + s : s;
}

/** Columns stored as booleans. */
var BOOLEAN = { reversed: 1, restock: 1, active: 1, isAdvance: 1 };

/* ==========================================================================
   Web app entry points
   ========================================================================== */

function doGet(e) {
  return json({ ok: true, data: { status: 'SGA Balloon Merchant backend is running' } });
}

// Who the current request is acting as, for the activity log. Set per request
// from the validated session rather than hardcoded, so attribution stays
// correct once a second account exists.
var ACTING_USER = 'system';

/**
 * Actions that create records, and so must never run twice for one request.
 *
 * A write can genuinely arrive twice without anybody clicking twice: the
 * browser retries a request whose response was lost, a phone changes network
 * mid-send, the page is refreshed while a save is in flight. Each of those
 * lands a second identical POST, and without a guard it writes a second bill.
 */
var REPLAY_GUARDED = {
  saveBill: 1, addPayment: 1, addReturn: 1, addAdvance: 1, savePurchase: 1,
  addEmployeeTx: 1, saveExpense: 1, saveStockLoss: 1, saveAsset: 1,
  saveCheque: 1, settleParty: 1,
  savePurchaseBill: 1, addSupplierPayment: 1, addSupplierReturn: 1, saveSupplier: 1,
  setOffParty: 1,
  saveWarehouse: 1, saveWhMove: 1, saveWhExpense: 1,
  saveStockCount: 1, importBatch: 1, saveUser: 1,
  saveWhParty: 1, addWhPartyPayment: 1
};

/** How long a completed request's result stays replayable, in seconds. */
var REPLAY_TTL = 600;

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};

    // The client stamps each write with a one-off id. If this exact request
    // has already been carried out, return what it returned the first time
    // rather than doing the work again — the caller cannot tell the difference,
    // and no second row is written.
    var rid = body.requestId;
    var cache = null;
    var key = null;

    // Only for a caller with a live session, and keyed to that session: a
    // stored result must never be handed to someone who merely guessed or
    // copied a request id.
    if (rid && REPLAY_GUARDED[action] && validSession(body.token)) {
      try { cache = CacheService.getScriptCache(); } catch (err2) { cache = null; }
      key = 'req:' + sha256(String(body.token) + '|' + String(rid));
      if (cache) {
        var prior = null;
        try { prior = cache.get(key); } catch (err3) { prior = null; }
        if (prior) {
          // Already done. Hand back the original outcome.
          return ContentService
            .createTextOutput(prior)
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    var data = route(action, payload, body.token);
    var out = JSON.stringify({ ok: true, data: data });

    if (cache && key) {
      // Only successful writes are remembered: a failure should be retryable.
      try { cache.put(key, out, REPLAY_TTL); } catch (err4) {}
    }

    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json({ ok: false, error: publicError(err) });
  }
}

/**
 * What the caller is allowed to see about a failure.
 *
 * Messages thrown deliberately by this file are written for the person using
 * the dashboard ("Payment exceeds the amount due"), so they are safe and
 * useful to return. Anything else is a runtime fault whose text can name sheets
 * and row numbers, so it is logged server-side and replaced with a generic
 * line. `throw stamped(new Error(...))` is what marks a message as intended
 * for the caller.
 */
function publicError(err) {
  if (err && err.jhPublic) return String(err.message);
  try {
    console.error('Unhandled backend error: ' + (err && err.stack ? err.stack : err));
  } catch (e) {}
  return 'Something went wrong on the server. Please try again.';
}

/** Mark an Error as safe to show the caller. */
function stamped(err) {
  err.jhPublic = true;
  return err;
}

/** Throw a message written for the person using the dashboard. */
function fail(message) {
  throw stamped(new Error(message));
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==========================================================================
   Router — one case per action, matching src/lib/api.js exactly
   ========================================================================== */

/**
 * Actions reachable without a session.
 *
 * `login` must be, or nobody could ever get a token. `openSharedLedger` is the
 * party-facing link: its caller is a customer who has no dashboard account and
 * authenticates with the link's own token plus password instead.
 *
 * Everything absent from this list — including `bootstrap`, which returns the
 * whole database — requires a valid session.
 */
var PUBLIC_ACTIONS = { login: 1, openSharedLedger: 1 };

// The signed-in user for this request: { username, name, role, pages, seesCost }.
var CURRENT = null;

function route(action, p, token) {
  CURRENT = null;
  if (!PUBLIC_ACTIONS[action]) {
    var session = validSession(token);
    if (!session) fail('Your session has expired. Please sign in again.');
    // Permissions are read from the Users tab on every request rather than
    // remembered in the session, so a change the super admin makes applies on
    // the user's very next click.
    var user = findUser(ensureSuperAdmin(readAll('Users')), session.username);
    if (!user || user.status === 'disabled') {
      logout(token);
      fail('Your session has expired. Please sign in again.');
    }
    CURRENT = accessOf(user);
    ACTING_USER = user.username;
    authorize(action, CURRENT);
  } else {
    ACTING_USER = 'system';
  }

  var result = dispatch(action, p, token);
  if (action === 'bootstrap' && result) result.me = CURRENT;
  // Whoever may not see cost prices gets every response without them, not
  // only the screens: a hidden column is still in the data otherwise.
  if (CURRENT && !CURRENT.seesCost) {
    result = action === 'bootstrap' ? stripCostData(result) : stripCostFields(result);
  }
  return result;
}

function dispatch(action, p, token) {
  switch (action) {
    case 'login':            return login(p);
    case 'logout':           return logout(token);
    case 'changePassword':   return changePassword(p);
    case 'bootstrap':        return bootstrap();

    case 'saveParty':        return saveParty(p);
    case 'archiveParty':     return toggleArchive('Parties', p.id, 'party');
    case 'setPartyLock':     return setPartyLock(p);

    case 'saveItem':         return saveItem(p);
    case 'archiveItem':      return toggleArchive('Items', p.id, 'item');

    case 'saveBill':         return saveBill(p);
    case 'voidBill':         return voidBill(p);
    case 'setDelivery':      return setDelivery(p);
    case 'setLineDelivery':  return setLineDelivery(p);

    case 'addPayment':       return addPayment(p);
    case 'reversePayment':   return reversePayment(p);
    case 'deletePayment':    return deletePayment(p);
    case 'updatePayment':    return updatePayment(p);
    case 'settleParty':      return settleParty(p);

    case 'addReturn':        return addReturn(p);

    case 'saveCheque':       return saveCheque(p);
    case 'setChequeStatus':  return setChequeStatus(p);
    case 'deleteCheque':     return deleteCheque(p);

    case 'addAdvance':       return addAdvance(p);
    case 'deleteAdvance':    return deleteAdvance(p);
    case 'savePurchase':     return savePurchase(p);
    case 'updatePurchase':   return updatePurchase(p);
    case 'deletePurchase':   return deletePurchase(p);

    case 'saveSupplier':          return saveSupplier(p);
    case 'archiveSupplier':       return toggleArchive('Suppliers', p.id, 'supplier');
    case 'savePurchaseBill':      return savePurchaseBill(p);
    case 'voidPurchaseBill':      return voidPurchaseBill(p);
    case 'setPurchaseReceipt':    return setPurchaseReceipt(p);
    case 'addSupplierPayment':    return addSupplierPayment(p);
    case 'deleteSupplierPayment': return deleteSupplierPayment(p);
    case 'addSupplierReturn':     return addSupplierReturn(p);
    case 'deleteSupplierReturn':  return deleteSupplierReturn(p);
    case 'linkPartySupplier':     return linkPartySupplier(p);
    case 'setOffParty':           return setOffParty(p);

    case 'saveEmployee':     return saveEmployee(p);
    case 'addEmployeeTx':    return addEmployeeTx(p);

    case 'saveExpense':      return saveExpense(p);
    case 'saveStockLoss':    return saveStockLoss(p);
    case 'saveAsset':        return saveAsset(p);

    case 'saveSettings':     return saveSettings(p);

    case 'createShareLink':  return createShareLink(p);
    case 'revokeShareLink':  return revokeShareLink(p);
    case 'openSharedLedger': return openSharedLedger(p);

    case 'fullBackup':       return bootstrap();

    case 'syncPush':         return syncPush(p);

    case 'saveWarehouse':    return saveWarehouse(p);
    case 'archiveWarehouse': return toggleArchive('Warehouses', p.id, 'warehouse');
    case 'saveWhMove':       return saveWhMove(p);
    case 'voidWhMove':       return voidWhMove(p);
    case 'saveWhExpense':    return saveWhExpense(p);
    case 'deleteWhExpense':  return deleteWhExpense(p);
    case 'saveStockCount':   return saveStockCount(p);
    case 'setWhMoveRates':   return setWhMoveRates(p);

    case 'saveWhParty':          return saveWhParty(p);
    case 'archiveWhParty':       return toggleArchive('WhParties', p.id, 'warehouse party');
    case 'setWhPartyLock':       return setPartyLock(p, 'WhParties');
    case 'addWhPartyPayment':    return addWhPartyPayment(p);
    case 'deleteWhPartyPayment': return deleteWhPartyPayment(p);
    case 'createWhShareLink':    return createShareLink(p, 'WhParties');
    case 'revokeWhShareLink':    return revokeShareLink(p, 'WhParties');

    case 'listUsers':        return listUsers();
    case 'saveUser':         return saveUser(p);
    case 'deleteUser':       return deleteUser(p);

    case 'importBatch':      return importBatch(p);

    // Safe to echo: the caller chose this string, so it reveals nothing.
    default: fail('Unknown action: ' + action);
  }
}

/* ==========================================================================
   Users and permissions
   ========================================================================== */

/**
 * Every screen a user can be given. Mirrors PAGES in src/lib/permissions.js.
 * COST_PAGES show cost prices, directly or by arithmetic, so staff never get
 * them however their page list is set.
 */
var PAGE_KEYS = [
  'dashboard', 'newBill', 'bills', 'returns', 'parties', 'suppliers', 'outstanding', 'ledgerBook',
  'cheques', 'accounts', 'expenses', 'assets', 'items', 'purchases', 'stockLoss', 'employees',
  'profit', 'balanceSheet', 'audit', 'activity', 'reports', 'settings',
  'whDashboard', 'warehouses', 'whStock', 'whMoves', 'whCount', 'whExpenses', 'whReports', 'whActivity',
  'whParties'
];
var COST_PAGES = { suppliers: 1, purchases: 1, accounts: 1, profit: 1, balanceSheet: 1, audit: 1 };
var ROLES = { superadmin: 1, admin: 1, staff: 1 };

/** Which pages each write needs; having any one of them is enough. */
var ACTION_PAGES = {
  saveParty: ['parties', 'newBill', 'bills'],
  archiveParty: ['parties'], setPartyLock: ['parties'],
  createShareLink: ['parties'], revokeShareLink: ['parties'],
  saveItem: ['items', 'newBill', 'purchases', 'whStock', 'whMoves'],
  archiveItem: ['items'],
  saveBill: ['newBill', 'bills'],
  voidBill: ['bills', 'parties'], setDelivery: ['bills', 'parties'], setLineDelivery: ['bills', 'parties'],
  addPayment: ['bills', 'parties', 'outstanding'],
  reversePayment: ['bills', 'parties'], deletePayment: ['parties'], updatePayment: ['parties'],
  settleParty: ['parties', 'outstanding'],
  addAdvance: ['parties'], deleteAdvance: ['parties'],
  addReturn: ['returns', 'bills', 'parties'],
  saveCheque: ['cheques'], setChequeStatus: ['cheques', 'parties', 'bills'], deleteCheque: ['cheques', 'parties'],
  savePurchase: ['purchases'], updatePurchase: ['purchases', 'suppliers'], deletePurchase: ['purchases', 'suppliers'],
  saveSupplier: ['suppliers', 'purchases'], archiveSupplier: ['suppliers'],
  savePurchaseBill: ['purchases', 'suppliers'], voidPurchaseBill: ['purchases', 'suppliers'],
  setPurchaseReceipt: ['purchases', 'suppliers'],
  addSupplierPayment: ['purchases', 'suppliers'], deleteSupplierPayment: ['purchases', 'suppliers'],
  addSupplierReturn: ['purchases', 'suppliers'], deleteSupplierReturn: ['purchases', 'suppliers'],
  linkPartySupplier: ['suppliers', 'purchases'], setOffParty: ['suppliers', 'purchases'],
  saveEmployee: ['employees'], addEmployeeTx: ['employees'],
  saveExpense: ['expenses'], saveStockLoss: ['stockLoss'], saveAsset: ['assets'],
  saveSettings: ['settings'],
  saveWarehouse: ['warehouses'], archiveWarehouse: ['warehouses'],
  saveWhMove: ['whMoves'], voidWhMove: ['whMoves'], saveStockCount: ['whCount'],
  saveWhExpense: ['whExpenses'], deleteWhExpense: ['whExpenses'],
  // A party can be added straight from the stock in / out form.
  saveWhParty: ['whParties', 'whMoves'], archiveWhParty: ['whParties'], setWhPartyLock: ['whParties'],
  addWhPartyPayment: ['whParties'], deleteWhPartyPayment: ['whParties'],
  createWhShareLink: ['whParties'], revokeWhShareLink: ['whParties'],
  setWhMoveRates: ['whMoves', 'whParties']
};
// Writes that put money on record: rates are buying prices, and a party's
// payments and shared statement show them. Staff never make these, whatever
// pages they hold.
var MONEY_ACTIONS = {
  addWhPartyPayment: 1, deleteWhPartyPayment: 1, createWhShareLink: 1, revokeWhShareLink: 1,
  setWhMoveRates: 1
};
var ALWAYS_ALLOWED = { bootstrap: 1, changePassword: 1, logout: 1 };
var SUPER_ONLY = { listUsers: 1, saveUser: 1, deleteUser: 1, importBatch: 1 };
var ADMIN_ONLY = { fullBackup: 1, syncPush: 1 };

function normRole(r) {
  r = String(r || '').toLowerCase().replace(/[\s_-]/g, '');
  return ROLES[r] ? r : 'staff';
}

/** A stored page list: null means "every page" (an admin with no list). */
function parsePages(v) {
  if (v === '' || v === null || v === undefined) return null;
  try {
    var list = JSON.parse(v);
    return Array.isArray(list) ? list.filter(function (k) { return PAGE_KEYS.indexOf(k) >= 0; }) : null;
  } catch (e) {
    return null;
  }
}

/** What one user may do, as sent to the dashboard. */
function accessOf(user) {
  var role = normRole(user.role);
  var pages = role === 'superadmin' ? null : parsePages(user.pages);
  // Staff with no list see nothing until the super admin gives them pages.
  if (role === 'staff' && pages === null) pages = [];
  if (role === 'staff') pages = pages.filter(function (k) { return !COST_PAGES[k]; });
  return {
    username: String(user.username), name: String(user.name || user.username),
    role: role, pages: pages, seesCost: role !== 'staff'
  };
}

function hasPage(me, page) {
  if (me.role === 'superadmin') return true;
  if (me.role === 'staff' && COST_PAGES[page]) return false;
  return me.pages === null || me.pages.indexOf(page) >= 0;
}

function authorize(action, me) {
  if (ALWAYS_ALLOWED[action]) return;
  if (SUPER_ONLY[action]) {
    if (me.role !== 'superadmin') fail('Only the super admin can do this.');
    return;
  }
  if (me.role === 'superadmin') return;
  if (MONEY_ACTIONS[action] && !me.seesCost) fail('Only an admin can record money or rates.');
  if (ADMIN_ONLY[action]) {
    if (me.role !== 'admin') fail('Only an admin can do this.');
    return;
  }
  var pages = ACTION_PAGES[action];
  if (pages) {
    for (var i = 0; i < pages.length; i++) if (hasPage(me, pages[i])) return;
  }
  fail('You do not have access to this. Ask the super admin to give you the page.');
}

/**
 * The account installs start with is an admin; the first time a super admin
 * is needed and none exists, that account becomes one, so someone can always
 * manage users.
 */
function ensureSuperAdmin(users) {
  for (var i = 0; i < users.length; i++) if (normRole(users[i].role) === 'superadmin') return users;
  var pick = findUser(users, 'admin') || users.filter(function (u) { return normRole(u.role) === 'admin'; })[0] || users[0];
  if (pick) {
    var rowNum = findRow('Users', pick.id);
    if (rowNum > 0) updateRow('Users', rowNum, { role: 'superadmin' });
    pick.role = 'superadmin';
  }
  return users;
}

function publicUser(u) {
  var a = accessOf(u);
  return {
    id: u.id, username: a.username, name: a.name, role: a.role,
    pages: a.role === 'superadmin' ? null : a.pages,
    status: u.status === 'disabled' ? 'disabled' : 'active', createdAt: u.createdAt || ''
  };
}

function listUsers() {
  return readAll('Users').map(publicUser);
}

function saveUser(p) {
  return withLock(function () {
    var users = readAll('Users');
    var username = String(p.username || '').trim();
    if (!/^[A-Za-z0-9._@-]{3,32}$/.test(username)) {
      fail('Username must be 3–32 letters or numbers, with no spaces.');
    }
    for (var i = 0; i < users.length; i++) {
      if (users[i].id !== p.id && String(users[i].username).toLowerCase() === username.toLowerCase()) {
        fail('The username "' + username + '" is already taken.');
      }
    }
    var role = normRole(p.role);
    var pages = null;
    if (role !== 'superadmin' && p.pages !== null && p.pages !== undefined) {
      if (!Array.isArray(p.pages)) fail('Pages must be a list');
      pages = p.pages.filter(function (k) {
        return PAGE_KEYS.indexOf(k) >= 0 && !(role === 'staff' && COST_PAGES[k]);
      });
    }
    if (role === 'staff' && (!pages || !pages.length)) fail('Give this user at least one page.');
    var status = p.status === 'disabled' ? 'disabled' : 'active';
    var password = String(p.password || '');
    if (password && password.length < 6) fail('Password must be at least 6 characters');
    if (password && password === DEFAULT_PASSWORD) fail('Choose a password other than the default one');

    var supers = users.filter(function (u) { return normRole(u.role) === 'superadmin' && u.status !== 'disabled'; });
    var fields = {
      username: username, name: String(p.name || '').trim() || username, role: role,
      pages: pages === null ? '' : JSON.stringify(pages), status: status
    };

    if (p.id) {
      var existing = getById('Users', p.id);
      if (!existing) fail('User not found');
      var self = String(existing.username).toLowerCase() === String(ACTING_USER).toLowerCase();
      if (self && (role !== 'superadmin' || status === 'disabled')) {
        fail('You cannot remove your own super admin access. Ask another super admin.');
      }
      var wasSuper = normRole(existing.role) === 'superadmin' && existing.status !== 'disabled';
      if (wasSuper && (role !== 'superadmin' || status === 'disabled') && supers.length <= 1) {
        fail('This is the only super admin. Make someone else super admin first.');
      }
      if (password) fields.passwordHash = makePasswordHash(password);
      updateRow('Users', existing._row, fields);
      // Old sessions carry the old name and powers: sign the user out everywhere
      // when either changes, so the next sign-in picks up the new ones.
      if (!self && (password || status === 'disabled' || username !== existing.username ||
          role !== normRole(existing.role) || fields.pages !== String(existing.pages || ''))) {
        revokeSessionsFor(existing.username);
      }
      logActivity('user', p.id, 'edit', 'Edited user "' + username + '" (' + role + ')' + (password ? ', password reset' : ''));
      return publicUser(getById('Users', p.id));
    }

    if (!password) fail('Set a password for the new user');
    var rec = {
      id: uid('usr'), username: username, passwordHash: makePasswordHash(password),
      role: role, pages: fields.pages, status: status, name: fields.name, createdAt: nowISO()
    };
    appendRow('Users', rec);
    logActivity('user', rec.id, 'create', 'Added user "' + username + '" (' + role + ')');
    return publicUser(rec);
  });
}

function deleteUser(p) {
  return withLock(function () {
    var u = getById('Users', p.id);
    if (!u) fail('User not found');
    if (String(u.username).toLowerCase() === String(ACTING_USER).toLowerCase()) fail('You cannot delete your own account.');
    var supers = readAll('Users').filter(function (x) { return normRole(x.role) === 'superadmin' && x.status !== 'disabled'; });
    if (normRole(u.role) === 'superadmin' && supers.length <= 1) fail('This is the only super admin.');
    deleteRowById('Users', p.id);
    revokeSessionsFor(u.username);
    logActivity('user', p.id, 'delete', 'Deleted user "' + u.username + '"');
    return { ok: true };
  });
}

/* ---------------------------------------------------------------- Cost */

// Activity on these records describes purchase prices.
var COST_ACTIVITY = {
  purchase: 1, purchaseBill: 1, supplierPayment: 1, supplierReturn: 1, supplier: 1, stockLoss: 1,
  'warehouse payment': 1, 'warehouse rates': 1
};

function blank(rows, keys) {
  return (rows || []).map(function (r) {
    var o = {};
    for (var k in r) o[k] = keys.indexOf(k) >= 0 ? '' : r[k];
    return o;
  });
}

/** The whole database as someone who may not see cost prices receives it. */
function stripCostData(out) {
  out.items = blank(out.items, ['costPrice']);
  out.billItems = blank(out.billItems, ['costPriceAtSale']);
  // Purchases stay — shop stock is worked out from them — without their prices.
  out.purchases = blank(out.purchases, ['costPrice', 'method']);
  out.purchaseBills = blank(out.purchaseBills, ['totalAmount']);
  out.supplierReturns = blank(out.supplierReturns, ['value']);
  out.supplierPayments = [];
  out.suppliers = [];
  out.whMoveLines = blank(out.whMoveLines, ['rate']);
  // A warehouse party's khata is money at buying rates: staff see the goods only.
  out.whParties = blank(out.whParties, ['openingBalance']);
  out.whPartyPayments = [];
  out.stockLoss = blank(out.stockLoss, ['estimatedValue']);
  out.expenses = (out.expenses || []).filter(function (e) { return !e.linkedStockLossId; });
  out.activityLog = blank((out.activityLog || []).filter(function (l) { return !COST_ACTIVITY[l.entityType]; }), ['oldValue', 'newValue']);
  return out;
}

var COST_FIELDS = ['costPrice', 'costPriceAtSale', 'rate', 'estimatedValue', 'openingBalance'];

/** One action's result, without cost prices. */
function stripCostFields(v) {
  if (Array.isArray(v)) return v.map(stripCostFields);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    var o = {};
    for (var k in v) o[k] = COST_FIELDS.indexOf(k) >= 0 ? '' : stripCostFields(v[k]);
    return o;
  }
  return v;
}

/* ==========================================================================
   Import — the super admin bringing in records from a file, page by page
   ========================================================================== */

// Set while an import runs, so saveBill may keep the file's own bill number.
var IMPORTING = false;

var IMPORT_ACTIONS = {
  saveParty: saveParty, saveItem: saveItem, saveSupplier: saveSupplier, saveEmployee: saveEmployee,
  saveExpense: saveExpense, saveAsset: saveAsset, saveBill: saveBill, savePurchaseBill: savePurchaseBill,
  saveWarehouse: saveWarehouse, saveWhMove: saveWhMove, saveWhExpense: saveWhExpense,
  saveWhParty: saveWhParty
};

/**
 * Run a batch of rows under one lock. Each row is validated exactly as if it
 * had been typed into its form; a bad row is reported and the rest go ahead.
 * The dashboard sends a file in batches, so no single request runs too long.
 */
function importBatch(p) {
  var ops = (p && p.ops) || [];
  if (!ops.length) fail('Nothing to import');
  if (ops.length > 60) fail('Send at most 60 rows at a time');
  return withLock(function () {
    IMPORTING = true;
    var ok = 0;
    var results;
    try {
      results = importOps(ops, function () { ok++; });
    } finally {
      IMPORTING = false;
    }
    logActivity('system', 'import', 'create', 'Imported ' + ok + ' of ' + ops.length + ' ' + (p.label || 'records') + ' from a file');
    return { results: results };
  });
}

function importOps(ops, onOk) {
  return ops.map(function (op) {
      try {
        var fn = IMPORT_ACTIONS[op && op.action];
        if (!fn) fail('This kind of record cannot be imported');
        var rec = fn(op.payload || {});
        onOk();
        return { ok: true, ref: op.ref || '', id: rec && rec.id ? rec.id : '' };
      } catch (err) {
        return { ok: false, ref: (op && op.ref) || '', error: publicError(err) };
      }
  });
}

/* ==========================================================================
   Spreadsheet helpers
   ========================================================================== */

function ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

var TZ_CACHE = null;

/**
 * The spreadsheet's own time zone. A date typed into a cell is read in this
 * zone, so it must be written back out in the same one — the script's zone can
 * differ, and then every date read from the sheet lands a day early or late.
 */
function tz() {
  if (!TZ_CACHE) {
    try { TZ_CACHE = ss().getSpreadsheetTimeZone(); } catch (e) {}
    if (!TZ_CACHE) TZ_CACHE = Session.getScriptTimeZone();
  }
  return TZ_CACHE;
}

// Tabs already looked up (and migrated) during this request. Every append and
// update starts by finding its tab, and each lookup is several round trips.
var SHEET_CACHE = {};

/**
 * Get a tab, creating it with its header row if missing.
 *
 * A tab created by an older version of this file can be missing columns that
 * SCHEMA has since gained. Reads and writes both address columns by SCHEMA
 * position, so a stale header would shift every value in the row.
 *
 * A new column is not necessarily added at the end — `salt` sits in the middle
 * of PartyLedgerLinks — so each missing column is inserted at its SCHEMA
 * position and existing cells shift right with it. Existing rows keep their
 * data and read back blank in the new column, which is what a migration should
 * do.
 */
function sheet(name) {
  if (SHEET_CACHE[name]) return SHEET_CACHE[name];

  var s = ss().getSheetByName(name);
  if (!s) {
    s = ss().insertSheet(name);
    s.appendRow(SCHEMA[name]);
    s.setFrozenRows(1);
    SHEET_CACHE[name] = s;
    return s;
  }
  SHEET_CACHE[name] = s;

  var want = SCHEMA[name];
  var width = s.getLastColumn();
  if (s.getLastRow() < 1 || width >= want.length) return s;

  var have = s.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < want.length; i++) {
    if (String(have[i] || '') === want[i]) continue;
    // want[i] is missing here: open a column and label it.
    s.insertColumnBefore(i + 1);
    s.getRange(1, i + 1).setValue(want[i]);
    have.splice(i, 0, want[i]);
  }
  return s;
}

/**
 * Read an entire tab in ONE call and map rows to objects.
 * Apps Script is slow at many small calls, fast at few large ones.
 */
function readAll(name) {
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return [];

  var values = s.getRange(1, 1, last, SCHEMA[name].length).getValues();
  var headers = values[0];
  var out = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (isBlankRow(row)) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = headers[c];
      if (!key) continue;
      obj[key] = decodeCell(key, row[c], name);
    }
    out.push(obj);
  }
  return out;
}

function isBlankRow(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

/**
 * Decode one cell.
 *
 * `tab` matters: the Settings sheet stores generic key/value pairs, and its
 * `value` column holds text (shop name, rounding rule) as well as numbers.
 * Assets also has a `value` column, but there it is always money. Coercing by
 * column name alone turned every text setting into NaN, so the tab is passed
 * in and Settings is exempt from numeric coercion.
 *
 * Every other column is text, and comes back as text even when the sheet holds
 * a number: a party called "786" would otherwise reach the dashboard as the
 * number 786, and sorting parties by name would throw on it.
 */
function decodeCell(key, v, tab) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return TIMESTAMP[key] ? v.toISOString() : Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  }
  if (tab === 'Settings') return v;
  if (BOOLEAN[key]) return v === true || v === 'TRUE' || v === 'true';
  if (NUMERIC[key]) return v === '' ? 0 : Number(v);
  if (NUMERIC_OR_BLANK[key]) return v === '' ? '' : Number(v);
  if (key === 'phone') return v === '' ? '' : phoneText(v);
  return typeof v === 'number' ? String(v) : v;
}

/** Append one object as a row, in schema column order. */
function appendRow(name, obj) {
  var s = sheet(name);
  var row = SCHEMA[name].map(function (k) { return cellValue(k, obj[k]); });
  s.appendRow(row);
  return obj;
}

/** Find the 1-based sheet row number for a record id. */
function findRow(name, idValue, idField) {
  idField = idField || 'id';
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return -1;

  var col = SCHEMA[name].indexOf(idField) + 1;
  if (col < 1) return -1;

  var values = s.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(idValue)) return i + 2;
  }
  return -1;
}

/** Update specific fields of a row, leaving others untouched. */
function updateRow(name, rowNum, patch) {
  var s = sheet(name);
  var headers = SCHEMA[name];
  for (var k in patch) {
    var col = headers.indexOf(k) + 1;
    if (col > 0) {
      s.getRange(rowNum, col).setValue(cellValue(k, patch[k]));
    }
  }
}

/** Read one record as an object by id. */
function getById(name, idValue, idField) {
  var rowNum = findRow(name, idValue, idField);
  if (rowNum < 0) return null;
  var s = sheet(name);
  var values = s.getRange(rowNum, 1, 1, SCHEMA[name].length).getValues()[0];
  var obj = {};
  SCHEMA[name].forEach(function (k, i) { obj[k] = decodeCell(k, values[i], name); });
  obj._row = rowNum;
  return obj;
}

/* ==========================================================================
   Locking — around the write only, per Performance Guide 1.2
   ========================================================================== */

// How deep this request is inside withLock. An import runs each row's own save
// function, which takes the lock again; the inner call must neither wait for
// the lock this request already holds nor release it early.
var LOCK_DEPTH = 0;

function withLock(fn) {
  if (LOCK_DEPTH > 0) return fn();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail('System busy, please try again');
  LOCK_DEPTH++;
  try {
    var result = fn();
    SpreadsheetApp.flush();
    clearCache();
    return result;
  } finally {
    LOCK_DEPTH--;
    lock.releaseLock();
  }
}

function clearCache() {
  try { CacheService.getScriptCache().remove('bootstrap'); } catch (e) {}
}

/* ==========================================================================
   Utilities
   ========================================================================== */

function uid(prefix) {
  return prefix + '_' + new Date().getTime().toString(36) +
         Math.random().toString(36).slice(2, 7);
}

/**
 * An unguessable value for anything that grants access: a session token, a
 * share link, a salt. uid() is a timestamp plus about 26 random bits — fine for
 * a record id, but a token built that way could be found by trying the few
 * million values around the moment it was made.
 */
function secureToken(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function nowISO() {
  return new Date().toISOString();
}

function todayISO() {
  return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
}

/**
 * A date in any shape reduced to YYYY-MM-DD, or '' if it is not one.
 *
 * A date column comes back from Sheets as a string on one read and a Date
 * object on another, depending on how the cell was written. Comparing the raw
 * values then fails for two rows that describe the same day.
 */
function dayOf(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  }
  var s = String(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, tz(), 'yyyy-MM-dd');
}

/**
 * A day plus some days, worked on the calendar date alone. Going through a
 * local Date shifted the result by a day whenever the script's zone was behind
 * UTC, since "2026-03-01" parses as midnight UTC.
 */
function addDaysISO(iso, days) {
  var base = dayOf(iso) || todayISO();
  var p = base.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + (Number(days) || 0)));
  return d.toISOString().slice(0, 10);
}

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** A name reduced to its comparable form: case and spacing are not meaningful. */
function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A phone reduced to its comparable form, so "0300-1234567", "0300 1234567",
 * "+923001234567" and 3001234567 (a number Sheets stripped the 0 from) all
 * match. Mirror of phoneKey() in src/lib/localAdapter.js.
 */
function phoneKey(v) {
  var d = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  if (/^92\d{10}$/.test(d)) d = '0' + d.slice(2);
  if (/^3\d{9}$/.test(d)) d = '0' + d;
  return d;
}

/** Mirror of applyRounding() in src/lib/format.js — keep the two in step. */
function applyRounding(amount, rule) {
  var v = r2(amount);
  switch (rule) {
    case 'exact':     return v;
    case 'nearest5':  return Math.round(v / 5) * 5;
    case 'nearest10': return Math.round(v / 10) * 10;
    default:          return Math.round(v);
  }
}

/**
 * Recompute a bill's money from its lines (Safety Guide 2.3).
 * The client's subtotal/roundOff/total are display values only: over a real
 * network anyone can post their own, so the server must derive its own.
 */
function billTotalsFromLines(lines, roundingRule) {
  var subtotal = r2(lines.reduce(function (s, l) {
    return s + (Number(l.qty) || 0) * (Number(l.price) || 0);
  }, 0));
  var total = applyRounding(subtotal, roundingRule);
  return { subtotal: subtotal, roundOff: r2(total - subtotal), total: r2(total) };
}

/**
 * What has been paid and returned against every bill, read once.
 *
 * A payment counts unless it is reversed or its cheque bounced; a cheque still
 * waiting to clear counts, so the same money cannot be taken twice. This is
 * payableNow() on the client: gross, less returns, less payments.
 *
 * Reading the three tabs once matters for account payments, which walk every
 * bill a party has — reading them per bill made a long khata time out.
 */
function dueBook() {
  var bounced = {};
  readAll('Cheques').forEach(function (c) {
    if (c.status === 'bounced' && c.paymentId) bounced[c.paymentId] = 1;
  });
  var returned = {};
  readAll('Returns').forEach(function (r) {
    returned[r.billId] = (returned[r.billId] || 0) + (Number(r.valueAdjusted) || 0);
  });
  var paid = {};
  readAll('Payments').forEach(function (p) {
    if (!p.billId || p.reversed || bounced[p.id]) return;
    paid[p.billId] = (paid[p.billId] || 0) + (Number(p.amount) || 0);
  });
  return {
    paid: function (billId) { return r2(paid[billId] || 0); },
    returned: function (billId) { return r2(returned[billId] || 0); },
    due: function (bill) {
      return r2(Math.max(0, r2(r2(bill.totalAmount) - r2(returned[bill.id] || 0)) - r2(paid[bill.id] || 0)));
    }
  };
}

/** Amount still owed on one bill. */
function billDue(billId) {
  var bill = getById('Bills', billId);
  if (!bill) return 0;
  return dueBook().due(bill);
}

/**
 * Methods the system writes itself. 'Advance' is a bill paid from a party's
 * advance balance and 'Set-off' a sale cancelled against a purchase; neither
 * brings money in, so a payment typed in by hand must never claim one.
 */
var RESERVED_METHODS = { 'Advance': 1, 'Set-off': 1 };

function assertMethod(method) {
  if (RESERVED_METHODS[String(method || '')]) {
    fail('"' + method + '" is recorded by the system itself. Choose how the money was actually paid.');
  }
}

/**
 * Reject lines that would produce impossible money or stock before any of it
 * reaches the sheet. `min="0"` in the form is a browser hint only.
 */
function validateBillLines(lines, itemById) {
  lines.forEach(function (l, i) {
    var qty = Number(l.qty);
    var price = Number(l.price);
    if (!isFinite(qty) || qty <= 0) {
      fail('Line ' + (i + 1) + ': quantity must be greater than zero');
    }
    if (!isFinite(price) || price < 0) {
      fail('Line ' + (i + 1) + ': price must be zero or more');
    }
    if (!itemById[l.itemId]) {
      fail('Line ' + (i + 1) + ': item not found');
    }
  });
}

/**
 * Share-link password hash, salted per link.
 *
 * Without a salt, two parties who pick the same password get the same hash, and
 * every hash can be attacked with one precomputed table. The salt is stored
 * beside the hash — that is expected; its job is to make each link's password
 * have to be attacked on its own.
 */
function saltedHash(password, salt) {
  return sha256(String(salt || '') + ':' + String(password || ''));
}

/**
 * Check a share password against a stored link, accepting links created before
 * salting existed so that adding it does not lock out live links.
 */
function sharePasswordMatches(link, password) {
  if (link.salt) return saltedHash(password, link.salt) === link.passwordHash;
  return sha256(String(password || '')) === link.passwordHash;
}

/** SHA-256 hex — same hashing the frontend local adapter uses (NFR-5). */
function sha256(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var s = b.toString(16);
    hex += s.length === 1 ? '0' + s : s;
  }
  return hex;
}

function logActivity(entityType, entityId, action, description, oldValue, newValue) {
  appendRow('ActivityLog', {
    id: uid('log'),
    entityType: entityType,
    entityId: entityId,
    action: action,
    description: description,
    oldValue: oldValue ? JSON.stringify(oldValue) : '',
    newValue: newValue ? JSON.stringify(newValue) : '',
    user: ACTING_USER,
    timestamp: nowISO()
  });
}

/* ==========================================================================
   Settings (stored as key/value rows)
   ========================================================================== */

var SETTINGS_DEFAULTS = {
  shopName: 'SGA Balloon Merchant',
  phone: '', address: '', email: '', logoUrl: '',
  roundingRule: 'nearest1',
  priceAlertThreshold: 15,
  defaultCreditDays: 7,
  customMethods: []
};

function readSettings() {
  var rows = readAll('Settings');
  var out = {};
  for (var k in SETTINGS_DEFAULTS) out[k] = SETTINGS_DEFAULTS[k];

  rows.forEach(function (r) {
    if (!r.key) return;
    var v = r.value;
    if (r.key === 'customMethods') {
      try { v = JSON.parse(v || '[]'); } catch (e) { v = []; }
    } else if (r.key === 'phone') {
      v = phoneText(v);
    } else if (r.key === 'priceAlertThreshold' || r.key === 'defaultCreditDays') {
      v = Number(v) || SETTINGS_DEFAULTS[r.key];
    } else if (typeof v === 'number' && typeof SETTINGS_DEFAULTS[r.key] === 'string') {
      v = String(v);
    }
    out[r.key] = v;
  });
  // The business was renamed. The old name saved before the rename reads as
  // the new one until someone types a different name in Settings.
  if (String(out.shopName).trim() === 'J.H Enterprises') out.shopName = SETTINGS_DEFAULTS.shopName;
  return out;
}

/** Settings the dashboard can change. Anything else in a request is ignored. */
var SETTINGS_KEYS = {
  shopName: 1, phone: 1, address: 1, email: 1, logoUrl: 1, roundingRule: 1,
  priceAlertThreshold: 1, defaultCreditDays: 1, customMethods: 1, receiptWidthMm: 1
};
var BUILTIN_METHODS = ['Cash', 'JazzCash', 'EasyPaisa', 'HBL Bank', 'Cheque'];

/**
 * Custom payment methods, cleaned: trimmed, no repeats, and none that clash
 * with a built-in or a system method. A custom "Advance" would make every bill
 * paid from an advance count as money arriving in that account.
 */
function cleanMethods(list) {
  if (!Array.isArray(list)) fail('Payment methods must be a list');
  var taken = {};
  BUILTIN_METHODS.forEach(function (m) { taken[m.toLowerCase()] = 1; });
  for (var r in RESERVED_METHODS) taken[r.toLowerCase()] = 1;
  var out = [];
  list.forEach(function (m) {
    var name = String(m || '').trim();
    if (!name) return;
    if (taken[name.toLowerCase()]) fail('"' + name + '" is already a payment method, or is used by the system.');
    taken[name.toLowerCase()] = 1;
    out.push(name);
  });
  return out;
}

function saveSettings(patch) {
  return withLock(function () {
    var before = readSettings();
    var s = sheet('Settings');

    if (patch.roundingRule !== undefined &&
        ['exact', 'nearest1', 'nearest5', 'nearest10'].indexOf(patch.roundingRule) < 0) {
      fail('Unknown rounding rule');
    }

    for (var key in patch) {
      if (!SETTINGS_KEYS[key]) continue;
      var value = patch[key];
      if (key === 'customMethods') value = JSON.stringify(cleanMethods(value || []));
      // Written under the setting's own name, not the column's: 'value' is a
      // money column elsewhere, and a phone number must not become a number.
      value = cellValue(key, value);
      var rowNum = findRow('Settings', key, 'key');
      if (rowNum > 0) {
        s.getRange(rowNum, 2).setValue(value);
      } else {
        s.appendRow([key, value]);
      }
    }

    var after = readSettings();
    logActivity('settings', 'settings', 'edit', 'Settings updated', before, after);
    return after;
  });
}

/* ==========================================================================
   Auth
   ========================================================================== */

// Failed-attempt throttling. Unlike the browser adapter's localStorage copy,
// this one is server-side and so cannot be cleared by whoever is guessing.
var MAX_ATTEMPTS = 5;
var LOCK_MS = 60 * 1000;

/** Seconds left on a lockout for this key, or 0 if it may try now. */
function lockRemaining(key) {
  var raw = PropertiesService.getScriptProperties().getProperty('lock:' + key);
  if (!raw) return 0;
  var rec = JSON.parse(raw);
  if (rec.count < MAX_ATTEMPTS) return 0;
  var left = rec.lockedAt + LOCK_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function recordFailure(key) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('lock:' + key);
  var rec = raw ? JSON.parse(raw) : { count: 0, lockedAt: 0 };
  // An expired lockout starts counting again from zero.
  if (rec.count >= MAX_ATTEMPTS && rec.lockedAt + LOCK_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedAt = Date.now();
  props.setProperty('lock:' + key, JSON.stringify(rec));
}

function clearFailures(key) {
  PropertiesService.getScriptProperties().deleteProperty('lock:' + key);
}

function assertNotLocked(key) {
  var wait = lockRemaining(key);
  if (wait > 0) {
    fail('Too many failed attempts. Try again in ' + wait +
         ' second' + (wait === 1 ? '' : 's') + '.');
  }
}

/* --------------------------------------------------------------------------
   Sessions

   A token is only meaningful because this file wrote it down. Every non-public
   action is checked against this store, so a caller who has the deployment URL
   but no valid token can do nothing at all.

   Script properties are the store rather than a sheet: a session check runs on
   every request, and a property read does not contend with the spreadsheet
   lock that writes hold.
   -------------------------------------------------------------------------- */

// Sessions do not expire — signing in once lasts until someone presses logout.
// A till is open all day and a re-login prompt mid-sale is worse than a browser
// left signed in on the shop's own device.
//
// Ten years rather than Infinity so expiresAt stays a real timestamp that
// pruneSessions and validateToken can still compare.
// Matches SESSION_TTL_MS in src/lib/localAdapter.js.
var SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Script properties are a bounded store, so sessions cannot accumulate
 * forever. Expired entries are dropped first; only if live sessions still
 * exceed the cap are the oldest of those evicted, which signs that user out.
 */
var MAX_SESSIONS = 200;

/**
 * How many live sessions one username may hold.
 *
 * Sessions no longer expire, so without this every login would keep its record
 * forever: the same shop device signing in each morning would consume a slot a
 * day until it filled MAX_SESSIONS and started evicting other people's logins.
 * Trimming a user's own oldest sessions keeps that self-inflicted growth away
 * from the shared cap, while still allowing several real devices per account.
 */
var MAX_SESSIONS_PER_USER = 10;

function sessionKey(token) {
  return 'sess:' + token;
}

/** The session this token names, or null if absent, malformed or expired. */
function validSession(token) {
  if (!token) return null;

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(sessionKey(token));
  if (!raw) return null;

  var rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    // A malformed entry can never become valid again, so drop it.
    props.deleteProperty(sessionKey(token));
    return null;
  }

  if (!rec || !rec.username || !rec.expiresAt || Date.now() >= rec.expiresAt) {
    props.deleteProperty(sessionKey(token));
    return null;
  }
  return rec;
}

function createSession(username, role) {
  var props = PropertiesService.getScriptProperties();
  pruneSessions(props);
  trimUserSessions(props, username);

  var token = secureToken('tok');
  var expiresAt = Date.now() + SESSION_TTL_MS;
  props.setProperty(sessionKey(token), JSON.stringify({
    username: username,
    role: role,
    expiresAt: expiresAt
  }));
  return { token: token, expiresAt: expiresAt };
}

function pruneSessions(props) {
  var keys = props.getKeys().filter(function (k) { return k.indexOf('sess:') === 0; });
  if (keys.length < MAX_SESSIONS) return;

  var live = [];
  keys.forEach(function (k) {
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (!rec || !rec.expiresAt || Date.now() >= rec.expiresAt) {
      props.deleteProperty(k);
    } else {
      live.push({ key: k, expiresAt: rec.expiresAt });
    }
  });

  // Still over the cap even after clearing the dead ones: evict the oldest
  // logins. Sessions no longer expire, so almost nothing is ever cleared as
  // dead above and this eviction is the only thing keeping the property store
  // inside its bounds. Ordering by expiresAt still means oldest-login-first,
  // because every session is issued with the same fixed lifetime.
  var excess = live.length - MAX_SESSIONS + 1;
  if (excess <= 0) return;
  live.sort(function (a, b) { return a.expiresAt - b.expiresAt; });
  live.slice(0, excess).forEach(function (s) { props.deleteProperty(s.key); });
}

/**
 * Keep one user's live sessions under MAX_SESSIONS_PER_USER, dropping their
 * oldest first. Called as a new session is about to be created, so it leaves
 * room for that one. Only ever touches this username's own sessions: a busy
 * device must not be able to sign anybody else out.
 */
function trimUserSessions(props, username) {
  var mine = [];
  props.getKeys().forEach(function (k) {
    if (k.indexOf('sess:') !== 0) return;
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (!rec || rec.username !== username) return;
    if (!rec.expiresAt || Date.now() >= rec.expiresAt) {
      props.deleteProperty(k);
      return;
    }
    mine.push({ key: k, expiresAt: rec.expiresAt });
  });

  var excess = mine.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) return;
  // Same fixed lifetime for every session, so nearest expiry is oldest login.
  mine.sort(function (a, b) { return a.expiresAt - b.expiresAt; });
  mine.slice(0, excess).forEach(function (s) { props.deleteProperty(s.key); });
}

/** Invalidate every session for a user — used when the password changes. */
function revokeSessionsFor(username) {
  var props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) {
    if (k.indexOf('sess:') !== 0) return;
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (rec && rec.username === username) props.deleteProperty(k);
  });
}

/** End this one session: the token stops working everywhere, not just here. */
function logout(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty(sessionKey(token));
  return { ok: true };
}

/**
 * Login password storage: "s1$<salt>$<sha256(salt:password)>".
 *
 * Unsalted, two accounts with one password share a hash, and every hash can be
 * looked up in a precomputed table. Accounts created before salting hold a bare
 * sha256; they still sign in, and are upgraded on that first sign-in.
 */
function makePasswordHash(password) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 's1$' + salt + '$' + sha256(salt + ':' + String(password || ''));
}

function passwordMatches(user, password) {
  var stored = String((user && user.passwordHash) || '');
  var parts = stored.split('$');
  if (parts.length === 3 && parts[0] === 's1') {
    return sha256(parts[1] + ':' + String(password || '')) === parts[2];
  }
  return stored !== '' && stored === sha256(String(password || ''));
}

/** The account a username belongs to, compared without case. */
function findUser(users, username) {
  var want = String(username || '').trim().toLowerCase();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username).toLowerCase() === want) return users[i];
  }
  return null;
}

/** The password every new install starts with. */
var DEFAULT_PASSWORD = 'admin123';

function login(p) {
  // Creating the tabs reads and writes all of them. It is needed once, so it
  // is not repeated on every sign-in — this action is reachable by anyone.
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('seeded') !== 'yes') {
    ensureSeed();
    props.setProperty('seeded', 'yes');
  }

  var user = findUser(ensureSuperAdmin(readAll('Users')), p.username);
  if (user && user.status === 'disabled') fail('This account is switched off. Ask the super admin.');

  // Only a real account is throttled. Recording failures for any name typed
  // would let anyone fill the script's property store, one made-up username at
  // a time, until no session could be saved and nobody could sign in.
  var lockKey = user ? 'login:' + String(user.username).toLowerCase() : null;
  if (lockKey) assertNotLocked(lockKey);

  if (!user || !passwordMatches(user, p.password)) {
    if (lockKey) recordFailure(lockKey);
    fail('Invalid username or password');
  }
  clearFailures(lockKey);

  if (String(user.passwordHash).indexOf('s1$') !== 0) {
    var rowNum = findRow('Users', user.id);
    if (rowNum > 0) updateRow('Users', rowNum, { passwordHash: makePasswordHash(p.password) });
  }

  var session = createSession(user.username, user.role);
  var access = accessOf(user);
  return {
    token: session.token,
    username: user.username,
    name: access.name,
    role: access.role,
    pages: access.pages,
    seesCost: access.seesCost,
    expiresAt: session.expiresAt,
    // Lets the dashboard ask for the factory password to be changed.
    defaultPassword: String(p.password || '') === DEFAULT_PASSWORD
  };
}

function changePassword(p) {
  return withLock(function () {
    var users = readAll('Users');
    if (!users.length) fail('No user account found');

    // Change the password of whoever is signed in, not whoever happens to be
    // first in the sheet.
    var user = findUser(users, ACTING_USER);
    if (!user) fail('No user account found');

    // Throttled like login: this endpoint takes the current password, so
    // without a limit it would be a guessing oracle for a stolen token.
    assertNotLocked('pw:' + user.username);

    if (!passwordMatches(user, p.oldPassword)) {
      recordFailure('pw:' + user.username);
      fail('Current password is incorrect');
    }
    if (!p.newPassword || String(p.newPassword).length < 6) {
      fail('New password must be at least 6 characters');
    }
    if (String(p.newPassword) === DEFAULT_PASSWORD) {
      fail('Choose a password other than the default one');
    }
    clearFailures('pw:' + user.username);

    var rowNum = findRow('Users', user.id);
    updateRow('Users', rowNum, { passwordHash: makePasswordHash(p.newPassword) });

    // A password change must end sessions opened with the old one — on every
    // other device. The device that made the change gets a fresh session, or
    // its very next click would sign it out.
    revokeSessionsFor(user.username);
    var session = createSession(user.username, user.role);

    logActivity('user', user.id, 'edit', 'Password changed');
    return {
      ok: true,
      token: session.token,
      username: user.username,
      role: user.role,
      expiresAt: session.expiresAt
    };
  });
}

/* ==========================================================================
   Bootstrap — every tab in one response (cached briefly)
   ========================================================================== */

function bootstrap() {
  // ensureSeed() touches all 19 tabs and can create sheets, which is slow and
  // contends with concurrent requests. Once the workbook is initialised it never
  // needs to run again, so a Script Property gates it after the first success.
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('seeded') !== 'yes') {
    ensureSeed();
    props.setProperty('seeded', 'yes');
  }

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) {}

  if (cache) {
    try {
      var hit = cache.get('bootstrap');
      if (hit) return JSON.parse(hit);
    } catch (e) {
      // A cache miss, expiry, or parse failure must never fail the request —
      // fall through and read from the sheets instead.
    }
  }

  var out = {};
  for (var tab in TAB_TO_KEY) {
    out[TAB_TO_KEY[tab]] = readAll(tab);
  }

  // A share link's password hash is never needed by the dashboard — it only
  // shows whether a link exists and lets you revoke it. Sending the hash would
  // put every share password into the bootstrap response (and its cache) for
  // offline cracking.
  out.partyLedgerLinks = (out.partyLedgerLinks || []).map(function (l) {
    return {
      partyId: l.partyId,
      token: l.token,
      active: l.active,
      createdAt: l.createdAt
    };
  });
  out.settings = readSettings();
  out.methods = ['Cash', 'JazzCash', 'EasyPaisa', 'HBL Bank', 'Cheque']
    .concat(out.settings.customMethods || []);

  if (cache) {
    try {
      var payload = JSON.stringify(out);
      // CacheService caps an entry at 100KB of UTF-8, so measure bytes, not
      // JS characters, and leave headroom.
      if (Utilities.newBlob(payload).getBytes().length < 90000) {
        cache.put('bootstrap', payload, CACHE_SECONDS);
      }
    } catch (e) {
      // Caching is an optimisation; never let it break the response.
    }
  }

  return out;
}

/* ==========================================================================
   Sync — accept records entered offline on a device
   ========================================================================== */

/**
 * Upsert records that were created while the dashboard had no internet.
 *
 * The contract that makes this safe:
 *
 *   1. The DEVICE's id is authoritative. Ids are `prefix_<base36 time><random>`
 *      and are generated identically on both sides, so a local id can be
 *      written straight into the sheet. Same id in both places means the two
 *      databases line up exactly — a bill's partyId still resolves, and the
 *      ledgers agree without any id translation.
 *
 *   2. An id that already exists is an UPDATE, never a second row. That is what
 *      makes pushing twice harmless: re-sending the same day's work cannot
 *      duplicate a bill. Sync is idempotent by construction.
 *
 *   3. When both sides changed the same record, the more recently edited one
 *      wins, compared on `updatedAt` (falling back to `createdAt`). A record
 *      the server has edited more recently is KEPT and reported as `kept`, so
 *      nothing is silently overwritten either way.
 *
 * Everything is written under one lock and one flush, so a half-applied push
 * cannot leave the sheet inconsistent.
 */
function syncPush(p) {
  var groups = p && p.records ? p.records : {};

  // Parents before children: a bill must not land before its party exists, or
  // a ledger would briefly reference a missing row.
  var ORDER = [
    'Parties', 'Suppliers', 'Items', 'Employees', 'Assets',
    'PurchaseBills', 'Purchases', 'Bills', 'BillItems', 'PartyItemPrices',
    'Payments', 'Returns', 'Cheques', 'PartyAdvances',
    'EmployeeTransactions', 'Expenses', 'StockLoss',
    'SupplierPayments', 'SupplierReturns',
    'Warehouses', 'WhParties', 'WarehouseMoves', 'WarehouseMoveLines', 'WarehouseExpenses',
    'WhPartyPayments', 'ActivityLog'
  ];

  return withLock(function () {
    var result = {
      inserted: 0, updated: 0, kept: 0, failed: 0,
      byTab: {}, conflicts: [], errors: [], billNoChanges: []
    };

    for (var i = 0; i < ORDER.length; i++) {
      var tab = ORDER[i];
      var rows = groups[tab];
      if (!rows || !rows.length) continue;

      // One read per tab rather than one lookup per record: Apps Script is slow
      // at many small calls, and a day's sync can carry hundreds of rows.
      var existing = readAll(tab);
      var byId = {};
      for (var e = 0; e < existing.length; e++) byId[String(existing[e].id)] = existing[e];

      var stats = { inserted: 0, updated: 0, kept: 0, failed: 0 };

      for (var r = 0; r < rows.length; r++) {
        var rec = rows[r];
        try {
          if (!rec || !rec.id) { stats.failed++; result.failed++; continue; }

          var current = byId[String(rec.id)];

          if (!current) {
            // Bills carry a human-facing number that both sides allocate
            // independently, so an offline bill can arrive holding a number
            // the server already issued to a different bill. The record is
            // still inserted — never dropped — under the next free number,
            // and the change is reported so the shopkeeper can see it.
            if (tab === 'Bills') {
              var wanted = String(rec.billNo || '');
              if (wanted && billNoTakenBy(existing, wanted, rec.id)) {
                var replacement = nextFreeBillNo(existing, wanted);
                result.billNoChanges.push({ id: rec.id, from: wanted, to: replacement });
                rec.billNo = replacement;
              }
            }

            appendRow(tab, rec);
            existing.push(rec);
            byId[String(rec.id)] = rec;
            stats.inserted++;
            result.inserted++;
          } else if (isNewer(rec, current)) {
            updateRow(tab, findRow(tab, rec.id), rec);
            byId[String(rec.id)] = rec;
            stats.updated++;
            result.updated++;
          } else {
            // The server's copy is the same or newer: leave it alone.
            stats.kept++;
            result.kept++;
            if (changed(rec, current)) {
              result.conflicts.push({
                tab: tab, id: rec.id,
                keptServerVersion: true,
                serverUpdatedAt: stamp(current),
                deviceUpdatedAt: stamp(rec)
              });
            }
          }
        } catch (err) {
          stats.failed++;
          result.failed++;
          // Report and continue: one bad row must not abandon the rest of the
          // day's work.
          result.errors.push({
            tab: tab,
            id: rec && rec.id ? rec.id : '(no id)',
            error: String(err && err.message ? err.message : err)
          });
        }
      }

      result.byTab[tab] = stats;
    }

    // Records the device deleted — a removed payment, or the old lines of an
    // edited bill. Without this the Sheet keeps them forever, and the next
    // download would hand them straight back to the device. Limited to the
    // tabs sync writes; the log is append-only and never deleted from.
    // `deleted` is always a number, even 0: the device reads its presence as
    // "this backend understands deletions" before marking any as done.
    result.deleted = 0;
    var del = p && p.deleted ? p.deleted : {};
    for (var dt in del) {
      if (ORDER.indexOf(dt) < 0 || dt === 'ActivityLog') continue;
      var ids = del[dt] || [];
      for (var x = 0; x < ids.length; x++) {
        try {
          // Already gone counts as done: the device only needs it absent.
          deleteRowById(dt, ids[x]);
          result.deleted++;
        } catch (err) {
          result.failed++;
          result.errors.push({
            tab: dt, id: ids[x],
            error: String(err && err.message ? err.message : err)
          });
        }
      }
    }

    logActivity('system', 'sync', 'create',
      'Synced from a device: ' + result.inserted + ' new, ' + result.updated +
      ' updated, ' + result.deleted + ' deleted, ' + result.kept + ' kept, ' +
      result.failed + ' failed');

    return result;
  });
}

/** The edit time a sync comparison should use. */
function stamp(rec) {
  if (!rec) return '';
  return String(rec.updatedAt || rec.createdAt || rec.timestamp || '');
}

/** Is the incoming record more recently edited than the one on the server? */
function isNewer(incoming, current) {
  var a = stamp(incoming);
  var b = stamp(current);
  // With nothing to compare, keep the server's copy rather than overwrite
  // blind. A record with no timestamps is almost always unchanged reference
  // data that has simply been re-sent.
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

/** Do two versions of a record actually differ on any shared field? */
function changed(a, b) {
  for (var k in a) {
    if (k === '_row' || k === 'updatedAt') continue;
    if (b[k] === undefined) continue;
    if (String(a[k]) !== String(b[k])) return true;
  }
  return false;
}

/** Is this bill number already used by a DIFFERENT bill? */
function billNoTakenBy(bills, billNo, selfId) {
  for (var i = 0; i < bills.length; i++) {
    if (String(bills[i].billNo) === String(billNo) &&
        String(bills[i].id) !== String(selfId)) return true;
  }
  return false;
}

/** The next unused number in the same YEAR-SEQ series. */
function nextFreeBillNo(bills, wanted) {
  var parts = String(wanted).split('-');
  var year = parts.length > 1 ? parts[0] : String(new Date().getFullYear());

  var max = 0;
  for (var i = 0; i < bills.length; i++) {
    var bits = String(bills[i].billNo || '').split('-');
    if (bits.length === 2 && bits[0] === year) {
      var n = parseInt(bits[1], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  var next = String(max + 1);
  while (next.length < 4) next = '0' + next;
  return year + '-' + next;
}

/* ==========================================================================
   Parties
   ========================================================================== */

function saveParty(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Party name is required');

    // Two parties with the same name each get their own ledger, so payments
    // land on whichever was picked and neither balance is right — and the
    // shopkeeper cannot tell them apart in a dropdown. Compared case- and
    // space-insensitively: "hamza foods" and "Hamza  Foods" are one shop to
    // everyone except a string comparison.
    var wantKey = nameKey(p.name);
    var parties = readAll('Parties');
    for (var dp = 0; dp < parties.length; dp++) {
      if (String(parties[dp].id) !== String(p.id) && nameKey(parties[dp].name) === wantKey) {
        fail('A party called "' + parties[dp].name + '" already exists. ' +
             'Use a different name, or open the existing one.');
      }
    }

    // One mobile number, one party: otherwise the same customer can end up
    // with two ledgers under two names.
    var wantPhone = phoneKey(p.phone);
    if (wantPhone) {
      for (var pp = 0; pp < parties.length; pp++) {
        if (String(parties[pp].id) !== String(p.id) && phoneKey(parties[pp].phone) === wantPhone) {
          fail('This mobile number is already registered on party "' + parties[pp].name + '".');
        }
      }
    }

    var settings = readSettings();

    if (p.id) {
      var existing = getById('Parties', p.id);
      if (!existing) fail('Party not found');
      var patch = {
        name: String(p.name).trim(),
        phone: p.phone || '',
        address: p.address || '',
        creditLimit: Number(p.creditLimit) || 0,
        defaultDueDays: Number(p.defaultDueDays) || settings.defaultCreditDays
      };
      updateRow('Parties', existing._row, patch);
      logActivity('party', p.id, 'edit', 'Edited party "' + patch.name + '"', existing, patch);
      return getById('Parties', p.id);
    }

    var rec = {
      id: uid('pty'),
      name: String(p.name).trim(),
      phone: p.phone || '',
      address: p.address || '',
      creditLimit: Number(p.creditLimit) || 0,
      defaultDueDays: Number(p.defaultDueDays) || settings.defaultCreditDays,
      status: 'active',
      createdAt: nowISO()
    };
    appendRow('Parties', rec);
    logActivity('party', rec.id, 'create', 'Added party "' + rec.name + '"');
    return rec;
  });
}

/**
 * Set, change or remove the password on one party's ledger. Mirrors
 * setPartyLock in src/lib/localAdapter.js.
 *
 * Changing or removing an existing lock needs the party's current password,
 * or the signed-in user's login password so a forgotten one can be reset.
 */
function setPartyLock(p, tab) {
  tab = tab || 'Parties';
  return withLock(function () {
    var party = getById(tab, p.partyId);
    if (!party) fail('Party not found');

    var next = String(p.password || '');
    if (next && next.length < 4) fail('Party password must be at least 4 characters');

    if (party.lockHash) {
      // Accepts the login password too, so it is throttled like the password
      // change: otherwise it would be a free guessing oracle for that password.
      var throttle = 'pw:' + ACTING_USER;
      assertNotLocked(throttle);
      var cur = String(p.currentPassword || '');
      var partyOk = saltedHash(cur, party.lockSalt) === party.lockHash;
      var loginOk = passwordMatches(findUser(readAll('Users'), ACTING_USER), cur);
      if (!partyOk && !loginOk) {
        recordFailure(throttle);
        fail('Current password is wrong. Enter this party’s password, or your login password.');
      }
      clearFailures(throttle);
    }

    var salt = next ? secureToken('slt') : '';
    updateRow(tab, party._row, {
      lockSalt: salt,
      lockHash: next ? saltedHash(next, salt) : ''
    });
    logActivity(tab === 'Parties' ? 'party' : 'warehouse party', party.id, 'edit',
      next ? (party.lockHash ? 'Changed ledger password for "' + party.name + '"'
                             : 'Locked ledger of "' + party.name + '" with a password')
           : 'Removed ledger password from "' + party.name + '"');
    return { ok: true, locked: Boolean(next) };
  });
}

/** Archive/restore — never delete (Safety Guide 2.1). */
function toggleArchive(tab, id, label) {
  return withLock(function () {
    var rec = getById(tab, id);
    if (!rec) fail(label.charAt(0).toUpperCase() + label.slice(1) + ' not found');
    var next = rec.status === 'archived' ? 'active' : 'archived';
    updateRow(tab, rec._row, { status: next });
    logActivity(label, id,
      'edit',
      (next === 'archived' ? 'Archived ' : 'Restored ') + label + ' "' + rec.name + '"');
    return getById(tab, id);
  });
}

/* ==========================================================================
   Items
   ========================================================================== */

function saveItem(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Item name is required');

    // Same reasoning as parties: two items of one name split a product's stock
    // and price history across two records, so neither reads correctly.
    var wantItemKey = nameKey(p.name);
    var allItems = readAll('Items');
    for (var di = 0; di < allItems.length; di++) {
      if (String(allItems[di].id) !== String(p.id) &&
          nameKey(allItems[di].name) === wantItemKey) {
        fail('An item called "' + allItems[di].name + '" already exists. ' +
             'Use a different name, or edit the existing one.');
      }
    }

    // Someone who cannot see cost prices cannot set them either: their form
    // has no cost, and saving it must not wipe the real one.
    var setsCost = !CURRENT || CURRENT.seesCost;

    if (p.id) {
      var existing = getById('Items', p.id);
      if (!existing) fail('Item not found');
      var patch = {
        name: String(p.name).trim(),
        baseUnit: p.baseUnit || 'Piece',
        altUnit: p.altUnit || '',
        conversionRate: Number(p.conversionRate) || 0,
        category: p.category || '',
        costPrice: setsCost ? Number(p.costPrice) || 0 : Number(existing.costPrice) || 0,
        lowStockAlert: Number(p.lowStockAlert) || 0
      };
      updateRow('Items', existing._row, patch);
      logActivity('item', p.id, 'edit', 'Edited item "' + patch.name + '"', existing, patch);
      return getById('Items', p.id);
    }

    var rec = {
      id: uid('itm'),
      name: String(p.name).trim(),
      baseUnit: p.baseUnit || 'Piece',
      altUnit: p.altUnit || '',
      conversionRate: Number(p.conversionRate) || 0,
      category: p.category || '',
      costPrice: setsCost ? Number(p.costPrice) || 0 : 0,
      lastPurchaseDate: '',
      openingStock: Number(p.openingStock) || 0,
      lowStockAlert: Number(p.lowStockAlert) || 0,
      status: 'active'
    };
    appendRow('Items', rec);
    logActivity('item', rec.id, 'create', 'Added item "' + rec.name + '"');
    return rec;
  });
}

/* ==========================================================================
   Bills
   ========================================================================== */

/**
 * Auto-incrementing bill number per year (FR-10).
 *
 * The counter lives in script properties, which a copied or restored script
 * does not carry over, while the bills themselves stay in the sheet. So the
 * next number is also kept above the highest one already written — a reset
 * counter must never hand out a number a bill already has.
 */
function nextBillNo() {
  var year = todayISO().slice(0, 4);
  var props = PropertiesService.getScriptProperties();
  var key = 'billCounter_' + year;
  var n = Number(props.getProperty(key) || 0);
  readAll('Bills').forEach(function (b) {
    var m = /^(\d{4})-(\d+)$/.exec(String(b.billNo || ''));
    if (m && m[1] === year) n = Math.max(n, Number(m[2]));
  });
  n += 1;
  props.setProperty(key, String(n));
  var padded = ('0000' + n).slice(-4);
  return year + '-' + padded;
}

function saveBill(p) {
  return withLock(function () {
    if (!p.partyId) fail('Select a party');
    if (!p.lines || !p.lines.length) fail('Add at least one item');

    if (!getById('Parties', p.partyId)) fail('Party not found');

    var settings = readSettings();
    var items = readAll('Items');
    var itemById = {};
    items.forEach(function (it) { itemById[it.id] = it; });

    validateBillLines(p.lines, itemById);
    var computed = billTotalsFromLines(p.lines, settings.roundingRule);

    var bill;
    var editing = Boolean(p.id);
    // itemId -> quantity already delivered on the bill being edited.
    var deliveredBefore = {};
    // itemId -> cost it was sold at, on the bill being edited.
    var costBefore = {};
    var trustCost = !CURRENT || CURRENT.seesCost;

    /* ---- Everything is checked before anything is written ---- */
    var existing = null;
    var covered = 0;
    if (editing) {
      existing = getById('Bills', p.id);
      if (!existing) fail('Bill not found');
      if (existing.status === 'voided') fail('A voided bill cannot be edited');

      // Editing a bill down below what has already been paid or returned would
      // leave the overpayment with nowhere to go: it is not refunded, not held
      // as an advance, and simply disappears from the ledger. Refusing says what
      // is wrong and leaves the shopkeeper to reverse a payment first.
      var book = dueBook();
      var paidSoFar = book.paid(p.id);
      var returnedSoFar = book.returned(p.id);
      covered = r2(paidSoFar + returnedSoFar);
      if (covered > r2(computed.total) + 0.004) {
        fail('This bill already has ' + paidSoFar.toFixed(2) + ' paid' +
             (returnedSoFar > 0 ? ' and ' + returnedSoFar.toFixed(2) + ' returned' : '') +
             ' against it, so it cannot be reduced to ' + computed.total.toFixed(2) + '. ' +
             'Reverse a payment first.');
      }

      // Payments and returns carry the party they came from. Moving the bill
      // alone would leave them on the old party's khata, against a bill that is
      // no longer theirs.
      if (String(p.partyId) !== String(existing.partyId) && (covered > 0 ||
          readAll('Payments').some(function (x) { return x.billId === p.id; }))) {
        fail('This bill has payments recorded against it, so it cannot be moved to another party. ' +
             'Void it and write a new bill for the right party instead.');
      }
    }

    // Money taken with the bill. Paying more than the bill is worth would leave
    // the extra attached to a bill that cannot absorb it.
    var payTotal = 0;
    (p.payments || []).forEach(function (pay, i) {
      var a = Number(pay.amount);
      if (!(a > 0)) return;
      if (!isFinite(a)) fail('Payment ' + (i + 1) + ': enter a valid amount');
      assertMethod(pay.method);
      payTotal = r2(payTotal + r2(a));
    });
    var wantAdvance = Number(p.advanceApplied);
    if (!(isFinite(wantAdvance) && wantAdvance > 0)) wantAdvance = 0;
    if (wantAdvance > 0) {
      // Never apply more advance than the party actually holds: that would
      // record a payment against money that does not exist.
      var available = advanceAvailable(p.partyId);
      if (r2(wantAdvance) > r2(available) + 0.004) {
        fail('Advance applied (' + r2(wantAdvance).toFixed(2) + ') exceeds this ' +
             'party’s available advance of ' + available.toFixed(2) + '.');
      }
    }
    p.lines.forEach(function (l) {
      var given = givenQty(l.deliveredQty);
      if (given !== null && (given < 0 || given > (Number(l.qty) || 0) + 0.0001)) {
        fail(((itemById[l.itemId] || {}).name || 'Item') + ': delivered quantity must be between 0 and ' + l.qty);
      }
    });
    var room = r2(computed.total - covered);
    if (r2(payTotal + wantAdvance) > room + 0.004) {
      fail('Payments of ' + r2(payTotal + wantAdvance).toFixed(2) + ' are more than ' +
           (editing ? 'is left to pay on this bill' : 'the bill total') + ' (' + room.toFixed(2) + '). ' +
           'Reduce a payment, or record the extra as an advance from the party ledger.');
    }

    if (editing) {
      /* ---- Editing an existing bill (FR-25) ---- */
      var patch = {
        partyId: p.partyId,
        date: p.date || existing.date,
        subtotal: computed.subtotal,
        roundOff: computed.roundOff,
        totalAmount: computed.total,
        dueDate: p.dueDate || '',
        note: p.note || ''
      };
      updateRow('Bills', existing._row, patch);

      // What had already gone out, per item, so an edit does not forget it —
      // and the cost each item was sold at, kept when the editor cannot see it.
      readAll('BillItems').forEach(function (x) {
        if (x.billId !== p.id) return;
        deliveredBefore[x.itemId] = (deliveredBefore[x.itemId] || 0) + lineDeliveredQty(x, existing);
        costBefore[x.itemId] = x.costPriceAtSale;
      });

      // Replace line items; payments stay attached to the bill
      deleteRowsWhere('BillItems', 'billId', p.id);

      logActivity('bill', p.id, 'edit', 'Edited Bill ' + existing.billNo, existing, patch);
      bill = getById('Bills', p.id);

    } else {
      /* ---- New bill ---- */
      // An imported bill keeps the number it had in the file, unless another
      // bill already has it — then it is refused, so a file imported twice
      // cannot write every bill a second time.
      var ownNo = IMPORTING ? String(p.billNo || '').trim() : '';
      if (ownNo && readAll('Bills').some(function (b) { return String(b.billNo) === ownNo; })) {
        fail('Bill ' + ownNo + ' is already in the system');
      }
      bill = {
        id: uid('bil'),
        billNo: ownNo || nextBillNo(),
        partyId: p.partyId,
        date: p.date || todayISO(),
        subtotal: computed.subtotal,
        roundOff: computed.roundOff,
        totalAmount: computed.total,
        status: 'due',
        dueDate: p.dueDate || addDaysISO(p.date || todayISO(), settings.defaultCreditDays),
        note: p.note || '',
        createdAt: nowISO(),
        voidReason: '',
        voidedAt: '',
        // Most sales are handed over as the bill is written, so the biller marks
        // the exceptions as pending rather than confirming every ordinary sale.
        delivery: p.delivery === 'pending' ? 'pending' : 'delivered',
        deliveredAt: p.delivery === 'pending' ? '' : nowISO()
      };
      appendRow('Bills', bill);
      logActivity('bill', bill.id, 'create', 'Created Bill ' + bill.billNo);
    }

    /* ---- Bill lines: capture cost price at time of sale (FR-38) ---- */
    p.lines.forEach(function (l) {
      var item = itemById[l.itemId] || {};
      var qty = Number(l.qty) || 0;
      // Delivered on this line: what the caller says; else all of it when the
      // bill is marked delivered; else whatever of this item had already gone
      // out before the edit (none on a new pending bill).
      var delivered = givenQty(l.deliveredQty);
      if (delivered === null) {
        if (p.delivery === 'delivered' || (!editing && p.delivery !== 'pending')) {
          delivered = qty;
        } else {
          delivered = Math.min(qty, deliveredBefore[l.itemId] || 0);
          deliveredBefore[l.itemId] = r2((deliveredBefore[l.itemId] || 0) - delivered);
        }
      }
      if (delivered < 0 || delivered > qty + 0.0001) {
        fail((item.name || 'Item') + ': delivered quantity must be between 0 and ' + qty);
      }
      appendRow('BillItems', {
        id: uid('bli'),
        billId: bill.id,
        itemId: l.itemId,
        qty: qty,
        unit: l.unit || item.baseUnit || 'Piece',
        price: r2(l.price),
        // The cost is the server's to know when the person billing cannot see
        // it: what the item sold at before an edit, else its current cost.
        costPriceAtSale: r2(trustCost && l.costPriceAtSale !== undefined && l.costPriceAtSale !== null && l.costPriceAtSale !== ''
          ? l.costPriceAtSale
          : (costBefore[l.itemId] !== undefined && costBefore[l.itemId] !== '' ? costBefore[l.itemId] : (item.costPrice || 0))),
        lineTotal: r2((Number(l.qty) || 0) * (Number(l.price) || 0)),
        deliveredQty: r2(delivered)
      });

      // Remember this party's price for this item (source for FR-3 auto-fill)
      appendRow('PartyItemPrices', {
        id: uid('pip'),
        partyId: bill.partyId,
        itemId: l.itemId,
        price: r2(l.price),
        unit: l.unit || item.baseUnit || 'Piece',
        date: bill.date
      });
    });

    /* ---- Payments recorded with the bill (FR-7) ---- */
    (p.payments || []).forEach(function (pay) {
      if (!(Number(pay.amount) > 0)) return;
      var payId = uid('pay');
      appendRow('Payments', {
        id: payId,
        billId: bill.id,
        partyId: bill.partyId,
        method: pay.method || 'Cash',
        amount: r2(pay.amount),
        date: bill.date,
        note: pay.note || '',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false
      });

      if (pay.method === 'Cheque' && pay.cheque) {
        appendRow('Cheques', {
          id: uid('chq'),
          billId: bill.id,
          partyId: bill.partyId,
          paymentId: payId,
          chequeNo: pay.cheque.chequeNo || '',
          bankName: pay.cheque.bankName || '',
          accountHolder: pay.cheque.accountHolder || '',
          dateIssued: pay.cheque.dateIssued || bill.date,
          dateDue: pay.cheque.dateDue || bill.date,
          status: 'pending',
          amount: r2(pay.amount),
          note: pay.cheque.note || '',
          statusChangedAt: ''
        });
      }
    });

    /* ---- Applied party advance (FR-9) — checked above, before any write ---- */
    if (wantAdvance > 0) {
      // Record exactly what was consumed, so the payment row and the advance
      // ledger can never disagree.
      var used = applyAdvance(bill.partyId, wantAdvance);
      appendRow('Payments', {
        id: uid('pay'),
        billId: bill.id,
        partyId: bill.partyId,
        method: 'Advance',
        amount: used,
        date: bill.date,
        note: 'Advance applied',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false
      });
    }

    syncBillDeliveryFlag(bill.id);
    return getById('Bills', bill.id) || bill;
  });
}

/** Unapplied advance a party still holds. */
function advanceAvailable(partyId) {
  return r2(readAll('PartyAdvances')
    .filter(function (a) { return a.partyId === partyId; })
    .reduce(function (s, a) {
      return s + Math.max(0, (Number(a.amount) || 0) - (Number(a.applied) || 0));
    }, 0));
}

/**
 * Consume a party's advance balance, oldest first.
 * Returns the amount actually consumed, which the caller records as the
 * payment so the two can never drift apart.
 */
function applyAdvance(partyId, amount) {
  var advances = readAll('PartyAdvances').filter(function (a) { return a.partyId === partyId; });
  var requested = Number(amount);
  if (!isFinite(requested) || requested <= 0) return 0;

  var remaining = r2(requested);
  for (var i = 0; i < advances.length && remaining > 0; i++) {
    var a = advances[i];
    var avail = (Number(a.amount) || 0) - (Number(a.applied) || 0);
    if (avail <= 0) continue;
    var use = Math.min(avail, remaining);
    var rowNum = findRow('PartyAdvances', a.id);
    updateRow('PartyAdvances', rowNum, { applied: r2((Number(a.applied) || 0) + use) });
    remaining = r2(remaining - use);
  }
  return r2(requested - remaining);
}

/** Remove rows matching a field value (used only to replace bill lines on edit). */
function deleteRowsWhere(name, field, value) {
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return;

  var col = SCHEMA[name].indexOf(field) + 1;
  if (col < 1) return;

  var values = s.getRange(2, col, last - 1, 1).getValues();
  // Delete bottom-up so row numbers stay valid
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]) === String(value)) s.deleteRow(i + 2);
  }
}

/**
 * Mark a bill's goods as handed over, or still waiting.
 *
 * Delivery is its own field because `status` already carries the money state
 * (due/partial/paid/voided) — a bill can be paid but not yet delivered, or
 * delivered and still unpaid.
 */
function setDelivery(p) {
  return withLock(function () {
    var bill = getById('Bills', p.id);
    if (!bill) fail('Bill not found');
    if (p.delivery !== 'pending' && p.delivery !== 'delivered') {
      fail('Delivery must be pending or delivered');
    }
    // A voided bill has no goods to hand over; marking it delivered would put a
    // cancelled sale on the delivery list.
    if (bill.status === 'voided') fail('A voided bill cannot be delivered');

    var patch = {
      delivery: p.delivery,
      deliveredAt: p.delivery === 'delivered' ? nowISO() : ''
    };
    updateRow('Bills', bill._row, patch);
    // The whole bill at once: every line follows.
    readAll('BillItems').forEach(function (x) {
      if (x.billId !== p.id) return;
      var rowNum = findRow('BillItems', x.id);
      if (rowNum > 0) {
        updateRow('BillItems', rowNum,
          { deliveredQty: p.delivery === 'delivered' ? (Number(x.qty) || 0) : 0 });
      }
    });
    logActivity('bill', p.id, 'edit',
      'Bill ' + bill.billNo + ' marked ' + p.delivery, bill, patch);
    return getById('Bills', p.id);
  });
}

/* ---------------- Per-line delivery and receiving ---------------- */

/** A quantity the caller actually supplied, or null when it left it out. */
function givenQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  if (!isFinite(n)) fail('Quantity must be a number');
  return n;
}

/**
 * How much of one bill line has gone out. Rows from before per-line delivery
 * have a blank deliveredQty and follow the bill's own flag.
 */
function lineDeliveredQty(line, bill) {
  var qty = Number(line.qty) || 0;
  var v = line.deliveredQty;
  if (v === '' || v === null || v === undefined || !isFinite(Number(v))) {
    return bill && bill.delivery === 'pending' ? 0 : qty;
  }
  return Math.min(qty, Math.max(0, Number(v)));
}

/** How much of one purchase line has arrived. Blank reads as all of it. */
function lineReceivedQty(line) {
  var qty = Number(line.qty) || 0;
  var v = line.receivedQty;
  if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return qty;
  return Math.min(qty, Math.max(0, Number(v)));
}

/**
 * Keep the bill's whole-bill delivery flag in step with its lines: it stays
 * 'pending' until every line has fully gone out.
 */
function syncBillDeliveryFlag(billId) {
  var bill = getById('Bills', billId);
  if (!bill) return;
  var lines = readAll('BillItems').filter(function (x) { return x.billId === billId; });
  var all = lines.every(function (l) {
    return lineDeliveredQty(l, bill) >= (Number(l.qty) || 0) - 0.0001;
  });
  var next = all ? 'delivered' : 'pending';
  if (next === bill.delivery) return;
  updateRow('Bills', bill._row, {
    delivery: next,
    deliveredAt: next === 'delivered' ? nowISO() : ''
  });
}

/** Record how much of each line has gone out: some items now, the rest later. */
function setLineDelivery(p) {
  return withLock(function () {
    var bill = getById('Bills', p.billId);
    if (!bill) fail('Bill not found');
    if (bill.status === 'voided') fail('A voided bill cannot be delivered');
    var changes = p.lines || [];
    if (!changes.length) fail('Nothing to update');

    var lines = readAll('BillItems').filter(function (x) { return x.billId === bill.id; });
    var byId = {};
    lines.forEach(function (l) { byId[l.id] = l; });

    // Validated in full first, so one bad line leaves the bill untouched.
    var done = changes.map(function (c) {
      var line = byId[c.id];
      if (!line) fail('Bill line not found');
      var qty = Number(line.qty) || 0;
      var delivered = givenQty(c.deliveredQty);
      if (delivered === null || delivered < 0 || delivered > qty + 0.0001) {
        var it = getById('Items', line.itemId);
        fail((it ? it.name : 'Item') + ': delivered quantity must be between 0 and ' + qty);
      }
      return [line, r2(delivered)];
    });
    done.forEach(function (pair) {
      updateRow('BillItems', findRow('BillItems', pair[0].id), { deliveredQty: pair[1] });
      pair[0].deliveredQty = pair[1];
    });
    syncBillDeliveryFlag(bill.id);

    var sent = 0;
    var total = 0;
    lines.forEach(function (l) { sent += lineDeliveredQty(l, bill); total += Number(l.qty) || 0; });
    logActivity('bill', bill.id, 'edit',
      'Bill ' + bill.billNo + ' delivery updated: ' + r2(sent) + ' of ' + r2(total) + ' delivered');
    return getById('Bills', bill.id);
  });
}

/** Record how much of each purchase line has arrived from the supplier. */
function setPurchaseReceipt(p) {
  return withLock(function () {
    var bill = getById('PurchaseBills', p.purchaseBillId);
    if (!bill) fail('Purchase bill not found');
    if (bill.status === 'voided') fail('This purchase was cancelled');
    var changes = p.lines || [];
    if (!changes.length) fail('Nothing to update');

    var lines = readAll('Purchases').filter(function (x) { return x.purchaseBillId === bill.id; });
    var byId = {};
    lines.forEach(function (l) { byId[l.id] = l; });

    var done = changes.map(function (c) {
      var line = byId[c.id];
      if (!line) fail('Purchase line not found');
      var qty = Number(line.qty) || 0;
      var received = givenQty(c.receivedQty);
      if (received === null || received < 0 || received > qty + 0.0001) {
        var it = getById('Items', line.itemId);
        fail((it ? it.name : 'Item') + ': received quantity must be between 0 and ' + qty);
      }
      return [line, r2(received)];
    });
    done.forEach(function (pair) {
      updateRow('Purchases', findRow('Purchases', pair[0].id), { receivedQty: pair[1] });
      pair[0].receivedQty = pair[1];
    });

    var got = 0;
    var total = 0;
    lines.forEach(function (l) { got += lineReceivedQty(l); total += Number(l.qty) || 0; });
    logActivity('purchaseBill', bill.id, 'edit',
      'Purchase ' + bill.purchaseNo + ' receiving updated: ' + r2(got) + ' of ' + r2(total) + ' received');
    return getById('PurchaseBills', bill.id);
  });
}

function voidBill(p) {
  return withLock(function () {
    var bill = getById('Bills', p.id);
    if (!bill) fail('Bill not found');
    if (bill.status === 'voided') fail('This bill is already voided');

    var patch = { status: 'voided', voidReason: p.reason || '', voidedAt: nowISO() };
    updateRow('Bills', bill._row, patch);
    logActivity('bill', p.id, 'void',
      'Voided Bill ' + bill.billNo + (p.reason ? ' — ' + p.reason : ''), bill, patch);
    return getById('Bills', p.id);
  });
}

/* ==========================================================================
   Payments
   ========================================================================== */

function addPayment(p) {
  return withLock(function () {
    var amount = Number(p.amount);
    if (!isFinite(amount) || amount <= 0) fail('Enter a payment amount');
    assertMethod(p.method);

    // FR-26: never take more than is owed. The client clamps the display at
    // zero, so an unchecked excess would simply disappear from the ledger.
    var partyId = p.partyId;
    if (p.billId) {
      var target = getById('Bills', p.billId);
      if (!target) fail('Bill not found');
      if (target.status === 'voided') fail('A voided bill cannot take a payment');

      var due = billDue(p.billId);
      if (r2(amount) > r2(due) + 0.004) {
        fail('Payment exceeds the amount due (' + due.toFixed(2) + '). ' +
                        'Record the extra as an advance instead.');
      }
      // The bill decides whose money this is, whatever the request says.
      partyId = target.partyId;
    } else if (!getById('Parties', partyId)) {
      fail('Party not found');
    }

    var payId = uid('pay');
    var rec = {
      id: payId,
      billId: p.billId || '',
      partyId: partyId,
      method: p.method || 'Cash',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      reversed: false,
      reversedAt: '',
      reverseReason: '',
      isAdvance: false
    };
    appendRow('Payments', rec);

    if (p.method === 'Cheque' && p.cheque) {
      appendRow('Cheques', {
        id: uid('chq'),
        billId: p.billId || '',
        partyId: partyId,
        paymentId: payId,
        chequeNo: p.cheque.chequeNo || '',
        bankName: p.cheque.bankName || '',
        accountHolder: p.cheque.accountHolder || '',
        dateIssued: p.cheque.dateIssued || rec.date,
        dateDue: p.cheque.dateDue || rec.date,
        status: 'pending',
        amount: r2(p.amount),
        note: p.cheque.note || '',
        statusChangedAt: ''
      });
    }

    var bill = p.billId ? getById('Bills', p.billId) : null;
    logActivity('payment', payId, 'create',
      'Payment received' + (bill ? ' for Bill ' + bill.billNo : '') + ' — ' + rec.method);
    return rec;
  });
}

/** Remove a single row by id. Returns true if a row was actually removed. */
function deleteRowById(name, id) {
  var rowNum = findRow(name, id);
  if (rowNum < 0) return false;
  sheet(name).deleteRow(rowNum);
  return true;
}

/**
 * Permanently remove a payment.
 *
 * Distinct from reversePayment, which keeps the row and flags it: a reversal
 * is a correction that stays on the record, this erases the entry outright.
 * It is for a row that should never have existed — a test entry, or money
 * logged against the wrong party — where leaving a struck-through line on a
 * customer's statement would only confuse them.
 *
 * Any cheque attached to the payment goes with it. Leaving it would strand a
 * cheque pointing at a payment id that no longer resolves, and billState()
 * would still count that dangling cheque when deciding what a bill owes.
 *
 * An advance receipt is refused: the money has an entry in PartyAdvances that
 * this action cannot see, and deleting one side would leave the party holding
 * a balance with nothing behind it.
 */
function deletePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    // An advance receipt normally has to go via deleteAdvance, which removes
    // the balance row with it. The exception is a receipt whose advance row no
    // longer exists: there is nothing to keep in step, and refusing would leave
    // a stranded row nobody can clear.
    if (pay.isAdvance && !p.orphan) {
      fail('This is an advance receipt. Delete the advance itself from the ' +
           'Advances list, which removes this receipt with it and keeps the ' +
           'party’s advance balance correct.');
    }

    var killed = [];
    readAll('Cheques').forEach(function (c) {
      if (c.paymentId === p.id) {
        deleteRowById('Cheques', c.id);
        killed.push(c.chequeNo || c.id);
      }
    });

    deleteRowById('Payments', p.id);

    // A bill paid from the party's advance: the money goes back to that
    // advance, or it would vanish from both the bill and the balance. A
    // reversed one was already given back when it was reversed.
    if (pay.method === 'Advance' && !pay.isAdvance && !pay.reversed) {
      restoreAdvance(pay.partyId, pay.amount);
    }

    logActivity('payment', p.id, 'delete',
      'Deleted payment of ' + pay.amount + ' (' + pay.method + ')' +
      (killed.length ? ' and cheque ' + killed.join(', ') : '') +
      (p.reason ? ' — ' + p.reason : ''), pay, null);
    return { ok: true, deletedCheques: killed.length };
  });
}

/**
 * Edit a payment that was recorded wrongly — wrong amount, method, date or note.
 *
 * Only those four fields move. billId and partyId are deliberately fixed: a
 * payment that landed on the wrong bill is a different correction, and
 * re-pointing it here would silently change two bills' balances at once.
 */
function updatePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    if (pay.reversed) fail('A reversed payment cannot be edited');

    var cheques = readAll('Cheques').filter(function (c) { return c.paymentId === p.id; });
    var amountChanges = p.amount !== undefined && r2(p.amount) !== r2(pay.amount);
    var methodChanges = p.method !== undefined && String(p.method) !== String(pay.method);

    // Money the system moved by itself — out of an advance, or set off against
    // purchases — has a second record that has to agree with it. Changing one
    // side here would leave the other wrong.
    if (RESERVED_METHODS[pay.method] && (amountChanges || methodChanges)) {
      fail('This payment was made ' + (pay.method === 'Advance' ? 'from the party’s advance' : 'by set-off') +
           '. Only its date and note can be edited; delete it to undo it.');
    }
    if (methodChanges) {
      assertMethod(p.method);
      // A cheque row holds this payment back until the bank clears it. Renaming
      // the method would leave the cheque attached to "Cash" money.
      if (cheques.length) fail('A cheque payment keeps its method. Delete it and record the payment again instead.');
      if (p.method === 'Cheque') fail('Record a cheque as a new payment, so its number and bank are kept.');
    }

    var patch = {};
    if (p.amount !== undefined) {
      var amt = Number(p.amount);
      if (!isFinite(amt) || amt <= 0) fail('Enter a payment amount');

      // Same ceiling addPayment enforces, but measured against what the bill
      // would owe WITHOUT this payment — otherwise its own amount counts
      // against itself and any increase is rejected. A payment whose cheque
      // bounced is not counted in what is due, so it frees nothing up.
      if (pay.billId) {
        var bill = getById('Bills', pay.billId);
        if (bill) {
          var bouncedNow = cheques.some(function (c) { return c.status === 'bounced'; });
          var headroom = r2(billDue(pay.billId) + (bouncedNow ? 0 : (Number(pay.amount) || 0)));
          if (r2(amt) > headroom + 0.004) {
            fail('Payment exceeds the amount due (' + headroom.toFixed(2) + '). ' +
                 'Record the extra as an advance instead.');
          }
        }
      }
      patch.amount = r2(amt);
    }
    if (p.method !== undefined) patch.method = p.method;
    if (p.date !== undefined) patch.date = p.date;
    if (p.note !== undefined) patch.note = p.note || '';

    updateRow('Payments', pay._row, patch);

    // A cheque mirrors its payment's amount; letting them diverge would make
    // the bill and the cheque register disagree about the same money.
    if (patch.amount !== undefined) {
      readAll('Cheques').forEach(function (c) {
        if (c.paymentId === p.id) {
          updateRow('Cheques', findRow('Cheques', c.id), { amount: patch.amount });
        }
      });
    }

    logActivity('payment', p.id, 'edit', 'Edited payment', pay, patch);
    return getById('Payments', p.id);
  });
}

/**
 * Permanently remove a cheque.
 *
 * The payment it backs is left alone and becomes an ordinary one of its
 * method. That is the point: deleting a cheque record must not quietly erase
 * the money, only the bank instrument attached to it.
 */
function deleteCheque(p) {
  return withLock(function () {
    var chq = getById('Cheques', p.id);
    if (!chq) fail('Cheque not found');

    // A bounced cheque holds its payment out of the bill. Removing the cheque
    // makes the payment count again, which must not pay the bill twice if it
    // has since been settled another way.
    if (chq.status === 'bounced' && chq.paymentId) {
      var pay = getById('Payments', chq.paymentId);
      if (pay && !pay.reversed && pay.billId) {
        var room = billDue(pay.billId);
        if (r2(pay.amount) > room + 0.004) {
          fail('This bounced cheque’s bill has only ' + room.toFixed(2) + ' left to pay. Deleting the ' +
               'cheque would count its ' + r2(pay.amount).toFixed(2) + ' as paid again. Delete the payment instead.');
        }
      }
    }

    deleteRowById('Cheques', p.id);
    logActivity('cheque', p.id, 'delete',
      'Deleted cheque ' + (chq.chequeNo || '') + ' of ' + chq.amount +
      (p.reason ? ' — ' + p.reason : ''), chq, null);
    return { ok: true };
  });
}

/**
 * One payment spread across a party's unpaid bills, oldest first.
 *
 * This is how money actually arrives in the shop: a customer hands over a sum
 * against their whole account, not against an invoice number. Recording it
 * bill-by-bill means the shopkeeper does the allocation arithmetic by hand and
 * the ledger disagrees with the cash drawer whenever they get it wrong.
 *
 * Oldest first, because that is both normal trade practice and what keeps the
 * ageing buckets honest — paying a new bill while an old one sits open would
 * understate how overdue the account really is.
 *
 * Anything left once every bill is settled becomes an advance rather than
 * being refused, so the shopkeeper is never forced to reject cash that is
 * genuinely in their hand.
 */
function settleParty(p) {
  return withLock(function () {
    var total = Number(p.amount);
    if (!isFinite(total) || total <= 0) fail('Enter a payment amount');
    if (!p.partyId) fail('Select a party');
    if (!getById('Parties', p.partyId)) fail('Party not found');
    assertMethod(p.method);

    var date = p.date || todayISO();
    var method = p.method || 'Cash';

    /**
     * A cheque is not money until the bank clears it.
     *
     * Without a Cheques row, billDue() and billState() have nothing to hold
     * the payment back with, so an uncleared cheque counts as cash: the bill
     * reads paid, outstanding is understated and the cash position is
     * overstated. One row per payment, as addPayment and saveBill already do.
     */
    function chequeFor(payId, amount) {
      if (method !== 'Cheque') return;
      var c = p.cheque || {};
      appendRow('Cheques', {
        id: uid('chq'),
        billId: '',
        partyId: p.partyId,
        paymentId: payId,
        chequeNo: c.chequeNo || '',
        bankName: c.bankName || '',
        accountHolder: c.accountHolder || '',
        dateIssued: c.dateIssued || date,
        dateDue: c.dateDue || date,
        status: 'pending',
        amount: r2(amount),
        note: c.note || '',
        statusChangedAt: ''
      });
    }

    // Oldest first by bill date, with the bill number breaking ties so two
    // bills written the same day always allocate in a stable order.
    var mine = readAll('Bills')
      .filter(function (b) { return b.partyId === p.partyId && b.status !== 'voided'; })
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) ||
               String(a.billNo).localeCompare(String(b.billNo));
      });

    var remaining = r2(total);
    var applied = [];
    // Shared by every part of this one receipt, so the ledger shows one entry.
    var groupId = uid('grp');
    // Each bill's due is its own, so one read before writing serves them all.
    var book = dueBook();

    for (var i = 0; i < mine.length && remaining > 0.004; i++) {
      var due = book.due(mine[i]);
      if (due <= 0.004) continue;

      var use = r2(Math.min(due, remaining));
      var payId = uid('pay');
      appendRow('Payments', {
        id: payId,
        billId: mine[i].id,
        partyId: p.partyId,
        method: method,
        amount: use,
        date: date,
        note: p.note || 'Account payment',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false,
        groupId: groupId
      });

      chequeFor(payId, use);
      applied.push({ billId: mine[i].id, billNo: mine[i].billNo, amount: use });
      remaining = r2(remaining - use);
    }

    // Whatever the bills could not absorb is money the party has genuinely
    // overpaid, so it is held as an advance against their next bill.
    var asAdvance = 0;
    if (remaining > 0.004) {
      asAdvance = remaining;
      var advId = uid('adv');
      appendRow('PartyAdvances', {
        id: advId,
        partyId: p.partyId,
        amount: asAdvance,
        applied: 0,
        dateReceived: date,
        method: method,
        note: p.note || 'Overpayment held as advance'
      });
      var advPayId = uid('pay');
      appendRow('Payments', {
        id: advPayId,
        billId: '',
        partyId: p.partyId,
        method: method,
        amount: asAdvance,
        date: date,
        note: 'Advance received',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: true,
        groupId: groupId
      });
      chequeFor(advPayId, asAdvance);
    }

    logActivity('payment', p.partyId, 'create',
      'Account payment ' + r2(total) + ' — settled ' + applied.length +
      ' bill' + (applied.length === 1 ? '' : 's') +
      (asAdvance > 0 ? ', ' + asAdvance + ' held as advance' : ''));

    return { applied: applied, advance: asAdvance, total: r2(total) };
  });
}

/** Reversal is an offsetting flag, never a delete (FR-26). */
function reversePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    if (pay.reversed) fail('This payment is already reversed');

    var patch = { reversed: true, reversedAt: nowISO(), reverseReason: p.reason || '' };
    updateRow('Payments', pay._row, patch);

    // A bill paid from the party's advance reopens, and the money it used goes
    // back to that advance — otherwise it would leave both at once.
    if (pay.method === 'Advance' && !pay.isAdvance) restoreAdvance(pay.partyId, pay.amount);

    logActivity('payment', p.id, 'reverse',
      'Reversed payment of ' + pay.amount + ' (' + pay.method + ')' +
      (p.reason ? ' — ' + p.reason : ''), pay, patch);
    return getById('Payments', p.id);
  });
}

/**
 * Put money taken from a party's advances back, newest advance first — the
 * reverse of applyAdvance(), which uses them oldest first.
 */
function restoreAdvance(partyId, amount) {
  var left = r2(amount);
  var advances = readAll('PartyAdvances').filter(function (a) {
    return a.partyId === partyId && (Number(a.applied) || 0) > 0;
  });
  for (var i = advances.length - 1; i >= 0 && left > 0.004; i--) {
    var a = advances[i];
    var back = r2(Math.min(Number(a.applied) || 0, left));
    updateRow('PartyAdvances', findRow('PartyAdvances', a.id), { applied: r2((Number(a.applied) || 0) - back) });
    left = r2(left - back);
  }
}

/* ==========================================================================
   Returns
   ========================================================================== */

function addReturn(p) {
  return withLock(function () {
    var bill = getById('Bills', p.billId);
    if (!bill) fail('Bill not found');
    if (bill.status === 'voided') fail('A voided bill cannot take a return');

    /* The form already caps a return at what was sold. These repeat the rule
       where it actually protects the books: a record arriving from an offline
       device, or a row typed straight into the Sheet, reaches this point
       without ever passing the form.

       Unchecked, returning more than was sold drives the bill's net negative —
       a Rs 200 bill reading as the shop owing Rs 4,800 — and restocking more
       than was sold invents stock that never existed. */
    var qty = Number(p.qty) || 0;
    if (qty <= 0) fail('Return quantity must be greater than zero');

    var soldQty = 0;
    readAll('BillItems').forEach(function (bi) {
      if (bi.billId === p.billId && bi.itemId === p.itemId) {
        soldQty += Number(bi.qty) || 0;
      }
    });
    if (!soldQty) fail('That item is not on this bill');

    var returnedQty = 0;
    var returnedValue = 0;
    readAll('Returns').forEach(function (r) {
      if (r.billId !== p.billId) return;
      returnedValue += Number(r.valueAdjusted) || 0;
      if (r.itemId === p.itemId) returnedQty += Number(r.qty) || 0;
    });

    var qtyLeft = r2(soldQty - returnedQty);
    if (qty > qtyLeft + 0.0001) {
      fail('Only ' + qtyLeft + ' of that item is left to return (' + soldQty +
           ' sold, ' + returnedQty + ' already returned).');
    }

    // Value is capped separately: qty and value are independent fields, so a
    // valid quantity can still carry an absurd amount.
    var value = r2(p.valueAdjusted);
    if (value < 0) fail('Return value cannot be negative');
    var valueLeft = r2(r2(bill.totalAmount) - r2(returnedValue));
    if (value > valueLeft + 0.004) {
      fail('Return value cannot exceed what is left on the bill (' +
           valueLeft.toFixed(2) + ').');
    }

    var rec = {
      id: uid('ret'),
      billId: p.billId,
      itemId: p.itemId,
      qty: Number(p.qty) || 0,
      valueAdjusted: r2(p.valueAdjusted),
      restock: Boolean(p.restock),
      date: p.date || todayISO(),
      note: p.note || ''
    };
    appendRow('Returns', rec);
    logActivity('return', rec.id, 'create',
      'Return against Bill ' + bill.billNo + ' — value ' + rec.valueAdjusted);
    return rec;
  });
}

/* ==========================================================================
   Cheques
   ========================================================================== */

function saveCheque(p) {
  return withLock(function () {
    if (p.id) {
      var existing = getById('Cheques', p.id);
      if (!existing) fail('Cheque not found');
      // Only the details printed on the cheque. Its amount follows its payment,
      // its status moves through setChequeStatus, and its links and id must not
      // be rewritten by whatever a request happens to carry.
      var patch = {};
      ['chequeNo', 'bankName', 'accountHolder', 'dateIssued', 'dateDue', 'note'].forEach(function (k) {
        if (p[k] !== undefined) patch[k] = p[k] || '';
      });
      updateRow('Cheques', existing._row, patch);
      logActivity('cheque', p.id, 'edit', 'Edited cheque ' + (existing.chequeNo || ''), existing, patch);
      return getById('Cheques', p.id);
    }
    if (['pending', 'cleared', 'bounced'].indexOf(p.status || 'pending') < 0) fail('Unknown cheque status');
    var rec = {
      id: uid('chq'),
      billId: p.billId || '',
      partyId: p.partyId || '',
      paymentId: p.paymentId || '',
      chequeNo: p.chequeNo || '',
      bankName: p.bankName || '',
      accountHolder: p.accountHolder || '',
      dateIssued: p.dateIssued || todayISO(),
      dateDue: p.dateDue || todayISO(),
      status: p.status || 'pending',
      amount: r2(p.amount),
      note: p.note || '',
      statusChangedAt: ''
    };
    appendRow('Cheques', rec);
    logActivity('cheque', rec.id, 'create', 'Cheque ' + rec.chequeNo + ' recorded');
    return rec;
  });
}

/**
 * Change cheque status (FR-29 / FR-30).
 * Marking Bounced needs no extra write: the frontend excludes payments backed
 * by a bounced cheque, so the bill's due balance reopens automatically.
 */
function setChequeStatus(p) {
  return withLock(function () {
    var chq = getById('Cheques', p.id);
    if (!chq) fail('Cheque not found');
    if (['pending', 'cleared', 'bounced'].indexOf(p.status) < 0) fail('Unknown cheque status');

    // One physical cheque can sit in several rows: settleParty writes one per
    // bill it pays. The bank clears or bounces the whole cheque, so every row
    // of it moves together — otherwise the other bills stay outstanding.
    var patch = { status: p.status, statusChangedAt: nowISO() };
    var rows = chequeSiblings(readAll('Cheques'), chq);
    // A bounced cheque stopped counting, so its bill reopened and may since
    // have been paid another way. Reviving it would pay that bill twice.
    // Mirrors setChequeStatus in src/lib/localAdapter.js.
    if (p.status !== 'bounced') {
      rows.forEach(function (c) {
        if (c.status !== 'bounced' || !c.paymentId) return;
        var pay = getById('Payments', c.paymentId);
        if (!pay || pay.reversed || !pay.billId) return;
        var bill = getById('Bills', pay.billId);
        if (!bill) return;
        var room = billDue(pay.billId);
        if (r2(pay.amount) > room + 0.004) {
          fail('Bill ' + bill.billNo + ' has only ' + room.toFixed(2) + ' left to pay, so this ' +
               'bounced cheque of ' + r2(pay.amount).toFixed(2) + ' cannot be revived. ' +
               'Record the money as a new payment instead.');
        }
      });
    }
    rows.forEach(function (c) {
      var rowNum = c.id === chq.id ? chq._row : findRow('Cheques', c.id);
      if (rowNum > 0) updateRow('Cheques', rowNum, patch);
    });
    logActivity('cheque', p.id, 'edit',
      'Cheque ' + chq.chequeNo + ' marked ' + p.status +
      (rows.length > 1 ? ' (' + rows.length + ' bill entries)' : ''), chq, patch);
    return getById('Cheques', p.id);
  });
}

/**
 * Every row recording the same physical cheque: same party, number and bank.
 * A cheque with no number cannot be matched safely, so it stands alone.
 * Mirrors chequeSiblings() in src/lib/localAdapter.js.
 */
function chequeSiblings(cheques, chq) {
  function key(s) { return String(s || '').trim().toLowerCase(); }
  if (!key(chq.chequeNo)) return [chq];
  return cheques.filter(function (x) {
    return x.id === chq.id || (
      x.partyId === chq.partyId &&
      key(x.chequeNo) === key(chq.chequeNo) &&
      key(x.bankName) === key(chq.bankName));
  });
}

/* ==========================================================================
   Party advances
   ========================================================================== */

function addAdvance(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an advance amount');
    if (!getById('Parties', p.partyId)) fail('Party not found');
    assertMethod(p.method);

    var rec = {
      id: uid('adv'),
      partyId: p.partyId,
      amount: r2(p.amount),
      applied: 0,
      dateReceived: p.dateReceived || todayISO(),
      method: p.method || 'Cash',
      note: p.note || ''
    };
    appendRow('PartyAdvances', rec);

    var advPay = uid('pay');
    appendRow('Payments', {
      id: advPay,
      billId: '',
      partyId: p.partyId,
      method: rec.method,
      amount: rec.amount,
      date: rec.dateReceived,
      note: 'Advance received',
      reversed: false,
      reversedAt: '',
      reverseReason: '',
      isAdvance: true
    });

    // An advance handed over as a cheque is not money until it clears, the
    // same as any other cheque. Without this row nothing holds it back and the
    // party appears to hold a balance the bank has not yet paid.
    if (rec.method === 'Cheque') {
      var ac = p.cheque || {};
      appendRow('Cheques', {
        id: uid('chq'),
        billId: '',
        partyId: p.partyId,
        paymentId: advPay,
        chequeNo: ac.chequeNo || '',
        bankName: ac.bankName || '',
        accountHolder: ac.accountHolder || '',
        dateIssued: ac.dateIssued || rec.dateReceived,
        dateDue: ac.dateDue || rec.dateReceived,
        status: 'pending',
        amount: rec.amount,
        note: ac.note || '',
        statusChangedAt: ''
      });
    }

    logActivity('advance', rec.id, 'create', 'Advance received ' + rec.amount);
    return rec;
  });
}

/**
 * Remove an advance outright, along with everything it paid for.
 *
 * Three records can exist behind one advance, and leaving any of them would
 * leave the books disagreeing with themselves:
 *
 *   1. the PartyAdvances row — the balance the party is holding with the shop
 *   2. the Payments receipt (isAdvance) — the money arriving at the till
 *   3. any 'Advance' payments already applied to bills out of that balance
 *
 * The third is why this cannot simply drop one row. If part of the advance has
 * been spent on a bill, deleting only the advance would leave that bill still
 * showing as paid by money that no longer exists. Those payments go too, so
 * the bills they settled reopen for their proper amount — which is the honest
 * outcome, even though it changes balances elsewhere.
 *
 * A cheque advance takes its cheque with it, for the same reason deletePayment
 * does: a cheque pointing at a deleted payment is still counted by billDue().
 */
function deleteAdvance(p) {
  return withLock(function () {
    var adv = getById('PartyAdvances', p.id);
    if (!adv) fail('Advance not found');

    var partyId = adv.partyId;
    var amount = r2(adv.amount);
    var applied = r2(adv.applied);

    var payments = readAll('Payments');
    var cheques = readAll('Cheques');

    // The receipt: the advance arriving. Nothing links the two rows, so they
    // are matched on party and amount, with the day only breaking a tie
    // between several advances of the same size. Comparing the raw date would
    // be wrong — a date survives a round trip through Sheets as a string or a
    // Date object, and the two rows can come back in different shapes.
    var candidates = [];
    for (var i = 0; i < payments.length; i++) {
      var pay = payments[i];
      if (pay.isAdvance && pay.partyId === partyId && r2(pay.amount) === amount) {
        candidates.push(pay);
      }
    }

    var receiptId = null;
    if (candidates.length === 1) {
      receiptId = candidates[0].id;
    } else if (candidates.length > 1) {
      var wantDay = dayOf(adv.dateReceived);
      for (var c = 0; c < candidates.length; c++) {
        if (dayOf(candidates[c].date) === wantDay) { receiptId = candidates[c].id; break; }
      }
      if (!receiptId) receiptId = candidates[0].id;
    }

    // Payments made OUT of this balance. Method 'Advance' is what saveBill
    // writes when a bill consumes advance, so these are the bills to reopen.
    var reopened = [];
    var spent = 0;
    if (applied > 0.004) {
      var budget = applied;
      for (var j = 0; j < payments.length && budget > 0.004; j++) {
        var ap = payments[j];
        if (ap.partyId !== partyId || ap.method !== 'Advance' || ap.reversed) continue;

        var bill = ap.billId ? getById('Bills', ap.billId) : null;
        reopened.push({
          billId: ap.billId,
          billNo: bill ? bill.billNo : '',
          amount: r2(ap.amount)
        });
        spent = r2(spent + r2(ap.amount));
        budget = r2(budget - r2(ap.amount));

        cheques.forEach(function (c) {
          if (c.paymentId === ap.id) deleteRowById('Cheques', c.id);
        });
        deleteRowById('Payments', ap.id);
      }
    }

    if (receiptId) {
      cheques.forEach(function (c) {
        if (c.paymentId === receiptId) deleteRowById('Cheques', c.id);
      });
      deleteRowById('Payments', receiptId);
    }

    deleteRowById('PartyAdvances', p.id);

    var party = getById('Parties', partyId);
    logActivity('advance', p.id, 'delete',
      'Deleted advance of ' + amount + ' for ' +
      (party ? party.name : 'party') +
      (reopened.length
        ? ' — reopened ' + reopened.length + ' bill' + (reopened.length === 1 ? '' : 's')
        : '') +
      (p.reason ? ' — ' + p.reason : ''), adv, null);

    return { ok: true, amount: amount, reopened: reopened, reopenedValue: spent };
  });
}

/* ==========================================================================
   Purchases
   ========================================================================== */

function savePurchase(p) {
  return withLock(function () {
    if (!getById('Items', p.itemId)) fail('Select an item');
    if (!(Number(p.qty) > 0)) fail('Quantity must be greater than zero');
    if (!(Number(p.costPrice) >= 0)) fail('Cost price must be zero or more');
    assertMethod(p.method);
    var rec = {
      id: uid('pur'),
      itemId: p.itemId,
      supplierName: p.supplierName || '',
      qty: Number(p.qty) || 0,
      costPrice: r2(p.costPrice),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash'
    };
    appendRow('Purchases', rec);

    // Purchase updates the item's current cost price and last purchase date (FR-37)
    var item = getById('Items', p.itemId);
    if (item) {
      updateRow('Items', item._row, {
        costPrice: rec.costPrice,
        lastPurchaseDate: rec.date
      });
    }

    logActivity('purchase', rec.id, 'create',
      'Purchased ' + rec.qty + ' x ' + (item ? item.name : 'item') + ' @ ' + rec.costPrice);
    return rec;
  });
}

/**
 * The item's most recent purchase that actually brought goods in — the one its
 * current cost price came from. Mirrors latestPurchase() in localAdapter.js.
 */
function latestPurchase(purchases, voided, itemId) {
  var best = null;
  purchases.forEach(function (x) {
    if (x.itemId !== itemId || voided[x.purchaseBillId]) return;
    if (!best || dayOf(x.date) >= dayOf(best.date)) best = x;
  });
  return best;
}

function voidedPurchaseBills() {
  var out = {};
  readAll('PurchaseBills').forEach(function (b) { if (b.status === 'voided') out[b.id] = 1; });
  return out;
}

/**
 * Put an item's cost price back in step with its latest purchase, after that
 * purchase was edited or deleted. With no purchase left the cost is kept.
 */
function refreshItemCost(itemId) {
  var item = getById('Items', itemId);
  if (!item) return;
  var last = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), itemId);
  if (last) {
    updateRow('Items', item._row, { costPrice: r2(last.costPrice), lastPurchaseDate: dayOf(last.date) });
  } else {
    updateRow('Items', item._row, { lastPurchaseDate: '' });
  }
}

/** A purchase bill's total, worked out again from the lines it still has. */
function recomputePurchaseBill(billId) {
  var bill = getById('PurchaseBills', billId);
  if (!bill) return;
  var total = r2(readAll('Purchases')
    .filter(function (x) { return x.purchaseBillId === billId; })
    .reduce(function (s, x) { return s + (Number(x.qty) || 0) * (Number(x.costPrice) || 0); }, 0));
  updateRow('PurchaseBills', bill._row, { totalAmount: total });
}

/**
 * Refuse an edit or delete that would leave goods returned to the supplier
 * which, on paper, were never bought on that bill. `newQty` is what the line
 * holds afterwards under `newItemId` (0 for a delete).
 */
function assertReturnsCovered(billId, line, newItemId, newQty) {
  var returned = 0;
  readAll('SupplierReturns').forEach(function (r) {
    if (r.purchaseBillId === billId && r.itemId === line.itemId) returned += Number(r.qty) || 0;
  });
  if (!returned) return;
  var others = 0;
  readAll('Purchases').forEach(function (x) {
    if (x.purchaseBillId === billId && x.itemId === line.itemId && x.id !== line.id) {
      others += Number(x.qty) || 0;
    }
  });
  var kept = others + (newItemId === line.itemId ? newQty : 0);
  if (kept < returned - 0.0001) {
    fail(returned + ' of this item was already returned to the supplier from this purchase. ' +
         'Delete that return first.');
  }
}

/**
 * Fix a purchase entered wrongly. Mirrors updatePurchase in localAdapter.js.
 * A line of a supplier purchase bill keeps its bill's supplier, date and
 * payment; only what was bought changes, and the bill total is recomputed.
 */
function updatePurchase(p) {
  return withLock(function () {
    var rec = getById('Purchases', p.id);
    if (!rec) fail('Purchase not found');
    var bill = rec.purchaseBillId ? getById('PurchaseBills', rec.purchaseBillId) : null;
    if (bill && bill.status === 'voided') fail('This purchase was cancelled and cannot be edited');

    var itemId = p.itemId || rec.itemId;
    var item = getById('Items', itemId);
    if (!item) fail('Select an item');
    var qty = Number(p.qty);
    if (!(qty > 0)) fail('Quantity must be greater than zero');
    var cost = Number(p.costPrice);
    if (!(cost >= 0)) fail('Cost price must be zero or more');
    if (bill) assertReturnsCovered(bill.id, rec, itemId, qty);

    var latest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), rec.itemId);
    var wasLatest = Boolean(latest && latest.id === rec.id);

    // A line that had fully arrived stays fully arrived at its new quantity;
    // a part-received one keeps what came, up to the new quantity.
    var givenReceived = givenQty(p.receivedQty);
    var hadAll = lineReceivedQty(rec) >= (Number(rec.qty) || 0) - 0.0001;
    var received = givenReceived !== null ? givenReceived
      : hadAll ? qty : Math.min(qty, lineReceivedQty(rec));
    if (received < 0 || received > qty + 0.0001) {
      fail('Received quantity must be between 0 and ' + qty);
    }

    var patch = { itemId: itemId, qty: qty, costPrice: r2(cost), receivedQty: r2(received) };
    if (p.note !== undefined) patch.note = p.note || '';
    if (!bill) {
      if (p.supplierName !== undefined) patch.supplierName = p.supplierName || '';
      if (p.date) patch.date = p.date;
      if (p.method) patch.method = p.method;
    }
    updateRow('Purchases', rec._row, patch);
    if (bill) recomputePurchaseBill(bill.id);

    if (wasLatest) refreshItemCost(rec.itemId);
    var nowLatest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), itemId);
    if (nowLatest && nowLatest.id === rec.id) refreshItemCost(itemId);

    logActivity('purchase', rec.id, 'edit',
      'Edited purchase: ' + qty + ' x ' + item.name + ' @ ' + r2(cost) +
      (bill ? ' (' + bill.purchaseNo + ')' : ''), rec, patch);
    return getById('Purchases', p.id);
  });
}

/**
 * Remove a purchase outright. The last line of a purchase bill takes the bill
 * with it; any payment made against that bill stays, on account.
 */
function deletePurchase(p) {
  return withLock(function () {
    var rec = getById('Purchases', p.id);
    if (!rec) fail('Purchase not found');
    var bill = rec.purchaseBillId ? getById('PurchaseBills', rec.purchaseBillId) : null;
    if (bill) assertReturnsCovered(bill.id, rec, rec.itemId, 0);

    var latest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), rec.itemId);
    var wasLatest = Boolean(latest && latest.id === rec.id);

    deleteRowById('Purchases', p.id);

    var billRemoved = false;
    if (bill) {
      var rest = readAll('Purchases').filter(function (x) { return x.purchaseBillId === bill.id; });
      if (rest.length) {
        recomputePurchaseBill(bill.id);
      } else {
        readAll('SupplierPayments').forEach(function (sp) {
          if (sp.purchaseBillId === bill.id) {
            updateRow('SupplierPayments', findRow('SupplierPayments', sp.id), { purchaseBillId: '' });
          }
        });
        deleteRowById('PurchaseBills', bill.id);
        billRemoved = true;
      }
    }
    if (wasLatest) refreshItemCost(rec.itemId);

    var item = getById('Items', rec.itemId);
    logActivity('purchase', rec.id, 'delete',
      'Deleted purchase: ' + rec.qty + ' x ' + (item ? item.name : 'item') + ' @ ' + rec.costPrice +
      (bill ? (billRemoved ? ' — purchase ' + bill.purchaseNo + ' removed' : ' from ' + bill.purchaseNo) : '') +
      (p.reason ? ' — ' + p.reason : ''), rec, null);
    return { ok: true, billRemoved: billRemoved };
  });
}

/* ==========================================================================
   Suppliers — the buying side (mirrors src/lib/localAdapter.js)
   ========================================================================== */

/** Next PUR-YYYY-NNNN number, from the highest already used that year. */
function nextPurchaseNo(date) {
  var year = String(date || todayISO()).slice(0, 4);
  var max = 0;
  readAll('PurchaseBills').forEach(function (b) {
    var m = /^PUR-(\d{4})-(\d+)$/.exec(String(b.purchaseNo || ''));
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  });
  var n = String(max + 1);
  while (n.length < 4) n = '0' + n;
  return 'PUR-' + year + '-' + n;
}

function saveSupplier(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Supplier name is required');
    var want = nameKey(p.name);
    var all = readAll('Suppliers');
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) !== String(p.id) && nameKey(all[i].name) === want) {
        fail('A supplier called "' + all[i].name + '" already exists. ' +
             'Use a different name, or open the existing one.');
      }
    }
    var fields = {
      name: String(p.name).trim(),
      phone: p.phone || '',
      address: p.address || '',
      openingBalance: r2(p.openingBalance)
    };
    if (p.id) {
      var existing = getById('Suppliers', p.id);
      if (!existing) fail('Supplier not found');
      updateRow('Suppliers', existing._row, fields);
      logActivity('supplier', p.id, 'edit', 'Edited supplier "' + fields.name + '"', existing, fields);
      return getById('Suppliers', p.id);
    }
    var rec = {
      id: uid('sup'), name: fields.name, phone: fields.phone, address: fields.address,
      openingBalance: fields.openingBalance, status: 'active', createdAt: nowISO()
    };
    appendRow('Suppliers', rec);
    logActivity('supplier', rec.id, 'create', 'Added supplier "' + rec.name + '"');
    return rec;
  });
}

/**
 * A party who also sells to the shop. Their buying side is an ordinary
 * supplier row carrying the party's id, created on first use. A supplier
 * already kept under the same name is linked rather than duplicated. Mirrors
 * linkPartySupplier in src/lib/localAdapter.js.
 */
function linkPartySupplier(p) {
  return withLock(function () {
    var party = getById('Parties', p.partyId);
    if (!party) fail('Party not found');

    var all = readAll('Suppliers');

    // A named supplier, linked by hand from its own page: the names need not
    // match. One party, one supplier side, so neither may already be taken.
    if (p.supplierId) {
      var sup = getById('Suppliers', p.supplierId);
      if (!sup) fail('Supplier not found');
      for (var k = 0; k < all.length; k++) {
        if (String(all[k].partyId) === String(party.id) && all[k].id !== sup.id) {
          fail('"' + party.name + '" is already linked to supplier "' + all[k].name + '".');
        }
      }
      if (sup.partyId && String(sup.partyId) !== String(party.id)) {
        fail('Supplier "' + sup.name + '" is already linked to another party.');
      }
      if (String(sup.partyId) !== String(party.id)) {
        updateRow('Suppliers', sup._row, { partyId: party.id });
        logActivity('supplier', sup.id, 'edit',
          'Linked supplier "' + sup.name + '" to party "' + party.name + '"');
      }
      var done = getById('Suppliers', sup.id);
      delete done._row;
      return done;
    }

    for (var i = 0; i < all.length; i++) {
      if (String(all[i].partyId) === String(party.id)) {
        var linked = getById('Suppliers', all[i].id);
        if (linked.status === 'archived') {
          updateRow('Suppliers', linked._row, { status: 'active' });
          linked.status = 'active';
        }
        delete linked._row;
        return linked;
      }
    }

    var want = nameKey(party.name);
    for (var j = 0; j < all.length; j++) {
      if (nameKey(all[j].name) !== want) continue;
      if (all[j].partyId) fail('Supplier "' + all[j].name + '" is already linked to another party.');
      var same = getById('Suppliers', all[j].id);
      updateRow('Suppliers', same._row, { partyId: party.id, status: 'active' });
      logActivity('supplier', same.id, 'edit',
        'Linked supplier "' + same.name + '" to party "' + party.name + '"');
      var out = getById('Suppliers', same.id);
      delete out._row;
      return out;
    }

    var rec = {
      id: uid('sup'), name: party.name, phone: party.phone || '', address: party.address || '',
      openingBalance: 0, status: 'active', createdAt: nowISO(), partyId: party.id
    };
    appendRow('Suppliers', rec);
    logActivity('supplier', rec.id, 'create', 'Party "' + party.name + '" set up as a supplier');
    return rec;
  });
}

/** What the shop owes one supplier, as supplierBalance() in calc.js works it out. */
function supplierOwed(supplierId) {
  var sup = getById('Suppliers', supplierId);
  var total = Number(sup && sup.openingBalance) || 0;
  readAll('PurchaseBills').forEach(function (b) {
    if (b.supplierId === supplierId && b.status !== 'voided') total += Number(b.totalAmount) || 0;
  });
  readAll('SupplierPayments').forEach(function (x) {
    if (x.supplierId === supplierId) total -= Number(x.amount) || 0;
  });
  readAll('SupplierReturns').forEach(function (x) {
    if (x.supplierId === supplierId) total -= Number(x.value) || 0;
  });
  return r2(total);
}

/**
 * Settle what a party owes on sales against what the shop owes them on
 * purchases. No cash moves: the sale bills are paid oldest first with a
 * 'Set-off' payment, and the same amount is paid to their supplier side, so
 * both halves of the khata go down together and the net is unchanged.
 */
function setOffParty(p) {
  return withLock(function () {
    var party = getById('Parties', p.partyId);
    if (!party) fail('Party not found');
    var sup = null;
    readAll('Suppliers').forEach(function (s) {
      if (!sup && String(s.partyId) === String(party.id)) sup = s;
    });
    if (!sup) fail('Nothing has been bought from this party yet');

    var amount = r2(p.amount);
    if (!(amount > 0)) fail('Enter an amount to set off');

    var mine = readAll('Bills')
      .filter(function (b) { return b.partyId === party.id && b.status !== 'voided'; })
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) ||
               String(a.billNo).localeCompare(String(b.billNo));
      });
    var book = dueBook();
    var dues = mine.map(function (b) { return [b, book.due(b)]; });
    var receivable = r2(dues.reduce(function (s, x) { return s + x[1]; }, 0));
    var payable = supplierOwed(sup.id);

    if (amount > receivable + 0.004) {
      fail('Set-off cannot be more than ' + party.name + ' owes on sales (' + receivable.toFixed(2) + ').');
    }
    if (amount > payable + 0.004) {
      fail('Set-off cannot be more than you owe ' + party.name + ' on purchases (' +
           Math.max(0, payable).toFixed(2) + ').');
    }

    var date = p.date || todayISO();
    var note = p.note || 'Set off against purchases';
    var remaining = amount;
    var applied = [];
    for (var i = 0; i < dues.length && remaining > 0.004; i++) {
      if (dues[i][1] <= 0.004) continue;
      var use = r2(Math.min(dues[i][1], remaining));
      appendRow('Payments', {
        id: uid('pay'), billId: dues[i][0].id, partyId: party.id,
        method: 'Set-off', amount: use, date: date, note: note,
        reversed: false, reversedAt: '', reverseReason: '', isAdvance: false
      });
      applied.push({ billId: dues[i][0].id, billNo: dues[i][0].billNo, amount: use });
      remaining = r2(remaining - use);
    }

    appendRow('SupplierPayments', {
      id: uid('spy'), supplierId: sup.id, purchaseBillId: '',
      method: 'Set-off', amount: amount, date: date, note: note, isAdvance: false
    });

    logActivity('payment', party.id, 'create',
      'Set off ' + amount + ' between sales and purchases of "' + party.name + '"');
    return { applied: applied, amount: amount };
  });
}

function savePurchaseBill(p) {
  return withLock(function () {
    var supplier = getById('Suppliers', p.supplierId);
    if (!supplier) fail('Select a supplier');
    var lines = p.lines || [];
    if (!lines.length) fail('Add at least one item');

    var itemById = {};
    readAll('Items').forEach(function (it) { itemById[it.id] = it; });
    lines.forEach(function (l, i) {
      if (!itemById[l.itemId]) fail('Line ' + (i + 1) + ': item not found');
      if (!(Number(l.qty) > 0)) fail('Line ' + (i + 1) + ': quantity must be greater than zero');
      if (!(Number(l.costPrice) >= 0)) fail('Line ' + (i + 1) + ': price must be zero or more');
    });

    var total = r2(lines.reduce(function (s, l) {
      return s + Number(l.qty) * Number(l.costPrice);
    }, 0));
    var paidNow = r2(p.paidNow);
    if (paidNow < 0) fail('Amount paid cannot be negative');
    if (paidNow > total + 0.004) {
      fail('Amount paid (' + paidNow + ') is more than the bill total (' + total + '). ' +
           'Record the extra as a separate payment to the supplier.');
    }

    var date = p.date || todayISO();
    var bill = {
      id: uid('pbl'), purchaseNo: nextPurchaseNo(date), supplierId: supplier.id,
      invoiceNo: String(p.invoiceNo || '').trim(), date: date, totalAmount: total,
      note: p.note || '', status: 'active', createdAt: nowISO(), voidReason: '', voidedAt: ''
    };
    appendRow('PurchaseBills', bill);

    // Validated before anything is written, so a bad line leaves no half bill.
    var receivedOf = lines.map(function (l) {
      var qty = Number(l.qty);
      var given = givenQty(l.receivedQty);
      var received = given !== null ? given : (p.received === false ? 0 : qty);
      if (received < 0 || received > qty + 0.0001) {
        fail('Received quantity must be between 0 and ' + qty);
      }
      return r2(received);
    });

    lines.forEach(function (l, i) {
      var cost = r2(l.costPrice);
      appendRow('Purchases', {
        id: uid('pur'), itemId: l.itemId, supplierName: supplier.name,
        qty: Number(l.qty), costPrice: cost, date: date, note: '',
        method: '', supplierId: supplier.id, purchaseBillId: bill.id,
        receivedQty: receivedOf[i]
      });
      var item = getById('Items', l.itemId);
      if (item) updateRow('Items', item._row, { costPrice: cost, lastPurchaseDate: date });
    });

    if (paidNow > 0) {
      appendRow('SupplierPayments', {
        id: uid('spy'), supplierId: supplier.id, purchaseBillId: bill.id,
        method: p.method || 'Cash', amount: paidNow, date: date, note: 'Paid at purchase'
      });
    }

    logActivity('purchaseBill', bill.id, 'create',
      'Purchase ' + bill.purchaseNo + ' from ' + supplier.name + ' — ' + total +
      (paidNow > 0 ? ', paid ' + paidNow + ' (' + (p.method || 'Cash') + ')' : ''));
    return bill;
  });
}

function voidPurchaseBill(p) {
  return withLock(function () {
    var bill = getById('PurchaseBills', p.id);
    if (!bill) fail('Purchase bill not found');
    if (bill.status === 'voided') fail('This purchase is already cancelled');
    var hasReturns = readAll('SupplierReturns').some(function (r) { return r.purchaseBillId === p.id; });
    if (hasReturns) {
      fail('Goods from this purchase were returned to the supplier. ' +
           'Delete those returns first, then cancel the purchase.');
    }
    var patch = { status: 'voided', voidReason: p.reason || '', voidedAt: nowISO() };
    updateRow('PurchaseBills', bill._row, patch);
    logActivity('purchaseBill', p.id, 'void',
      'Cancelled purchase ' + bill.purchaseNo + (p.reason ? ' — ' + p.reason : ''), bill, patch);
    return getById('PurchaseBills', p.id);
  });
}

function addSupplierPayment(p) {
  return withLock(function () {
    var supplier = getById('Suppliers', p.supplierId);
    if (!supplier) fail('Select a supplier');
    var amount = r2(p.amount);
    if (!(amount > 0)) fail('Enter a payment amount');
    if (!p.isAdvance && p.purchaseBillId) {
      var bill = getById('PurchaseBills', p.purchaseBillId);
      if (!bill || bill.supplierId !== p.supplierId) fail('Purchase bill not found for this supplier');
    }
    // An advance is money handed over before goods arrive, so it never
    // belongs to one purchase bill.
    var isAdvance = Boolean(p.isAdvance);
    var rec = {
      id: uid('spy'), supplierId: p.supplierId,
      purchaseBillId: isAdvance ? '' : (p.purchaseBillId || ''),
      method: p.method || 'Cash', amount: amount, date: p.date || todayISO(), note: p.note || '',
      isAdvance: isAdvance
    };
    appendRow('SupplierPayments', rec);
    logActivity('supplierPayment', rec.id, 'create',
      (isAdvance ? 'Advance ' : 'Paid ') + amount + ' to ' + supplier.name + ' — ' + rec.method);
    return rec;
  });
}

function deleteSupplierPayment(p) {
  return withLock(function () {
    var pay = getById('SupplierPayments', p.id);
    if (!pay) fail('Payment not found');
    deleteRowById('SupplierPayments', p.id);
    logActivity('supplierPayment', p.id, 'delete',
      'Deleted payment of ' + pay.amount + ' (' + pay.method + ') to supplier' +
      (p.reason ? ' — ' + p.reason : ''), pay, null);
    return { ok: true };
  });
}

function addSupplierReturn(p) {
  return withLock(function () {
    if (!getById('Suppliers', p.supplierId)) fail('Select a supplier');
    var item = getById('Items', p.itemId);
    if (!item) fail('Select an item');
    var qty = Number(p.qty);
    if (!(qty > 0)) fail('Return quantity must be greater than zero');
    var value = r2(p.value);
    if (value < 0) fail('Return value cannot be negative');

    if (p.purchaseBillId) {
      var bill = getById('PurchaseBills', p.purchaseBillId);
      if (!bill || bill.supplierId !== p.supplierId) fail('Purchase bill not found for this supplier');
      if (bill.status === 'voided') fail('That purchase was cancelled');
      var bought = 0;
      readAll('Purchases').forEach(function (x) {
        if (x.purchaseBillId === bill.id && x.itemId === p.itemId) bought += Number(x.qty) || 0;
      });
      if (!bought) fail('That item is not on this purchase bill');
      var already = 0;
      readAll('SupplierReturns').forEach(function (x) {
        if (x.purchaseBillId === bill.id && x.itemId === p.itemId) already += Number(x.qty) || 0;
      });
      if (qty > r2(bought - already) + 0.0001) {
        fail('Only ' + r2(bought - already) + ' of that item is left to return (' +
             bought + ' bought, ' + already + ' already returned).');
      }
    }

    var rec = {
      id: uid('srt'), supplierId: p.supplierId, purchaseBillId: p.purchaseBillId || '',
      itemId: p.itemId, qty: qty, value: value, date: p.date || todayISO(), note: p.note || ''
    };
    appendRow('SupplierReturns', rec);
    logActivity('supplierReturn', rec.id, 'create',
      'Returned ' + qty + ' x ' + item.name + ' to supplier — value ' + value);
    return rec;
  });
}

function deleteSupplierReturn(p) {
  return withLock(function () {
    var ret = getById('SupplierReturns', p.id);
    if (!ret) fail('Return not found');
    deleteRowById('SupplierReturns', p.id);
    logActivity('supplierReturn', p.id, 'delete',
      'Deleted return to supplier (value ' + ret.value + ')', ret, null);
    return { ok: true };
  });
}

/* ==========================================================================
   Warehouses — mirrors the warehouse actions in src/lib/localAdapter.js
   ========================================================================== */

/** How each movement type changes the warehouse it names. Mirror of MOVE_TYPES in calc.js. */
var MOVE_TYPES = {
  'in':         { label: 'Stock In',       prefix: 'GRN', sign: 1 },
  'out':        { label: 'Stock Out',      prefix: 'GDN', sign: -1 },
  'transfer':   { label: 'Transfer',       prefix: 'TRF', sign: -1 },
  'to-shop':    { label: 'Sent to Shop',   prefix: 'TSH', sign: -1 },
  'from-shop':  { label: 'From Shop',      prefix: 'FSH', sign: 1 },
  'adjust-in':  { label: 'Adjustment (+)', prefix: 'ADJ', sign: 1 },
  'adjust-out': { label: 'Adjustment (-)', prefix: 'ADJ', sign: -1 }
};

/** Stock of every item in one warehouse: { itemId: qty }. */
function warehouseStock(warehouseId) {
  var moves = {};
  readAll('WarehouseMoves').forEach(function (m) {
    if (m.status !== 'voided') moves[m.id] = m;
  });
  var out = {};
  readAll('WarehouseMoveLines').forEach(function (l) {
    var m = moves[l.moveId];
    if (!m) return;
    var sign = 0;
    if (m.type === 'transfer') {
      if (m.toWarehouseId === warehouseId) sign = 1;
      else if (m.warehouseId === warehouseId) sign = -1;
    } else if (m.warehouseId === warehouseId) {
      sign = (MOVE_TYPES[m.type] || {}).sign || 0;
    }
    if (!sign) return;
    out[l.itemId] = r2((out[l.itemId] || 0) + sign * (Number(l.qty) || 0));
  });
  return out;
}

/** Shop stock of one item. Mirror of itemStock in src/lib/calc.js. */
function shopStockOf(itemId) {
  function live(rows, statusById, idKey) {
    return rows.filter(function (r) { return !statusById[r[idKey]]; });
  }
  function sum(rows, f) { return rows.reduce(function (s, x) { return s + (f ? f(x) : (Number(x.qty) || 0)); }, 0); }
  function voidedIds(sheetName) {
    var v = {};
    readAll(sheetName).forEach(function (b) { if (b.status === 'voided') v[b.id] = true; });
    return v;
  }
  function forItem(rows) { return rows.filter(function (r) { return r.itemId === itemId; }); }
  var item = getById('Items', itemId);
  var opening = item ? Number(item.openingStock) || 0 : 0;
  var bought = sum(live(forItem(readAll('Purchases')), voidedIds('PurchaseBills'), 'purchaseBillId'), lineReceivedQty);
  var sold = sum(live(forItem(readAll('BillItems')), voidedIds('Bills'), 'billId'));
  var restocked = sum(forItem(readAll('Returns')).filter(function (r) { return r.restock === true || r.restock === 'TRUE' || r.restock === 'true' || r.restock === 1; }));
  var lost = sum(forItem(readAll('StockLoss')));
  var sentBack = sum(forItem(readAll('SupplierReturns')));
  var moves = {};
  readAll('WarehouseMoves').forEach(function (m) { if (m.status !== 'voided') moves[m.id] = m; });
  var flow = 0;
  forItem(readAll('WarehouseMoveLines')).forEach(function (l) {
    var m = moves[l.moveId];
    if (!m) return;
    if (m.type === 'to-shop') flow += Number(l.qty) || 0;
    if (m.type === 'from-shop') flow -= Number(l.qty) || 0;
  });
  return r2(opening + bought - sold + restocked - lost - sentBack + flow);
}

/** Refuse a movement that would take the shop's stock of an item below zero. */
function assertShopHas(lines, cancelling) {
  var want = {};
  lines.forEach(function (l) { want[l.itemId] = r2((want[l.itemId] || 0) + Number(l.qty)); });
  for (var itemId in want) {
    var have = shopStockOf(itemId);
    if (want[itemId] > have + 0.0001) {
      var item = getById('Items', itemId);
      var name = item ? item.name : 'Item';
      fail(cancelling
        ? name + ': only ' + have + ' left in the shop, so this movement cannot be cancelled — the goods have already been used.'
        : name + ': only ' + have + ' ' + (item ? item.baseUnit : '') + ' in the shop, cannot send ' + want[itemId] + '.');
    }
  }
}

/** Refuse a movement that would take a warehouse below zero on any item. */
function assertWarehouseHas(wh, lines, cancelling) {
  var stock = warehouseStock(wh.id);
  var want = {};
  lines.forEach(function (l) { want[l.itemId] = r2((want[l.itemId] || 0) + Number(l.qty)); });
  for (var itemId in want) {
    var have = stock[itemId] || 0;
    if (want[itemId] > have + 0.0001) {
      var item = getById('Items', itemId);
      var name = item ? item.name : 'Item';
      fail(cancelling
        ? name + ': only ' + have + ' left in ' + wh.name + ', so this movement cannot be cancelled — the goods have already moved on.'
        : name + ': only ' + have + ' ' + (item ? item.baseUnit : '') + ' in ' + wh.name + ', cannot send ' + want[itemId] + '.');
    }
  }
}

/** Next GRN-2026-0001 style number, from the highest already used that year. */
function nextDocNo(prefix, date) {
  var year = String(date || todayISO()).slice(0, 4);
  var re = new RegExp('^' + prefix + '-(\\d{4})-(\\d+)$');
  var max = 0;
  readAll('WarehouseMoves').forEach(function (m) {
    var x = re.exec(String(m.docNo || ''));
    if (x && x[1] === year) max = Math.max(max, Number(x[2]));
  });
  var n = String(max + 1);
  while (n.length < 4) n = '0' + n;
  return prefix + '-' + year + '-' + n;
}

function saveWarehouse(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Warehouse name is required');
    var want = nameKey(p.name);
    var all = readAll('Warehouses');
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) !== String(p.id) && nameKey(all[i].name) === want) {
        fail('A warehouse called "' + all[i].name + '" already exists.');
      }
    }
    var fields = {
      name: String(p.name).trim(), code: String(p.code || '').trim().toUpperCase(),
      location: p.location || '', manager: p.manager || '', phone: p.phone || '',
      capacity: p.capacity || '', note: p.note || ''
    };
    if (p.id) {
      var existing = getById('Warehouses', p.id);
      if (!existing) fail('Warehouse not found');
      updateRow('Warehouses', existing._row, fields);
      logActivity('warehouse', p.id, 'edit', 'Edited warehouse "' + fields.name + '"', existing, fields);
      return getById('Warehouses', p.id);
    }
    var rec = {
      id: uid('whs'), name: fields.name, code: fields.code, location: fields.location,
      manager: fields.manager, phone: fields.phone, capacity: fields.capacity, note: fields.note,
      status: 'active', createdAt: nowISO()
    };
    appendRow('Warehouses', rec);
    logActivity('warehouse', rec.id, 'create', 'Added warehouse "' + rec.name + '"');
    return rec;
  });
}

function saveWhMove(p) {
  return withLock(function () {
    var meta = MOVE_TYPES[p.type];
    if (!meta) fail('Choose what kind of movement this is');
    var wh = getById('Warehouses', p.warehouseId);
    if (!wh) fail('Select a warehouse');
    if (wh.status === 'archived') fail('Warehouse "' + wh.name + '" is archived. Restore it first.');
    var dest = null;
    if (p.type === 'transfer') {
      dest = getById('Warehouses', p.toWarehouseId);
      if (!dest) fail('Select the warehouse the goods are going to');
      if (dest.id === wh.id) fail('A transfer needs two different warehouses');
      if (dest.status === 'archived') fail('Warehouse "' + dest.name + '" is archived. Restore it first.');
    }
    var lines = (p.lines || []).filter(function (l) { return l.itemId; });
    if (!lines.length) fail('Add at least one item');
    var itemById = {};
    readAll('Items').forEach(function (it) { itemById[it.id] = it; });
    lines.forEach(function (l, i) {
      if (!itemById[l.itemId]) fail('Line ' + (i + 1) + ': item not found');
      if (!(Number(l.qty) > 0)) fail('Line ' + (i + 1) + ': quantity must be greater than zero');
      if (l.rate !== undefined && l.rate !== '' && !(Number(l.rate) >= 0)) fail('Line ' + (i + 1) + ': rate must be zero or more');
    });
    var party = whPartyFor(p);
    // Goods leaving a warehouse must be there to leave.
    if (meta.sign < 0) assertWarehouseHas(wh, lines, false);
    // Goods sent from the shop into a warehouse must be on the shop's shelves.
    if (p.type === 'from-shop') assertShopHas(lines, false);

    var date = p.date || todayISO();
    var move = {
      id: uid('whm'), docNo: nextDocNo(meta.prefix, date), type: p.type,
      warehouseId: wh.id, toWarehouseId: dest ? dest.id : '', date: date,
      partyName: party ? party.name : String(p.partyName || '').trim(), reference: String(p.reference || '').trim(),
      vehicleNo: String(p.vehicleNo || '').trim(), driverName: String(p.driverName || '').trim(),
      reason: p.reason || '', note: p.note || '', status: 'active',
      createdAt: nowISO(), createdBy: ACTING_USER, voidReason: '', voidedAt: '',
      partyId: party ? party.id : ''
    };
    appendRow('WarehouseMoves', move);
    // Rates are money on a party's khata; someone who cannot see them cannot set them.
    var takesRates = !CURRENT || CURRENT.seesCost;
    var total = 0;
    lines.forEach(function (l) {
      var item = itemById[l.itemId];
      appendRow('WarehouseMoveLines', {
        id: uid('wml'), moveId: move.id, itemId: l.itemId, qty: r2(l.qty),
        unit: l.unit || item.baseUnit || 'Piece',
        rate: !takesRates || l.rate === '' || l.rate === undefined || l.rate === null ? '' : r2(l.rate),
        note: l.note || ''
      });
      total += Number(l.qty) || 0;
    });
    logActivity('warehouse', move.id, 'create',
      meta.label + ' ' + move.docNo + ' — ' + wh.name + (dest ? ' → ' + dest.name : '') + ', ' +
      lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' (' + r2(total) + ')');
    return move;
  });
}

/**
 * The warehouse party a stock in / out names, or null. Only those two kinds
 * have one: a transfer or an adjustment never involves anyone outside.
 */
function whPartyFor(p) {
  if (!p.partyId) return null;
  if (p.type !== 'in' && p.type !== 'out') fail('Only stock in and stock out have a party');
  var party = getById('WhParties', p.partyId);
  if (!party) fail('Party not found');
  if (party.status === 'archived') fail('Party "' + party.name + '" is archived. Restore it first.');
  return party;
}

/**
 * Change the rates on a saved movement's lines. Goods are often received
 * before the bill is checked, by someone who does not see prices; an admin
 * fills the rates in afterwards, and the party's khata follows.
 */
function setWhMoveRates(p) {
  return withLock(function () {
    var move = getById('WarehouseMoves', p.id);
    if (!move) fail('Movement not found');
    if (move.status === 'voided') fail('This movement is cancelled');
    var changes = p.rates || [];
    if (!changes.length) fail('Nothing to change');
    var s = sheet('WarehouseMoveLines');
    var last = s.getLastRow();
    var ids = last < 2 ? [] : s.getRange(2, 1, last - 1, 1).getValues();
    var rowOf = {};
    var moveCol = SCHEMA.WarehouseMoveLines.indexOf('moveId');
    var moveIds = last < 2 ? [] : s.getRange(2, moveCol + 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(moveIds[i][0]) === String(move.id)) rowOf[String(ids[i][0])] = i + 2;
    }
    changes.forEach(function (c, n) {
      if (!rowOf[String(c.id)]) fail('Line ' + (n + 1) + ' is not part of ' + move.docNo);
      var blankRate = c.rate === '' || c.rate === null || c.rate === undefined;
      if (!blankRate && !(Number(c.rate) >= 0)) fail('Line ' + (n + 1) + ': rate must be zero or more');
    });
    changes.forEach(function (c) {
      var blankRate = c.rate === '' || c.rate === null || c.rate === undefined;
      updateRow('WarehouseMoveLines', rowOf[String(c.id)], { rate: blankRate ? '' : r2(c.rate) });
    });
    logActivity('warehouse rates', move.id, 'edit', 'Rates updated on ' + move.docNo +
      (move.partyName ? ' (' + move.partyName + ')' : ''));
    return { ok: true };
  });
}

function voidWhMove(p) {
  return withLock(function () {
    var move = getById('WarehouseMoves', p.id);
    if (!move) fail('Movement not found');
    if (move.status === 'voided') fail('This movement is already cancelled');
    var meta = MOVE_TYPES[move.type] || {};
    var lines = readAll('WarehouseMoveLines').filter(function (l) { return l.moveId === move.id; });
    // Cancelling goods that came IN takes them back out — they must still be there.
    var receiver = move.type === 'transfer'
      ? getById('Warehouses', move.toWarehouseId)
      : (meta.sign > 0 ? getById('Warehouses', move.warehouseId) : null);
    if (receiver) assertWarehouseHas(receiver, lines, true);
    // Cancelling goods sent to the shop takes them back off the shop's shelves.
    if (move.type === 'to-shop') assertShopHas(lines, true);
    var patch = { status: 'voided', voidReason: p.reason || '', voidedAt: nowISO() };
    updateRow('WarehouseMoves', move._row, patch);
    logActivity('warehouse', move.id, 'void',
      'Cancelled ' + (meta.label || 'movement') + ' ' + move.docNo + (p.reason ? ' — ' + p.reason : ''), move, patch);
    return getById('WarehouseMoves', move.id);
  });
}

/**
 * A physical count of one warehouse. Each item counted is compared with what
 * the books say; shortages go out as one Adjustment (−) and surpluses come in
 * as one Adjustment (+), both under one lock, so the warehouse then holds
 * exactly what was counted and every difference is a document on record.
 */
function saveStockCount(p) {
  return withLock(function () {
    var wh = getById('Warehouses', p.warehouseId);
    if (!wh) fail('Select a warehouse');
    var counts = p.counts || [];
    if (!counts.length) fail('Count at least one item');
    var stock = warehouseStock(wh.id);
    var outs = [];
    var ins = [];
    counts.forEach(function (c, i) {
      var counted = Number(c.counted);
      if (c.counted === '' || c.counted === null || !isFinite(counted) || counted < 0) {
        fail('Line ' + (i + 1) + ': enter the quantity counted (0 or more)');
      }
      var diff = r2(counted - (stock[c.itemId] || 0));
      if (diff > 0.0001) ins.push({ itemId: c.itemId, qty: diff, note: 'Counted ' + counted });
      else if (diff < -0.0001) outs.push({ itemId: c.itemId, qty: -diff, note: 'Counted ' + counted });
    });
    if (!ins.length && !outs.length) fail('Every count matches the books — nothing to adjust.');
    var base = { warehouseId: wh.id, date: p.date || todayISO(), reason: 'Stock count', note: p.note || 'Physical stock count' };
    var moves = [];
    if (outs.length) moves.push(saveWhMove(Object.assign({}, base, { type: 'adjust-out', lines: outs })));
    if (ins.length) moves.push(saveWhMove(Object.assign({}, base, { type: 'adjust-in', lines: ins })));
    return { moves: moves, shortages: outs.length, surpluses: ins.length };
  });
}

function saveWhExpense(p) {
  return withLock(function () {
    var wh = getById('Warehouses', p.warehouseId);
    if (!wh) fail('Select a warehouse');
    if (!(Number(p.amount) > 0)) fail('Enter an amount');
    var rec = {
      id: uid('wex'), warehouseId: wh.id, category: p.category || 'Miscellaneous', amount: r2(p.amount),
      date: p.date || todayISO(), method: p.method || 'Cash', note: p.note || ''
    };
    appendRow('WarehouseExpenses', rec);
    logActivity('warehouse', rec.id, 'create', 'Warehouse expense ' + rec.category + ' — ' + rec.amount + ' (' + wh.name + ')');
    return rec;
  });
}

function deleteWhExpense(p) {
  return withLock(function () {
    var rec = getById('WarehouseExpenses', p.id);
    if (!rec) fail('Expense not found');
    deleteRowById('WarehouseExpenses', p.id);
    logActivity('warehouse', p.id, 'delete',
      'Deleted warehouse expense ' + rec.category + ' — ' + rec.amount + (p.reason ? ' — ' + p.reason : ''), rec, null);
    return { ok: true };
  });
}

/* ---------------------------------------------------- Warehouse parties */

function saveWhParty(p) {
  return withLock(function () {
    var name = String(p.name || '').trim();
    if (!name) fail('Party name is required');
    // As with shop parties: one name, one khata, and one mobile number, one party.
    var all = readAll('WhParties');
    var wantPhone = phoneKey(p.phone);
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(p.id || '')) continue;
      if (nameKey(all[i].name) === nameKey(name)) {
        fail('A warehouse party called "' + all[i].name + '" already exists. Use a different name, or open the existing one.');
      }
      if (wantPhone && phoneKey(all[i].phone) === wantPhone) {
        fail('This mobile number is already on warehouse party "' + all[i].name + '".');
      }
    }
    var fields = {
      name: name, phone: String(p.phone || '').trim(), city: String(p.city || '').trim(),
      address: String(p.address || '').trim(), note: String(p.note || '').trim()
    };
    // The opening balance is money: staff save a party without touching it.
    var setsMoney = !CURRENT || CURRENT.seesCost;
    if (setsMoney && p.openingBalance !== undefined) {
      var opening = p.openingBalance === '' || p.openingBalance === null ? 0 : Number(p.openingBalance);
      if (!isFinite(opening)) fail('Opening balance must be a number');
      fields.openingBalance = r2(opening);
    }

    if (p.id) {
      var existing = getById('WhParties', p.id);
      if (!existing) fail('Party not found');
      updateRow('WhParties', existing._row, fields);
      logActivity('warehouse party', p.id, 'edit', 'Edited warehouse party "' + name + '"', existing, fields);
      return getById('WhParties', p.id);
    }

    var rec = {
      id: uid('whp'), name: fields.name, phone: fields.phone, city: fields.city, address: fields.address,
      openingBalance: fields.openingBalance || 0, note: fields.note, status: 'active', createdAt: nowISO(),
      lockHash: '', lockSalt: ''
    };
    appendRow('WhParties', rec);
    var linked = linkMovesByName(rec);
    logActivity('warehouse party', rec.id, 'create', 'Added warehouse party "' + rec.name + '"' +
      (linked ? ' — ' + linked + ' earlier movement' + (linked === 1 ? '' : 's') + ' linked by name' : ''));
    return rec;
  });
}

/**
 * Stock in / out typed before this party existed name it as free text. Give
 * those movements the party's id, so its khata starts with its whole history.
 * Read in one call and written cell by cell, only where a name matches.
 */
function linkMovesByName(party) {
  var key = nameKey(party.name);
  var s = sheet('WarehouseMoves');
  var last = s.getLastRow();
  if (!key || last < 2) return 0;
  var cols = SCHEMA.WarehouseMoves;
  var values = s.getRange(2, 1, last - 1, cols.length).getValues();
  var iType = cols.indexOf('type');
  var iName = cols.indexOf('partyName');
  var iParty = cols.indexOf('partyId');
  var n = 0;
  for (var i = 0; i < values.length; i++) {
    var type = String(values[i][iType]);
    if (type !== 'in' && type !== 'out') continue;
    if (String(values[i][iParty] || '') || nameKey(values[i][iName]) !== key) continue;
    s.getRange(i + 2, iParty + 1).setValue(cellValue('partyId', party.id));
    n++;
  }
  return n;
}

function addWhPartyPayment(p) {
  return withLock(function () {
    var party = getById('WhParties', p.partyId);
    if (!party) fail('Party not found');
    if (p.direction !== 'paid' && p.direction !== 'received') fail('Choose whether you paid them or they paid you');
    var amount = Number(p.amount);
    if (!isFinite(amount) || amount <= 0) fail('Enter an amount greater than zero');
    var method = String(p.method || 'Cash');
    assertMethod(method);
    var rec = {
      id: uid('wpp'), partyId: party.id, direction: p.direction, amount: r2(amount),
      date: p.date || todayISO(), method: method, note: String(p.note || '').trim(),
      createdAt: nowISO(), createdBy: ACTING_USER
    };
    appendRow('WhPartyPayments', rec);
    logActivity('warehouse payment', rec.id, 'create',
      (rec.direction === 'paid' ? 'Paid ' + rec.amount + ' to ' : 'Received ' + rec.amount + ' from ') +
      'warehouse party "' + party.name + '" (' + method + ')');
    return rec;
  });
}

function deleteWhPartyPayment(p) {
  return withLock(function () {
    var rec = getById('WhPartyPayments', p.id);
    if (!rec) fail('Payment not found');
    var party = getById('WhParties', rec.partyId);
    deleteRowById('WhPartyPayments', p.id);
    logActivity('warehouse payment', p.id, 'delete',
      'Deleted ' + (rec.direction === 'paid' ? 'payment of ' : 'receipt of ') + rec.amount +
      (party ? ' — ' + party.name : '') + (p.reason ? ' — ' + p.reason : ''), rec, null);
    return { ok: true };
  });
}

/**
 * What a warehouse party sees through a share link: its own movements with
 * item names and rates — its own bills, so nothing it does not already know —
 * and the money either way. Never stock levels, other parties or cost prices.
 */
function sharedWarehouseLedger(party, settings) {
  var moves = readAll('WarehouseMoves').filter(function (m) { return m.partyId === party.id; });
  var ids = {};
  moves.forEach(function (m) { ids[m.id] = 1; });
  var nameById = {};
  readAll('Items').forEach(function (i) { nameById[i.id] = i.name; });
  return {
    kind: 'warehouse',
    party: { name: party.name, phone: party.phone, city: party.city },
    shopName: settings.shopName,
    openingBalance: Number(party.openingBalance) || 0,
    moves: moves.map(function (m) {
      return {
        id: m.id, docNo: m.docNo, type: m.type, date: m.date, reference: m.reference,
        vehicleNo: m.vehicleNo, status: m.status
      };
    }),
    lines: readAll('WarehouseMoveLines')
      .filter(function (l) { return ids[l.moveId]; })
      .map(function (l) {
        return {
          id: l.id, moveId: l.moveId, qty: l.qty, unit: l.unit, rate: l.rate, note: l.note,
          itemName: nameById[l.itemId] || 'Item'
        };
      }),
    payments: readAll('WhPartyPayments')
      .filter(function (x) { return x.partyId === party.id; })
      .map(function (x) {
        return { id: x.id, direction: x.direction, amount: x.amount, date: x.date, method: x.method, note: x.note };
      })
  };
}

/* ==========================================================================
   Employees
   ========================================================================== */

function saveEmployee(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Employee name is required');

    if (p.id) {
      var existing = getById('Employees', p.id);
      if (!existing) fail('Employee not found');
      var patch = {
        name: String(p.name).trim(),
        phone: p.phone || '',
        role: p.role || '',
        monthlySalary: r2(p.monthlySalary),
        joinDate: p.joinDate || existing.joinDate
      };
      updateRow('Employees', existing._row, patch);
      logActivity('employee', p.id, 'edit', 'Edited employee "' + patch.name + '"', existing, patch);
      return getById('Employees', p.id);
    }

    var rec = {
      id: uid('emp'),
      name: String(p.name).trim(),
      phone: p.phone || '',
      role: p.role || '',
      monthlySalary: r2(p.monthlySalary),
      joinDate: p.joinDate || todayISO(),
      status: 'active'
    };
    appendRow('Employees', rec);
    logActivity('employee', rec.id, 'create', 'Added employee "' + rec.name + '"');
    return rec;
  });
}

function addEmployeeTx(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an amount');
    if (!getById('Employees', p.employeeId)) fail('Employee not found');
    if (['salary', 'advance', 'bonus'].indexOf(p.type || 'salary') < 0) fail('Unknown entry type');
    assertMethod(p.method);

    var rec = {
      id: uid('etx'),
      employeeId: p.employeeId,
      type: p.type || 'salary',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash'
    };
    appendRow('EmployeeTransactions', rec);

    var emp = getById('Employees', p.employeeId);
    logActivity('employeeTx', rec.id, 'create',
      rec.type + ' ' + rec.amount + ' to ' + (emp ? emp.name : 'employee'));
    return rec;
  });
}

/* ==========================================================================
   Expenses / stock loss / assets
   ========================================================================== */

function saveExpense(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an amount');
    assertMethod(p.method);
    var rec = {
      id: uid('exp'),
      category: p.category || 'Miscellaneous',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash',
      linkedStockLossId: p.linkedStockLossId || ''
    };
    appendRow('Expenses', rec);
    logActivity('expense', rec.id, 'create', 'Expense ' + rec.category + ' — ' + rec.amount);
    return rec;
  });
}

/** Stock loss also creates its linked expense — one entry, correct accounting (FR-36). */
function saveStockLoss(p) {
  return withLock(function () {
    var item = getById('Items', p.itemId);
    if (!item) fail('Select an item');
    if (!(Number(p.qty) > 0)) fail('Quantity lost must be greater than zero');
    if (!(Number(p.estimatedValue || 0) >= 0)) fail('Value lost cannot be negative');
    // Staff cannot see cost, so the loss is valued at cost here instead.
    if (CURRENT && !CURRENT.seesCost) p.estimatedValue = r2((Number(p.qty) || 0) * (Number(item.costPrice) || 0));
    var lossId = uid('stl');
    var expId = uid('exp');

    var loss = {
      id: lossId,
      itemId: p.itemId,
      qty: Number(p.qty) || 0,
      reason: p.reason || 'Damaged',
      estimatedValue: r2(p.estimatedValue),
      date: p.date || todayISO(),
      note: p.note || '',
      linkedExpenseId: expId
    };
    appendRow('StockLoss', loss);

    appendRow('Expenses', {
      id: expId,
      category: 'Stock Loss',
      amount: r2(p.estimatedValue),
      date: loss.date,
      note: (item ? item.name : 'Item') + ' x ' + loss.qty + ' — ' + loss.reason,
      method: '',
      linkedStockLossId: lossId
    });

    logActivity('stockLoss', lossId, 'create',
      'Stock loss: ' + loss.qty + ' x ' + (item ? item.name : 'item') + ' (' + loss.reason + ')');
    return loss;
  });
}

function saveAsset(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Asset name is required');
    if (!(Number(p.value) >= 0)) fail('Asset value must be zero or more');
    var rec = {
      id: uid('ast'),
      name: String(p.name).trim(),
      value: r2(p.value),
      date: p.date || todayISO(),
      note: p.note || ''
    };
    appendRow('Assets', rec);
    logActivity('asset', rec.id, 'create', 'Asset added "' + rec.name + '"');
    return rec;
  });
}

/* ==========================================================================
   Shared ledger links (FR-20 / FR-21)
   ========================================================================== */

/**
 * One link per party. `tab` is Parties for a shop customer, WhParties for a
 * warehouse party — the two share PartyLedgerLinks, and openSharedLedger tells
 * them apart by which tab holds the id.
 */
function createShareLink(p, tab) {
  tab = tab || 'Parties';
  return withLock(function () {
    if (!p.password || String(p.password).length < 6) {
      fail('Set a password of at least 6 characters');
    }
    if (!getById(tab, p.partyId)) fail('Party not found');
    // One active link per party
    deleteRowsWhere('PartyLedgerLinks', 'partyId', p.partyId);

    var token = secureToken('shr');
    var salt = secureToken('slt');
    appendRow('PartyLedgerLinks', {
      partyId: p.partyId,
      token: token,
      passwordHash: saltedHash(p.password, salt),
      salt: salt,
      active: true,
      createdAt: nowISO()
    });
    // Logged against the party, not the token: the log is visible to every
    // dashboard user and the token is half of what opens the ledger.
    logActivity(tab === 'Parties' ? 'shareLink' : 'warehouse party', p.partyId, 'create', 'Shared ledger link created');
    return { token: token };
  });
}

function revokeShareLink(p, tab) {
  tab = tab || 'Parties';
  return withLock(function () {
    // Only a party of this side: the warehouse page cannot end a shop link.
    if (!getById(tab, p.partyId)) fail('Party not found');
    deleteRowsWhere('PartyLedgerLinks', 'partyId', p.partyId);
    logActivity(tab === 'Parties' ? 'shareLink' : 'warehouse party', p.partyId, 'void', 'Shared ledger link revoked');
    return { ok: true };
  });
}

/**
 * Bill lines for the public party view, with the item NAME attached.
 * The shared page has no access to the Items table, and a raw id would be
 * meaningless to the party. Only the name is exposed — never cost price or
 * stock levels.
 */
function sharedBillItems(billIds) {
  var items = readAll('Items');
  var nameById = {};
  items.forEach(function (i) { nameById[i.id] = i.name; });

  return readAll('BillItems')
    .filter(function (x) { return billIds[x.billId]; })
    .map(function (bi) {
      return {
        id: bi.id, billId: bi.billId, itemId: bi.itemId,
        qty: bi.qty, unit: bi.unit, price: bi.price,
        itemName: nameById[bi.itemId] || 'Item'
      };
    });
}

/** Read-only payload for the public party view — that party's data only. */
function openSharedLedger(p) {
  // Throttled on the token, so a share password is no easier to guess than
  // the main login.
  assertNotLocked('share:' + p.token);

  var links = readAll('PartyLedgerLinks');
  var link = null;
  for (var i = 0; i < links.length; i++) {
    if (links[i].token === p.token && links[i].active) { link = links[i]; break; }
  }
  if (!link) fail('This link is no longer valid');
  if (!sharePasswordMatches(link, p.password)) {
    recordFailure('share:' + p.token);
    fail('Incorrect password');
  }
  clearFailures('share:' + p.token);

  var settings = readSettings();
  var whParty = getById('WhParties', link.partyId);
  if (whParty) return sharedWarehouseLedger(whParty, settings);
  var party = getById('Parties', link.partyId);

  var bills = readAll('Bills').filter(function (b) { return b.partyId === link.partyId; });
  var billIds = {};
  bills.forEach(function (b) { billIds[b.id] = 1; });

  return {
    party: { name: party ? party.name : '', phone: party ? party.phone : '' },
    shopName: settings.shopName,
    bills: bills,
    billItems: sharedBillItems(billIds),
    payments: readAll('Payments').filter(function (x) { return x.partyId === link.partyId; }),
    returns: readAll('Returns').filter(function (x) { return billIds[x.billId]; }),
    cheques: readAll('Cheques').filter(function (x) { return x.partyId === link.partyId; }),
    partyAdvances: readAll('PartyAdvances').filter(function (x) { return x.partyId === link.partyId; })
  };
}

/* ==========================================================================
   First-run setup
   ========================================================================== */

/** Create every tab with its header row, and seed the admin account. */
function ensureSeed() {
  for (var name in SCHEMA) sheet(name);

  var users = readAll('Users');
  if (!users.length) {
    appendRow('Users', {
      id: uid('usr'),
      username: 'admin',
      // SHA-256 of "admin123" — change it from Settings after first login
      passwordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
      role: 'superadmin',
      status: 'active',
      name: 'Owner',
      createdAt: nowISO()
    });
  }

  var settingsRows = readAll('Settings');
  if (!settingsRows.length) {
    var s = sheet('Settings');
    for (var k in SETTINGS_DEFAULTS) {
      var v = SETTINGS_DEFAULTS[k];
      s.appendRow([k, cellValue(k, k === 'customMethods' ? JSON.stringify(v) : v)]);
    }
  }
}

/**
 * Run this ONCE from the Apps Script editor after creating the project.
 * It builds every tab and seeds the admin login.
 *
 * SpreadsheetApp.getUi() only works when the script runs with the spreadsheet
 * open in front of you. Run it from the editor's Run button, from a trigger,
 * or from a standalone project and it throws "Cannot call
 * SpreadsheetApp.getUi() from this context". Setup itself has nothing to do
 * with dialogs, so the alert is best-effort: the result always goes to the
 * execution log, which is visible in every context.
 */
function setup() {
  ensureSeed();
  PropertiesService.getScriptProperties().setProperty('seeded', 'yes');

  var message =
    'Setup complete.\n\n' +
    'All sheet tabs created.\n' +
    'Login: admin / admin123\n\n' +
    'Change the password from Settings after your first login.';

  Logger.log(message);

  // Show a dialog only if this context actually has a UI.
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // No UI here (editor Run button, trigger, or standalone project).
    // The log above is the result; nothing has failed.
  }

  return message;
}

/**
 * Verify the backend is wired up correctly. Run this from the editor and read
 * the execution log. It reports what it actually found rather than assuming.
 */
function healthCheck() {
  var book = null;
  try { book = ss(); } catch (e) {}

  if (!book) {
    Logger.log(
      'FAIL: this script is not bound to a spreadsheet.\n' +
      'SpreadsheetApp.getActiveSpreadsheet() returned nothing, so no data can\n' +
      'be read or written. Fix: open your Google Sheet, choose\n' +
      'Extensions > Apps Script, and paste this code into THAT project.\n' +
      'A standalone Apps Script project cannot work here.'
    );
    return;
  }

  var lines = [];
  lines.push('Spreadsheet: ' + book.getName());

  var missing = [];
  for (var name in SCHEMA) {
    if (!book.getSheetByName(name)) missing.push(name);
  }
  lines.push(missing.length
    ? 'Missing tabs: ' + missing.join(', ') + '  -> run setup()'
    : 'All ' + Object.keys(SCHEMA).length + ' tabs present.');

  var users = readAll('Users');
  lines.push('Admin account: ' +
    (users.length ? 'yes (' + users[0].username + ')' : 'MISSING -> run setup()'));

  var st = readSettings();
  lines.push('shopName reads back as: ' + JSON.stringify(st.shopName));
  lines.push('roundingRule reads back as: ' + JSON.stringify(st.roundingRule));

  if (st.shopName === null || typeof st.shopName === 'number') {
    lines.push('');
    lines.push('WARNING: settings are being corrupted on read. This deployment is');
    lines.push('running an OLD version of Code.gs. Paste the latest file and use');
    lines.push('Deploy > Manage deployments > edit > New version > Deploy.');
  }

  lines.push('Parties: ' + readAll('Parties').length +
             ', Items: ' + readAll('Items').length +
             ', Bills: ' + readAll('Bills').length);

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/* ==========================================================================
   Optional nightly backup (Safety Guide 2.4)
   Create a time-driven trigger for this function to auto-copy the spreadsheet
   to a dated file in Drive every night.
   ========================================================================== */

function nightlyBackup() {
  var file = DriveApp.getFileById(ss().getId());
  var stamp = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  var folderName = 'JH Dashboard Backups';

  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  file.makeCopy('JH Backup ' + stamp, folder);

  // Keep the most recent 30 copies
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    list.push({ file: f, date: f.getDateCreated() });
  }
  list.sort(function (a, b) { return b.date - a.date; });
  for (var i = 30; i < list.length; i++) list[i].file.setTrashed(true);
}
