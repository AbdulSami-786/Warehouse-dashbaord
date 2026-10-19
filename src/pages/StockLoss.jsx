import { useMemo, useState } from 'react';
import {
  Boxes, Download, Link2, Plus, Save, TriangleAlert,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { LOSS_REASONS } from '../lib/config.js';
import { money, r2, today, fmtDate, norm, rangeFor, inRange } from '../lib/format.js';
import { itemStock } from '../lib/calc.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Select, Stat, Textarea, Typeahead,
} from '../components/ui.jsx';

const blank = () => ({ itemId: '', qty: '', reason: 'Damaged', estimatedValue: '', date: today(), note: '' });

function LossModal({ open, onClose }) {
  const { data, activeItems, mutate } = useApp();
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const item = data.items.find((i) => i.id === f.itemId);
  const stock = f.itemId ? itemStock(f.itemId, data) : null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pick = (id) => {
    const it = data.items.find((i) => i.id === id);
    setF((x) => ({ ...x, itemId: id, estimatedValue: x.qty && it ? String(r2(Number(x.qty) * Number(it.costPrice || 0))) : x.estimatedValue }));
  };
  const setQty = (e) => {
    const v = e.target.value;
    setF((x) => ({ ...x, qty: v, estimatedValue: item ? String(r2(Number(v || 0) * Number(item.costPrice || 0))) : x.estimatedValue }));
  };
  const tooMany = stock !== null && Number(f.qty) > stock;
  const save = async () => {
    if (busy || !f.itemId || !(Number(f.qty) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.saveStockLoss({ itemId: f.itemId, qty: Number(f.qty), reason: f.reason, estimatedValue: Number(f.estimatedValue) || 0, date: f.date, note: f.note }), 'Stock loss logged and expense created');
      setF(blank());
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title="Log Damaged / Expired Stock"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!f.itemId || !(Number(f.qty) > 0)}>Log Stock Loss</Button></>}
    >
      <Field label="Item" hint={stock !== null ? `Current stock: ${stock} ${item?.baseUnit || ''}` : undefined}>
        <Typeahead items={activeItems} value={f.itemId} onChange={pick} getLabel={(i) => i.name} getSub={(i) => `${i.category || 'Uncategorised'} · cost ${money(i.costPrice)}`} placeholder="Search item…" autoFocus />
      </Field>
      <div className="form-grid">
        <Field label="Quantity lost" error={tooMany ? `Only ${stock} ${item?.baseUnit} in stock` : ''}><Input type="number" min="0" step="any" value={f.qty} onChange={setQty} placeholder="0" /></Field>
        <Field label="Reason"><Select value={f.reason} onChange={set('reason')} options={LOSS_REASONS} /></Field>
        <Field className="cost-only" label="Estimated value lost" hint="Defaults to quantity × cost price"><Input type="number" min="0" step="any" value={f.estimatedValue} onChange={set('estimatedValue')} placeholder="0" /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Note" className="full"><Textarea value={f.note} onChange={set('note')} rows={2} placeholder="What happened?" /></Field>
      </div>
      <div style={{ padding: '10px 12px', background: 'var(--info-bg)', border: '1px solid #BFDBFE', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#1D4ED8', display: 'flex', gap: 7 }}>
        <Link2 size={14} style={{ flex: 'none', marginTop: 1 }} />
        <span>Saving reduces this item's stock and creates a matching<strong> Stock Loss </strong>entry in Expenses automatically.</span>
      </div>
    </Modal>
  );
}

export default function StockLoss() {
  const { data, settings, toast, access } = useApp();
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [adding, setAdding] = useState(false);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.stockLoss.map((l) => ({ ...l, item: data.items.find((i) => i.id === l.itemId) }))
      .filter((l) => inRange(l.date, range.from, range.to))
      .filter((l) => !s || norm(l.item?.name).includes(s) || norm(l.reason).includes(s))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data, q, range]);
  const totals = useMemo(() => ({
    value: r2(rows.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0)),
    count: rows.length,
    units: r2(rows.reduce((s, l) => s + (Number(l.qty) || 0), 0)),
  }), [rows]);
  const byReason = useMemo(() => {
    const m = new Map();
    rows.forEach((l) => m.set(l.reason, r2((m.get(l.reason) || 0) + (Number(l.estimatedValue) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const toExcel = () => {
    exportCSV('StockLoss', ['Date', 'Item', 'Qty', 'Reason', 'Estimated Value', 'Note'],
      rows.map((l) => [fmtDate(l.date), l.item?.name || '', l.qty, l.reason, Number(l.estimatedValue).toFixed(2), l.note || '']),
      [`${settings.shopName} — Damaged / Expired Stock`, `Total value lost: ${money(totals.value)}`]);
    toast('Stock loss log exported');
  };
  const reasonPill = (r) => <Pill status={r === 'Expired' ? 'partial' : 'due'} label={r} />;
  return (
    <>
      <PageHead title="Damaged / Expired Stock" subtitle={access.seesCost ? `${totals.count} entries · ${money(totals.value)} lost in the selected period` : `${totals.count} entries in the selected period`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search item or reason…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log Stock Loss</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat className="cost-only" label="Value Lost" value={money(totals.value)} icon={TriangleAlert} tone="#DC2626" />
        <Stat label="Entries" value={totals.count} icon={Boxes} tone="#F59E0B" />
        <Stat label="Units Lost" value={totals.units} icon={Boxes} tone="#6B7280" />
      </div>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card tight>
          {rows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Item</th><th className="r">Qty</th><th>Reason</th><th>Note</th><th className="r cost-only">Value lost</th></tr></thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id}>
                        <td className="nowrap">{fmtDate(l.date)}</td>
                        <td style={{ fontWeight: 500 }}>{l.item?.name || 'Item'}</td>
                        <td className="r">{l.qty} {l.item?.baseUnit || ''}</td>
                        <td>{reasonPill(l.reason)}</td>
                        <td className="small muted">{l.note || '—'}</td>
                        <td className="r strong cost-only"><Money value={l.estimatedValue} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={5}>{totals.count} entries</td><td className="r cost-only" style={{ color: 'var(--danger)' }}>{money(totals.value)}</td></tr></tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((l) => (
                  <div key={l.id} className="mcard due-30">
                    <div className="top"><span className="name">{l.item?.name || 'Item'}</span><span className="amt cost-only">{money(l.estimatedValue)}</span></div>
                    <div className="meta">{reasonPill(l.reason)}<span>{l.qty} {l.item?.baseUnit}</span><span>{fmtDate(l.date)}</span></div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty
              icon={Boxes}
              title="No stock loss recorded"
              message="Log damaged or expired goods here. Stock reduces automatically and a matching expense is created for you."
              action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log stock loss</Button>}
            />
          )}
        </Card>
        <Card title="By Reason" tight className="cost-only">
          {byReason.length ? (
            <table className="tbl">
              <tbody>{byReason.map(([r, v]) => <tr key={r}><td>{r}</td><td className="r strong"><Money value={v} /></td></tr>)}</tbody>
              <tfoot><tr><td>Total</td><td className="r">{money(totals.value)}</td></tr></tfoot>
            </table>
          ) : <Empty title="Nothing logged" message="Entries will be summarised here." />}
        </Card>
      </div>
      <LossModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
