import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ArrowDownToLine, ArrowLeft, ArrowLeftRight, ArrowUpFromLine, Boxes, ChevronRight, MapPin,
  Pencil, Phone, Plus, Printer, Save, Store, User, Wallet, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, norm, qty } from '../lib/format.js';
import {
  MOVE_TYPES, moveEffect, warehouseExpenseTotal, warehouseStockMap, warehouseStockValue,
} from '../lib/calc.js';
import { printReport } from '../lib/exporters.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Stat, Textarea,
} from '../components/ui.jsx';
import ImportButton from '../components/ImportButton.jsx';

export function WarehouseForm({ warehouse = null, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    name: String(warehouse?.name ?? ''), code: String(warehouse?.code ?? ''), location: String(warehouse?.location ?? ''),
    manager: String(warehouse?.manager ?? ''), phone: String(warehouse?.phone ?? ''), capacity: String(warehouse?.capacity ?? ''), note: String(warehouse?.note ?? ''),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Warehouse name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveWarehouse({ id: warehouse?.id, ...f, name: f.name.trim() }), warehouse ? 'Warehouse updated' : 'Warehouse added');
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Warehouse name" error={err}><Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Main Godown" /></Field>
        <Field label="Short code" hint="Printed on documents, e.g. WH1"><Input value={f.code} onChange={set('code')} placeholder="WH1" maxLength={8} /></Field>
        <Field label="Location / address" className="full"><Input value={f.location} onChange={set('location')} placeholder="e.g. Plot 12, Industrial Area" /></Field>
        <Field label="In-charge / manager"><Input value={f.manager} onChange={set('manager')} placeholder="Name" /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" /></Field>
        <Field label="Capacity" hint="Optional — e.g. 5,000 bags"><Input value={f.capacity} onChange={set('capacity')} placeholder="Optional" /></Field>
        <Field label="Note" className="full"><Textarea value={f.note} onChange={set('note')} rows={2} placeholder="Anything worth recording" /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{warehouse ? 'Update Warehouse' : 'Add Warehouse'}</Button>
      </div>
    </form>
  );
}

/** Per-warehouse figures used by the list and the overview. */
export function useWarehouseSummaries() {
  const { data } = useApp();
  return useMemo(() => {
    const map = warehouseStockMap(data);
    const cost = new Map(data.items.map((i) => [i.id, Number(i.costPrice) || 0]));
    return (data.warehouses || []).map((w) => {
      const stock = map.get(w.id) || new Map();
      let units = 0;
      let value = 0;
      let lines = 0;
      for (const [itemId, q] of stock) {
        if (q <= 0.0001) continue;
        units += q;
        value += q * (cost.get(itemId) || 0);
        lines += 1;
      }
      const moves = (data.whMoves || []).filter((m) => m.status !== 'voided' && (m.warehouseId === w.id || m.toWarehouseId === w.id));
      const last = moves.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      return {
        ...w, units: r2(units), value: r2(value), itemCount: lines, moveCount: moves.length, lastMove: last || null,
        expenses: warehouseExpenseTotal(data.whExpenses, w.id),
      };
    });
  }, [data]);
}

export default function Warehouses() {
  const { mutate } = useApp();
  const navigate = useNavigate();
  const all = useWarehouseSummaries();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toggling, setToggling] = useState(null);
  const rows = useMemo(() => {
    const s = norm(q);
    return all.filter((w) => (archived ? w.status === 'archived' : w.status !== 'archived'))
      .filter((w) => !s || norm(w.name).includes(s) || norm(w.code).includes(s) || norm(w.location).includes(s) || norm(w.manager).includes(s))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  }, [all, q, archived]);
  const live = all.filter((w) => w.status !== 'archived');
  const totals = {
    value: r2(live.reduce((s, w) => s + w.value, 0)),
    units: r2(live.reduce((s, w) => s + w.units, 0)),
    expenses: r2(live.reduce((s, w) => s + w.expenses, 0)),
  };
  const toggle = async () => {
    const w = toggling;
    setToggling(null);
    await mutate(() => api.archiveWarehouse(w.id), w.status === 'archived' ? 'Warehouse restored' : 'Warehouse archived');
  };
  return (
    <>
      <PageHead title="Warehouses" subtitle={`${rows.length} ${archived ? 'archived' : 'active'} warehouse${rows.length === 1 ? '' : 's'}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Name, code, location…" />
        <Button onClick={() => setArchived((v) => !v)}>{archived ? 'Show active' : 'Show archived'}</Button>
        <ImportButton kind="warehouses" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Warehouse</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Warehouses" value={live.length} icon={Warehouse} tone="#1F2937" />
        <Stat className="cost-only" label="Stock Value (at cost)" value={money(totals.value)} icon={Boxes} tone="#16A34A" />
        <Stat label="Units Held" value={qty(totals.units)} icon={Boxes} tone="#F59E0B" />
        <Stat label="Running Costs (all time)" value={money(totals.expenses)} icon={Wallet} tone="#DC2626" />
      </div>
      {rows.length ? (
        <div className="wh-cards">
          {rows.map((w) => (
            <div key={w.id} className="card wh-card clickable" onClick={() => navigate(`/warehouse/w/${w.id}`)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/warehouse/w/${w.id}`); }}>
              <div className="wh-card-head">
                <span className="wh-ico"><Warehouse size={18} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="wh-name">{w.name}{w.code && <span className="wh-code">{w.code}</span>}</div>
                  {w.location && <div className="small muted"><MapPin size={11} style={{ verticalAlign: -1 }} /> {w.location}</div>}
                </div>
                {w.status === 'archived' && <Pill status="archived" />}
              </div>
              <div className="wh-card-stats">
                <div className="cost-only"><div className="small muted">Stock value</div><div className="money">{money(w.value)}</div></div>
                <div><div className="small muted">Items</div><div className="num">{w.itemCount}</div></div>
                <div><div className="small muted">Units</div><div className="num">{qty(w.units)}</div></div>
              </div>
              <div className="wh-card-foot small muted">
                {w.manager && <span><User size={11} style={{ verticalAlign: -1 }} /> {w.manager}</span>}
                {w.phone && <span><Phone size={11} style={{ verticalAlign: -1 }} /> {w.phone}</span>}
                <span>{w.lastMove ? `Last movement ${fmtDate(w.lastMove.date)}` : 'No movements yet'}</span>
                <span className="spacer" />
                <span onClick={(e) => e.stopPropagation()} className="row" style={{ gap: 2 }}>
                  <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(w)}><Pencil size={14} /></button>
                  <button className="btn btn-ghost btn-sm" title={w.status === 'archived' ? 'Restore' : 'Archive'} onClick={() => setToggling(w)}>
                    {w.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <Empty
            icon={Warehouse}
            title={q ? 'No matching warehouses' : archived ? 'No archived warehouses' : 'No warehouses yet'}
            message={q ? `Nothing matches "${q}".` : 'Add each godown or store room you keep stock in. Every movement is recorded against one of them.'}
            action={!q && !archived ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first warehouse</Button> : null}
          />
        </Card>
      )}
      <Modal open={adding} title="Add Warehouse" onClose={() => setAdding(false)}>
        <WarehouseForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Warehouse'}`} onClose={() => setEditing(null)}>
        {editing && <WarehouseForm warehouse={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
      <Confirm
        open={!!toggling}
        title={toggling?.status === 'archived' ? 'Restore warehouse?' : 'Archive warehouse?'}
        message={toggling?.status === 'archived'
          ? `"${toggling?.name}" will be available for new movements again.`
          : `"${toggling?.name}" will be hidden from new movements. Its stock records and history stay intact — nothing is deleted.${toggling?.units > 0 ? ` It still holds ${qty(toggling.units)} units; transfer them out first if they are really leaving.` : ''}`}
        confirmLabel={toggling?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={toggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}

export function WarehouseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, setActiveWarehouse, access } = useApp();
  const sc = access.seesCost;
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const wh = (data.warehouses || []).find((w) => w.id === id);
  const stock = useMemo(() => {
    const map = warehouseStockMap(data).get(id) || new Map();
    const s = norm(q);
    return [...map.entries()].filter(([, v]) => Math.abs(v) > 0.0001)
      .map(([itemId, v]) => {
        const item = data.items.find((i) => i.id === itemId);
        return { itemId, item, qty: v, value: r2(Math.max(0, v) * (Number(item?.costPrice) || 0)) };
      })
      .filter((x) => !s || norm(x.item?.name).includes(s) || norm(x.item?.category).includes(s))
      .sort((a, b) => String(a.item?.name).localeCompare(String(b.item?.name)));
  }, [data, id, q]);
  const moves = useMemo(() => (data.whMoves || [])
    .filter((m) => m.warehouseId === id || m.toWarehouseId === id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 12), [data.whMoves, id]);
  if (!wh) return <Empty icon={Warehouse} title="Warehouse not found" action={<Button onClick={() => navigate('/warehouse/list')}>Back to Warehouses</Button>} />;
  const value = warehouseStockValue(data, id);
  const units = r2(stock.reduce((s, x) => s + Math.max(0, x.qty), 0));
  const expenses = warehouseExpenseTotal(data.whExpenses, id);
  const linesOf = (mid) => (data.whMoveLines || []).filter((l) => l.moveId === mid);
  const start = (type) => {
    setActiveWarehouse(id);
    navigate(`/warehouse/new/${type}`);
  };
  const printStock = () => printReport({
    title: `Stock — ${wh.name}`, subtitle: [wh.code, wh.location].filter(Boolean).join(' · '), shopName: settings.shopName,
    headers: ['Item', 'Category', { label: 'In stock', align: 'r' }, ...(sc ? [{ label: 'Cost', align: 'r' }, { label: 'Value', align: 'r' }] : [])],
    rows: stock.map((x) => [x.item?.name || 'Item', x.item?.category || '', `${qty(x.qty)} ${x.item?.baseUnit || ''}`, ...(sc ? [money(x.item?.costPrice), money(x.value)] : [])]),
    totals: ['Total', '', qty(units), ...(sc ? ['', money(value)] : [])],
    meta: [wh.manager ? `In-charge: ${wh.manager}` : '', `As at ${fmtDate(new Date())}`].filter(Boolean),
  });
  return (
    <>
      <PageHead title={wh.name} subtitle={[wh.code, wh.location, wh.manager && `In-charge ${wh.manager}`, wh.phone].filter(Boolean).join(' · ') || 'Warehouse'}>
        <Button icon={ArrowLeft} onClick={() => navigate('/warehouse/list')}>Warehouses</Button>
        <Button icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>
        <Button icon={Printer} onClick={printStock}>Print Stock</Button>
      </PageHead>
      <div className="row mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" icon={ArrowDownToLine} onClick={() => start('in')}>Stock In</Button>
        <Button icon={ArrowUpFromLine} onClick={() => start('out')}>Stock Out</Button>
        <Button icon={ArrowLeftRight} onClick={() => start('transfer')}>Transfer</Button>
        <Button icon={Store} onClick={() => start('to-shop')}>Send to Shop</Button>
      </div>
      <div className="stat-grid">
        <Stat className="cost-only" label="Stock Value (at cost)" value={money(value)} icon={Boxes} tone="#16A34A" />
        <Stat label="Items in Stock" value={stock.filter((x) => x.qty > 0).length} icon={Boxes} tone="#1F2937" />
        <Stat label="Units" value={qty(units)} icon={Boxes} tone="#F59E0B" />
        <Stat label="Running Costs" value={money(expenses)} icon={Wallet} tone="#DC2626" onClick={() => navigate('/warehouse/expenses')} />
      </div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)', alignItems: 'start' }}>
        <Card title="Stock in this warehouse" tight actions={<SearchBox value={q} onChange={setQ} placeholder="Search item…" style={{ minWidth: 180 }} />}>
          {stock.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Item</th><th className="r">In stock</th><th className="r cost-only">Value</th><th style={{ width: 40 }} /></tr></thead>
                <tbody>
                  {stock.map((x) => (
                    <tr key={x.itemId} className="clickable" onClick={() => navigate(`/warehouse/item/${x.itemId}?wh=${id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{x.item?.name || 'Item'}</div>
                        {x.item?.category && <div className="small muted">{x.item.category}</div>}
                      </td>
                      <td className="r strong"><span className="num" style={{ color: x.qty < 0 ? 'var(--danger)' : undefined }}>{qty(x.qty)} {x.item?.baseUnit}</span></td>
                      <td className="r cost-only"><Money value={x.value} /></td>
                      <td><ChevronRight size={15} className="muted" /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>{stock.length} items</td><td className="r">{qty(units)}</td><td className="r cost-only">{money(value)}</td><td /></tr></tfoot>
              </table>
            </div>
          ) : <Empty icon={Boxes} title={q ? 'No matching items' : 'Nothing in stock'} message={q ? `Nothing matches "${q}".` : 'Record a Stock In to bring goods into this warehouse.'} />}
        </Card>
        <Card title="Recent movements" tight actions={<Button size="sm" onClick={() => { setActiveWarehouse(id); navigate('/warehouse/moves'); }}>View all</Button>}>
          {moves.length ? moves.map((m) => {
            const sign = moveEffect({ ...m, status: 'active' }, id);
            const lines = linesOf(m.id);
            const total = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
            return (
              <div key={m.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/move/${m.id}`)} style={m.status === 'voided' ? { opacity: 0.55 } : undefined}>
                <span className={`ico ${sign > 0 ? 'info' : 'warning'}`}>{sign > 0 ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}</span>
                <div className="body">
                  <div className="t" style={{ textDecoration: m.status === 'voided' ? 'line-through' : 'none' }}>{m.docNo} · {MOVE_TYPES[m.type]?.label}</div>
                  <div className="s">{fmtDate(m.date)} · {lines.length} item{lines.length === 1 ? '' : 's'}{m.partyName ? ` · ${m.partyName}` : ''}</div>
                </div>
                <span className="num" style={{ color: sign > 0 ? 'var(--success)' : 'var(--danger)' }}>{sign > 0 ? '+' : '−'}{qty(total)}</span>
              </div>
            );
          }) : <Empty icon={ArrowLeftRight} title="No movements yet" message="Stock in, out and transfers for this warehouse will appear here." />}
        </Card>
      </div>
      <Modal open={editing} title={`Edit ${wh.name}`} onClose={() => setEditing(false)}>
        {editing && <WarehouseForm warehouse={wh} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />}
      </Modal>
    </>
  );
}
