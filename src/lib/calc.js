// Every balance in the dashboard is derived from the raw records here, never
// stored. The database holds facts (bills, payments, returns, cheques); this file
// turns them into what is owed, what is in stock, and what the shop is worth.

import {
  r2, applyRounding, ageBucket, daysSince, dayOf, inRange, fmtDate, rs,
} from './format.js';

/* ------------------------------------------------------------------ Bills */

export function linesSubtotal(lines = []) {
  return r2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
}

/** Subtotal, rounding and total for a set of lines. Mirrors billTotalsFromLines() in Code.gs. */
export function billTotals(lines, rule = 'nearest1') {
  const subtotal = linesSubtotal(lines);
  const total = applyRounding(subtotal, rule);
  return { subtotal, roundOff: r2(total - subtotal), total: r2(total) };
}

export function billReturned(billId, returns = []) {
  return r2(returns.filter((r) => r.billId === billId).reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0));
}

/**
 * Everything the screen needs to know about one bill's money.
 *
 * A payment backed by a cheque that has not cleared does not count as paid; a
 * bounced cheque stops counting altogether, so the bill reopens by itself.
 */
export function billState(bill, { payments = [], returns = [], cheques = [] } = {}) {
  const gross = r2(bill.totalAmount);
  const returned = billReturned(bill.id, returns);
  const net = r2(gross - returned);
  const uncleared = new Set(cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId));
  const counts = (p) => p.billId === bill.id && !p.reversed && !uncleared.has(p.id);
  const paid = r2(payments.filter(counts).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const pendingCheques = r2(
    payments
      .filter((p) => p.billId === bill.id && !p.reversed && uncleared.has(p.id))
      .filter((p) => {
        const c = cheques.find((x) => x.paymentId === p.id);
        return c && c.status !== 'bounced';
      })
      .reduce((s, p) => s + (Number(p.amount) || 0), 0),
  );
  const delivery = bill.status === 'voided' ? 'cancelled' : bill.delivery === 'pending' ? 'pending' : 'delivered';
  return withPaid(
    {
      ...bill, gross, returned, net, pendingCheques, delivery,
      isPending: delivery === 'pending',
      overpaid: r2(Math.max(0, paid - net)),
      carriedIn: 0,
    },
    paid,
  );
}

function withPaid(state, paid) {
  const due = r2(Math.max(0, state.net - paid));
  let status;
  if (state.status === 'voided') status = 'voided';
  else if (due <= 0.004) status = 'paid';
  else if (paid > 0.004) status = 'partial';
  else if (state.pendingCheques > 0.004) status = 'cheque-pending';
  else status = 'due';
  const overdueDays = status !== 'paid' && status !== 'voided' ? daysSince(state.dueDate) : 0;
  return {
    ...state,
    paid: r2(paid),
    due,
    status,
    isOverdue: due > 0 && overdueDays > 0,
    overdueDays,
    bucket: due > 0 ? ageBucket(Math.max(0, overdueDays)) : null,
  };
}

/**
 * A bill paid beyond its net (usually after a return) leaves money that
 * belongs to the party. It is carried onto their oldest open bills.
 */
function carryOverpayments(states) {
  const byParty = new Map();
  states.forEach((s, i) => {
    if (s.status === 'voided') return;
    if (!byParty.has(s.partyId)) byParty.set(s.partyId, []);
    byParty.get(s.partyId).push(i);
  });
  const out = states.slice();
  for (const idx of byParty.values()) {
    let spare = r2(idx.reduce((s, i) => s + (out[i].overpaid || 0), 0));
    if (spare <= 0.004) continue;
    idx.forEach((i) => { if (out[i].overpaid > 0) out[i] = withPaid(out[i], out[i].net); });
    const open = idx
      .filter((i) => out[i].due > 0.004)
      .sort((a, b) => String(out[a].date).localeCompare(String(out[b].date)) ||
        String(out[a].billNo).localeCompare(String(out[b].billNo)));
    for (const i of open) {
      if (spare <= 0.004) break;
      const use = r2(Math.min(out[i].due, spare));
      spare = r2(spare - use);
      out[i] = withPaid({ ...out[i], carriedIn: use }, out[i].paid + use);
    }
  }
  return out;
}

/** What can still be paid on a bill now, after cheques waiting to clear. */
export function payableNow(state) {
  return r2(Math.max(0, (state?.due || 0) - (state?.pendingCheques || 0)));
}

export function billStates(bills = [], data = {}) {
  return carryOverpayments(bills.map((b) => billState(b, data)));
}

export function partyCredit(partyId, states = []) {
  const mine = states.filter((s) => s.partyId === partyId && s.status !== 'voided');
  return r2(Math.max(0, mine.reduce((s, b) => s + (b.overpaid || 0), 0) - mine.reduce((s, b) => s + (b.carriedIn || 0), 0)));
}

export function givenQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How much of a bill line has gone out. Blank follows the bill's own flag. */
export function lineDelivered(line, bill) {
  const q = Number(line?.qty) || 0;
  const v = givenQty(line?.deliveredQty);
  if (v === null) return bill?.delivery === 'pending' ? 0 : q;
  return Math.min(q, Math.max(0, v));
}

function progress(lines, doneOf) {
  let total = 0;
  let done = 0;
  lines.forEach((l) => { total += Number(l.qty) || 0; done += doneOf(l); });
  total = r2(total);
  done = r2(done);
  return {
    state: !lines.length || done >= total - 0.0001 ? 'full' : done > 0.0001 ? 'partial' : 'none',
    done, total, left: r2(Math.max(0, total - done)),
  };
}

export function deliveryProgress(bill, billItems = []) {
  if (!bill) return { state: 'pending', done: 0, total: 0, left: 0 };
  const lines = billItems.filter((l) => l.billId === bill.id);
  const p = progress(lines, (l) => lineDelivered(l, bill));
  if (bill.status === 'voided') return { ...p, state: 'cancelled' };
  return { ...p, state: p.state === 'full' ? 'delivered' : p.state === 'partial' ? 'partial' : 'pending' };
}

/** How much of a purchase line has arrived. Blank reads as all of it. */
export function lineReceived(line) {
  const q = Number(line?.qty) || 0;
  const v = givenQty(line?.receivedQty);
  return v === null ? q : Math.min(q, Math.max(0, v));
}

export function receiptProgress(lines = []) {
  const p = progress(lines, lineReceived);
  return { ...p, state: p.state === 'full' ? 'received' : p.state === 'partial' ? 'partial' : 'pending' };
}

export function partyDue(partyId, states = []) {
  return r2(states.filter((s) => s.partyId === partyId && s.status !== 'voided').reduce((s, b) => s + b.due, 0));
}

/** Every item a party has bought, with its price history. */
export function partyItemHistory(partyId, { bills = [], billItems = [], items = [] } = {}) {
  const billById = new Map(bills.filter((b) => b.partyId === partyId).map((b) => [b.id, b]));
  const byItem = new Map();
  for (const l of billItems) {
    const b = billById.get(l.billId);
    if (!b) continue;
    if (!byItem.has(l.itemId)) byItem.set(l.itemId, []);
    byItem.get(l.itemId).push({
      billId: b.id, billNo: b.billNo, date: b.date,
      qty: Number(l.qty) || 0, unit: l.unit || '', price: r2(l.price),
      lineTotal: r2((Number(l.qty) || 0) * (Number(l.price) || 0)),
      voided: b.status === 'voided',
    });
  }
  const out = [];
  for (const [itemId, rows] of byItem) {
    rows.sort((a, b) => new Date(b.date) - new Date(a.date) || String(b.billNo).localeCompare(String(a.billNo)));
    const live = rows.filter((r) => !r.voided);
    const item = items.find((i) => i.id === itemId);
    const prices = live.map((r) => r.price);
    out.push({
      itemId,
      name: item?.name || 'Item',
      unit: item?.baseUnit || rows[0]?.unit || '',
      status: item?.status || 'active',
      costPrice: r2(item?.costPrice || 0),
      rows,
      times: live.length,
      last: live[0] || null,
      previous: live[1] || null,
      totalQty: r2(live.reduce((s, r) => s + r.qty, 0)),
      totalValue: r2(live.reduce((s, r) => s + r.lineTotal, 0)),
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      lastDate: live[0]?.date || rows[0]?.date || '',
    });
  }
  return out.sort((a, b) => new Date(b.lastDate) - new Date(a.lastDate));
}

export function partyPendingCheques(partyId, { cheques = [] } = {}) {
  return r2(cheques
    .filter((c) => c.partyId === partyId && c.status !== 'cleared' && c.status !== 'bounced')
    .reduce((s, c) => s + (Number(c.amount) || 0), 0));
}

export function advanceAvailable(partyId, partyAdvances = []) {
  return r2(partyAdvances
    .filter((a) => a.partyId === partyId)
    .reduce((s, a) => s + (Number(a.amount) || 0) - (Number(a.applied) || 0), 0));
}

/** Is this party past their own usual gap between orders? */
export function reorderSuggestion(partyId, bills = []) {
  const dates = bills
    .filter((b) => b.partyId === partyId && b.status !== 'voided')
    .map((b) => new Date(b.date))
    .filter((d) => !isNaN(d))
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  let gaps = 0;
  for (let i = 1; i < dates.length; i++) gaps += (dates[i] - dates[i - 1]) / 864e5;
  const avg = gaps / (dates.length - 1);
  if (avg <= 0) return null;
  const last = dates[dates.length - 1];
  const since = Math.round((Date.now() - last) / 864e5);
  const overdueBy = Math.round(since - avg);
  return { partyId, avgDays: Math.round(avg), sinceDays: since, overdueBy, isDue: overdueBy >= 0, lastOrder: last };
}

/* ------------------------------------------------------------------ Stock */

/**
 * Shop stock of one item: opening + bought − sold + restocked returns − lost
 * − returned to supplier + received from a warehouse − sent to a warehouse.
 */
export function itemStock(itemId, {
  purchases = [], billItems = [], bills = [], returns = [], stockLoss = [], items = [],
  purchaseBills = [], supplierReturns = [], whMoves = [], whMoveLines = [],
} = {}) {
  const voidedBills = new Set(bills.filter((b) => b.status === 'voided').map((b) => b.id));
  const voidedPurchases = new Set(purchaseBills.filter((b) => b.status === 'voided').map((b) => b.id));
  const opening = Number(items.find((i) => i.id === itemId)?.openingStock) || 0;
  const sum = (rows) => rows.reduce((s, x) => s + (Number(x.qty) || 0), 0);
  const bought = receivedQty(purchases.filter((p) => p.itemId === itemId && !voidedPurchases.has(p.purchaseBillId)));
  const sentBack = sum(supplierReturns.filter((r) => r.itemId === itemId));
  const sold = sum(billItems.filter((l) => l.itemId === itemId && !voidedBills.has(l.billId)));
  const restocked = sum(returns.filter((r) => r.itemId === itemId && r.restock));
  const lost = sum(stockLoss.filter((l) => l.itemId === itemId));
  const shop = shopWarehouseFlow(itemId, { whMoves, whMoveLines });
  return r2(opening + bought - sold + restocked - lost - sentBack + shop.in - shop.out);
}

/** Bought quantity that has actually arrived: goods still with the supplier cannot be sold. */
function receivedQty(rows) {
  return rows.reduce((s, p) => s + lineReceived(p), 0);
}

/** Quantity moved between the shop and the warehouses, for one item. */
function shopWarehouseFlow(itemId, { whMoves = [], whMoveLines = [] }) {
  const live = new Map(whMoves.filter((m) => m.status !== 'voided').map((m) => [m.id, m]));
  let inQ = 0;
  let outQ = 0;
  whMoveLines.forEach((l) => {
    if (l.itemId !== itemId) return;
    const m = live.get(l.moveId);
    if (!m) return;
    if (m.type === 'to-shop') inQ += Number(l.qty) || 0;
    if (m.type === 'from-shop') outQ += Number(l.qty) || 0;
  });
  return { in: inQ, out: outQ };
}

export function lineProfit(line) {
  const q = Number(line.qty) || 0;
  return r2((Number(line.price) || 0) * q - (Number(line.costPriceAtSale) || 0) * q);
}

export function grossProfit(billItems = [], bills = []) {
  const voided = new Set(bills.filter((b) => b.status === 'voided').map((b) => b.id));
  return r2(billItems.filter((l) => !voided.has(l.billId)).reduce((s, l) => s + lineProfit(l), 0));
}

export function stockValue(items = [], data = {}) {
  return r2(items.reduce((s, i) => s + itemStock(i.id, data) * (Number(i.costPrice) || 0), 0));
}

/* --------------------------------------------------------------- Accounts */

/** Methods the system writes itself; no money arrives through either. */
export const SYSTEM_METHODS = ['Advance', 'Set-off'];

/**
 * Payments that brought money into the shop: not reversed, not an opening
 * balance, not a bill paid from an advance (that money arrived when the
 * advance did) or by set-off (no money moved), and not a cheque the bank has
 * not paid.
 */
export function collectedPayments(payments = [], cheques = []) {
  const uncleared = new Set(cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId));
  return payments.filter((p) => !p.reversed && !p.isOpening && !SYSTEM_METHODS.includes(p.method) && !uncleared.has(p.id));
}

/**
 * A quick purchase is paid on the spot from the method it names. Lines of a
 * supplier purchase bill are paid through supplier payments instead.
 */
function paidPurchases(purchases = []) {
  return purchases
    .filter((p) => !p.purchaseBillId && p.method)
    .map((p) => ({ ...p, amount: r2((Number(p.qty) || 0) * (Number(p.costPrice) || 0)) }));
}

/** Expenses paid in money. A stock loss is goods written off; no cash left. */
function paidExpenses(expenses = []) {
  return expenses.filter((e) => !e.linkedStockLossId);
}

/** Money in and out of each payment method (Cash, JazzCash, bank…). */
export function methodBalances(methods = [], {
  payments = [], expenses = [], employeeTx = [], cheques = [], supplierPayments = [], whExpenses = [], purchases = [],
  whPartyPayments = [],
} = {}) {
  const uncleared = new Set(cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId));
  const sum = (rows) => rows.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const bought = paidPurchases(purchases);
  const spent = paidExpenses(expenses);
  return methods.map((m) => {
    const inflow = sum(payments.filter((p) => p.method === m && !p.reversed && !uncleared.has(p.id))) +
      sum(whPartyPayments.filter((p) => p.direction === 'received' && (p.method || 'Cash') === m));
    const out =
      sum(spent.filter((e) => (e.method || 'Cash') === m)) +
      sum(employeeTx.filter((t) => (t.method || 'Cash') === m && t.type !== 'bonus_accrual')) +
      sum(supplierPayments.filter((p) => (p.method || 'Cash') === m)) +
      sum(whExpenses.filter((e) => (e.method || 'Cash') === m)) +
      sum(whPartyPayments.filter((p) => p.direction === 'paid' && (p.method || 'Cash') === m)) +
      sum(bought.filter((p) => p.method === m));
    return { method: m, in: r2(inflow), out: r2(out), balance: r2(inflow - out) };
  });
}

/** Every movement through one payment method, with a running balance. */
export function methodLedger(method, {
  payments = [], expenses: allExpenses = [], employeeTx = [], cheques = [], parties = [], employees = [],
  supplierPayments = [], suppliers = [], whExpenses = [], warehouses = [], purchases = [], items = [],
  whPartyPayments = [], whParties = [],
} = {}) {
  const expenses = paidExpenses(allExpenses);
  const uncleared = new Set(cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId));
  const partyName = (id) => parties.find((p) => p.id === id)?.name || 'Unknown party';
  const empName = (id) => employees.find((e) => e.id === id)?.name || 'Employee';
  const supName = (id) => suppliers.find((s) => s.id === id)?.name || 'Supplier';
  const whName = (id) => warehouses.find((w) => w.id === id)?.name || 'Warehouse';
  const rows = [];
  payments
    .filter((p) => p.method === method && !p.reversed && !uncleared.has(p.id))
    .forEach((p) => rows.push({
      id: p.id, date: p.date, direction: 'in', amount: r2(p.amount),
      desc: p.isOpening ? p.note || 'Opening balance'
        : p.isAdvance ? `Advance from ${partyName(p.partyId)}` : `Payment from ${partyName(p.partyId)}`,
      relatedType: p.isOpening ? 'opening' : 'payment', relatedId: p.billId,
    }));
  expenses
    .filter((e) => (e.method || 'Cash') === method)
    .forEach((e) => rows.push({
      id: e.id, date: e.date, direction: 'out', amount: r2(e.amount),
      desc: `${e.category}${e.note ? ` — ${e.note}` : ''}`, relatedType: 'expense', relatedId: e.id,
    }));
  employeeTx
    .filter((t) => (t.method || 'Cash') === method)
    .forEach((t) => rows.push({
      id: t.id, date: t.date, direction: 'out', amount: r2(t.amount),
      desc: `${t.type === 'salary' ? 'Salary' : t.type === 'advance' ? 'Advance' : 'Bonus'} — ${empName(t.employeeId)}`,
      relatedType: 'salary', relatedId: t.employeeId,
    }));
  supplierPayments
    .filter((p) => (p.method || 'Cash') === method)
    .forEach((p) => rows.push({
      id: p.id, date: p.date, direction: 'out', amount: r2(p.amount),
      desc: `${p.isAdvance ? 'Advance to supplier' : 'Paid to supplier'} ${supName(p.supplierId)}${p.note ? ` — ${p.note}` : ''}`,
      relatedType: 'supplier', relatedId: p.supplierId,
    }));
  whExpenses
    .filter((e) => (e.method || 'Cash') === method)
    .forEach((e) => rows.push({
      id: e.id, date: e.date, direction: 'out', amount: r2(e.amount),
      desc: `Warehouse ${whName(e.warehouseId)} — ${e.category}${e.note ? ` — ${e.note}` : ''}`,
      relatedType: 'warehouse', relatedId: e.warehouseId,
    }));
  whPartyPayments
    .filter((p) => (p.method || 'Cash') === method)
    .forEach((p) => rows.push({
      id: p.id, date: p.date, direction: p.direction === 'paid' ? 'out' : 'in', amount: r2(p.amount),
      desc: `${p.direction === 'paid' ? 'Paid to' : 'Received from'} ${whParties.find((x) => x.id === p.partyId)?.name || 'warehouse party'} (warehouse)${p.note ? ` — ${p.note}` : ''}`,
      relatedType: 'whParty', relatedId: p.partyId,
    }));
  paidPurchases(purchases)
    .filter((p) => p.method === method)
    .forEach((p) => rows.push({
      id: p.id, date: p.date, direction: 'out', amount: p.amount,
      desc: `Purchase — ${items.find((i) => i.id === p.itemId)?.name || 'Item'} × ${p.qty}${p.supplierName ? ` from ${p.supplierName}` : ''}`,
      relatedType: 'purchase', relatedId: p.id,
    }));
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.id).localeCompare(String(b.id)));
  let bal = 0;
  return rows.map((r) => {
    bal = r2(bal + (r.direction === 'in' ? r.amount : -r.amount));
    return { ...r, runningBalance: bal };
  });
}

/** Salary paid this month against the monthly salary. Bonuses are extra. */
export function salaryStatus(employee, employeeTx = [], when = null) {
  const d = when ? new Date(when) : new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const paid = employeeTx
    .filter((t) => {
      if (t.employeeId !== employee.id || t.type === 'bonus') return false;
      const td = new Date(t.date);
      return td.getFullYear() === y && td.getMonth() === m;
    })
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const salary = Number(employee.monthlySalary) || 0;
  return { salary, paid: r2(paid), remaining: r2(Math.max(0, salary - paid)) };
}

export function balanceSheet(data) {
  const { items = [], assets = [], parties = [], employees = [], employeeTx = [], methods = [], bills = [] } = data;
  const balances = methodBalances(methods, data);
  const cash = r2(balances.reduce((s, b) => s + b.balance, 0));
  const states = billStates(bills, data);
  const receivable = r2(parties.reduce((s, p) => s + partyDue(p.id, states), 0));
  const stock = stockValue(items, data);
  const whStock = warehouseStockValue(data);
  const assetValue = r2(assets.reduce((s, a) => s + (Number(a.value) || 0), 0));
  const unpaidSalaries = r2(employees.filter((e) => e.status !== 'archived')
    .reduce((s, e) => s + salaryStatus(e, employeeTx).remaining, 0));
  const supBalances = (data.suppliers || []).map((s) => supplierBalance(s.id, data));
  const payable = r2(supBalances.reduce((s, b) => s + Math.max(0, b), 0));
  const supplierAdvances = r2(supBalances.reduce((s, b) => s + Math.max(0, -b), 0));
  // An advance a customer has paid is already in the cash above, but it is
  // still theirs until a bill uses it — the shop owes it back.
  const customerAdvances = r2((data.partyAdvances || [])
    .reduce((s, a) => s + Math.max(0, (Number(a.amount) || 0) - (Number(a.applied) || 0)), 0));
  // Warehouse parties' khatas: above zero they owe us, below zero we owe them.
  const whBalances = [...whPartySummaries(data).values()].map((x) => x.balance);
  const whReceivable = r2(whBalances.reduce((t, b) => t + Math.max(0, b), 0));
  const whPayable = r2(whBalances.reduce((t, b) => t + Math.max(0, -b), 0));
  const owns = [
    { label: 'Cash & Bank Balances', value: cash },
    { label: 'Stock Value (at cost)', value: stock },
    ...(whStock ? [{ label: 'Warehouse Stock (at cost)', value: whStock }] : []),
    { label: 'Receivables (party dues)', value: receivable },
    { label: 'Advances paid to suppliers', value: supplierAdvances },
    ...(whReceivable ? [{ label: 'Warehouse parties owe us', value: whReceivable }] : []),
    { label: 'Assets', value: assetValue },
  ];
  const owes = [
    { label: 'Payables (supplier dues)', value: payable },
    ...(whPayable ? [{ label: 'Warehouse party dues', value: whPayable }] : []),
    { label: 'Customer advances held', value: customerAdvances },
    { label: 'Unpaid Salaries (this month)', value: unpaidSalaries },
  ];
  const totalOwns = r2(owns.reduce((s, x) => s + x.value, 0));
  const totalOwes = r2(owes.reduce((s, x) => s + x.value, 0));
  return { owns, owes, totalOwns, totalOwes, net: r2(totalOwns - totalOwes), balances };
}

export function periodSummary(data, from, to) {
  const { bills = [], payments = [], expenses = [], billItems = [], employeeTx = [], cheques = [] } = data;
  const within = (d) => {
    const x = new Date(d);
    return (!from || x >= new Date(from)) && (!to || x <= new Date(to + 'T23:59:59'));
  };
  const live = bills.filter((b) => b.status !== 'voided' && within(b.date));
  const states = billStates(live, data);
  const ids = new Set(live.map((b) => b.id));
  const sales = r2(states.reduce((s, b) => s + b.net, 0));
  const collections = r2(collectedPayments(payments, cheques).filter((p) => within(p.date))
    .reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const exp = r2(expenses.filter((e) => within(e.date)).reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const salaries = r2(employeeTx.filter((t) => within(t.date)).reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const gross = grossProfit(billItems.filter((l) => ids.has(l.billId)), bills);
  const outstanding = r2(states.reduce((s, b) => s + b.due, 0));
  return {
    sales, collections, expenses: exp, salaries, grossProfit: gross,
    netProfit: r2(gross - exp - salaries), outstanding, billCount: live.length,
  };
}

/** One combined day-book of sales, receipts and returns. */
export function ledgerBook(data, partyId = null, from = null, to = null) {
  const { bills = [], payments: allPayments = [], parties = [], returns = [], cheques = [] } = data;
  // What reduces a party's balance, as on their own statement: an advance
  // counts when a bill uses it, not when it arrives, and a cheque counts once
  // the bank pays it.
  const uncleared = new Set(cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId));
  const payments = allPayments.filter((p) => !p.isAdvance && !uncleared.has(p.id));
  const within = (d) => {
    const x = new Date(d);
    return (!from || x >= new Date(from)) && (!to || x <= new Date(to + 'T23:59:59'));
  };
  const nameOf = (id) => parties.find((p) => p.id === id)?.name || 'Unknown';
  const rows = [];
  bills
    .filter((b) => b.status !== 'voided' && (!partyId || b.partyId === partyId) && within(b.date))
    .forEach((b) => rows.push({
      date: b.date, ref: b.billNo, party: nameOf(b.partyId), partyId: b.partyId,
      desc: `Sale — Bill ${b.billNo}`, debit: r2(b.totalAmount), credit: 0,
    }));
  payments
    .filter((p) => !p.reversed && !p.isOpening && (!partyId || p.partyId === partyId) && within(p.date))
    .forEach((p) => rows.push({
      date: p.date, ref: p.method, party: nameOf(p.partyId), partyId: p.partyId,
      desc: `Payment received — ${p.method}`, debit: 0, credit: r2(p.amount),
    }));
  returns.filter((r) => within(r.date)).forEach((r) => {
    const b = bills.find((x) => x.id === r.billId);
    if (!b || (partyId && b.partyId !== partyId)) return;
    rows.push({
      date: r.date, ref: b.billNo, party: nameOf(b.partyId), partyId: b.partyId,
      desc: `Return against Bill ${b.billNo}`, debit: 0, credit: r2(r.valueAdjusted),
    });
  });
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  let bal = 0;
  return rows.map((r) => {
    bal = r2(bal + r.debit - r.credit);
    return { ...r, balance: bal };
  });
}

/* ---------------------------------------------------------- Party ledger */

/** Which advance row a receipt belongs to — matched on amount, then day. */
function matchAdvance(payment, advances = [], used = new Set()) {
  const mine = advances.filter((a) => a.partyId === payment.partyId);
  if (!mine.length) return null;
  const free = mine.filter((a) => !used.has(a.id));
  const pool = free.length ? free : mine;
  const same = pool.filter((a) => r2(a.amount) === r2(payment.amount));
  if (same.length === 1) return same[0].id;
  if (same.length > 1) return (same.find((a) => dayOf(a.dateReceived) === dayOf(payment.date)) || same[0]).id;
  return (pool.find((a) => dayOf(a.dateReceived) === dayOf(payment.date)) || pool[0]).id;
}

/** Creation time encoded in an id (`pay_<time><5 random>`), or NaN. */
function idTime(id) {
  const m = /^[a-z]+_([0-9a-z]+)$/.exec(String(id || ''));
  return !m || m[1].length <= 5 ? NaN : parseInt(m[1].slice(0, -5), 36);
}

/**
 * Payments that are parts of one receipt. New ones share a groupId; older
 * account payments are recognised by being written within two seconds of each
 * other on the same day, method and note, each against a different bill.
 */
function paymentGroups(payments) {
  const keyOf = new Map();
  const groups = new Map();
  const add = (k, id) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  };
  const legacy = [];
  for (const p of payments) {
    if (p.groupId) add(`g:${p.groupId}`, p.id);
    else if (p.billId && !p.isAdvance && Number.isFinite(idTime(p.id))) legacy.push(p);
  }
  legacy.sort((a, b) => idTime(a.id) - idTime(b.id));
  let run = [];
  const flush = () => {
    if (run.length > 1) run.forEach((p) => add(`t:${run[0].id}`, p.id));
    run = [];
  };
  for (const p of legacy) {
    const last = run[run.length - 1];
    const joins = last && p.date === last.date && p.method === last.method &&
      String(p.note || '') === String(last.note || '') &&
      !run.some((x) => x.billId === p.billId) && idTime(p.id) - idTime(last.id) <= 2000;
    if (!joins) flush();
    run.push(p);
  }
  flush();
  for (const [k, ids] of groups) if (ids.length > 1) ids.forEach((id) => keyOf.set(id, k));
  return keyOf;
}

/** Fold the parts of one grouped receipt into a single ledger line. */
function collapseGroups(rows) {
  const parts = new Map();
  const out = [];
  const seenInfo = new Set();
  for (const r of rows) {
    if (r.groupKey && r.paymentId && !r.isAdvance) {
      const k = `${r.groupKey}|${r.type}|${r.struck ? 1 : 0}|${r.date}`;
      if (!parts.has(k)) {
        parts.set(k, []);
        out.push({ __group: k });
      }
      parts.get(k).push(r);
      continue;
    }
    if (r.groupKey && r.info) {
      const k = `${r.groupKey}|${r.title}|${r.date}`;
      if (seenInfo.has(k)) continue;
      seenInfo.add(k);
    }
    out.push(r);
  }
  return out.map((r) => {
    if (!r.__group) return r;
    const g = parts.get(r.__group);
    if (g.length === 1) return g[0];
    const first = g[0];
    const total = r2(g.reduce((s, x) => s + (x.originalAmount || 0), 0));
    const split = g.map((x) => `Bill ${x.billNo || '?'}: ${rs(x.originalAmount)}`);
    const notes = [...new Set(g.map((x) => x.noteText).filter(Boolean))];
    return {
      id: `grp-${g[0].id}`, date: first.date, type: first.type, title: first.title,
      detail: [split.join(', ') + ` = ${rs(total)}`, first.chequeText, ...notes].filter(Boolean).join(' · '),
      method: first.method, ref: first.ref, debit: 0,
      credit: r2(g.reduce((s, x) => s + (x.credit || 0), 0)),
      pending: r2(g.reduce((s, x) => s + (x.pending || 0), 0)),
      originalAmount: total, struck: first.struck, reversed: g.every((x) => x.reversed),
      paymentId: null, chequeId: null, billId: null, parts: g,
    };
  });
}

/** A party's statement: bills, payments, returns, cheques, with a running balance. */
export function partyLedger(partyId, data = {}, from = null, to = null) {
  const {
    bills = [], payments = [], returns = [], billItems = [], items = [], cheques = [], partyAdvances = [],
  } = data;
  const within = (d) => inRange(d, from, to);
  const itemName = (id) => items.find((i) => i.id === id)?.name || 'Item';
  const usedAdvances = new Set();
  const advanceFor = (p) => {
    const id = matchAdvance(p, partyAdvances, usedAdvances);
    if (id) usedAdvances.add(id);
    return id;
  };
  const mine = bills.filter((b) => b.partyId === partyId);
  const billById = new Map(mine.map((b) => [b.id, b]));
  const rows = [];

  mine.forEach((b) => {
    if (!within(b.date)) return;
    const lines = billItems.filter((l) => l.billId === b.id);
    const detail = lines.length
      ? lines.map((l) => `${itemName(l.itemId)} ${l.qty}${l.unit ? ' ' + l.unit : ''}`).join(', ')
      : '';
    if (b.status === 'voided') {
      rows.push({
        id: `bill-${b.id}`, date: b.date, type: 'void', billId: b.id, ref: b.billNo,
        title: `Bill ${b.billNo} — VOIDED`, detail: b.voidReason || 'Cancelled', method: '',
        debit: 0, credit: 0, voided: true,
      });
      return;
    }
    rows.push({
      id: `bill-${b.id}`, date: b.date, type: 'bill', billId: b.id, ref: b.billNo,
      title: `Bill ${b.billNo}`, detail, method: '', debit: r2(b.totalAmount), credit: 0,
    });
  });

  const partyPays = payments.filter((p) => p.partyId === partyId && !p.isOpening);
  const groups = paymentGroups(partyPays);
  partyPays.forEach((p) => {
    const bill = p.billId ? billById.get(p.billId) : null;
    const chq = cheques.find((c) => c.paymentId === p.id);
    let detail = bill ? `Against Bill ${bill.billNo}` : 'On account';
    if (p.isAdvance) detail = 'Advance received (not against a bill)';
    if (chq) {
      detail += ` · Cheque ${chq.chequeNo || ''}${chq.bankName ? ' / ' + chq.bankName : ''}`.trimEnd();
      if (chq.accountHolder) detail += ` (A/c ${chq.accountHolder})`;
      if (chq.status === 'pending') detail += chq.dateDue ? ` — clears ${fmtDate(chq.dateDue)}` : ' — awaiting clearance';
      if (chq.status === 'cleared' && chq.statusChangedAt) detail += ` — cleared ${fmtDate(chq.statusChangedAt)}`;
      if (chq.status === 'bounced') detail += chq.statusChangedAt ? ` — BOUNCED ${fmtDate(chq.statusChangedAt)}` : ' — BOUNCED';
    }
    if (p.note) detail += ` · ${p.note}`;
    const bounced = chq && chq.status === 'bounced';
    const waiting = chq && chq.status !== 'cleared' && !bounced;
    if (within(p.date)) {
      rows.push({
        id: `pay-${p.id}`, date: p.date,
        type: waiting ? 'cheque-pending' : p.isAdvance ? 'advance' : 'payment',
        paymentId: p.id, chequeId: chq ? chq.id : null, isAdvance: !!p.isAdvance,
        advanceId: p.isAdvance ? advanceFor(p) : null, reversed: !!p.reversed,
        billId: p.billId || null, ref: p.method,
        title: waiting ? `Cheque received — ${chq.bankName || p.method}`
          : p.isAdvance ? 'Advance received' : `Payment — ${p.method}`,
        detail, method: p.method, debit: 0,
        credit: p.reversed || bounced || waiting || p.isAdvance ? 0 : r2(p.amount),
        struck: !!(p.reversed || bounced),
        pending: waiting ? r2(p.amount) : 0,
        originalAmount: r2(p.amount),
        groupKey: groups.get(p.id) || null,
        billNo: bill ? bill.billNo : '',
        chequeText: chq ? `Cheque ${chq.chequeNo || ''}${chq.bankName ? ' / ' + chq.bankName : ''}`.trimEnd() : '',
        noteText: p.note || '',
      });
    }
    if (p.reversed && within(p.reversedAt || p.date)) {
      rows.push({
        id: `rev-${p.id}`, date: (p.reversedAt || p.date).slice(0, 10), type: 'reversal',
        billId: p.billId || null, ref: p.method, title: `Payment reversed — ${p.method}`,
        detail: p.reverseReason || 'Entered in error', method: p.method, debit: 0, credit: 0, info: true,
      });
    }
    if (chq && chq.status === 'cleared' && chq.statusChangedAt &&
        chq.statusChangedAt.slice(0, 10) !== p.date && within(chq.statusChangedAt)) {
      rows.push({
        id: `clr-${p.id}`, date: chq.statusChangedAt.slice(0, 10), type: 'info', billId: p.billId || null,
        ref: chq.chequeNo || p.method, title: `Cheque cleared — ${chq.bankName || p.method}`,
        detail: `Cheque ${chq.chequeNo || ''} cleared the bank`.trim(), method: p.method,
        debit: 0, credit: 0, info: true, groupKey: groups.get(p.id) || null,
      });
    }
    if (bounced && within(chq.statusChangedAt || p.date)) {
      rows.push({
        id: `bnc-${p.id}`, date: (chq.statusChangedAt || p.date).slice(0, 10), type: 'bounced',
        billId: p.billId || null, ref: chq.chequeNo || p.method,
        title: `Cheque bounced — ${chq.bankName || p.method}`,
        detail: `Cheque ${chq.chequeNo || ''} returned unpaid, amount reopened`.trim(), method: p.method,
        debit: 0, credit: 0, info: true, groupKey: groups.get(p.id) || null,
      });
    }
  });

  returns.forEach((r) => {
    const b = billById.get(r.billId);
    if (!b || !within(r.date)) return;
    rows.push({
      id: `ret-${r.id}`, date: r.date, type: 'return', billId: r.billId, ref: b.billNo,
      title: `Return against Bill ${b.billNo}`,
      detail: `${itemName(r.itemId)} × ${r.qty}${r.restock ? ' (restocked)' : ''}${r.note ? ' · ' + r.note : ''}`,
      method: '', debit: 0, credit: r2(r.valueAdjusted),
    });
  });

  partyAdvances.filter((a) => a.partyId === partyId && Number(a.applied) > 0).forEach((a) => {
    if (!within(a.dateReceived)) return;
    rows.push({
      id: `advapp-${a.id}`, date: a.dateReceived, type: 'info', ref: '',
      title: 'Advance applied to billing',
      detail: `${rs(a.applied)} of the ${rs(a.amount)} advance has been used`,
      method: a.method || '', debit: 0, credit: 0, info: true,
    });
  });

  const folded = collapseGroups(rows);
  const order = { bill: 0, payment: 1, advance: 1, 'cheque-pending': 1, return: 2, reversal: 3, bounced: 3, void: 4, info: 5 };
  folded.sort((a, b) => new Date(a.date) - new Date(b.date) ||
    (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.id).localeCompare(String(b.id)));
  let bal = 0;
  return folded.map((r) => {
    bal = r2(bal + r.debit - r.credit);
    return { ...r, balance: bal };
  });
}

/* -------------------------------------------------------------- Suppliers */

/** What the shop owes a supplier. Below zero is an advance they hold. */
export function supplierBalance(supplierId, { suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [] } = {}) {
  const opening = Number(suppliers.find((s) => s.id === supplierId)?.openingBalance) || 0;
  const bought = purchaseBills.filter((b) => b.supplierId === supplierId && b.status !== 'voided')
    .reduce((s, b) => s + (Number(b.totalAmount) || 0), 0);
  const paid = supplierPayments.filter((p) => p.supplierId === supplierId).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const returned = supplierReturns.filter((r) => r.supplierId === supplierId).reduce((s, r) => s + (Number(r.value) || 0), 0);
  return r2(opening + bought - paid - returned);
}

/** Each purchase bill of a supplier with what is still owed on it. */
export function supplierBillStates(supplierId, { suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [] } = {}) {
  const mine = purchaseBills.filter((b) => b.supplierId === supplierId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.purchaseNo).localeCompare(String(b.purchaseNo)));
  const left = new Map();
  mine.forEach((b) => left.set(b.id, b.status === 'voided' ? 0 : r2(b.totalAmount)));
  const paid = new Map(mine.map((b) => [b.id, 0]));
  const returned = new Map(mine.map((b) => [b.id, 0]));
  let spare = 0;
  const apply = (billId, amount) => {
    const owed = left.get(billId) || 0;
    const use = r2(Math.min(owed, amount));
    left.set(billId, r2(owed - use));
    paid.set(billId, r2(paid.get(billId) + use));
    return r2(amount - use);
  };
  supplierPayments.filter((p) => p.supplierId === supplierId).forEach((p) => {
    const amt = r2(p.amount);
    spare = r2(spare + (p.purchaseBillId && left.has(p.purchaseBillId) ? apply(p.purchaseBillId, amt) : amt));
  });
  supplierReturns.filter((r) => r.supplierId === supplierId).forEach((r) => {
    const v = r2(r.value);
    if (r.purchaseBillId && returned.has(r.purchaseBillId)) {
      returned.set(r.purchaseBillId, r2(returned.get(r.purchaseBillId) + v));
      spare = r2(spare + apply(r.purchaseBillId, v));
    } else spare = r2(spare + v);
  });
  const opening = Number(suppliers.find((s) => s.id === supplierId)?.openingBalance) || 0;
  spare = opening < 0 ? r2(spare - opening) : r2(spare - Math.min(spare, opening));
  for (const b of mine) {
    if (spare <= 0.004) break;
    spare = apply(b.id, spare);
  }
  return mine.map((b) => {
    const total = r2(b.totalAmount);
    const due = b.status === 'voided' ? 0 : r2(left.get(b.id));
    let status;
    if (b.status === 'voided') status = 'voided';
    else if (due <= 0.004) status = 'paid';
    else if (due < total - 0.004) status = 'partial';
    else status = 'due';
    return { ...b, total, due, status, paid: r2(paid.get(b.id) - returned.get(b.id)), returned: r2(returned.get(b.id)) };
  }).reverse();
}

export function purchaseLines(purchaseBillId, { purchases = [] } = {}) {
  return purchases.filter((p) => p.purchaseBillId === purchaseBillId);
}

export function supplierLedger(supplierId, data = {}, from = null, to = null) {
  const { suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [], purchases = [], items = [] } = data;
  const sup = suppliers.find((s) => s.id === supplierId);
  const itemName = (id) => items.find((i) => i.id === id)?.name || 'Item';
  const billById = new Map(purchaseBills.map((b) => [b.id, b]));
  const rows = [];
  const opening = r2(sup?.openingBalance);
  if (opening) {
    rows.push({
      id: `open-${supplierId}`, date: dayOf(sup.createdAt) || '0000-01-01', type: 'opening',
      title: 'Opening balance',
      detail: opening > 0 ? 'Owed before this record began' : 'Advance before this record began',
      debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0,
    });
  }
  purchaseBills.filter((b) => b.supplierId === supplierId).forEach((b) => {
    const lines = purchases.filter((p) => p.purchaseBillId === b.id)
      .map((p) => `${itemName(p.itemId)} ${p.qty} @ ${rs(p.costPrice)}`).join(', ');
    const ref = b.invoiceNo ? `${b.purchaseNo} · Inv ${b.invoiceNo}` : b.purchaseNo;
    rows.push(b.status === 'voided'
      ? { id: `pb-${b.id}`, date: b.date, type: 'void', purchaseBillId: b.id, title: `Purchase ${ref} — CANCELLED`, detail: b.voidReason || lines, debit: 0, credit: 0, voided: true }
      : { id: `pb-${b.id}`, date: b.date, type: 'purchase', purchaseBillId: b.id, title: `Purchase ${ref}`, detail: [lines, b.note].filter(Boolean).join(' · '), debit: r2(b.totalAmount), credit: 0 });
  });
  supplierPayments.filter((p) => p.supplierId === supplierId).forEach((p) => {
    const b = p.purchaseBillId ? billById.get(p.purchaseBillId) : null;
    rows.push({
      id: `sp-${p.id}`, date: p.date, type: 'payment', paymentId: p.id,
      title: p.isAdvance ? `Advance given — ${p.method}` : `Paid — ${p.method}`,
      detail: [p.isAdvance ? 'Advance to supplier' : b ? `Against purchase ${b.purchaseNo}` : 'On account', p.note].filter(Boolean).join(' · '),
      isAdvance: !!p.isAdvance, method: p.method, debit: 0, credit: r2(p.amount),
    });
  });
  supplierReturns.filter((r) => r.supplierId === supplierId).forEach((r) => {
    const b = r.purchaseBillId ? billById.get(r.purchaseBillId) : null;
    rows.push({
      id: `sr-${r.id}`, date: r.date, type: 'return', returnId: r.id,
      title: b ? `Returned to supplier — purchase ${b.purchaseNo}` : 'Returned to supplier',
      detail: `${itemName(r.itemId)} × ${r.qty}${r.note ? ` · ${r.note}` : ''}`, debit: 0, credit: r2(r.value),
    });
  });
  const order = { opening: 0, purchase: 1, void: 1, payment: 2, return: 3 };
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
    (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.id).localeCompare(String(b.id)));
  let bal = 0;
  return rows
    .map((r) => {
      bal = r2(bal + r.debit - r.credit);
      return { ...r, balance: bal };
    })
    .filter((r) => r.type === 'opening' || inRange(r.date, from, to));
}

export function supplierForParty(partyId, suppliers = []) {
  return suppliers.find((s) => s.partyId && s.partyId === partyId) || null;
}

/** A party who also sells to the shop: both sides of the khata in one statement. */
export function combinedPartyLedger(partyId, data = {}, from = null, to = null) {
  const sale = partyLedger(partyId, data, from, to);
  const sup = supplierForParty(partyId, data.suppliers);
  if (!sup) return sale;
  const buy = supplierLedger(sup.id, data, from, to).map((r) => {
    const { balance, paymentId, returnId, ...rest } = r;
    return {
      ...rest,
      supplierPaymentId: paymentId || null,
      supplierReturnId: returnId || null,
      side: 'purchase',
      type: r.type === 'void' ? 'void' : `sup-${r.type}`,
      title: r.type === 'purchase' ? r.title.replace(/^Purchase /, 'Bought from them — ')
        : r.type === 'payment' ? r.title.replace(/^(Paid|Advance given)/, (m) => (m === 'Paid' ? 'Paid to them' : 'Advance given to them'))
          : r.type === 'return' ? r.title.replace(/^Returned to supplier/, 'Goods returned to them')
            : r.type === 'opening' ? 'Opening balance (purchases)' : r.title,
      debit: r.credit,
      credit: r.debit,
    };
  });
  const order = {
    'sup-opening': -1, bill: 0, 'sup-purchase': 0, void: 4, payment: 1, advance: 1,
    'cheque-pending': 1, 'sup-payment': 1, return: 2, 'sup-return': 2, reversal: 3, bounced: 3, info: 5,
  };
  const all = [...sale.map(({ balance, ...r }) => r), ...buy];
  all.sort((a, b) => String(dayOf(a.date)).localeCompare(String(dayOf(b.date))) ||
    (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.id).localeCompare(String(b.id)));
  let bal = 0;
  return all.map((r) => {
    bal = r2(bal + r.debit - r.credit);
    return { ...r, balance: bal };
  });
}

/** The supplier's statement, with the party's sales side folded in when linked. */
export function combinedSupplierLedger(supplierId, data = {}, from = null, to = null) {
  const buy = supplierLedger(supplierId, data, from, to);
  const sup = (data.suppliers || []).find((s) => s.id === supplierId);
  const partyId = sup?.partyId;
  if (!partyId || !(data.parties || []).some((p) => p.id === partyId)) return buy;
  const sale = partyLedger(partyId, data, from, to).map((r) => {
    const { balance, ...rest } = r;
    return {
      ...rest, side: 'sale', type: `sale-${r.type}`, debit: r.credit, credit: r.debit,
      pendingSide: r.pending > 0 ? 'debit' : undefined,
    };
  });
  const order = {
    opening: -1, purchase: 0, 'sale-bill': 0, void: 4, 'sale-void': 4, payment: 1, 'sale-payment': 1,
    'sale-advance': 1, 'sale-cheque-pending': 1, return: 2, 'sale-return': 2, 'sale-reversal': 3,
    'sale-bounced': 3, 'sale-info': 5,
  };
  const all = [...buy.map(({ balance, ...r }) => ({ ...r, side: 'purchase' })), ...sale];
  all.sort((a, b) => String(dayOf(a.date)).localeCompare(String(dayOf(b.date))) ||
    (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.id).localeCompare(String(b.id)));
  let bal = 0;
  return all.map((r) => {
    bal = r2(bal + r.debit - r.credit);
    return { ...r, balance: bal };
  });
}

export const LEDGER_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sales', label: 'Sales' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'received', label: 'Received' },
  { value: 'paid', label: 'Paid' },
  { value: 'returns', label: 'Returns' },
  { value: 'cheques', label: 'Cheques' },
];

function ledgerKind(row, { supplierView = false } = {}) {
  const t = String(row?.type || '');
  const buying = row?.side === 'purchase' || t.startsWith('sup-') || (supplierView && row?.side !== 'sale');
  const base = t.replace(/^(sup|sale)-/, '');
  if (base === 'opening') return 'other';
  if (buying) {
    if (base === 'purchase' || base === 'void') return 'purchases';
    if (base === 'payment') return 'paid';
    if (base === 'return') return 'returns';
    return 'other';
  }
  if (base === 'bill' || base === 'void') return 'sales';
  if (base === 'return') return 'returns';
  return 'received';
}

export function ledgerFilterMatch(row, filter, opts) {
  if (!filter || filter === 'all') return true;
  if (filter === 'cheques') {
    const t = String(row?.type || '');
    return !!row?.chequeId || /cheque-pending|bounced/.test(t) || (/info/.test(t) && /^Cheque/.test(row?.title || ''));
  }
  return ledgerKind(row, opts) === filter;
}

/* -------------------------------------------------------------- Warehouses */

/**
 * Movement types and how each changes the stock of the warehouse it names.
 *   in          goods received into the warehouse (from a supplier, a factory…)
 *   out         goods sent out of the warehouse to a customer or anyone else
 *   transfer    from one warehouse to another (out of warehouseId, into toWarehouseId)
 *   to-shop     sent from the warehouse to the shop — adds to the shop's stock
 *   from-shop   sent from the shop into the warehouse — takes it off the shop
 *   adjust-in   counted more than the books say
 *   adjust-out  damaged, expired, lost or counted short
 */
export const MOVE_TYPES = {
  in: { label: 'Stock In', short: 'In', prefix: 'GRN', sign: 1, tone: 'paid' },
  out: { label: 'Stock Out', short: 'Out', prefix: 'GDN', sign: -1, tone: 'due' },
  transfer: { label: 'Transfer', short: 'Transfer', prefix: 'TRF', sign: -1, tone: 'partial' },
  'to-shop': { label: 'Sent to Shop', short: 'To shop', prefix: 'TSH', sign: -1, tone: 'partial' },
  'from-shop': { label: 'From Shop', short: 'From shop', prefix: 'FSH', sign: 1, tone: 'paid' },
  'adjust-in': { label: 'Adjustment (+)', short: 'Adjust +', prefix: 'ADJ', sign: 1, tone: 'cleared' },
  'adjust-out': { label: 'Adjustment (−)', short: 'Adjust −', prefix: 'ADJ', sign: -1, tone: 'bounced' },
};

/** Signed quantity a movement line puts into (or takes out of) one warehouse. */
export function moveEffect(move, warehouseId) {
  if (!move || move.status === 'voided') return 0;
  if (move.type === 'transfer') {
    if (move.toWarehouseId === warehouseId) return 1;
    if (move.warehouseId === warehouseId) return -1;
    return 0;
  }
  if (move.warehouseId !== warehouseId) return 0;
  return MOVE_TYPES[move.type]?.sign || 0;
}

/**
 * Stock of every item in every warehouse, in one pass:
 * Map<warehouseId, Map<itemId, qty>>.
 */
export function warehouseStockMap({ warehouses = [], whMoves = [], whMoveLines = [] } = {}) {
  const out = new Map(warehouses.map((w) => [w.id, new Map()]));
  const moves = new Map(whMoves.map((m) => [m.id, m]));
  const bump = (wid, itemId, q) => {
    if (!wid) return;
    if (!out.has(wid)) out.set(wid, new Map());
    const m = out.get(wid);
    m.set(itemId, r2((m.get(itemId) || 0) + q));
  };
  whMoveLines.forEach((l) => {
    const m = moves.get(l.moveId);
    if (!m || m.status === 'voided') return;
    const q = Number(l.qty) || 0;
    if (m.type === 'transfer') {
      bump(m.warehouseId, l.itemId, -q);
      bump(m.toWarehouseId, l.itemId, q);
    } else {
      bump(m.warehouseId, l.itemId, (MOVE_TYPES[m.type]?.sign || 0) * q);
    }
  });
  return out;
}

export function warehouseItemStock(warehouseId, itemId, data) {
  return warehouseStockMap(data).get(warehouseId)?.get(itemId) || 0;
}

/** Cost value of everything held in one warehouse (or all when id is null). */
export function warehouseStockValue(data = {}, warehouseId = null) {
  const { items = [] } = data;
  if (!(data.whMoveLines || []).length) return 0;
  const map = warehouseStockMap(data);
  const cost = new Map(items.map((i) => [i.id, Number(i.costPrice) || 0]));
  let total = 0;
  for (const [wid, stock] of map) {
    if (warehouseId && wid !== warehouseId) continue;
    for (const [itemId, q] of stock) total += Math.max(0, q) * (cost.get(itemId) || 0);
  }
  return r2(total);
}

/** Item-by-item card for one warehouse: every movement with a running balance. */
export function warehouseItemCard(warehouseId, itemId, data = {}, from = null, to = null) {
  const { whMoves = [], whMoveLines = [], warehouses = [] } = data;
  const moves = new Map(whMoves.map((m) => [m.id, m]));
  const whName = (id) => warehouses.find((w) => w.id === id)?.name || 'Warehouse';
  const rows = [];
  whMoveLines.forEach((l) => {
    if (l.itemId !== itemId) return;
    const m = moves.get(l.moveId);
    const sign = moveEffect(m, warehouseId);
    if (!sign) return;
    const q = Number(l.qty) || 0;
    let party = m.partyName || '';
    if (m.type === 'transfer') party = sign > 0 ? `From ${whName(m.warehouseId)}` : `To ${whName(m.toWarehouseId)}`;
    if (m.type === 'to-shop') party = 'To shop';
    if (m.type === 'from-shop') party = 'From shop';
    rows.push({
      id: l.id, moveId: m.id, date: m.date, docNo: m.docNo, type: m.type, party,
      inQty: sign > 0 ? q : 0, outQty: sign < 0 ? q : 0, unit: l.unit || '', note: m.note || '',
    });
  });
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.docNo).localeCompare(String(b.docNo)));
  let bal = 0;
  return rows
    .map((r) => {
      bal = r2(bal + r.inQty - r.outQty);
      return { ...r, balance: bal };
    })
    .filter((r) => inRange(r.date, from, to));
}

/** Money spent running warehouses, overall or for one. */
export function warehouseExpenseTotal(whExpenses = [], warehouseId = null, from = null, to = null) {
  return r2(whExpenses
    .filter((e) => (!warehouseId || e.warehouseId === warehouseId) && inRange(e.date, from, to))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0));
}

/* ------------------------------------------------------ Warehouse parties */

const hasRate = (l) => l.rate !== '' && l.rate !== null && l.rate !== undefined;

/**
 * A warehouse party's khata, worked out from its movements and payments. The
 * dashboard and the shared link both build it here, so the party and the shop
 * always see the same figures.
 *
 * Above zero the party owes us; below zero we owe them.
 *   goods sent to them (stock out)    debit  (+)
 *   money we paid them                debit  (+)
 *   goods received from them (in)     credit (−)
 *   money they paid us                credit (−)
 * Goods count at the rates on their lines; a line without a rate adds nothing
 * until one is filled in. A cancelled movement stays on the list, struck
 * through, at zero.
 */
export function whPartyKhata({
  openingBalance = 0, openingDate = '', moves = [], lines = [], payments = [],
  itemName = (l) => l.itemName || 'Item',
} = {}) {
  const byMove = new Map();
  lines.forEach((l) => {
    if (!byMove.has(l.moveId)) byMove.set(l.moveId, []);
    byMove.get(l.moveId).push(l);
  });
  const rows = [];
  const opening = r2(openingBalance);
  if (opening) {
    rows.push({
      id: 'opening', kind: 'opening', date: dayOf(openingDate) || '', title: 'Opening balance',
      debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0,
    });
  }
  moves.filter((m) => m.type === 'in' || m.type === 'out').forEach((m) => {
    const ls = (byMove.get(m.id) || []).map((l) => {
      const q = Number(l.qty) || 0;
      const rated = hasRate(l);
      return { ...l, name: itemName(l), rated, value: rated ? r2(q * (Number(l.rate) || 0)) : 0 };
    });
    const voided = m.status === 'voided';
    const received = m.type === 'in';
    const value = r2(ls.reduce((s, l) => s + l.value, 0));
    const units = r2(ls.reduce((s, l) => s + (Number(l.qty) || 0), 0));
    rows.push({
      id: m.id, moveId: m.id, kind: received ? 'in' : 'out', date: m.date, docNo: m.docNo, reference: m.reference || '',
      title: `${received ? 'Goods received' : 'Goods sent'} — ${m.docNo}`,
      lines: ls, units, value, voided, unrated: voided ? 0 : ls.filter((l) => !l.rated).length,
      inQty: received && !voided ? units : 0, outQty: !received && !voided ? units : 0,
      debit: !voided && !received ? value : 0, credit: !voided && received ? value : 0,
      createdAt: m.createdAt || '',
    });
  });
  payments.forEach((p) => {
    const paid = p.direction === 'paid';
    const amount = r2(p.amount);
    rows.push({
      id: p.id, paymentId: p.id, kind: paid ? 'paid' : 'received', date: p.date, method: p.method || '',
      title: paid ? 'Paid to party' : 'Received from party', note: p.note || '',
      debit: paid ? amount : 0, credit: paid ? 0 : amount, createdAt: p.createdAt || '',
    });
  });
  const rank = { opening: 0, in: 1, out: 1, paid: 2, received: 2 };
  rows.sort((a, b) => (a.kind === 'opening' ? -1 : b.kind === 'opening' ? 1 : 0)
    || String(dayOf(a.date)).localeCompare(String(dayOf(b.date)))
    || rank[a.kind] - rank[b.kind]
    || String(a.createdAt || a.docNo || '').localeCompare(String(b.createdAt || b.docNo || '')));
  let bal = 0;
  return rows.map((r) => {
    bal = r2(bal + r.debit - r.credit);
    return { ...r, balance: bal };
  });
}

/** Headline figures of a khata built by whPartyKhata(). */
export function whPartyTotals(rows = []) {
  const live = rows.filter((r) => !r.voided);
  const sum = (kind, key) => r2(live.filter((r) => r.kind === kind).reduce((s, r) => s + (r[key] || 0), 0));
  return {
    receivedQty: sum('in', 'inQty'),
    sentQty: sum('out', 'outQty'),
    receivedValue: sum('in', 'credit'),
    sentValue: sum('out', 'debit'),
    paid: sum('paid', 'debit'),
    received: sum('received', 'credit'),
    opening: r2(live.filter((r) => r.kind === 'opening').reduce((s, r) => s + r.debit - r.credit, 0)),
    unrated: live.reduce((s, r) => s + (r.unrated || 0), 0),
    moves: live.filter((r) => r.kind === 'in' || r.kind === 'out').length,
    balance: rows.length ? rows[rows.length - 1].balance : 0,
  };
}

/** One party's khata from the dashboard's data. */
export function whPartyLedger(partyId, data = {}) {
  const { whParties = [], whMoves = [], whMoveLines = [], whPartyPayments = [], items = [] } = data;
  const party = whParties.find((p) => p.id === partyId);
  const moves = whMoves.filter((m) => m.partyId === partyId);
  const ids = new Set(moves.map((m) => m.id));
  const names = new Map(items.map((i) => [i.id, i.name]));
  return whPartyKhata({
    openingBalance: Number(party?.openingBalance) || 0,
    openingDate: party?.createdAt || '',
    moves,
    lines: whMoveLines.filter((l) => ids.has(l.moveId)),
    payments: whPartyPayments.filter((p) => p.partyId === partyId),
    itemName: (l) => names.get(l.itemId) || 'Item',
  });
}

/** Every warehouse party's headline figures in one pass: Map<partyId, totals + lastDate>. */
export function whPartySummaries(data = {}) {
  const { whParties = [], whMoves = [], whMoveLines = [], whPartyPayments = [] } = data;
  const out = new Map(whParties.map((p) => {
    const opening = r2(p.openingBalance);
    return [p.id, {
      receivedQty: 0, sentQty: 0, receivedValue: 0, sentValue: 0, paid: 0, received: 0,
      opening, balance: opening, moves: 0, unrated: 0, lastDate: '',
    }];
  }));
  const partyMoves = new Map();
  whMoves.forEach((m) => {
    const s = out.get(m.partyId);
    if (!s || m.status === 'voided' || (m.type !== 'in' && m.type !== 'out')) return;
    partyMoves.set(m.id, m);
    s.moves += 1;
    if (String(dayOf(m.date)) > s.lastDate) s.lastDate = String(dayOf(m.date));
  });
  whMoveLines.forEach((l) => {
    const m = partyMoves.get(l.moveId);
    if (!m) return;
    const s = out.get(m.partyId);
    const q = Number(l.qty) || 0;
    const v = hasRate(l) ? q * (Number(l.rate) || 0) : 0;
    if (!hasRate(l)) s.unrated += 1;
    if (m.type === 'in') {
      s.receivedQty += q;
      s.receivedValue += v;
      s.balance -= v;
    } else {
      s.sentQty += q;
      s.sentValue += v;
      s.balance += v;
    }
  });
  whPartyPayments.forEach((p) => {
    const s = out.get(p.partyId);
    if (!s) return;
    const a = Number(p.amount) || 0;
    if (p.direction === 'paid') {
      s.paid += a;
      s.balance += a;
    } else {
      s.received += a;
      s.balance -= a;
    }
    if (String(dayOf(p.date)) > s.lastDate) s.lastDate = String(dayOf(p.date));
  });
  out.forEach((s) => {
    ['receivedQty', 'sentQty', 'receivedValue', 'sentValue', 'paid', 'received', 'balance'].forEach((k) => { s[k] = r2(s[k]); });
  });
  return out;
}

/** What went each way with one party, item by item, from a khata's rows. */
export function whPartyItems(rows = []) {
  const map = new Map();
  rows.filter((r) => (r.kind === 'in' || r.kind === 'out') && !r.voided).forEach((r) => {
    r.lines.forEach((l) => {
      const key = l.itemId || l.name;
      if (!map.has(key)) {
        map.set(key, { key, itemId: l.itemId || '', name: l.name, unit: l.unit || '', inQty: 0, outQty: 0, inValue: 0, outValue: 0, lastDate: '' });
      }
      const x = map.get(key);
      const q = Number(l.qty) || 0;
      if (r.kind === 'in') {
        x.inQty = r2(x.inQty + q);
        x.inValue = r2(x.inValue + l.value);
      } else {
        x.outQty = r2(x.outQty + q);
        x.outValue = r2(x.outValue + l.value);
      }
      if (String(dayOf(r.date)) > x.lastDate) x.lastDate = String(dayOf(r.date));
    });
  });
  return [...map.values()].sort((a, b) => (b.inQty + b.outQty) - (a.inQty + a.outQty) || a.name.localeCompare(b.name));
}
