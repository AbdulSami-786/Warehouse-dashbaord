// The shop and every warehouse seen together: one stock sheet, one movement
// book, one sales and one expense report. Built only from the same records the
// rest of the dashboard uses, through the same rules (calc.js).

import { r2, inRange, dayOf } from './format.js';
import {
  billStates, isOpeningBill, itemStock, lineReceived, warehouseStockMap, MOVE_TYPES, lineProfit,
} from './calc.js';

export const SHOP = 'shop';

/** Every place stock is kept: the shop first, then each active warehouse. */
export function locationsOf(data) {
  return [
    { id: SHOP, name: 'Shop', code: 'SHOP' },
    ...(data.warehouses || []).filter((w) => w.status !== 'archived').map((w) => ({ id: w.id, name: w.name, code: w.code || '' })),
  ];
}

/** Each item's quantity in every location, with the total and its cost value. */
export function stockMatrix(data) {
  const locs = locationsOf(data);
  const wh = warehouseStockMap(data);
  const rows = (data.items || []).filter((i) => i.status !== 'archived').map((item) => {
    const per = {};
    let total = 0;
    locs.forEach((l) => {
      const q = l.id === SHOP ? itemStock(item.id, data) : wh.get(l.id)?.get(item.id) || 0;
      per[l.id] = r2(q);
      total += q;
    });
    total = r2(total);
    const cost = Number(item.costPrice) || 0;
    const alert = Number(item.lowStockAlert) || 0;
    return {
      item, per, total, value: r2(Math.max(0, total) * cost),
      low: alert > 0 && total <= alert, out: total <= 0,
    };
  });
  return { locations: locs, rows };
}

const voidedSet = (rows = []) => new Set(rows.filter((x) => x.status === 'voided').map((x) => x.id));

/**
 * Every change to stock, anywhere, in one list: sales and returns at the shop,
 * purchases received, damaged stock, goods sent back to suppliers, and every
 * warehouse document. `qtyIn`/`qtyOut` are in the item's base unit.
 */
export function stockEvents(data, from = null, to = null) {
  const out = [];
  const itemName = new Map((data.items || []).map((i) => [i.id, i.name]));
  const partyName = new Map((data.parties || []).map((p) => [p.id, p.name]));
  const whName = new Map((data.warehouses || []).map((w) => [w.id, w.name]));
  const within = (d) => inRange(d, from, to);
  const push = (e) => { if (within(e.date)) out.push({ ...e, itemName: itemName.get(e.itemId) || 'Item' }); };

  const bills = new Map((data.bills || []).map((b) => [b.id, b]));
  (data.billItems || []).forEach((l) => {
    const b = bills.get(l.billId);
    if (!b || b.status === 'voided') return;
    const wh = l.warehouseId || '';
    push({ date: dayOf(b.date), location: wh || SHOP, locationName: wh ? whName.get(wh) || 'Warehouse' : 'Shop', kind: 'Sale', itemId: l.itemId, qtyIn: 0, qtyOut: Number(l.qty) || 0, ref: b.billNo, party: partyName.get(b.partyId) || '' });
  });
  (data.returns || []).forEach((r) => {
    if (!r.restock) return;
    const b = bills.get(r.billId);
    push({ date: dayOf(r.date), location: SHOP, locationName: 'Shop', kind: 'Customer return', itemId: r.itemId, qtyIn: Number(r.qty) || 0, qtyOut: 0, ref: b?.billNo || '', party: partyName.get(b?.partyId) || '' });
  });
  const voidedPB = voidedSet(data.purchaseBills);
  const pbNo = new Map((data.purchaseBills || []).map((b) => [b.id, b.purchaseNo]));
  (data.purchases || []).forEach((p) => {
    if (voidedPB.has(p.purchaseBillId)) return;
    const got = lineReceived(p);
    if (got <= 0) return;
    push({ date: dayOf(p.date), location: SHOP, locationName: 'Shop', kind: 'Purchase', itemId: p.itemId, qtyIn: got, qtyOut: 0, ref: pbNo.get(p.purchaseBillId) || '', party: p.supplierName || '' });
  });
  (data.stockLoss || []).forEach((l) => {
    push({ date: dayOf(l.date), location: SHOP, locationName: 'Shop', kind: `Damaged (${l.reason || 'loss'})`, itemId: l.itemId, qtyIn: 0, qtyOut: Number(l.qty) || 0, ref: '', party: '' });
  });
  (data.supplierReturns || []).forEach((r) => {
    push({ date: dayOf(r.date), location: SHOP, locationName: 'Shop', kind: 'Returned to supplier', itemId: r.itemId, qtyIn: 0, qtyOut: Number(r.qty) || 0, ref: pbNo.get(r.purchaseBillId) || '', party: '' });
  });

  const moves = new Map((data.whMoves || []).filter((m) => m.status !== 'voided').map((m) => [m.id, m]));
  (data.whMoveLines || []).forEach((l) => {
    const m = moves.get(l.moveId);
    if (!m) return;
    const q = Number(l.qty) || 0;
    const label = MOVE_TYPES[m.type]?.label || m.type;
    const base = { date: dayOf(m.date), itemId: l.itemId, ref: m.docNo, party: m.partyName || '' };
    if (m.type === 'transfer') {
      push({ ...base, location: m.warehouseId, locationName: whName.get(m.warehouseId) || 'Warehouse', kind: `Transfer to ${whName.get(m.toWarehouseId) || 'warehouse'}`, qtyIn: 0, qtyOut: q });
      push({ ...base, location: m.toWarehouseId, locationName: whName.get(m.toWarehouseId) || 'Warehouse', kind: `Transfer from ${whName.get(m.warehouseId) || 'warehouse'}`, qtyIn: q, qtyOut: 0 });
      return;
    }
    const sign = MOVE_TYPES[m.type]?.sign || 0;
    push({ ...base, location: m.warehouseId, locationName: whName.get(m.warehouseId) || 'Warehouse', kind: label, qtyIn: sign > 0 ? q : 0, qtyOut: sign < 0 ? q : 0 });
    // Goods between a warehouse and the shop land on the other side too.
    if (m.type === 'to-shop') push({ ...base, location: SHOP, locationName: 'Shop', kind: `From ${whName.get(m.warehouseId) || 'warehouse'}`, qtyIn: q, qtyOut: 0 });
    if (m.type === 'from-shop') push({ ...base, location: SHOP, locationName: 'Shop', kind: `To ${whName.get(m.warehouseId) || 'warehouse'}`, qtyIn: 0, qtyOut: q });
  });

  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.ref).localeCompare(String(a.ref)));
}

/** What sold, by item: quantity, sales value and (for those who see cost) profit. */
export function salesByItem(data, from = null, to = null) {
  const live = new Map((data.bills || []).filter((b) => b.status !== 'voided' && inRange(b.date, from, to)).map((b) => [b.id, b]));
  const byItem = new Map();
  (data.billItems || []).forEach((l) => {
    if (!live.has(l.billId)) return;
    const g = byItem.get(l.itemId) || { itemId: l.itemId, qty: 0, amount: 0, profit: 0, bills: new Set() };
    g.qty += Number(l.qty) || 0;
    g.amount += (Number(l.qty) || 0) * (Number(l.price) || 0);
    g.profit += lineProfit(l);
    g.bills.add(l.billId);
    byItem.set(l.itemId, g);
  });
  const items = new Map((data.items || []).map((i) => [i.id, i]));
  return [...byItem.values()].map((g) => ({
    ...g, item: items.get(g.itemId), qty: r2(g.qty), amount: r2(g.amount), profit: r2(g.profit), bills: g.bills.size,
  })).sort((a, b) => b.amount - a.amount);
}

/** What each party bought, paid and still owes in the period. */
export function salesByParty(data, from = null, to = null) {
  const states = billStates((data.bills || []), data).filter((b) => b.status !== 'voided' && !isOpeningBill(b) && inRange(b.date, from, to));
  const byParty = new Map();
  states.forEach((b) => {
    const g = byParty.get(b.partyId) || { partyId: b.partyId, bills: 0, amount: 0, paid: 0, due: 0 };
    g.bills += 1;
    g.amount += b.net;
    g.paid += b.paid;
    g.due += b.due;
    byParty.set(b.partyId, g);
  });
  const parties = new Map((data.parties || []).map((p) => [p.id, p]));
  return [...byParty.values()].map((g) => ({
    ...g, party: parties.get(g.partyId), amount: r2(g.amount), paid: r2(g.paid), due: r2(g.due),
  })).sort((a, b) => b.amount - a.amount);
}

/** Shop and warehouse expenses as one list. Stock written off is not money spent. */
export function expensesMerged(data, from = null, to = null) {
  const whName = new Map((data.warehouses || []).map((w) => [w.id, w.name]));
  const shop = (data.expenses || []).filter((e) => !e.linkedStockLossId && inRange(e.date, from, to))
    .map((e) => ({ ...e, location: SHOP, locationName: 'Shop', amount: Number(e.amount) || 0 }));
  const wh = (data.whExpenses || []).filter((e) => inRange(e.date, from, to))
    .map((e) => ({ ...e, location: e.warehouseId, locationName: whName.get(e.warehouseId) || 'Warehouse', amount: Number(e.amount) || 0 }));
  return [...shop, ...wh].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** One line per location: what is there now, and what moved in the period. */
export function locationSummary(data, from = null, to = null) {
  const { locations, rows } = stockMatrix(data);
  const events = stockEvents(data, from, to);
  const expenses = expensesMerged(data, from, to);
  return locations.map((l) => {
    let units = 0;
    let items = 0;
    let value = 0;
    rows.forEach((r) => {
      const q = r.per[l.id] || 0;
      if (q > 0) {
        units += q;
        items += 1;
        value += q * (Number(r.item.costPrice) || 0);
      }
    });
    const ev = events.filter((e) => e.location === l.id);
    return {
      ...l,
      units: r2(units), items, value: r2(value),
      qtyIn: r2(ev.reduce((s, e) => s + e.qtyIn, 0)),
      qtyOut: r2(ev.reduce((s, e) => s + e.qtyOut, 0)),
      expenses: r2(expenses.filter((e) => e.location === l.id).reduce((s, e) => s + e.amount, 0)),
    };
  });
}
