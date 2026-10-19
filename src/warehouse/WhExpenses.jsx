import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Save, Trash2, Wallet } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { WAREHOUSE_EXPENSE_CATEGORIES } from '../lib/config.js';
import { money, r2, today, fmtDate, norm, rangeFor, inRange } from '../lib/format.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Confirm, DateRange, Empty, Field, Input, Modal, Money, PageHead, SearchBox, Select, Stat, Textarea,
} from '../components/ui.jsx';
import { useSelectedWarehouse, WarehousePicker } from './WarehouseLayout.jsx';
import ImportButton from '../components/ImportButton.jsx';

function ExpenseModal({ open, onClose, defaultWarehouse }) {
  const { activeWarehouses, methods, mutate } = useApp();
  const blank = () => ({ warehouseId: defaultWarehouse || activeWarehouses[0]?.id || '', category: 'Rent', amount: '', date: today(), method: 'Cash', note: '' });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF((x) => ({ ...x, warehouseId: defaultWarehouse || x.warehouseId || activeWarehouses[0]?.id || '' }));
  }, [open, defaultWarehouse, activeWarehouses]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ok = f.warehouseId && Number(f.amount) > 0;
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.saveWhExpense({ ...f, amount: Number(f.amount) }), 'Warehouse expense recorded');
      setF(blank());
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} title="Add Warehouse Expense" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Record Expense</Button></>}>
      <div className="form-grid">
        <Field label="Warehouse">
          <Select value={f.warehouseId} onChange={set('warehouseId')}>
            {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="Category"><Select value={f.category} onChange={set('category')} options={WAREHOUSE_EXPENSE_CATEGORIES} /></Field>
        <Field label="Amount"><Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} autoFocus placeholder="0" /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Paid from" hint="Comes out of the same cash and bank accounts as the shop"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
        <Field label="Note" className="full"><Textarea value={f.note} onChange={set('note')} rows={2} placeholder="What was this for?" /></Field>
      </div>
    </Modal>
  );
}

export default function WhExpenses() {
  const { data, settings, mutate, toast, activeWarehouses } = useApp();
  const selected = useSelectedWarehouse();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const whName = (id) => (data.warehouses || []).find((w) => w.id === id)?.name || 'Warehouse';
  const rows = useMemo(() => {
    const s = norm(q);
    return (data.whExpenses || [])
      .filter((e) => !selected || e.warehouseId === selected)
      .filter((e) => category === 'all' || e.category === category)
      .filter((e) => inRange(e.date, range.from, range.to))
      .filter((e) => !s || norm(e.category).includes(s) || norm(e.note).includes(s) || norm(whName(e.warehouseId)).includes(s))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data.whExpenses, q, category, range, selected]);
  const total = useMemo(() => r2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0)), [rows]);
  const byWarehouse = useMemo(() => {
    const m = new Map();
    rows.forEach((e) => m.set(e.warehouseId, r2((m.get(e.warehouseId) || 0) + (Number(e.amount) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const byCategory = useMemo(() => {
    const m = new Map();
    rows.forEach((e) => m.set(e.category, r2((m.get(e.category) || 0) + (Number(e.amount) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const toExcel = () => {
    exportCSV('WarehouseExpenses', ['Date', 'Warehouse', 'Category', 'Amount', 'Paid from', 'Note'],
      rows.map((e) => [fmtDate(e.date), whName(e.warehouseId), e.category, Number(e.amount).toFixed(2), e.method || '', e.note || '']),
      [`${settings.shopName} — Warehouse Expenses`, selected ? whName(selected) : 'All warehouses', `Total: ${money(total)}`]);
    toast('Expenses exported');
  };
  const remove = async () => {
    const e = deleting;
    setDeleting(null);
    await mutate(() => api.deleteWhExpense(e.id), 'Expense deleted').catch(() => {});
  };
  return (
    <>
      <PageHead title="Warehouse Expenses" subtitle={`${rows.length} entries · ${money(total)} in the selected period`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search category or note…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 160 }}>
          <option value="all">All categories</option>
          {WAREHOUSE_EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <WarehousePicker style={{ width: 170 }} />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="whExpenses" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={!activeWarehouses.length}>Add Expense</Button>
      </PageHead>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="stat-grid">
        <Stat label="Total spent" value={money(total)} icon={Wallet} tone="#DC2626" />
        <Stat label="Entries" value={rows.length} icon={Wallet} tone="#F59E0B" />
        <Stat label="Largest category" value={byCategory[0] ? byCategory[0][0] : '—'} icon={Wallet} tone="#1F2937" note={byCategory[0] ? money(byCategory[0][1]) : undefined} />
      </div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card tight>
          {rows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Warehouse</th><th>Category</th><th>Paid from</th><th>Note</th><th className="r">Amount</th><th style={{ width: 44 }} /></tr></thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td className="nowrap">{fmtDate(e.date)}</td>
                        <td>{whName(e.warehouseId)}</td>
                        <td>{e.category}</td>
                        <td>{e.method || '—'}</td>
                        <td className="small muted">{e.note || '—'}</td>
                        <td className="r strong"><Money value={e.amount} /></td>
                        <td><button className="btn btn-ghost btn-sm" title="Delete" onClick={() => setDeleting(e)}><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={5}>{rows.length} entries</td><td className="r">{money(total)}</td><td /></tr></tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((e) => (
                  <div key={e.id} className="mcard">
                    <div className="top"><span className="name">{e.category}</span><span className="amt">{money(e.amount)}</span></div>
                    <div className="meta"><span>{whName(e.warehouseId)}</span><span>{fmtDate(e.date)}</span>{e.note && <span>{e.note}</span>}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty icon={Wallet} title="No warehouse expenses" message="Record rent, labour, loading, electricity and other warehouse running costs here." action={activeWarehouses.length ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add expense</Button> : null} />
          )}
        </Card>
        <div className="col">
          <Card title="By Warehouse" tight>
            {byWarehouse.length ? (
              <table className="tbl">
                <tbody>{byWarehouse.map(([wid, v]) => <tr key={wid}><td>{whName(wid)}</td><td className="r strong"><Money value={v} /></td></tr>)}</tbody>
                <tfoot><tr><td>Total</td><td className="r">{money(total)}</td></tr></tfoot>
              </table>
            ) : <Empty title="Nothing to summarise" />}
          </Card>
          <Card title="By Category" tight>
            {byCategory.length ? (
              <table className="tbl">
                <tbody>
                  {byCategory.map(([c, v]) => (
                    <tr key={c}>
                      <td>{c}</td>
                      <td style={{ width: '40%' }}>
                        <div style={{ height: 6, background: 'var(--neutral-bg)', borderRadius: 999 }}>
                          <div style={{ height: '100%', width: `${total > 0 ? (v / total) * 100 : 0}%`, background: 'var(--accent)', borderRadius: 999 }} />
                        </div>
                      </td>
                      <td className="r strong"><Money value={v} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty title="Nothing to summarise" />}
          </Card>
        </div>
      </div>
      <ExpenseModal open={adding} onClose={() => setAdding(false)} defaultWarehouse={selected} />
      <Confirm
        open={!!deleting}
        danger
        title="Delete this expense?"
        message={deleting ? `${deleting.category} — ${money(deleting.amount)} on ${fmtDate(deleting.date)} (${whName(deleting.warehouseId)}). The money goes back into the ${deleting.method || 'Cash'} balance. This cannot be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
