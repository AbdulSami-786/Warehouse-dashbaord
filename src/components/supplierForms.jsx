import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, today, fmtDate } from '../lib/format.js';
import { itemStock, supplierBalance, supplierBillStates } from '../lib/calc.js';
import {
  Button, Field, Input, Modal, Select, Textarea, Typeahead,
} from './ui.jsx';
import { ItemForm } from './forms.jsx';

export function SupplierForm({ supplier = null, initialName = '', onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    name: String(supplier?.name ?? initialName ?? ''),
    phone: String(supplier?.phone ?? ''),
    address: String(supplier?.address ?? ''),
    openingBalance: supplier?.openingBalance ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Supplier name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveSupplier({
        id: supplier?.id, name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim(),
        openingBalance: Number(f.openingBalance) || 0,
      }), supplier ? 'Supplier updated' : 'Supplier added');
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Supplier name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. City Wholesale Supply" />
        </Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" /></Field>
        <Field label="Opening balance" hint="What you already owe them. Enter a minus amount if they hold an advance from you.">
          <Input type="number" step="any" value={f.openingBalance} onChange={set('openingBalance')} placeholder="0" />
        </Field>
        <Field label="Address" className="full">
          <Textarea value={f.address} onChange={set('address')} rows={2} placeholder="Market or area" />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{supplier ? 'Update Supplier' : 'Add Supplier'}</Button>
      </div>
    </form>
  );
}

/** Fix one purchase line (or a standalone purchase). */
export function EditPurchaseModal({ purchase, onClose }) {
  const { data, activeItems, methods, mutate } = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (purchase) {
      setF({
        itemId: purchase.itemId, qty: String(purchase.qty ?? ''), costPrice: String(purchase.costPrice ?? ''),
        supplierName: purchase.supplierName || '', date: purchase.date || '', method: purchase.method || 'Cash', note: purchase.note || '',
      });
    }
  }, [purchase]);
  const bill = purchase?.purchaseBillId ? (data.purchaseBills || []).find((b) => b.id === purchase.purchaseBillId) : null;
  const items = useMemo(() => {
    const it = data.items.find((i) => i.id === purchase?.itemId);
    return it && !activeItems.some((i) => i.id === it.id) ? [it, ...activeItems] : activeItems;
  }, [data.items, activeItems, purchase]);
  const suppliers = useMemo(() => [...new Set(data.purchases.map((p) => p.supplierName).filter(Boolean))].sort(), [data.purchases]);
  if (!purchase || !f) return null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const total = r2((Number(f.qty) || 0) * (Number(f.costPrice) || 0));
  const ok = f.itemId && Number(f.qty) > 0 && Number(f.costPrice) >= 0 && f.costPrice !== '';
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.updatePurchase({
        id: purchase.id, itemId: f.itemId, qty: Number(f.qty), costPrice: Number(f.costPrice), note: f.note,
        ...(bill ? {} : { supplierName: f.supplierName, date: f.date, method: f.method }),
      }), 'Purchase updated');
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={bill ? `Edit line — ${bill.purchaseNo}` : 'Edit Purchase'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Save {total > 0 ? money(total) : ''}</Button></>}
    >
      {bill && (
        <p className="small muted mb-2">
          Part of purchase {bill.purchaseNo}. Its supplier, date and payment stay as they are; the bill total is worked out again from its lines.
        </p>
      )}
      <Field label="Item">
        <Typeahead items={items} value={f.itemId} onChange={(v) => setF((x) => ({ ...x, itemId: v }))} getLabel={(i) => i.name} getSub={(i) => `${i.category || 'Uncategorised'} · current cost ${money(i.costPrice)}`} placeholder="Search item…" />
      </Field>
      <div className="form-grid">
        <Field label="Quantity"><Input type="number" min="0" step="any" value={f.qty} onChange={set('qty')} autoFocus /></Field>
        <Field label="Cost price per unit"><Input type="number" min="0" step="any" value={f.costPrice} onChange={set('costPrice')} /></Field>
        {!bill && (
          <>
            <Field label="Supplier">
              <Input value={f.supplierName} onChange={set('supplierName')} list="supplier-edit-list" placeholder="Supplier name" />
              <datalist id="supplier-edit-list">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
            <Field label="Paid from"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
          </>
        )}
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="Optional" /></Field>
      </div>
      <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontWeight: 700 }}>Line total</span><span className="spacer" />
        <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
      </div>
    </Modal>
  );
}

const blankPayment = (purchaseBillId = '', supplierId = '') => ({ supplierId, purchaseBillId, amount: '', method: 'Cash', date: today(), note: '' });

/** Pay a supplier, against one purchase or on account — or give an advance. */
export function SupplierPaymentModal({ open, onClose, supplierId = '', purchaseBillId = '', advance = false }) {
  const { data, methods, mutate } = useApp();
  const [f, setF] = useState(() => blankPayment(purchaseBillId, supplierId));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF(blankPayment(advance ? '' : purchaseBillId, supplierId));
  }, [open, purchaseBillId, supplierId, advance]);
  const sid = supplierId || f.supplierId;
  const suppliers = useMemo(() => data.suppliers.filter((s) => s.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)), [data.suppliers]);
  const balance = supplierBalance(sid, data);
  const open_ = useMemo(() => supplierBillStates(sid, data).filter((b) => b.status !== 'voided' && b.due > 0), [sid, data]);
  const picked = open_.find((b) => b.id === f.purchaseBillId);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amt = Number(f.amount) || 0;
  const extra = r2(amt - Math.max(0, balance));
  const save = async () => {
    if (busy || !(amt > 0) || !sid) return;
    setBusy(true);
    try {
      await mutate(() => api.addSupplierPayment({
        supplierId: sid, purchaseBillId: advance ? '' : f.purchaseBillId, amount: amt, method: f.method, date: f.date, note: f.note, isAdvance: advance,
      }), advance ? 'Advance to supplier recorded' : 'Payment to supplier recorded');
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={advance ? 'Give Advance to Supplier' : 'Pay Supplier'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!(amt > 0) || !sid}>{advance ? 'Give' : 'Pay'} {amt > 0 ? money(amt) : ''}</Button></>}
    >
      {!supplierId && (
        <Field label="Supplier">
          <Select value={f.supplierId} onChange={set('supplierId')}>
            <option value="">Select a supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
      {sid && (
        <div style={{ padding: 12, marginBottom: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span>{balance >= 0 ? 'You owe this supplier' : 'Advance they hold'}</span>
          <span className="spacer" />
          <span className={`money ${balance > 0 ? 'neg' : 'pos'}`} style={{ fontSize: 16 }}>{money(Math.abs(balance))}</span>
        </div>
      )}
      {advance && sid && balance > 0.004 && (
        <p className="small muted mb-2">You still owe this supplier {money(balance)}. An advance first clears that, and only the rest is held by the supplier as an advance.</p>
      )}
      <div className="form-grid">
        {!advance && (
          <Field label="Against purchase" className="full" hint={picked ? `${money(picked.due)} still due on this purchase` : 'On account settles the oldest dues first'}>
            <Select value={f.purchaseBillId} onChange={set('purchaseBillId')}>
              <option value="">On account (no particular bill)</option>
              {open_.map((b) => <option key={b.id} value={b.id}>{b.purchaseNo} · {fmtDate(b.date)} · due {money(b.due)}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Amount" hint={!advance && amt > 0 && extra > 0.004 ? `${money(extra)} will be held by the supplier as an advance` : undefined}>
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} placeholder="0" autoFocus />
        </Field>
        <Field label="Paid from"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder={advance ? 'e.g. advance for next order' : 'Optional'} /></Field>
      </div>
    </Modal>
  );
}

const blankReturn = () => ({ purchaseBillId: '', itemId: '', qty: '', value: '', date: today(), note: '' });

export function SupplierReturnModal({ open, onClose, supplierId, purchaseBillId = '' }) {
  const { data, activeItems, mutate } = useApp();
  const [f, setF] = useState(blankReturn);
  const [busy, setBusy] = useState(false);
  const [valueEdited, setValueEdited] = useState(false);
  useEffect(() => {
    if (open) {
      setF({ ...blankReturn(), purchaseBillId });
      setValueEdited(false);
    }
  }, [open, purchaseBillId]);
  const bills = useMemo(() => supplierBillStates(supplierId, data).filter((b) => b.status !== 'voided'), [supplierId, data]);
  const billLines = useMemo(() => data.purchases.filter((p) => f.purchaseBillId && p.purchaseBillId === f.purchaseBillId), [data.purchases, f.purchaseBillId]);
  const choices = f.purchaseBillId ? activeItems.filter((i) => billLines.some((l) => l.itemId === i.id)) : activeItems;
  const unitCost = () => {
    const l = billLines.find((x) => x.itemId === f.itemId);
    return l ? Number(l.costPrice) || 0 : Number(data.items.find((i) => i.id === f.itemId)?.costPrice) || 0;
  };
  const left = useMemo(() => {
    if (!f.purchaseBillId || !f.itemId) return null;
    const bought = billLines.filter((l) => l.itemId === f.itemId).reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const back = data.supplierReturns.filter((r) => r.purchaseBillId === f.purchaseBillId && r.itemId === f.itemId).reduce((s, r) => s + (Number(r.qty) || 0), 0);
    return r2(bought - back);
  }, [billLines, data.supplierReturns, f.purchaseBillId, f.itemId]);
  const setQty = (v) => setF((x) => ({ ...x, qty: v, value: valueEdited ? x.value : Number(v) > 0 ? String(r2(Number(v) * unitCost())) : '' }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const q = Number(f.qty) || 0;
  const tooMany = left !== null && q > left + 0.0001;
  const ok = f.itemId && q > 0 && !tooMany && Number(f.value) >= 0;
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.addSupplierReturn({
        supplierId, purchaseBillId: f.purchaseBillId, itemId: f.itemId, qty: q, value: Number(f.value) || 0, date: f.date, note: f.note,
      }), 'Return to supplier recorded');
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title="Return Goods to Supplier"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Record Return</Button></>}
    >
      <div className="form-grid">
        <Field label="From purchase" className="full" hint="Optional — pick it to return at the price you paid">
          <Select value={f.purchaseBillId} onChange={(e) => { setF((x) => ({ ...x, purchaseBillId: e.target.value, itemId: '', qty: '', value: '' })); setValueEdited(false); }}>
            <option value="">Not linked to a purchase bill</option>
            {bills.map((b) => <option key={b.id} value={b.id}>{b.purchaseNo} · {fmtDate(b.date)} · {money(b.total)}</option>)}
          </Select>
        </Field>
        <Field
          label="Item"
          className="full"
          hint={f.itemId ? (left !== null ? `${left} left to return from this purchase` : `In stock: ${itemStock(f.itemId, data)}`) : undefined}
        >
          <Typeahead
            items={choices}
            value={f.itemId}
            onChange={(v) => { setF((x) => ({ ...x, itemId: v || '', qty: '', value: '' })); setValueEdited(false); }}
            getLabel={(i) => i.name}
            getSub={(i) => `cost ${money(i.costPrice)}`}
            placeholder="Search item…"
          />
        </Field>
        <Field label="Quantity" error={tooMany ? `Only ${left} left on this purchase` : undefined}>
          <Input type="number" min="0" step="any" value={f.qty} placeholder="0" onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Value" hint="Taken off what you owe the supplier">
          <Input type="number" min="0" step="any" value={f.value} placeholder="0" onChange={(e) => { setValueEdited(true); set('value')(e); }} />
        </Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="e.g. damaged in transit" /></Field>
      </div>
    </Modal>
  );
}

let lineSeq = 0;
const newLine = () => ({ key: ++lineSeq, itemId: '', qty: '', costPrice: '' });
const blankBill = (supplierId = '') => ({
  supplierId, invoiceNo: '', date: today(), note: '', lines: [newLine()], paidNow: '', method: 'Cash', notReceived: false,
});

/** A supplier's invoice: several items bought at once, paid now or on credit. */
export function PurchaseBillModal({ open, onClose, supplierId = '', onSaved }) {
  const { data, activeItems, activeSuppliers, methods, mutate, toast } = useApp();
  const [f, setF] = useState(() => blankBill(supplierId));
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(null);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (open) setF(blankBill(supplierId));
  }, [open, supplierId]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const updLine = (key, patch) => setF((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const [focusKey, setFocusKey] = useState(null);
  const focusRef = useRef(null);
  const addLine = () => {
    const l = newLine();
    setF((x) => ({ ...x, lines: [...x.lines, l] }));
    setFocusKey(l.key);
  };
  useEffect(() => {
    if (focusKey) {
      focusRef.current?.focus();
      setFocusKey(null);
    }
  }, [focusKey]);
  const listening = open && !adding;
  useEffect(() => {
    if (!listening) return undefined;
    const onKey = (e) => {
      if (e.code !== 'KeyA' || !e.shiftKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat) return;
      e.preventDefault();
      addLine();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);
  const pick = (key, itemId, item) => {
    const it = item || data.items.find((i) => i.id === itemId);
    updLine(key, { itemId: itemId || '', costPrice: it ? String(it.costPrice || '') : '' });
  };
  const total = useMemo(() => r2(f.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.costPrice) || 0), 0)), [f.lines]);
  const ready = f.lines.filter((l) => l.itemId && Number(l.qty) > 0);
  const paid = Number(f.paidNow) || 0;
  const balance = f.supplierId ? supplierBalance(f.supplierId, data) : 0;
  const ok = f.supplierId && ready.length > 0 && paid >= 0 && paid <= total + 0.004;
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      const bill = await mutate(() => api.savePurchaseBill({
        supplierId: f.supplierId, invoiceNo: f.invoiceNo, date: f.date, note: f.note,
        lines: ready.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), costPrice: Number(l.costPrice) || 0 })),
        paidNow: paid, method: f.method, received: !f.notReceived,
      }), 'Purchase saved');
      setF(blankBill(supplierId));
      onSaved?.(bill);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        open={open && !adding}
        title="New Purchase Bill"
        onClose={onClose}
        wide
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Save {total > 0 ? money(total) : 'Purchase'}</Button></>}
      >
        <div className="form-grid">
          <Field
            label="Supplier"
            className="full"
            hint={f.supplierId ? (balance > 0 ? `You currently owe ${money(balance)}`
              : balance < 0 ? `They hold ${money(-balance)} advance from you — this purchase uses it first` : 'Account is clear') : undefined}
          >
            <Typeahead
              items={activeSuppliers}
              value={f.supplierId}
              onChange={(v) => setF((x) => ({ ...x, supplierId: v || '' }))}
              getLabel={(s) => s.name}
              getSub={(s) => s.phone || ''}
              placeholder="Search supplier…"
              autoFocus={!supplierId}
              onAddNew={(n) => { setNewName(n); setAdding('supplier'); }}
              addNewLabel="Add new supplier"
            />
          </Field>
          <Field label="Supplier's invoice no." hint="Optional"><Input value={f.invoiceNo} onChange={set('invoiceNo')} placeholder="e.g. INV-2231" /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        </div>
        <div className="pb-lines">
          <div className="pb-line pb-head">
            <span>#</span><span>Item</span><span className="r">Qty</span><span className="r">Cost / unit</span><span className="r">Total</span><span />
          </div>
          {f.lines.map((l, i) => {
            const it = data.items.find((x) => x.id === l.itemId);
            const lineTotal = r2((Number(l.qty) || 0) * (Number(l.costPrice) || 0));
            return (
              <div key={l.key} className="pb-line">
                <span className="pb-no">{i + 1}</span>
                <div className="pb-item">
                  <Typeahead
                    items={activeItems}
                    value={l.itemId}
                    onChange={(v, x) => pick(l.key, v, x)}
                    getLabel={(x) => x.name}
                    getSub={(x) => `Stock ${itemStock(x.id, data)} ${x.baseUnit || ''} · cost ${money(x.costPrice)}`}
                    placeholder="Search item…"
                    focusRef={l.key === focusKey ? focusRef : null}
                    onAddNew={(n) => { setNewName(n); setAdding(l.key); }}
                    addNewLabel="Add new item"
                  />
                  {it && <div className="pb-sub">In stock: {itemStock(it.id, data)} {it.baseUnit || ''} · last cost {money(it.costPrice)}</div>}
                </div>
                <label className="pb-field">
                  <span className="pb-label">Qty{it?.baseUnit ? ` (${it.baseUnit})` : ''}</span>
                  <Input type="number" min="0" step="any" value={l.qty} placeholder="0" onChange={(e) => updLine(l.key, { qty: e.target.value })} />
                </label>
                <label className="pb-field">
                  <span className="pb-label">Cost / unit</span>
                  <Input type="number" min="0" step="any" value={l.costPrice} placeholder="0" onChange={(e) => updLine(l.key, { costPrice: e.target.value })} />
                </label>
                <div className="pb-total"><span className="pb-label">Total</span><span className="money">{money(lineTotal)}</span></div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm pb-del"
                  title="Remove item"
                  disabled={f.lines.length === 1}
                  onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((y) => y.key !== l.key) }))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" className="pb-add" onClick={addLine} title="Add another item (Ctrl+Shift+A)">
          <Plus size={15} /> Add another item <kbd className="kbd-hint">Ctrl+Shift+A</kbd>
        </button>
        <div style={{ margin: '14px 0', padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>Purchase total</span><span className="spacer" />
          <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
        </div>
        <div className="form-grid">
          <Field label="Paid now" hint={paid > total + 0.004 ? 'Cannot be more than the bill total' : total > 0 ? `Left on account: ${money(r2(total - paid))}` : 'Leave 0 to buy on credit'}>
            <Input type="number" min="0" step="any" value={f.paidNow} onChange={set('paidNow')} placeholder="0" />
          </Field>
          <Field label="Paid from"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
          <Field label="Note" className="full"><Input value={f.note} onChange={set('note')} placeholder="Optional" /></Field>
        </div>
        <label className="row" style={{ gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" checked={f.notReceived} onChange={(e) => setF((x) => ({ ...x, notReceived: e.target.checked }))} style={{ width: 17, height: 17, marginTop: 1, flexShrink: 0 }} />
          <span>
            <span style={{ fontWeight: 600 }}>Goods not received yet</span>
            <span className="small muted" style={{ display: 'block' }}>
              Tick if the supplier has not sent the goods. Tick items off from the supplier's khata as they arrive, some now and the rest later.
            </span>
          </span>
        </label>
      </Modal>
      <Modal open={adding === 'supplier'} title="Add New Supplier" onClose={() => setAdding(null)}>
        <SupplierForm initialName={newName} onSaved={(s) => { setAdding(null); if (s?.id) setF((x) => ({ ...x, supplierId: s.id })); }} onCancel={() => setAdding(null)} />
      </Modal>
      <Modal open={adding !== null && adding !== 'supplier'} title="Add New Item" onClose={() => setAdding(null)}>
        <ItemForm
          initialName={newName}
          onSaved={(it) => {
            const key = adding;
            setAdding(null);
            if (it?.id) {
              pick(key, it.id, it);
              toast(`Item "${it.name}" added`);
            }
          }}
          onCancel={() => setAdding(null)}
        />
      </Modal>
    </>
  );
}
