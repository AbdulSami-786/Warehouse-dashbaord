// Who may open which page. Mirrors PAGE_KEYS / COST_PAGES in apps-script/Code.gs,
// which enforces the same rules on every request; hiding a page here is only
// the visible half.

export const ROLES = [
  { value: 'superadmin', label: 'Super admin', desc: 'Everything, including users and importing files' },
  { value: 'admin', label: 'Admin', desc: 'The pages you choose, with cost prices' },
  { value: 'staff', label: 'Staff', desc: 'The pages you choose, never cost prices' },
];

/** Every page a user can be given. `cost` pages show cost prices, so staff never get them. */
export const PAGES = [
  { key: 'dashboard', label: 'Dashboard', system: 'shop' },
  { key: 'newBill', label: 'New Bill', system: 'shop' },
  { key: 'bills', label: 'All Bills', system: 'shop' },
  { key: 'returns', label: 'Returns', system: 'shop' },
  { key: 'parties', label: 'Parties & ledgers', system: 'shop' },
  { key: 'outstanding', label: 'Outstanding', system: 'shop' },
  { key: 'ledgerBook', label: 'Ledger Book', system: 'shop' },
  { key: 'cheques', label: 'Cheques', system: 'shop' },
  { key: 'expenses', label: 'Expenses', system: 'shop' },
  { key: 'assets', label: 'Assets', system: 'shop' },
  { key: 'items', label: 'Items', system: 'shop' },
  { key: 'stockLoss', label: 'Damaged Stock', system: 'shop' },
  { key: 'employees', label: 'Employees', system: 'shop' },
  { key: 'activity', label: 'Activity Log', system: 'shop' },
  { key: 'settings', label: 'Shop settings', system: 'shop' },
  { key: 'suppliers', label: 'Suppliers', system: 'shop', cost: true },
  { key: 'purchases', label: 'Purchases', system: 'shop', cost: true },
  { key: 'accounts', label: 'Accounts (cash & bank)', system: 'shop', cost: true },
  { key: 'profit', label: 'Profit Report', system: 'shop', cost: true },
  { key: 'balanceSheet', label: 'Balance Sheet', system: 'shop', cost: true },
  { key: 'audit', label: 'Audit Summary', system: 'shop', cost: true },
  { key: 'reports', label: 'All Reports (shop + warehouses)', system: 'both' },
  { key: 'whDashboard', label: 'Warehouse overview', system: 'warehouse' },
  { key: 'warehouses', label: 'Warehouses', system: 'warehouse' },
  { key: 'whStock', label: 'Warehouse stock', system: 'warehouse' },
  { key: 'whMoves', label: 'Stock in / out / transfer', system: 'warehouse' },
  { key: 'whParties', label: 'Warehouse parties & khata', system: 'warehouse' },
  { key: 'whCount', label: 'Stock count', system: 'warehouse' },
  { key: 'whExpenses', label: 'Warehouse expenses', system: 'warehouse' },
  { key: 'whReports', label: 'Warehouse reports', system: 'warehouse' },
  { key: 'whActivity', label: 'Warehouse activity log', system: 'warehouse' },
];

export const COST_PAGES = new Set(PAGES.filter((p) => p.cost).map((p) => p.key));

/** Ready-made page lists for the people a shop usually has. */
export const PRESETS = [
  { label: 'Salesman', pages: ['dashboard', 'newBill', 'bills', 'returns', 'parties', 'outstanding', 'items'] },
  { label: 'Cashier', pages: ['dashboard', 'newBill', 'bills', 'parties', 'outstanding', 'cheques', 'expenses', 'ledgerBook'] },
  { label: 'Warehouse keeper', pages: ['whDashboard', 'warehouses', 'whStock', 'whMoves', 'whParties', 'whCount', 'whExpenses', 'whReports'] },
  { label: 'Everything (no cost)', pages: PAGES.filter((p) => !p.cost).map((p) => p.key) },
];

/** What the signed-in user may do. */
export function accessFor(me) {
  // A session from before roles existed has none; it belongs to the original admin.
  const role = ['superadmin', 'admin', 'staff'].includes(me?.role) ? me.role : 'admin';
  const pages = role === 'superadmin' ? null : Array.isArray(me?.pages) ? me.pages : role === 'staff' ? [] : null;
  const seesCost = role !== 'staff';
  const can = (page) => {
    if (!page || role === 'superadmin') return true;
    if (!seesCost && COST_PAGES.has(page)) return false;
    return pages === null || pages.includes(page);
  };
  return {
    role,
    isSuper: role === 'superadmin',
    isAdmin: role === 'superadmin' || role === 'admin',
    seesCost,
    can,
    canAny: (list) => list.some(can),
  };
}

/** A user record's access, as the server works it out (accessOf in Code.gs). */
export function accessOf(user) {
  const known = ['superadmin', 'admin', 'staff'];
  const role = known.includes(String(user?.role || '').toLowerCase()) ? String(user.role).toLowerCase() : 'staff';
  let pages = role === 'superadmin' ? null : Array.isArray(user?.pages) ? user.pages : null;
  if (role === 'staff') pages = (pages || []).filter((k) => !COST_PAGES.has(k));
  return { username: user.username, name: user.name || user.username, role, pages, seesCost: role !== 'staff' };
}

const COST_ACTIVITY = new Set(['purchase', 'purchaseBill', 'supplierPayment', 'supplierReturn', 'supplier', 'stockLoss',
  'warehouse payment', 'warehouse rates', 'journal payment']);
const blank = (rows = [], keys) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keys.includes(k) ? '' : v])));

/**
 * A supplier's or warehouse party's journal entry without its money: the
 * amounts, the take / give choice and the payment on each row.
 */
function withoutJournalMoney(e) {
  if (e.kind === 'party') return e;
  let fields = e.fields;
  try {
    const list = typeof fields === 'string' ? JSON.parse(fields) : fields;
    if (Array.isArray(list)) {
      const clean = list.map(({ payment, ...rest }) => rest);
      fields = typeof e.fields === 'string' ? JSON.stringify(clean) : clean;
    }
  } catch { /* leave the fields as they are */ }
  return { ...e, fields, amount: '', direction: '' };
}

/** The database as someone who may not see cost prices receives it (stripCostData in Code.gs). */
export function stripCostData(db) {
  return {
    ...db,
    items: blank(db.items, ['costPrice']),
    billItems: blank(db.billItems, ['costPriceAtSale']),
    purchases: blank(db.purchases, ['costPrice', 'method']),
    purchaseBills: blank(db.purchaseBills, ['totalAmount']),
    supplierReturns: blank(db.supplierReturns, ['value']),
    supplierPayments: [],
    suppliers: [],
    whMoveLines: blank(db.whMoveLines, ['rate']),
    whParties: blank(db.whParties, ['openingBalance']),
    whPartyPayments: [],
    journal: (db.journal || []).map(withoutJournalMoney),
    journalPayments: (db.journalPayments || []).filter((x) => x.kind === 'party'),
    stockLoss: blank(db.stockLoss, ['estimatedValue']),
    expenses: (db.expenses || []).filter((e) => !e.linkedStockLossId),
    activityLog: blank((db.activityLog || []).filter((l) => !COST_ACTIVITY.has(l.entityType)), ['oldValue', 'newValue']),
  };
}

export const SHOP_PAGES = PAGES.filter((p) => p.system !== 'warehouse').map((p) => p.key);
export const WAREHOUSE_PAGES = [...PAGES.filter((p) => p.system !== 'shop').map((p) => p.key), 'items'];
