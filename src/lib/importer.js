// Reading a spreadsheet the shop already keeps — CSV, or Excel .xlsx — and
// turning its rows into the same saves the forms make. Nothing here touches the
// screen, so the whole path can be tested on its own.

import { r2, today, nameKey, phoneKey } from './format.js';
import { billTotals } from './calc.js';
import { UNITS, EXPENSE_CATEGORIES, WAREHOUSE_EXPENSE_CATEGORIES } from './config.js';

/* ------------------------------------------------------------- file reading */

/** CSV text to rows of strings. Handles quotes, commas or semicolons, and Excel's BOM. */
export function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count('\t') > count(',') && count('\t') > count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** The files inside a .zip (an .xlsx is one), by name. */
async function unzip(buffer, wanted) {
  const b = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid Excel (.xlsx) file.');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10);
    const size = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const raw = b.subarray(start, start + size);
    files.set(name, method === 0 ? raw : await inflateRaw(raw));
  }
  return files;
}

const xmlText = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const colIndex = (ref) => {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** The first sheet of an .xlsx as rows of values (numbers stay numbers). */
export async function parseXLSX(buffer) {
  const files = await unzip(buffer, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const dec = new TextDecoder();
  const read = (n) => (files.has(n) ? dec.decode(files.get(n)) : '');
  const shared = [];
  for (const si of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join(''));
  }
  // The first sheet in the workbook's own order, wherever its file is.
  let path = 'xl/worksheets/sheet1.xml';
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(read('xl/workbook.xml'))?.[1];
  if (firstId) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(read('xl/_rels/workbook.xml.rels'))
      || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(read('xl/_rels/workbook.xml.rels'));
    if (rel) path = `xl/${rel[1].replace(/^\/?xl\//, '').replace(/^\.\//, '')}`;
  }
  const sheet = read(path) || read([...files.keys()].find((k) => k.startsWith('xl/worksheets/')) || '');
  if (!sheet) throw new Error('No sheet found in this Excel file.');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('');
      else if (type === 'b') val = v === '1';
      else if (type === 'str' || type === 'e') val = v !== undefined ? xmlText(v) : '';
      else val = v !== undefined && v !== '' ? Number(v) : '';
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? '' : x)));
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** A picked file to { headers, rows } where each row is keyed by its header. */
export async function readFile(file) {
  const name = String(file?.name || '').toLowerCase();
  let grid;
  if (name.endsWith('.xlsx')) grid = await parseXLSX(await file.arrayBuffer());
  else if (name.endsWith('.csv') || name.endsWith('.txt')) grid = parseCSV(await file.text());
  else if (name.endsWith('.xls')) throw new Error('Old .xls files cannot be read. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV, then import that.');
  else throw new Error('Choose a .csv or .xlsx file.');
  if (grid.length < 2) throw new Error('The file has no rows under its heading row.');
  const headers = grid[0].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, rows };
}

/* ---------------------------------------------------------- value cleaning */

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "1,250.50", "Rs 1250", 1250 → 1250.5; blank or nonsense → null. */
export function toNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/rs\.?|pkr|,|\s/gi, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 2026-03-01, 01/03/2026, 1-3-2026, 1 Mar 2026 or an Excel day number → YYYY-MM-DD. */
export function toDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel counts days from 1899-12-30.
    return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    // Day first, as written in Pakistan.
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const text = (v) => String(v ?? '').trim();
const unitOf = (v) => UNITS.find((u) => key(u) === key(v)) || text(v);
const catOf = (v, list) => list.find((c) => key(c) === key(v)) || text(v);

/* ------------------------------------------------------------------- specs */

const F = (k, label, aliases = [], opts = {}) => ({ key: k, label, aliases: [label, k, ...aliases], ...opts });

export const MOVE_ALIASES = [
  ['in', ['in', 'stockin', 'grn', 'receive', 'received', 'inward', 'purchase']],
  ['out', ['out', 'stockout', 'gdn', 'gatepass', 'dispatch', 'outward', 'sale', 'issue']],
  ['transfer', ['transfer', 'trf', 'move']],
  ['to-shop', ['toshop', 'senttoshop', 'shop']],
  ['from-shop', ['fromshop', 'returnfromshop']],
  ['adjust-in', ['adjustin', 'adjustmentin', 'adjust+', 'found', 'surplus']],
  ['adjust-out', ['adjustout', 'adjustmentout', 'adjust-', 'damage', 'damaged', 'lost', 'shortage']],
];
function moveType(v) {
  const k = String(v || '').toLowerCase().replace(/[^a-z+-]/g, '');
  for (const [t, words] of MOVE_ALIASES) if (words.some((w) => w === k)) return t;
  return null;
}

/**
 * One spec per page. `fields` are what the file can hold; `plan` turns the
 * mapped rows into saves, rows to skip because they are already in the
 * system, and rows that cannot be imported, each with its reason.
 */
export const SPECS = {
  parties: {
    label: 'parties', title: 'Parties',
    fields: [
      F('name', 'Party name', ['party', 'customer', 'customername', 'name', 'shop'], { required: true }),
      F('phone', 'Phone', ['mobile', 'mobileno', 'phoneno', 'contact', 'cell']),
      F('address', 'Address', ['area', 'city', 'location']),
      F('creditLimit', 'Credit limit', ['limit']),
      F('defaultDueDays', 'Credit days', ['duedays', 'creditdays', 'days']),
    ],
    example: ['Ahmed Kiryana Store', '0300-1234567', 'Main Bazaar', '50000', '15'],
    plan(recs, data) {
      const names = new Set(data.parties.map((p) => nameKey(p.name)));
      const phones = new Set(data.parties.map((p) => phoneKey(p.phone)).filter(Boolean));
      return recs.map((r) => {
        if (!r.name) return { row: r.$row, error: 'Party name is empty' };
        if (names.has(nameKey(r.name))) return { row: r.$row, skip: `"${r.name}" already exists` };
        const ph = phoneKey(r.phone);
        if (ph && phones.has(ph)) return { row: r.$row, skip: `Phone ${r.phone} is already on another party` };
        names.add(nameKey(r.name));
        if (ph) phones.add(ph);
        return {
          row: r.$row, ref: r.name,
          op: { action: 'saveParty', payload: { name: r.name, phone: r.phone, address: r.address, creditLimit: toNumber(r.creditLimit) || 0, defaultDueDays: toNumber(r.defaultDueDays) || undefined } },
        };
      });
    },
  },

  items: {
    label: 'items', title: 'Items',
    fields: [
      F('name', 'Item name', ['item', 'product', 'productname', 'name', 'description'], { required: true }),
      F('category', 'Category', ['group', 'type']),
      F('baseUnit', 'Unit', ['baseunit', 'uom']),
      F('altUnit', 'Alternate unit', ['altunit', 'packing']),
      F('conversionRate', 'Pieces per alternate unit', ['conversion', 'conversionrate', 'perpack', 'packsize']),
      F('costPrice', 'Cost price', ['cost', 'purchaseprice', 'buyprice', 'rate'], { cost: true }),
      F('openingStock', 'Opening stock', ['stock', 'qty', 'quantity', 'opening', 'balance']),
      F('lowStockAlert', 'Low stock alert', ['minstock', 'reorderlevel', 'minimum', 'alert']),
    ],
    example: ['Balloon Pack 100', 'Balloons', 'Packet', 'Carton', '50', '180', '200', '20'],
    plan(recs, data) {
      const names = new Set(data.items.map((i) => nameKey(i.name)));
      return recs.map((r) => {
        if (!r.name) return { row: r.$row, error: 'Item name is empty' };
        if (names.has(nameKey(r.name))) return { row: r.$row, skip: `"${r.name}" already exists` };
        names.add(nameKey(r.name));
        return {
          row: r.$row, ref: r.name,
          op: {
            action: 'saveItem',
            payload: {
              name: r.name, category: r.category, baseUnit: unitOf(r.baseUnit) || 'Piece', altUnit: r.altUnit ? unitOf(r.altUnit) : '',
              conversionRate: toNumber(r.conversionRate) || 0, costPrice: toNumber(r.costPrice) || 0,
              openingStock: toNumber(r.openingStock) || 0, lowStockAlert: toNumber(r.lowStockAlert) || 0,
            },
          },
        };
      });
    },
  },

  suppliers: {
    label: 'suppliers', title: 'Suppliers',
    fields: [
      F('name', 'Supplier name', ['supplier', 'vendor', 'company', 'name'], { required: true }),
      F('phone', 'Phone', ['mobile', 'contact']),
      F('address', 'Address', ['city', 'area']),
      F('openingBalance', 'Opening balance', ['balance', 'payable', 'opening']),
    ],
    example: ['City Balloon Wholesale', '0321-7654321', 'Shah Alam Market', '25000'],
    plan(recs, data) {
      const names = new Set((data.suppliers || []).map((s) => nameKey(s.name)));
      return recs.map((r) => {
        if (!r.name) return { row: r.$row, error: 'Supplier name is empty' };
        if (names.has(nameKey(r.name))) return { row: r.$row, skip: `"${r.name}" already exists` };
        names.add(nameKey(r.name));
        return { row: r.$row, ref: r.name, op: { action: 'saveSupplier', payload: { name: r.name, phone: r.phone, address: r.address, openingBalance: toNumber(r.openingBalance) || 0 } } };
      });
    },
  },

  employees: {
    label: 'employees', title: 'Employees',
    fields: [
      F('name', 'Employee name', ['employee', 'staff', 'name'], { required: true }),
      F('phone', 'Phone', ['mobile']),
      F('role', 'Role', ['designation', 'post', 'job']),
      F('monthlySalary', 'Monthly salary', ['salary', 'pay']),
      F('joinDate', 'Join date', ['joined', 'joiningdate', 'date'], { date: true }),
    ],
    example: ['Kashif Ali', '0333-1112223', 'Salesman', '25000', '2025-01-15'],
    plan(recs, data) {
      const names = new Set((data.employees || []).map((e) => nameKey(e.name)));
      return recs.map((r) => {
        if (!r.name) return { row: r.$row, error: 'Employee name is empty' };
        if (names.has(nameKey(r.name))) return { row: r.$row, skip: `"${r.name}" already exists` };
        names.add(nameKey(r.name));
        return { row: r.$row, ref: r.name, op: { action: 'saveEmployee', payload: { name: r.name, phone: r.phone, role: r.role, monthlySalary: toNumber(r.monthlySalary) || 0, joinDate: r.joinDate || today() } } };
      });
    },
  },

  expenses: {
    label: 'expenses', title: 'Expenses',
    fields: [
      F('date', 'Date', [], { date: true }),
      F('category', 'Category', ['head', 'type', 'expense'], { required: true }),
      F('amount', 'Amount', ['total', 'paid', 'rs'], { required: true }),
      F('method', 'Paid from', ['method', 'account', 'paymentmethod']),
      F('note', 'Note', ['details', 'description', 'remarks']),
    ],
    example: ['2026-03-01', 'Rent', '45000', 'Cash', 'March rent'],
    plan(recs, data, ctx) {
      const seen = new Set(data.expenses.map((e) => `${e.date}|${key(e.category)}|${r2(e.amount)}|${key(e.note)}`));
      return recs.map((r) => {
        const amount = toNumber(r.amount);
        if (!r.category) return { row: r.$row, error: 'Category is empty' };
        if (!(amount > 0)) return { row: r.$row, error: 'Amount must be more than 0' };
        const date = r.date || today();
        const sig = `${date}|${key(r.category)}|${r2(amount)}|${key(r.note)}`;
        if (seen.has(sig)) return { row: r.$row, skip: 'The same expense is already recorded' };
        seen.add(sig);
        return { row: r.$row, ref: `${r.category} ${amount}`, op: { action: 'saveExpense', payload: { date, category: catOf(r.category, EXPENSE_CATEGORIES), amount, method: ctx.method(r.method), note: r.note } } };
      });
    },
  },

  assets: {
    label: 'assets', title: 'Assets',
    fields: [
      F('name', 'Asset name', ['asset', 'name', 'item'], { required: true }),
      F('value', 'Value', ['amount', 'cost', 'price'], { required: true }),
      F('date', 'Date acquired', ['date', 'purchasedate'], { date: true }),
      F('note', 'Note', ['details', 'remarks']),
    ],
    example: ['Delivery van', '850000', '2024-06-01', 'Suzuki Bolan'],
    plan(recs, data) {
      const seen = new Set((data.assets || []).map((a) => `${nameKey(a.name)}|${r2(a.value)}`));
      return recs.map((r) => {
        const value = toNumber(r.value);
        if (!r.name) return { row: r.$row, error: 'Asset name is empty' };
        if (!(value >= 0) || value === null) return { row: r.$row, error: 'Value is not a number' };
        const sig = `${nameKey(r.name)}|${r2(value)}`;
        if (seen.has(sig)) return { row: r.$row, skip: `"${r.name}" is already recorded` };
        seen.add(sig);
        return { row: r.$row, ref: r.name, op: { action: 'saveAsset', payload: { name: r.name, value, date: r.date || today(), note: r.note } } };
      });
    },
  },

  warehouses: {
    label: 'warehouses', title: 'Warehouses',
    fields: [
      F('name', 'Warehouse name', ['warehouse', 'godown', 'store', 'name'], { required: true }),
      F('code', 'Code', ['shortcode']),
      F('location', 'Location', ['address', 'area', 'city']),
      F('manager', 'In-charge', ['manager', 'keeper', 'incharge']),
      F('phone', 'Phone', ['mobile']),
      F('capacity', 'Capacity', ['size', 'space']),
      F('note', 'Note', ['remarks']),
    ],
    example: ['Godown 2', 'G2', 'Ravi Road', 'Asif', '0300-9998887', '2000 cartons', ''],
    plan(recs, data) {
      const names = new Set((data.warehouses || []).map((w) => nameKey(w.name)));
      return recs.map((r) => {
        if (!r.name) return { row: r.$row, error: 'Warehouse name is empty' };
        if (names.has(nameKey(r.name))) return { row: r.$row, skip: `"${r.name}" already exists` };
        names.add(nameKey(r.name));
        return { row: r.$row, ref: r.name, op: { action: 'saveWarehouse', payload: { name: r.name, code: r.code, location: r.location, manager: r.manager, phone: r.phone, capacity: r.capacity, note: r.note } } };
      });
    },
  },

  whExpenses: {
    label: 'warehouse expenses', title: 'Warehouse expenses',
    fields: [
      F('date', 'Date', [], { date: true }),
      F('warehouse', 'Warehouse', ['godown', 'store'], { required: true }),
      F('category', 'Category', ['head', 'type'], { required: true }),
      F('amount', 'Amount', ['total', 'rs'], { required: true }),
      F('method', 'Paid from', ['method', 'account']),
      F('note', 'Note', ['details', 'remarks']),
    ],
    example: ['2026-03-01', 'Godown 2', 'Labour', '3500', 'Cash', 'Unloading'],
    plan(recs, data, ctx) {
      const seen = new Set((data.whExpenses || []).map((e) => `${e.warehouseId}|${e.date}|${key(e.category)}|${r2(e.amount)}|${key(e.note)}`));
      return recs.map((r) => {
        const wh = ctx.warehouse(r.warehouse);
        const amount = toNumber(r.amount);
        if (!wh) return { row: r.$row, error: `Warehouse "${r.warehouse}" not found` };
        if (!r.category) return { row: r.$row, error: 'Category is empty' };
        if (!(amount > 0)) return { row: r.$row, error: 'Amount must be more than 0' };
        const date = r.date || today();
        const sig = `${wh.id}|${date}|${key(r.category)}|${r2(amount)}|${key(r.note)}`;
        if (seen.has(sig)) return { row: r.$row, skip: 'The same expense is already recorded' };
        seen.add(sig);
        return { row: r.$row, ref: `${wh.name} ${r.category}`, op: { action: 'saveWhExpense', payload: { warehouseId: wh.id, date, category: catOf(r.category, WAREHOUSE_EXPENSE_CATEGORIES), amount, method: ctx.method(r.method), note: r.note } } };
      });
    },
  },

  bills: {
    label: 'bills', title: 'Sales bills', grouped: true, batch: 10,
    help: 'One row per item. Rows with the same bill number (or, without one, the same party and date) become one bill.',
    fields: [
      F('billNo', 'Bill no', ['billnumber', 'invoice', 'invoiceno', 'bill', 'no']),
      F('date', 'Date', ['billdate'], { date: true }),
      F('party', 'Party', ['customer', 'partyname', 'customername', 'name'], { required: true }),
      F('phone', 'Phone', ['mobile']),
      F('item', 'Item', ['product', 'itemname', 'description'], { required: true }),
      F('qty', 'Qty', ['quantity', 'pcs']),
      F('unit', 'Unit', ['uom']),
      F('price', 'Rate', ['price', 'saleprice', 'unitprice']),
      F('paid', 'Paid', ['received', 'amountpaid', 'cash']),
      F('method', 'Paid by', ['method', 'paymentmethod']),
      F('note', 'Note', ['remarks', 'details']),
    ],
    example: ['1001', '2026-03-01', 'Ahmed Kiryana Store', '0300-1234567', 'Balloon Pack 100', '10', 'Packet', '250', '1000', 'Cash', ''],
    needs: ['parties', 'items'],
    plan(recs, data, ctx) {
      const used = new Set(data.bills.map((b) => String(b.billNo)));
      const groups = new Map();
      recs.forEach((r) => {
        const k = r.billNo ? `#${r.billNo}` : `${nameKey(r.party)}|${r.date || today()}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      return [...groups.values()].map((rows) => {
        const head = rows[0];
        const rowNos = rows.map((r) => r.$row);
        const ref = head.billNo ? `Bill ${head.billNo}` : `${head.party} ${head.date || ''}`.trim();
        if (head.billNo && used.has(String(head.billNo))) return { rows: rowNos, ref, skip: `Bill ${head.billNo} is already in the system` };
        const party = ctx.party(head.party);
        // Every missing name is gathered before giving up, so one pass can add them all.
        const missingItems = rows.filter((r) => !ctx.item(r.item)).map((r) => r.item);
        if (!party || missingItems.length) {
          const what = [!party && `party "${head.party}"`, missingItems.length && `item${missingItems.length === 1 ? '' : 's'} ${[...new Set(missingItems)].join(', ')}`].filter(Boolean).join(' and ');
          return { rows: rowNos, ref, error: `Not found: ${what}`, need: { parties: party ? [] : [head.party], items: missingItems } };
        }
        const lines = [];
        const missing = [];
        for (const r of rows) {
          const it = ctx.item(r.item);
          if (!it) { missing.push(r.item); continue; }
          const q = toNumber(r.qty) ?? 1;
          const price = toNumber(r.price);
          if (!(q > 0)) return { rows: rowNos, ref, error: `Row ${r.$row}: quantity must be more than 0` };
          if (price === null || price < 0) return { rows: rowNos, ref, error: `Row ${r.$row}: rate is missing` };
          lines.push({ itemId: it.id, qty: ctx.baseQty(it, q, r.unit), price: ctx.basePrice(it, price, q, r.unit), unit: it.baseUnit });
        }
        if (missing.length) return { rows: rowNos, ref, error: `Item${missing.length === 1 ? '' : 's'} not found: ${[...new Set(missing)].join(', ')}`, need: { items: missing } };
        const total = billTotals(lines, ctx.roundingRule).total;
        const paidRaw = rows.map((r) => toNumber(r.paid)).find((v) => v !== null && v !== undefined);
        const paid = Math.min(r2(paidRaw || 0), total);
        if (head.billNo) used.add(String(head.billNo));
        return {
          rows: rowNos, ref,
          op: {
            action: 'saveBill',
            payload: {
              billNo: head.billNo || '', partyId: party.id, date: head.date || today(), lines,
              payments: paid > 0 ? [{ method: ctx.method(head.method), amount: paid }] : [],
              dueDate: '', note: head.note || '', delivery: 'delivered',
            },
          },
        };
      });
    },
  },

  purchases: {
    label: 'purchase bills', title: 'Purchase bills', grouped: true, batch: 10,
    help: "One row per item. Rows with the same supplier and invoice number (or the same supplier and date) become one purchase bill.",
    fields: [
      F('invoiceNo', 'Invoice no', ['invoice', 'billno', 'bill', 'no']),
      F('date', 'Date', ['invoicedate', 'billdate'], { date: true }),
      F('supplier', 'Supplier', ['vendor', 'company', 'suppliername', 'name'], { required: true }),
      F('item', 'Item', ['product', 'itemname', 'description'], { required: true }),
      F('qty', 'Qty', ['quantity', 'pcs']),
      F('unit', 'Unit', ['uom']),
      F('cost', 'Cost', ['rate', 'price', 'costprice', 'purchaseprice']),
      F('paid', 'Paid', ['amountpaid', 'cash']),
      F('method', 'Paid by', ['method', 'paymentmethod']),
      F('note', 'Note', ['remarks', 'details']),
    ],
    example: ['INV-55', '2026-03-02', 'City Balloon Wholesale', 'Balloon Pack 100', '50', 'Packet', '180', '5000', 'Cash', ''],
    needs: ['suppliers', 'items'],
    plan(recs, data, ctx) {
      const used = new Set((data.purchaseBills || []).filter((b) => b.invoiceNo).map((b) => `${b.supplierId}|${key(b.invoiceNo)}`));
      const groups = new Map();
      recs.forEach((r) => {
        const k = `${nameKey(r.supplier)}|${r.invoiceNo ? key(r.invoiceNo) : r.date || today()}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      return [...groups.values()].map((rows) => {
        const head = rows[0];
        const rowNos = rows.map((r) => r.$row);
        const ref = head.invoiceNo ? `${head.supplier} · ${head.invoiceNo}` : `${head.supplier} ${head.date || ''}`.trim();
        const sup = ctx.supplier(head.supplier);
        const missingItems = rows.filter((r) => !ctx.item(r.item)).map((r) => r.item);
        if (!sup || missingItems.length) {
          const what = [!sup && `supplier "${head.supplier}"`, missingItems.length && `item${missingItems.length === 1 ? '' : 's'} ${[...new Set(missingItems)].join(', ')}`].filter(Boolean).join(' and ');
          return { rows: rowNos, ref, error: `Not found: ${what}`, need: { suppliers: sup ? [] : [head.supplier], items: missingItems } };
        }
        if (head.invoiceNo && used.has(`${sup.id}|${key(head.invoiceNo)}`)) return { rows: rowNos, ref, skip: `Invoice ${head.invoiceNo} from ${sup.name} is already in the system` };
        const lines = [];
        const missing = [];
        for (const r of rows) {
          const it = ctx.item(r.item);
          if (!it) { missing.push(r.item); continue; }
          const q = toNumber(r.qty) ?? 1;
          const cost = toNumber(r.cost);
          if (!(q > 0)) return { rows: rowNos, ref, error: `Row ${r.$row}: quantity must be more than 0` };
          if (cost === null || cost < 0) return { rows: rowNos, ref, error: `Row ${r.$row}: cost is missing` };
          lines.push({ itemId: it.id, qty: ctx.baseQty(it, q, r.unit), costPrice: ctx.basePrice(it, cost, q, r.unit) });
        }
        if (missing.length) return { rows: rowNos, ref, error: `Item${missing.length === 1 ? '' : 's'} not found: ${[...new Set(missing)].join(', ')}`, need: { items: missing } };
        const total = r2(lines.reduce((s, l) => s + l.qty * l.costPrice, 0));
        const paidRaw = rows.map((r) => toNumber(r.paid)).find((v) => v !== null && v !== undefined);
        if (head.invoiceNo) used.add(`${sup.id}|${key(head.invoiceNo)}`);
        return {
          rows: rowNos, ref,
          op: {
            action: 'savePurchaseBill',
            payload: {
              supplierId: sup.id, invoiceNo: head.invoiceNo || '', date: head.date || today(), note: head.note || '',
              lines, paidNow: Math.min(r2(paidRaw || 0), total), method: ctx.method(head.method), received: true,
            },
          },
        };
      });
    },
  },

  whMoves: {
    label: 'warehouse movements', title: 'Warehouse movements', grouped: true, batch: 12,
    help: 'One row per item. Type is In, Out, Transfer, To shop, From shop, Adjust in or Adjust out. Rows with the same reference, type, warehouse and date become one document.',
    fields: [
      F('type', 'Type', ['movement', 'movementtype', 'kind']),
      F('date', 'Date', [], { date: true }),
      F('warehouse', 'Warehouse', ['godown', 'from', 'fromwarehouse', 'store'], { required: true }),
      F('toWarehouse', 'To warehouse', ['to', 'destination']),
      F('reference', 'Reference', ['ref', 'docno', 'gatepass', 'grn', 'billno', 'invoice']),
      F('party', 'Party / supplier', ['party', 'supplier', 'customer']),
      F('vehicleNo', 'Vehicle no', ['vehicle', 'truck']),
      F('driverName', 'Driver', ['drivername']),
      F('item', 'Item', ['product', 'itemname'], { required: true }),
      F('qty', 'Qty', ['quantity', 'pcs']),
      F('unit', 'Unit', ['uom']),
      F('rate', 'Rate', ['price', 'cost'], { cost: true }),
      F('note', 'Note', ['remarks']),
    ],
    example: ['In', '2026-03-03', 'Godown 2', '', 'GRN-778', 'City Balloon Wholesale', 'LES-1234', 'Rafiq', 'Balloon Pack 100', '40', 'Packet', '', ''],
    needs: ['items'],
    plan(recs, data, ctx) {
      const done = new Set((data.whMoves || []).filter((m) => m.reference && m.status !== 'voided').map((m) => `${m.type}|${m.warehouseId}|${m.date}|${key(m.reference)}`));
      const groups = new Map();
      recs.forEach((r) => {
        const k = `${key(r.type)}|${nameKey(r.warehouse)}|${nameKey(r.toWarehouse)}|${r.date || today()}|${r.reference ? key(r.reference) : key(r.party)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      const planned = [...groups.values()].map((rows) => {
        const head = rows[0];
        const rowNos = rows.map((r) => r.$row);
        const type = moveType(head.type || 'in');
        const ref = `${head.type || 'In'} · ${head.warehouse}${head.reference ? ` · ${head.reference}` : ''}`;
        if (!type) return { rows: rowNos, ref, error: `Type "${head.type}" is not one of In, Out, Transfer, To shop, From shop, Adjust in, Adjust out` };
        const wh = ctx.warehouse(head.warehouse);
        if (!wh) return { rows: rowNos, ref, error: `Warehouse "${head.warehouse}" not found` };
        const dest = type === 'transfer' ? ctx.warehouse(head.toWarehouse) : null;
        if (type === 'transfer' && !dest) return { rows: rowNos, ref, error: `Destination warehouse "${head.toWarehouse || ''}" not found` };
        const date = head.date || today();
        if (head.reference && done.has(`${type}|${wh.id}|${date}|${key(head.reference)}`)) return { rows: rowNos, ref, skip: `${head.reference} is already recorded for ${wh.name}` };
        const lines = [];
        const missing = [];
        for (const r of rows) {
          const it = ctx.item(r.item);
          if (!it) { missing.push(r.item); continue; }
          const q = toNumber(r.qty);
          if (!(q > 0)) return { rows: rowNos, ref, error: `Row ${r.$row}: quantity must be more than 0` };
          const rate = toNumber(r.rate);
          lines.push({ itemId: it.id, qty: ctx.baseQty(it, q, r.unit), unit: it.baseUnit, rate: rate === null ? '' : ctx.basePrice(it, rate, q, r.unit), note: r.note || '' });
        }
        if (missing.length) return { rows: rowNos, ref, error: `Item${missing.length === 1 ? '' : 's'} not found: ${[...new Set(missing)].join(', ')}`, need: { items: missing } };
        return {
          rows: rowNos, ref, sign: ['in', 'from-shop', 'adjust-in'].includes(type) ? 1 : -1, date,
          op: {
            action: 'saveWhMove',
            payload: {
              type, warehouseId: wh.id, toWarehouseId: dest ? dest.id : '', date, partyName: head.party || '', reference: head.reference || '',
              vehicleNo: head.vehicleNo || '', driverName: head.driverName || '', reason: type.startsWith('adjust') ? 'Imported' : '', note: head.note || '', lines,
            },
          },
        };
      });
      // Goods must arrive before they can leave: each day's incoming documents first.
      return planned.sort((a, b) => (a.op && b.op ? String(a.date).localeCompare(String(b.date)) || b.sign - a.sign : 0));
    },
  },
};

/** The file's column for each field, guessed from its heading. */
export function autoMap(spec, headers) {
  const map = {};
  const taken = new Set();
  spec.fields.forEach((f) => {
    const wanted = f.aliases.map(key);
    const hit = headers.find((h) => !taken.has(h) && wanted.includes(key(h)));
    if (hit) { map[f.key] = hit; taken.add(hit); }
  });
  return map;
}

/** Rows keyed by field, cleaned: text trimmed, dates as YYYY-MM-DD. Row numbers count the heading as row 1. */
export function mapRows(spec, rows, mapping) {
  return rows.map((row, i) => {
    const rec = { $row: i + 2 };
    spec.fields.forEach((f) => {
      const v = mapping[f.key] ? row[mapping[f.key]] : '';
      if (f.date) {
        const d = toDate(v);
        rec[f.key] = d || '';
        if (d === null) rec.$badDate = `${f.label} "${v}" is not a date`;
      } else rec[f.key] = typeof v === 'number' ? v : text(v);
    });
    return rec;
  });
}

/** Lookups the plans use, built once from the current data. */
export function makeContext(data, { methods = [], roundingRule = 'nearest1' } = {}) {
  const byName = (list) => {
    const m = new Map();
    (list || []).forEach((x) => { if (x.status !== 'archived' || !m.has(nameKey(x.name))) m.set(nameKey(x.name), x); });
    return (name) => m.get(nameKey(name)) || null;
  };
  const whs = (data.warehouses || []).filter((w) => w.status !== 'archived');
  const whByCode = new Map(whs.filter((w) => w.code).map((w) => [key(w.code), w]));
  const allMethods = methods.length ? methods : ['Cash'];
  const isAlt = (it, unit) => unit && it.altUnit && key(unit) === key(it.altUnit) && Number(it.conversionRate) > 0;
  return {
    roundingRule,
    party: byName(data.parties),
    item: byName(data.items),
    supplier: byName(data.suppliers),
    warehouse: (name) => byName(whs)(name) || whByCode.get(key(name)) || null,
    method: (m) => allMethods.find((x) => key(x) === key(m)) || 'Cash',
    // A quantity in the item's alternate unit (cartons) is stored in its base unit.
    baseQty: (it, q, unit) => (isAlt(it, unit) ? r2(q * Number(it.conversionRate)) : r2(q)),
    basePrice: (it, price, q, unit) => (isAlt(it, unit) ? r2(price / Number(it.conversionRate)) : r2(price)),
  };
}

/** Everything a file would do, before anything is saved. */
export function preview(spec, records, data, opts) {
  const ctx = makeContext(data, opts);
  const out = { ops: [], skipped: [], errors: [], need: { parties: new Set(), items: new Set(), suppliers: new Set() } };
  const bad = records.filter((r) => r.$badDate);
  const good = records.filter((r) => !r.$badDate);
  bad.forEach((r) => out.errors.push({ rows: [r.$row], ref: '', message: r.$badDate }));
  const missingReq = spec.fields.filter((f) => f.required);
  const usable = good.filter((r) => {
    const empty = missingReq.find((f) => !String(r[f.key] ?? '').trim());
    if (empty) out.errors.push({ rows: [r.$row], ref: '', message: `${empty.label} is empty` });
    return !empty;
  });
  spec.plan(usable, data, ctx).forEach((p) => {
    const rows = p.rows || [p.row];
    if (p.op) out.ops.push({ ...p.op, ref: p.ref || `Row ${rows[0]}`, rows });
    else if (p.skip) out.skipped.push({ rows, ref: p.ref || '', message: p.skip });
    else if (p.error) out.errors.push({ rows, ref: p.ref || '', message: p.error });
    if (p.need) Object.entries(p.need).forEach(([k, names]) => names.forEach((n) => n && out.need[k]?.add(String(n).trim())));
  });
  return out;
}

/** Saves that create the parties, suppliers and items a file names but the system lacks. */
export function creationOps(need, data) {
  const ops = [];
  const exists = (list, n) => (list || []).some((x) => nameKey(x.name) === nameKey(n));
  [...need.parties].forEach((n) => { if (!exists(data.parties, n)) ops.push({ action: 'saveParty', payload: { name: n }, ref: `New party ${n}` }); });
  [...need.suppliers].forEach((n) => { if (!exists(data.suppliers, n)) ops.push({ action: 'saveSupplier', payload: { name: n, openingBalance: 0 }, ref: `New supplier ${n}` }); });
  [...need.items].forEach((n) => { if (!exists(data.items, n)) ops.push({ action: 'saveItem', payload: { name: n, baseUnit: 'Piece' }, ref: `New item ${n}` }); });
  return ops;
}

/** Split saves into request-sized batches. */
export function batches(ops, size = 25) {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

/** A starter file for a page: its headings and one example row. */
export function templateCSV(spec) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return `﻿${spec.fields.map((f) => cell(f.label)).join(',')}\r\n${spec.example.map(cell).join(',')}\r\n`;
}

