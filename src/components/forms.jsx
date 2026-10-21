import { useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck, Info, Plus, Printer, FileDown, Receipt, RotateCcw, Save, Send, Trash2,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { UNITS } from '../lib/config.js';
import {
  money, r2, today, addDays, fmtDate, phoneKey, uid, qtySummary, whatsappUrl,
} from '../lib/format.js';
import {
  billState, billStates, collectedPayments, isOpeningBill, payableNow, methodBalances,
} from '../lib/calc.js';
import { printReport } from '../lib/exporters.js';
import {
  Button, Empty, Field, Input, Modal, Money, Pill, Select, Textarea,
} from './ui.jsx';

export function blankCheque(date) {
  return { accountHolder: '', chequeNo: '', bankName: '', dateIssued: date, dateDue: addDays(date, 7) };
}

export function ChequeFields({ value, onChange }) {
  if (!value) return null;
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 11, background: 'var(--surface-2, #FCFCFD)', marginTop: 8 }}>
      <div className="row" style={{ gap: 7, marginBottom: 7 }}>
        <Input placeholder="Account holder name" aria-label="Account holder name" value={value.accountHolder || ''} onChange={set('accountHolder')} />
      </div>
      <div className="row" style={{ gap: 7, marginBottom: 7 }}>
        <Input placeholder="Cheque number" aria-label="Cheque number" value={value.chequeNo || ''} onChange={set('chequeNo')} />
        <Input placeholder="Bank name" aria-label="Bank name" value={value.bankName || ''} onChange={set('bankName')} />
      </div>
      <div className="row" style={{ gap: 7 }}>
        <div style={{ flex: 1 }}>
          <label className="small muted">Issued</label>
          <Input type="date" value={value.dateIssued || ''} onChange={set('dateIssued')} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="small muted">Clears on</label>
          <Input type="date" value={value.dateDue || ''} onChange={set('dateDue')} />
        </div>
      </div>
      <div className="small muted mt-1">
        <Info size={11} style={{ verticalAlign: -1 }} /> Not counted as paid until you mark it Cleared.
      </div>
    </div>
  );
}

export function PartyForm({ party = null, initialName = '', onSaved, onCancel }) {
  const { data, mutate, settings } = useApp();
  // The balance carried over from the paper books sits on a bill of its own.
  const openingBill = party ? (data?.bills || []).find((b) => b.partyId === party.id && isOpeningBill(b) && b.status !== 'voided') : null;
  const [f, setF] = useState({
    name: String(party?.name ?? initialName ?? ''),
    phone: String(party?.phone ?? ''),
    address: String(party?.address ?? ''),
    creditLimit: party?.creditLimit ?? '',
    defaultDueDays: party?.defaultDueDays ?? settings.defaultCreditDays,
    openingBalance: openingBill ? openingBill.totalAmount : '',
    openingDate: openingBill ? String(openingBill.date).slice(0, 10) : today(),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ph = phoneKey(f.phone);
  const dup = ph ? (data?.parties || []).find((p) => p.id !== party?.id && phoneKey(p.phone) === ph) : null;
  const phoneErr = dup ? `This mobile number is already registered on party "${dup.name}"` : '';

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Party name is required');
    if (phoneErr) return;
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveParty({
        id: party?.id, name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim(),
        creditLimit: Number(f.creditLimit) || 0, defaultDueDays: Number(f.defaultDueDays) || settings.defaultCreditDays,
        openingBalance: Number(f.openingBalance) || 0, openingDate: f.openingDate,
      }), party ? 'Party updated' : undefined);
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Party name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Ahmed Bhai Kiryana" />
        </Field>
        <Field label="Phone" error={phoneErr}>
          <Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" />
        </Field>
        <Field label="Credit limit" hint="0 means no limit">
          <Input type="number" min="0" step="any" value={f.creditLimit} onChange={set('creditLimit')} placeholder="0" />
        </Field>
        <Field label="Default credit days" hint="Used to set each bill's due date">
          <Input type="number" min="0" value={f.defaultDueDays} onChange={set('defaultDueDays')} />
        </Field>
        <Field label="Opening balance" hint="What this party already owes you from your previous books — 0 if nothing">
          <Input type="number" min="0" step="any" value={f.openingBalance} onChange={set('openingBalance')} placeholder="0" />
        </Field>
        <Field label="Balance as on" hint="The date of that balance">
          <Input type="date" value={f.openingDate} onChange={set('openingDate')} />
        </Field>
        <Field label="Address" className="full">
          <Textarea value={f.address} onChange={set('address')} rows={2} placeholder="Shop address or area" />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{party ? 'Update Party' : 'Add Party'}</Button>
      </div>
    </form>
  );
}

export function ItemForm({ item = null, initialName = '', onSaved, onCancel }) {
  const { mutate, data, access } = useApp();
  const categories = [...new Set(data.items.map((i) => i.category).filter(Boolean))];
  const [f, setF] = useState({
    name: String(item?.name ?? initialName ?? ''),
    baseUnit: item?.baseUnit ?? 'Piece',
    altUnit: item?.altUnit ?? '',
    conversionRate: item?.conversionRate ?? '',
    category: String(item?.category ?? ''),
    costPrice: item?.costPrice ?? '',
    openingStock: item?.openingStock ?? '',
    lowStockAlert: item?.lowStockAlert ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Item name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveItem({
        id: item?.id, name: f.name.trim(), baseUnit: f.baseUnit, altUnit: f.altUnit,
        conversionRate: Number(f.conversionRate) || 0, category: f.category.trim(),
        // Without sight of the cost, the form leaves it alone rather than clearing it.
        ...(access.seesCost ? { costPrice: Number(f.costPrice) || 0 } : {}), openingStock: Number(f.openingStock) || 0,
        lowStockAlert: Number(f.lowStockAlert) || 0,
      }), item ? 'Item updated' : undefined);
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Item name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Sugar" />
        </Field>
        <Field label="Base unit" hint="How you normally count this item">
          <Select value={f.baseUnit} onChange={set('baseUnit')} options={UNITS} />
        </Field>
        <Field label="Category">
          <Input value={f.category} onChange={set('category')} list="cat-list" placeholder="e.g. Grocery" />
          <datalist id="cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Alternate unit" hint="Optional — e.g. Carton">
          <Select value={f.altUnit} onChange={set('altUnit')}>
            <option value="">None</option>
            {UNITS.filter((u) => u !== f.baseUnit).map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
        <Field label="Conversion rate" hint={f.altUnit ? `1 ${f.altUnit} = how many ${f.baseUnit}?` : 'Set an alternate unit first'}>
          <Input type="number" min="0" step="any" value={f.conversionRate} onChange={set('conversionRate')} disabled={!f.altUnit} placeholder="e.g. 24" />
        </Field>
        <Field className="cost-only" label="Cost price" hint="Used for profit tracking">
          <Input type="number" min="0" step="any" value={f.costPrice} onChange={set('costPrice')} placeholder="0" />
        </Field>
        <Field label="Low stock alert" hint="Warn when stock falls to this level">
          <Input type="number" min="0" step="any" value={f.lowStockAlert} onChange={set('lowStockAlert')} placeholder="0" />
        </Field>
        {!item && (
          <Field label="Opening stock" className="full" hint="Current quantity on hand in the shop, if any">
            <Input type="number" min="0" step="any" value={f.openingStock} onChange={set('openingStock')} placeholder="0" />
          </Field>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{item ? 'Update Item' : 'Add Item'}</Button>
      </div>
    </form>
  );
}

function TotalRow({ label, value, showSign = false, muted = false, tone }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
      <span className={muted ? 'muted' : ''} style={{ fontSize: 13 }}>{label}</span>
      <span className="spacer" />
      <span className="money" style={{ color: tone, fontSize: 13 }}>{money(value, { showSign })}</span>
    </div>
  );
}

/** On-screen receipt shown after saving a bill, and on the shared ledger page. */
export function BillPreview({
  open, onClose, bill, lines = [], payments = [], cheques = [], returns = [], itemName = (x) => x,
  party, shopName, readOnly = false, onPrint, onPDF,
}) {
  if (!bill) return null;
  const live = payments.filter((p) => !p.reversed);
  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const summary = qtySummary(lines);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Bill ${bill.billNo}`}
      wide
      footer={readOnly ? <Button onClick={onClose}>Close</Button> : (
        <>
          <Button onClick={onClose}>Close</Button>
          {onPDF && <Button icon={FileDown} onClick={onPDF}>PDF</Button>}
          {onPrint && <Button variant="primary" icon={Printer} onClick={onPrint}>Print</Button>}
        </>
      )}
    >
      <div className="receipt-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, paddingBottom: 12, marginBottom: 14, borderBottom: '2px solid var(--primary)', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{shopName}</div>
          {party?.name && <div className="small muted">Billed to: {party.name}</div>}
          {party?.phone && <div className="small muted">{party.phone}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{bill.billNo}</div>
          <div className="small muted">{fmtDate(bill.date)}</div>
          <div style={{ marginTop: 4 }}><Pill status={bill.status} /></div>
        </div>
      </div>
      {lines.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th style={{ width: 32 }}>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id || i}>
                  <td className="muted">{i + 1}</td>
                  <td style={{ fontWeight: 500 }}>{itemName(l.itemId)}</td>
                  <td className="r">{l.qty}</td>
                  <td>{l.unit}</td>
                  <td className="r"><Money value={l.price} /></td>
                  <td className="r strong"><Money value={(Number(l.qty) || 0) * (Number(l.price) || 0)} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{lines.length} item{lines.length === 1 ? '' : 's'}</td>
                <td className="r" colSpan={2} style={{ fontWeight: 700 }}>{summary}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : <Empty icon={Receipt} title="No item detail" message="This bill has no line items recorded." />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <div className="receipt-totals" style={{ minWidth: 260 }}>
          {summary && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
              <span style={{ fontSize: 13 }}>Total quantity</span>
              <span className="spacer" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{summary}</span>
            </div>
          )}
          <TotalRow label="Subtotal" value={subtotal} />
          {Number(bill.roundOff) !== 0 && <TotalRow label="Round off" value={bill.roundOff} showSign muted />}
          {bill.returned > 0 && <TotalRow label="Returns" value={-bill.returned} tone="var(--danger)" />}
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', marginTop: 4, borderTop: '2px solid var(--border-strong)' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Total</span>
            <span className="spacer" />
            <span className="money" style={{ fontSize: 17 }}>{money(bill.net)}</span>
          </div>
          <TotalRow label="Paid" value={bill.paid} tone="var(--success)" />
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontWeight: 700 }}>Balance due</span>
            <span className="spacer" />
            <span className="money" style={{ fontSize: 16, color: bill.due > 0 ? 'var(--danger)' : 'var(--success)' }}>{money(bill.due)}</span>
          </div>
          {bill.due > 0 && bill.dueDate && (
            <div className="small muted" style={{ textAlign: 'right', marginTop: 2 }}>Payable by {fmtDate(bill.dueDate)}</div>
          )}
        </div>
      </div>
      {live.length > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 18, marginBottom: 7 }}>Payments received</h3>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {live.map((p) => {
                  const c = cheques.find((x) => x.paymentId === p.id);
                  return (
                    <tr key={p.id}>
                      <td className="nowrap small">{fmtDate(p.date)}</td>
                      <td>
                        {p.method}
                        {c && (
                          <div className="small muted">
                            {c.chequeNo}{c.bankName ? ` · ${c.bankName}` : ''}{c.accountHolder ? ` · ${c.accountHolder}` : ''}
                            {c.status !== 'cleared' && (
                              <> · <Pill status={c.status === 'bounced' ? 'bounced' : 'partial'} label={c.status === 'bounced' ? 'Bounced' : 'Pending'} /></>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small muted">{p.note || '—'}</td>
                      <td className="r strong"><Money value={p.amount} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {returns.length > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 18, marginBottom: 7 }}>Returns</h3>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Item</th><th className="r">Qty</th><th className="r">Value</th></tr></thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap small">{fmtDate(r.date)}</td>
                    <td>{itemName(r.itemId)}</td>
                    <td className="r">{r.qty}</td>
                    <td className="r strong"><Money value={r.valueAdjusted} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {bill.note && <div className="small muted" style={{ marginTop: 16 }}><strong>Note:</strong> {bill.note}</div>}
    </Modal>
  );
}

const newPay = () => ({ key: uid('p'), method: 'Cash', amount: '', cheque: null });

/** Record one or more payments against a single bill. */
export function PaymentModal({ open, onClose, bill, state, party }) {
  const { methods, mutate, refresh } = useApp();
  const [date, setDate] = useState(today());
  const [pays, setPays] = useState([newPay()]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingCheques = state?.pendingCheques ?? 0;
  const room = state ? payableNow(state) : 0;
  const total = useMemo(() => r2(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0)), [pays]);
  const over = total > room + 0.004;
  const left = r2(Math.max(0, room - total));
  const upd = (key, patch) => setPays((xs) => xs.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const fill = (key) => {
    const others = r2(pays.filter((p) => p.key !== key).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    upd(key, { amount: String(r2(Math.max(0, room - others))) });
  };
  const reset = () => {
    setPays([newPay()]);
    setNote('');
    setDate(today());
  };
  const close = () => {
    reset();
    onClose?.();
  };
  const save = async () => {
    if (busy) return;
    const real = pays.filter((p) => Number(p.amount) > 0);
    if (!real.length || over) return;
    setBusy(true);
    // Each method is its own payment. If a later one fails, the ones already
    // saved leave the form, so pressing Record again cannot save them twice.
    const saved = [];
    try {
      await mutate(async () => {
        for (const p of real) {
          await api.addPayment({
            billId: bill.id, partyId: bill.partyId, method: p.method, amount: Number(p.amount), date, note, cheque: p.cheque,
          });
          saved.push(p.key);
        }
      });
      close();
    } catch {
      if (saved.length) {
        setPays((xs) => (xs.length > saved.length ? xs.filter((x) => !saved.includes(x.key)) : [newPay()]));
        refresh({ silent: true }).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };
  if (!bill) return null;
  return (
    <Modal
      open={open}
      title={`Add Payment — Bill ${bill.billNo}`}
      onClose={close}
      footer={(
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={total <= 0 || over}>
            Record {total > 0 ? money(total) : 'Payment'}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 16, padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', marginBottom: 16, flexWrap: 'wrap' }}>
        <div><div className="small muted">Party</div><div style={{ fontWeight: 600 }}>{party?.name}</div></div>
        <div><div className="small muted">Bill total</div><Money value={state?.net ?? bill.totalAmount} /></div>
        <div><div className="small muted">Already paid</div><Money value={state?.paid ?? 0} /></div>
        <div><div className="small muted">Balance due</div><span className="money" style={{ color: 'var(--danger)' }}>{money(room)}</span></div>
        {pendingCheques > 0 && (
          <div><div className="small muted">Cheques awaiting clearance</div><span className="money" style={{ color: '#B45309' }}>{money(pendingCheques)}</span></div>
        )}
      </div>
      {over && (
        <div className="small mb-2" style={{ color: 'var(--danger)', fontWeight: 600 }}>
          Total {money(total)} is more than the {money(room)} left on this bill
          {pendingCheques > 0 ? ` after ${money(pendingCheques)} in uncleared cheques` : ''}.
          {' '}Use Payment on the party ledger for the extra — it goes to their other bills or becomes an advance.
        </div>
      )}
      <Field label="Payment date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 5 }}>Payment method{pays.length > 1 ? 's' : ''}</label>
      {pays.map((p) => (
        <div key={p.key} style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 7 }}>
            <Select value={p.method} onChange={(e) => upd(p.key, { method: e.target.value, cheque: e.target.value === 'Cheque' ? blankCheque(date) : null })} options={methods} style={{ width: 132 }} />
            <Input type="number" min="0" step="any" placeholder="0" aria-label="Payment amount" value={p.amount} onChange={(e) => upd(p.key, { amount: e.target.value })} />
            <Button size="sm" onClick={() => fill(p.key)}>Full</Button>
            {pays.length > 1 && (
              <button className="btn btn-ghost btn-icon" onClick={() => setPays((xs) => xs.filter((x) => x.key !== p.key))} aria-label="Remove method">
                <Trash2 size={15} color="var(--danger)" />
              </button>
            )}
          </div>
          {p.method === 'Cheque' && <ChequeFields value={p.cheque} onChange={(c) => upd(p.key, { cheque: c })} />}
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={() => setPays((xs) => [...xs, newPay()])}>Add another method</Button>
      <Field label="Note" className="mt-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional reference" /></Field>
      <div style={{
        padding: 12, borderRadius: 'var(--r-sm)', marginTop: 4,
        background: left > 0 ? 'var(--warning-bg)' : 'var(--success-bg)',
        border: `1px solid ${left > 0 ? '#FDE68A' : '#BBF7D0'}`,
        color: left > 0 ? '#B45309' : '#15803D', display: 'flex', alignItems: 'center', fontWeight: 700,
      }}
      >
        <span>{left > 0 ? 'Remaining after this payment' : 'This clears the bill'}</span>
        <span className="spacer" />
        <span>{money(left > 0 ? left : 0)}</span>
      </div>
    </Modal>
  );
}

/** Goods coming back from a customer against one bill. */
export function ReturnModal({ open, onClose, bill, party }) {
  const { data, mutate } = useApp();
  const [itemId, setItemId] = useState('');
  const [q, setQ] = useState('');
  const [restock, setRestock] = useState(true);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => (bill ? data.billItems.filter((l) => l.billId === bill.id) : []), [bill, data.billItems]);
  const state = useMemo(() => (bill ? billState(bill, data) : null), [bill, data]);
  const line = lines.find((l) => l.itemId === itemId);
  const nameOf = (id) => data.items.find((i) => i.id === id)?.name || 'Item';
  const already = useMemo(() => (!bill || !itemId ? 0
    : data.returns.filter((r) => r.billId === bill.id && r.itemId === itemId).reduce((s, r) => s + (Number(r.qty) || 0), 0)), [bill, itemId, data.returns]);
  const max = line ? r2(Number(line.qty) - already) : 0;
  const value = line ? r2((Number(q) || 0) * Number(line.price)) : 0;
  const tooMany = Number(q) > max;
  const refund = state && state.due <= 0 && value > 0;
  const reset = () => {
    setItemId('');
    setQ('');
    setNote('');
    setRestock(true);
    setDate(today());
  };
  const close = () => {
    reset();
    onClose?.();
  };
  const save = async () => {
    if (busy || !itemId || !(Number(q) > 0) || tooMany) return;
    setBusy(true);
    try {
      await mutate(() => api.addReturn({ billId: bill.id, itemId, qty: Number(q), valueAdjusted: value, restock, date, note }), 'Return recorded');
      close();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  if (!bill) return null;
  return (
    <Modal
      open={open}
      title={`Add Return — Bill ${bill.billNo}`}
      onClose={close}
      footer={(
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={RotateCcw} onClick={save} loading={busy} disabled={!itemId || !(Number(q) > 0) || tooMany}>Record Return</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 16, padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', marginBottom: 16, flexWrap: 'wrap' }}>
        <div><div className="small muted">Party</div><div style={{ fontWeight: 600 }}>{party?.name}</div></div>
        <div><div className="small muted">Bill total</div><Money value={state?.net} /></div>
        <div><div className="small muted">Currently due</div><Money value={state?.due} /></div>
      </div>
      <Field label="Which item is being returned?">
        <Select value={itemId} onChange={(e) => { setItemId(e.target.value); setQ(''); }}>
          <option value="">Select an item from this bill…</option>
          {lines.map((l) => <option key={l.id} value={l.itemId}>{nameOf(l.itemId)} — {l.qty} {l.unit} @ {money(l.price)}</option>)}
        </Select>
      </Field>
      {line && (
        <>
          <div className="form-grid">
            <Field
              label="Quantity returned"
              hint={`Max ${max} ${line.unit}${already > 0 ? ` (${already} already returned)` : ''}`}
              error={tooMany ? `Cannot return more than ${max} ${line.unit}` : ''}
            >
              <Input type="number" min="0" max={max} step="any" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="0" />
            </Field>
            <Field label="Return date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for return (optional)" /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', cursor: 'pointer', marginBottom: 14 }}>
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Add back to stock</div>
              <div className="small muted">Untick if the goods came back damaged and cannot be resold.</div>
            </div>
          </label>
          <div style={{
            padding: 12, borderRadius: 'var(--r-sm)', background: refund ? 'var(--info-bg)' : 'var(--success-bg)',
            border: `1px solid ${refund ? '#BFDBFE' : '#BBF7D0'}`, color: refund ? '#1D4ED8' : '#15803D',
          }}
          >
            <div style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
              <span>Return value</span><span className="spacer" /><span>{money(value)}</span>
            </div>
            {refund && value > 0 && (
              <div className="small" style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <Info size={13} style={{ flex: 'none', marginTop: 1 }} />
                This bill is already paid, so the return creates a {money(value)} refund owed to {party?.name}, visible on their ledger.
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Tick items as delivered (or received), some now and the rest later. */
export function LineProgressModal({ open, title, lines = [], verb = 'Delivered', onClose, onSave }) {
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setVals(Object.fromEntries(lines.map((l) => [l.id, String(l.done)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const val = (id) => Number(vals[id]);
  const bad = (l) => {
    const v = vals[l.id];
    return v === '' || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > l.qty + 0.0001;
  };
  const invalid = lines.some(bad);
  const changes = lines.filter((l) => !bad(l) && Math.abs(val(l.id) - l.done) > 0.0001).map((l) => ({ id: l.id, qty: r2(val(l.id)) }));
  const setAll = (full) => setVals(Object.fromEntries(lines.map((l) => [l.id, String(full ? l.qty : 0)])));
  const save = async () => {
    if (busy || invalid || !changes.length) return;
    setBusy(true);
    try {
      await onSave(changes);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  const fullCount = lines.filter((l) => !bad(l) && val(l.id) >= l.qty - 0.0001).length;
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={invalid || !changes.length}>Save</Button>
        </>
      )}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className="small muted" style={{ flex: 1, minWidth: 0 }}>Tick an item when all of it is {verb.toLowerCase()}, or type how much.</span>
        <Button size="sm" onClick={() => setAll(true)}>All</Button>
        <Button size="sm" onClick={() => setAll(false)}>None</Button>
      </div>
      <div className="ld-lines">
        {lines.map((l) => {
          const full = !bad(l) && val(l.id) >= l.qty - 0.0001;
          return (
            <div key={l.id} className={`ld-line ${full ? 'ld-full' : ''}`}>
              <label className="ld-tick">
                <input type="checkbox" checked={full} onChange={(e) => setVals((v) => ({ ...v, [l.id]: String(e.target.checked ? l.qty : 0) }))} />
                <span>
                  <span className="ld-name">{l.name}</span>
                  <span className="small muted" style={{ display: 'block' }}>
                    Ordered {l.qty} {l.unit || ''}
                    {!bad(l) && !full && val(l.id) > 0 ? ` · ${r2(l.qty - val(l.id))} still to go` : ''}
                  </span>
                </span>
              </label>
              <label className="ld-qty">
                <span className="small muted">{verb}</span>
                <Input type="number" min="0" max={l.qty} step="any" value={vals[l.id] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [l.id]: e.target.value }))} aria-invalid={bad(l)} />
                {bad(l) && <span className="err small">0 to {l.qty}</span>}
              </label>
            </div>
          );
        })}
      </div>
      <div className="small muted mt-2">{fullCount} of {lines.length} item{lines.length === 1 ? '' : 's'} fully {verb.toLowerCase()}.</div>
    </Modal>
  );
}

/**
 * Deliver what is still owing on a bill out of one warehouse. Each line shows
 * how much that warehouse holds; the quantity typed comes off its stock.
 * `lines` are the undelivered ones: { id, itemId, name, unit, left, warehouseId }.
 */
export function WarehouseDeliveryModal({ open, title, lines = [], warehouses = [], stockOf, onClose, onSave }) {
  const [whId, setWhId] = useState('');
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);

  // Goods already booked against the chosen warehouse are off its stock already.
  const availOf = (l, wid) => (l.warehouseId === wid ? l.left : stockOf(wid, l.itemId));
  const suggest = (wid) => Object.fromEntries(lines.map((l) => [l.id, String(Math.max(0, r2(Math.min(l.left, availOf(l, wid)))))]));

  useEffect(() => {
    if (!open) return;
    const first = warehouses[0]?.id || '';
    setWhId(first);
    setVals(suggest(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickWarehouse = (wid) => { setWhId(wid); setVals(suggest(wid)); };
  const qtyOf = (l) => Number(vals[l.id]) || 0;
  const bad = (l) => {
    const v = vals[l.id];
    return v !== '' && v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > l.left + 0.0001);
  };
  // Lines of one item share the warehouse's stock between them.
  const drawn = new Map();
  lines.forEach((l) => { if (l.warehouseId !== whId) drawn.set(l.itemId, r2((drawn.get(l.itemId) || 0) + qtyOf(l))); });
  const short = (l) => l.warehouseId !== whId && qtyOf(l) > 0 && (drawn.get(l.itemId) || 0) > stockOf(whId, l.itemId) + 0.0001;
  const invalid = lines.some((l) => bad(l) || short(l));
  const picked = lines.filter((l) => qtyOf(l) > 0 && !bad(l));

  const save = async () => {
    if (busy || invalid || !picked.length || !whId) return;
    setBusy(true);
    try {
      await onSave(whId, picked.map((l) => ({ id: l.id, qty: r2(qtyOf(l)) })));
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={invalid || !picked.length || !whId}>
            Deliver{picked.length ? ` ${picked.length} item${picked.length === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      )}
    >
      <Field label="Deliver from warehouse">
        <Select value={whId} onChange={(e) => pickWarehouse(e.target.value)} options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
      </Field>
      <div className="small muted" style={{ margin: '4px 0 8px' }}>
        Type how much goes out now. It is taken off this warehouse's stock and the bill total stays the same.
      </div>
      <div className="ld-lines">
        {lines.map((l) => {
          const have = availOf(l, whId);
          return (
            <div key={l.id} className="ld-line">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="ld-name">{l.name}</span>
                <span className="small muted" style={{ display: 'block' }}>
                  {l.left} {l.unit || ''} still to deliver · {l.warehouseId === whId ? 'already booked on this warehouse' : `${have} in warehouse`}
                </span>
              </div>
              <label className="ld-qty">
                <span className="small muted">Deliver</span>
                <Input type="number" min="0" max={l.left} step="any" value={vals[l.id] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [l.id]: e.target.value }))} aria-invalid={bad(l) || short(l)} />
                {bad(l) && <span className="err small">0 to {l.left}</span>}
                {!bad(l) && short(l) && <span className="err small">Only {stockOf(whId, l.itemId)} in stock</span>}
              </label>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function ProgressCount({ done, qty }) {
  const state = done >= qty - 0.0001 ? 'full' : done > 0.0001 ? 'part' : 'none';
  return (
    <span className={`ld-count ${state}`} style={{ display: 'inline', marginTop: 0 }}>
      {state === 'full' ? '✓ ' : ''}{+Number(done).toFixed(3)} / {+Number(qty).toFixed(3)}
    </span>
  );
}

/** End-of-day summary that can be printed or sent on WhatsApp. */
export function CloseToday({ open, onClose }) {
  const { data, settings, methods, access } = useApp();
  const day = today();
  const showCash = access.can('accounts');
  const s = useMemo(() => {
    const states = billStates(data.bills, data).filter((b) => b.status !== 'voided');
    const todays = states.filter((b) => b.date === day);
    const sales = r2(todays.reduce((t, b) => t + b.net, 0));
    const pays = collectedPayments(data.payments, data.cheques).filter((p) => p.date === day);
    const collected = r2(pays.reduce((t, p) => t + (Number(p.amount) || 0), 0));
    const byMethod = methods.map((m) => ({
      method: m, amount: r2(pays.filter((p) => p.method === m).reduce((t, p) => t + (Number(p.amount) || 0), 0)),
    })).filter((x) => x.amount > 0);
    const newCredit = r2(todays.reduce((t, b) => t + b.due, 0));
    const expenses = r2(data.expenses.filter((e) => e.date === day).reduce((t, e) => t + (Number(e.amount) || 0), 0));
    const cashInHand = r2(methodBalances(methods, data).reduce((t, b) => t + b.balance, 0));
    const totalOutstanding = r2(states.reduce((t, b) => t + b.due, 0));
    return { sales, collected, byMethod, newCredit, expenses, cashInHand, totalOutstanding, billCount: todays.length };
  }, [data, methods, day]);
  const text = useMemo(() => [
    `*${settings.shopName} — Daily Summary*`, fmtDate(day), '',
    `Bills made: ${s.billCount}`,
    `Total sales: ${money(s.sales)}`,
    `Collected today: ${money(s.collected)}`,
    ...s.byMethod.map((m) => `  • ${m.method}: ${money(m.amount)}`),
    `New credit given: ${money(s.newCredit)}`,
    `Expenses today: ${money(s.expenses)}`, '',
    ...(showCash ? [`Cash in hand: ${money(s.cashInHand)}`] : []),
    `Total outstanding: ${money(s.totalOutstanding)}`,
  ].join('\n'), [s, settings.shopName, day]);
  const print = () => printReport({
    title: 'Daily Closing Summary', subtitle: fmtDate(day), shopName: settings.shopName,
    headers: ['Item', { label: 'Amount', align: 'r' }],
    rows: [
      ['Bills made', s.billCount], ['Total sales', money(s.sales)], ['Collected today', money(s.collected)],
      ...s.byMethod.map((m) => [`   ${m.method}`, money(m.amount)]),
      ['New credit given', money(s.newCredit)], ['Expenses today', money(s.expenses)], ...(showCash ? [['Cash in hand', money(s.cashInHand)]] : []),
    ],
    totals: ['Total outstanding', money(s.totalOutstanding)],
  });
  const Row = ({ label, value, strong, tone }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #F1F3F5' }}>
      <span style={{ fontWeight: strong ? 700 : 500, color: tone }}>{label}</span>
      <span className="spacer" />
      <Money value={value} className={strong ? '' : 'small'} />
    </div>
  );
  return (
    <Modal
      open={open}
      title="Close Today"
      onClose={onClose}
      footer={(
        <>
          <Button icon={Printer} onClick={print}>Print</Button>
          <a className="btn btn-primary" target="_blank" rel="noreferrer" href={whatsappUrl(settings.phone, text)}>
            <Send size={15} /> Send on WhatsApp
          </a>
        </>
      )}
    >
      <div className="row mb-2" style={{ gap: 9 }}>
        <span className="ico" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--info-bg)', color: '#1D4ED8', display: 'grid', placeItems: 'center', flex: 'none' }}>
          <CalendarCheck size={17} />
        </span>
        <div>
          <div style={{ fontWeight: 700 }}>{fmtDate(day)}</div>
          <div className="small muted">{s.billCount} bill{s.billCount === 1 ? '' : 's'} made today</div>
        </div>
      </div>
      <Row label="Total sales" value={s.sales} strong />
      <Row label="Collected today" value={s.collected} />
      {s.byMethod.map((m) => <Row key={m.method} label={`    ${m.method}`} value={m.amount} tone="var(--text-muted)" />)}
      <Row label="New credit given" value={s.newCredit} tone="var(--danger)" />
      <Row label="Expenses today" value={s.expenses} />
      <div style={{ marginTop: 14, padding: 13, background: 'var(--bg)', borderRadius: 'var(--r)', border: '1px solid var(--border)' }}>
        {showCash && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
            <span style={{ fontWeight: 700 }}>Cash in hand</span><span className="spacer" /><Money value={s.cashInHand} />
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>Total outstanding</span><span className="spacer" />
          <span className="money" style={{ color: 'var(--danger)' }}>{money(s.totalOutstanding)}</span>
        </div>
      </div>
    </Modal>
  );
}
