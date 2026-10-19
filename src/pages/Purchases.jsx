import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Download, Eye, HandCoins, Pencil, Plus, Save, ShoppingCart, Trash2, TrendingUp,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, today, fmtDate, norm, rangeFor, inRange } from '../lib/format.js';
import { itemStock, lineReceived } from '../lib/calc.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Confirm, DateRange, Empty, Field, Input, Modal, Money, PageHead, SearchBox, Select, Stat, Typeahead,
} from '../components/ui.jsx';
import { ItemForm } from '../components/forms.jsx';
import { EditPurchaseModal, PurchaseBillModal, SupplierPaymentModal } from '../components/supplierForms.jsx';
import ImportButton from '../components/ImportButton.jsx';

function ReceivedTag({ p }) {
  const got = lineReceived(p);
  if (got >= (Number(p.qty) || 0) - 0.0001) return null;
  return <span className={`ld-count ${got > 0 ? 'part' : 'none'}`}>{got > 0 ? `${+got.toFixed(3)} received` : 'Not received'}</span>;
}

const blank = () => ({ itemId: '', supplierName: '', qty: '', costPrice: '', date: today(), method: 'Cash', note: '' });

/** One item bought, paid on the spot — no supplier account. */
function QuickPurchaseModal({ open, onClose }) {
  const { data, activeItems, methods, mutate, toast } = useApp();
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [newName, setNewName] = useState('');
  const item = data.items.find((i) => i.id === f.itemId);
  const stock = f.itemId ? itemStock(f.itemId, data) : null;
  const suppliers = useMemo(() => [...new Set(data.purchases.map((p) => p.supplierName).filter(Boolean))].sort(), [data.purchases]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pick = (id) => {
    const it = data.items.find((i) => i.id === id);
    setF((x) => ({ ...x, itemId: id, costPrice: x.costPrice || String(it?.costPrice || '') }));
  };
  const total = r2((Number(f.qty) || 0) * (Number(f.costPrice) || 0));
  const costChanges = item && Number(f.costPrice) && Number(f.costPrice) !== Number(item.costPrice);
  const save = async () => {
    if (busy || !f.itemId || !(Number(f.qty) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.savePurchase({
        itemId: f.itemId, supplierName: f.supplierName, qty: Number(f.qty), costPrice: Number(f.costPrice) || 0, date: f.date, method: f.method, note: f.note,
      }), 'Purchase recorded');
      setF(blank());
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        open={open && !addingItem}
        title="Record Purchase"
        onClose={onClose}
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!f.itemId || !(Number(f.qty) > 0)}>Record {total > 0 ? money(total) : 'Purchase'}</Button></>}
      >
        <Field label="Item" hint={stock !== null ? `Current stock: ${stock} ${item?.baseUnit || ''}` : undefined}>
          <Typeahead
            items={activeItems}
            value={f.itemId}
            onChange={pick}
            getLabel={(i) => i.name}
            getSub={(i) => `${i.category || 'Uncategorised'} · current cost ${money(i.costPrice)}`}
            placeholder="Search item…"
            autoFocus
            onAddNew={(n) => { setNewName(n); setAddingItem(true); }}
            addNewLabel="Add new item"
          />
        </Field>
        <div className="form-grid">
          <Field label="Supplier">
            <Input value={f.supplierName} onChange={set('supplierName')} list="supplier-list" placeholder="Supplier name" />
            <datalist id="supplier-list">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          </Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
          <Field label="Quantity"><Input type="number" min="0" step="any" value={f.qty} onChange={set('qty')} placeholder="0" /></Field>
          <Field label="Cost price per unit" hint={item ? `Current: ${money(item.costPrice)}` : undefined}><Input type="number" min="0" step="any" value={f.costPrice} onChange={set('costPrice')} placeholder="0" /></Field>
          <Field label="Paid from"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
          <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="Optional" /></Field>
        </div>
        <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>Purchase total</span><span className="spacer" />
          <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
        </div>
        {costChanges && (
          <div className="mt-2" style={{ padding: '10px 12px', background: 'var(--info-bg)', border: '1px solid #BFDBFE', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#1D4ED8', display: 'flex', gap: 7 }}>
            <TrendingUp size={14} style={{ flex: 'none', marginTop: 1 }} />
            <span>This updates {item.name}'s cost price from {money(item.costPrice)} to {money(f.costPrice)}. Past bills keep their original cost, so historical profit stays accurate.</span>
          </div>
        )}
      </Modal>
      <Modal open={addingItem} title="Add New Item" onClose={() => setAddingItem(false)}>
        <ItemForm
          initialName={newName}
          onSaved={(it) => {
            setAddingItem(false);
            if (it?.id) {
              setF((x) => ({ ...x, itemId: it.id, costPrice: x.costPrice || String(it.costPrice || '') }));
              toast(`Item "${it.name}" added`);
            }
          }}
          onCancel={() => setAddingItem(false)}
        />
      </Modal>
    </>
  );
}

export default function Purchases() {
  const { data, settings, toast, mutate } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [quick, setQuick] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [seeAll, setSeeAll] = useState(false);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  // Search ranks by how well the item name matches, then shows newest first.
  const all = useMemo(() => {
    const s = norm(q);
    const score = (p) => {
      if (!s) return 0;
      const n = norm(p.item?.name || '');
      if (n === s) return 100;
      if (n.startsWith(s)) return 80;
      if (n.split(' ').some((w) => w.startsWith(s))) return 70;
      if (n.includes(s)) return 60;
      if ([p.bill?.purchaseNo, p.bill?.invoiceNo].some((x) => norm(x || '').includes(s))) return 50;
      if (norm(p.supplierName || '').includes(s)) return 40;
      return 10;
    };
    const bills = new Map((data.purchaseBills || []).map((b) => [b.id, b]));
    return data.purchases
      .map((p) => ({ ...p, item: data.items.find((i) => i.id === p.itemId), bill: p.purchaseBillId ? bills.get(p.purchaseBillId) : null }))
      .filter((p) => p.bill?.status !== 'voided')
      .map((p) => (p.bill ? { ...p, method: 'Supplier account', note: [p.bill.purchaseNo, p.note].filter(Boolean).join(' · ') } : p))
      .filter((p) => inRange(p.date, range.from, range.to))
      .filter((p) => !s || norm([p.item?.name, p.item?.category, p.supplierName, p.note, p.method, p.bill?.purchaseNo, p.bill?.invoiceNo, p.bill?.note,
        p.qty, p.costPrice, r2(p.qty * p.costPrice), fmtDate(p.date), p.date].filter((x) => x != null).join(' ')).includes(s))
      .map((p) => ({ ...p, score: score(p) }))
      .sort((a, b) => b.score - a.score || new Date(b.date) - new Date(a.date) || String(b.id).localeCompare(String(a.id)));
  }, [data, q, range]);
  // While searching, show only the latest purchase of each matching item.
  const latestEach = useMemo(() => {
    const newer = (a, b) => new Date(a.date) - new Date(b.date) || String(a.id).localeCompare(String(b.id));
    const m = new Map();
    for (const p of all) {
      const k = p.itemId || p.id;
      const cur = m.get(k);
      if (!cur) m.set(k, { row: p, score: p.score });
      else {
        if (newer(p, cur.row) > 0) cur.row = p;
        cur.score = Math.max(cur.score, p.score);
      }
    }
    return [...m.values()].sort((a, b) => b.score - a.score || newer(b.row, a.row)).map((x) => x.row);
  }, [all]);
  const searching = !!norm(q);
  const rows = searching && !seeAll ? latestEach : all;
  const totals = useMemo(() => ({
    value: r2(rows.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.costPrice) || 0), 0)),
    count: rows.length,
    suppliers: new Set(rows.map((p) => p.supplierName).filter(Boolean)).size,
  }), [rows]);
  const doDelete = async () => {
    const p = deleting;
    setDeleting(null);
    await mutate(() => api.deletePurchase(p.id), 'Purchase deleted').catch(() => {});
  };
  const actions = (p) => (
    <>
      <button className="btn btn-ghost btn-sm" title="Open — edit, print, pay, receiving" onClick={() => navigate(`/purchase/${p.id}`)}><Eye size={14} /></button>
      <button className="btn btn-ghost btn-sm" title="Edit purchase" onClick={() => setEditing(data.purchases.find((x) => x.id === p.id) || p)}><Pencil size={14} /></button>
      <button className="btn btn-ghost btn-sm" title="Delete purchase" onClick={() => setDeleting(p)}><Trash2 size={14} /></button>
    </>
  );
  const toExcel = () => {
    exportCSV('Purchases', ['Date', 'Item', 'Supplier', 'Qty', 'Cost Price', 'Total', 'Paid from', 'Note'],
      rows.map((p) => [fmtDate(p.date), p.item?.name || '', p.supplierName, p.qty, Number(p.costPrice).toFixed(2), r2(p.qty * p.costPrice).toFixed(2), p.method || '', p.note || '']),
      [`${settings.shopName} — Purchases`, `Total purchased: ${money(totals.value)}`]);
    toast('Purchases exported');
  };
  return (
    <>
      <PageHead title="Purchases" subtitle={`${totals.count} purchases · ${money(totals.value)} in the selected period`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search item, supplier, PUR no, note…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={HandCoins} onClick={() => setAdvOpen(true)}>Give Advance</Button>
        <Button icon={Plus} onClick={() => setQuick(true)}>Quick Purchase</Button>
        <ImportButton kind="purchases" />
        <Button variant="primary" icon={Plus} onClick={() => setBillOpen(true)}>Purchase Bill</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Total Purchased" value={money(totals.value)} icon={ShoppingCart} tone="#1F2937" />
        <Stat label="Purchases" value={totals.count} icon={ShoppingCart} tone="#F59E0B" />
        <Stat label="Suppliers" value={totals.suppliers} icon={ShoppingCart} tone="#16A34A" />
      </div>
      <div className="row mb-2" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
        {searching && (
          <>
            <span className="spacer" />
            <span className="small muted">
              {seeAll || latestEach.length === all.length
                ? `${all.length} match${all.length === 1 ? '' : 'es'}`
                : `Latest of each item: ${latestEach.length} item${latestEach.length === 1 ? '' : 's'} (${all.length} records)`}
            </span>
            <label className="row" style={{ gap: 7, cursor: 'pointer', fontWeight: 600 }}>
              <input type="checkbox" checked={seeAll} onChange={(e) => setSeeAll(e.target.checked)} style={{ width: 17, height: 17 }} /> See all
            </label>
          </>
        )}
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Date</th><th>Item</th><th>Supplier</th><th className="r">Qty</th><th className="r">Cost price</th><th className="r">Total</th><th>Paid from</th><th>Note</th><th style={{ width: 116 }} /></tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/purchase/${p.id}`)}>
                      <td className="nowrap">{fmtDate(p.date)}</td>
                      <td style={{ fontWeight: 500 }}>{p.item?.name || 'Item'}</td>
                      <td>{p.supplierName || <span className="muted">—</span>}</td>
                      <td className="r">{p.qty} {p.item?.baseUnit || ''}<ReceivedTag p={p} /></td>
                      <td className="r"><Money value={p.costPrice} /></td>
                      <td className="r strong"><Money value={r2(p.qty * p.costPrice)} /></td>
                      <td className="small">{p.method || '—'}</td>
                      <td className="small muted">{p.note || '—'}</td>
                      <td className="nowrap" onClick={(e) => e.stopPropagation()}>{actions(p)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={5}>{totals.count} purchases</td><td className="r">{money(totals.value)}</td><td colSpan={3} /></tr></tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((p) => (
                <div key={p.id} className="mcard" onClick={() => navigate(`/purchase/${p.id}`)}>
                  <div className="top"><span className="name">{p.item?.name || 'Item'}</span><span className="amt">{money(r2(p.qty * p.costPrice))}</span></div>
                  <div className="meta">
                    <span>{p.qty} {p.item?.baseUnit} @ {money(p.costPrice)} <ReceivedTag p={p} /></span>
                    {p.supplierName && <span>{p.supplierName}</span>}
                    <span>{fmtDate(p.date)}</span>
                    {p.bill && <span>{p.bill.purchaseNo}</span>}
                  </div>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 4, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>{actions(p)}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={ShoppingCart}
            title="No purchases recorded"
            message="Record stock coming in from suppliers. This sets each item's cost price, which profit tracking depends on."
            action={<Button variant="primary" icon={Plus} onClick={() => setQuick(true)}>Record a purchase</Button>}
          />
        )}
      </Card>
      <QuickPurchaseModal open={quick} onClose={() => setQuick(false)} />
      <PurchaseBillModal open={billOpen} onClose={() => setBillOpen(false)} />
      <SupplierPaymentModal open={advOpen} advance onClose={() => setAdvOpen(false)} />
      <EditPurchaseModal purchase={editing} onClose={() => setEditing(null)} />
      <Confirm
        open={!!deleting}
        danger
        title="Delete this purchase?"
        message={deleting ? `${deleting.qty} × ${deleting.item?.name || 'item'} @ ${money(deleting.costPrice)} = ${money(r2(deleting.qty * deleting.costPrice))}. The stock comes back out`
          + (deleting.bill ? ` and ${deleting.bill.purchaseNo}'s total drops by that amount. If this is its only line, the whole purchase bill is removed; any payment made on it stays on the supplier account.` : '.') : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
