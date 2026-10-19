import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Info, PackagePlus, Plus, Save, SlidersHorizontal, Store, Trash2,
  TriangleAlert, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { ADJUST_REASONS } from '../lib/config.js';
import { money, r2, today, uid, qty } from '../lib/format.js';
import { itemStock, MOVE_TYPES, warehouseStockMap } from '../lib/calc.js';
import {
  Button, Card, Empty, Field, Input, Modal, PageHead, Select, Textarea, Typeahead,
} from '../components/ui.jsx';
import { ItemForm } from '../components/forms.jsx';
import { useSelectedWarehouse } from './WarehouseLayout.jsx';

const KINDS = {
  in: { title: 'Stock In', sub: 'Goods received into a warehouse — from a supplier, factory or anywhere else', icon: ArrowDownToLine },
  out: { title: 'Stock Out', sub: 'Goods sent out of a warehouse to a customer or anyone else', icon: ArrowUpFromLine },
  transfer: { title: 'Transfer', sub: 'Move goods from one warehouse to another', icon: ArrowLeftRight },
  'to-shop': { title: 'Shop ⇄ Warehouse', sub: 'Send goods to the wholesale shop, or bring shop stock back into a warehouse', icon: Store },
  adjust: { title: 'Stock Adjustment', sub: 'Correct the count — damaged, expired, lost, or found extra', icon: SlidersHorizontal },
};

const newLine = () => ({ key: uid('wl'), itemId: '', qty: '', unit: '', rate: '' });

export default function MoveForm() {
  const { kind = 'in' } = useParams();
  const navigate = useNavigate();
  const { data, activeWarehouses, activeItems, activeParties, mutate, toast } = useApp();
  const selected = useSelectedWarehouse();
  const meta = KINDS[kind] || KINDS.in;
  const [direction, setDirection] = useState(kind === 'adjust' ? 'adjust-out' : 'to-shop');
  const type = kind === 'to-shop' ? direction : kind === 'adjust' ? direction : kind;
  const [warehouseId, setWarehouseId] = useState(selected || activeWarehouses[0]?.id || '');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [date, setDate] = useState(today());
  const [partyName, setPartyName] = useState('');
  const [reference, setReference] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [driverName, setDriverName] = useState('');
  const [reason, setReason] = useState(ADJUST_REASONS[0]);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [busy, setBusy] = useState(false);
  const [addingItem, setAddingItem] = useState(null);
  const [newName, setNewName] = useState('');
  const focusRef = useRef(null);
  const [focusKey, setFocusKey] = useState(null);

  // A fresh form whenever the kind of movement changes.
  useEffect(() => {
    setLines([newLine()]);
    setPartyName('');
    setReference('');
    setNote('');
    setDirection(kind === 'adjust' ? 'adjust-out' : 'to-shop');
  }, [kind]);
  useEffect(() => {
    if (!warehouseId && activeWarehouses[0]) setWarehouseId(selected || activeWarehouses[0].id);
  }, [activeWarehouses, warehouseId, selected]);
  useEffect(() => {
    if (focusKey) {
      focusRef.current?.focus();
      setFocusKey(null);
    }
  }, [focusKey]);

  const stockMap = useMemo(() => warehouseStockMap(data), [data]);
  const have = (itemId) => stockMap.get(warehouseId)?.get(itemId) || 0;
  const outgoing = (MOVE_TYPES[type]?.sign || 0) < 0;
  const fromShop = type === 'from-shop';
  const names = useMemo(() => {
    const s = new Set();
    if (kind === 'in') (data.suppliers || []).forEach((x) => x.status !== 'archived' && s.add(x.name));
    activeParties.forEach((p) => s.add(p.name));
    return [...s].sort();
  }, [data.suppliers, activeParties, kind]);

  const updLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pick = (key, itemId, given = null) => {
    const it = given || data.items.find((i) => i.id === itemId);
    updLine(key, { itemId, unit: it?.baseUnit || 'Piece', rate: kind === 'in' && it?.costPrice ? String(it.costPrice) : '' });
  };
  const addLine = () => {
    const l = newLine();
    setLines((ls) => [...ls, l]);
    setFocusKey(l.key);
  };
  // Ctrl+Shift+A adds a line, like the bill form.
  const addRef = useRef(addLine);
  addRef.current = addLine;
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyA' || !e.shiftKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || addingItem) return;
      e.preventDefault();
      addRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addingItem]);

  /** Quantity in the item's base unit — stock is always counted in base units. */
  const baseQty = (l) => {
    const it = data.items.find((i) => i.id === l.itemId);
    const n = Number(l.qty) || 0;
    if (it && l.unit && l.unit === it.altUnit && Number(it.conversionRate) > 0) return r2(n * Number(it.conversionRate));
    return r2(n);
  };
  const ready = lines.filter((l) => l.itemId && Number(l.qty) > 0);
  const wanted = useMemo(() => {
    const m = new Map();
    ready.forEach((l) => m.set(l.itemId, r2((m.get(l.itemId) || 0) + baseQty(l))));
    return m;
  }, [ready]);
  const short = outgoing ? [...wanted.entries()].filter(([itemId, q]) => q > have(itemId) + 0.0001) : [];
  const shopShort = fromShop ? [...wanted.entries()].filter(([itemId, q]) => q > itemStock(itemId, data) + 0.0001) : [];
  const value = r2(ready.reduce((s, l) => s + baseQty(l) * (Number(l.rate) || Number(data.items.find((i) => i.id === l.itemId)?.costPrice) || 0), 0));
  const units = r2(ready.reduce((s, l) => s + baseQty(l), 0));
  const needsDest = type === 'transfer';
  const ok = warehouseId && ready.length > 0 && !short.length && (!needsDest || (toWarehouseId && toWarehouseId !== warehouseId));

  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      const move = await mutate(() => api.saveWhMove({
        type, warehouseId, toWarehouseId: needsDest ? toWarehouseId : '', date, partyName, reference, vehicleNo, driverName,
        reason: kind === 'adjust' ? reason : '', note,
        lines: ready.map((l) => {
          const it = data.items.find((i) => i.id === l.itemId);
          const converted = it && l.unit === it.altUnit && Number(it.conversionRate) > 0;
          return {
            itemId: l.itemId, qty: baseQty(l), unit: it?.baseUnit || l.unit, rate: l.rate === '' ? '' : Number(l.rate),
            note: converted ? `${l.qty} ${l.unit}` : '',
          };
        }),
      }), `${MOVE_TYPES[type].label} saved`);
      navigate(`/warehouse/move/${move.id}?saved=1`, { replace: true });
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };

  if (!activeWarehouses.length) {
    return (
      <>
        <PageHead title={meta.title} subtitle={meta.sub} />
        <Card>
          <Empty
            icon={Warehouse}
            title="Add a warehouse first"
            message="Every movement is recorded against a warehouse. Add your godowns or store rooms, then come back."
            action={<Button variant="primary" icon={Plus} onClick={() => navigate('/warehouse/list')}>Add Warehouse</Button>}
          />
        </Card>
      </>
    );
  }

  const whLabel = type === 'transfer' ? 'From warehouse' : outgoing ? 'From warehouse' : 'Into warehouse';
  return (
    <>
      <PageHead title={meta.title} subtitle={meta.sub}>
        <Button onClick={() => navigate(-1)}>Cancel</Button>
        <Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Save {MOVE_TYPES[type]?.short}</Button>
      </PageHead>

      {kind === 'to-shop' && (
        <div className="seg mb-2">
          <button className={direction === 'to-shop' ? 'active' : ''} onClick={() => setDirection('to-shop')}>Warehouse → Shop</button>
          <button className={direction === 'from-shop' ? 'active' : ''} onClick={() => setDirection('from-shop')}>Shop → Warehouse</button>
        </div>
      )}
      {kind === 'adjust' && (
        <div className="seg mb-2">
          <button className={direction === 'adjust-out' ? 'active' : ''} onClick={() => setDirection('adjust-out')}>Reduce stock (−)</button>
          <button className={direction === 'adjust-in' ? 'active' : ''} onClick={() => setDirection('adjust-in')}>Add stock (+)</button>
        </div>
      )}

      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Details">
            <div className="form-grid">
              <Field label={whLabel}>
                <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ''}</option>)}
                </Select>
              </Field>
              {needsDest ? (
                <Field label="To warehouse" error={toWarehouseId && toWarehouseId === warehouseId ? 'Pick a different warehouse' : ''}>
                  <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                    <option value="">Select destination…</option>
                    {activeWarehouses.filter((w) => w.id !== warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ''}</option>)}
                  </Select>
                </Field>
              ) : <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
              {needsDest && <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
              {(kind === 'in' || kind === 'out') && (
                <Field label={kind === 'in' ? 'Received from' : 'Sent to'} hint={kind === 'in' ? 'Supplier, factory or person' : 'Customer, party or person'}>
                  <Input value={partyName} onChange={(e) => setPartyName(e.target.value)} list="wh-names" placeholder={kind === 'in' ? 'e.g. City Wholesale Supply' : 'e.g. Ahmed Traders'} />
                  <datalist id="wh-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
                </Field>
              )}
              {kind === 'adjust' && (
                <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} options={ADJUST_REASONS} /></Field>
              )}
              <Field label="Reference no." hint="Invoice, bill, builty or gate pass number"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></Field>
              {kind !== 'adjust' && (
                <>
                  <Field label="Vehicle no."><Input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="e.g. LES-1234" /></Field>
                  <Field label="Driver / carrier"><Input value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="Name" /></Field>
                </>
              )}
            </div>
          </Card>

          <Card
            title="Items"
            actions={<Button size="sm" icon={Plus} onClick={addLine} title="Add line (Ctrl+Shift+A)">Add line <kbd className="kbd-hint">Ctrl+Shift+A</kbd></Button>}
          >
            {lines.length ? (
              <div className="col" style={{ gap: 12 }}>
                {lines.map((l, i) => {
                  const it = data.items.find((x) => x.id === l.itemId);
                  const units_ = it ? [it.baseUnit, ...(it.altUnit ? [it.altUnit] : [])] : [];
                  const avail = l.itemId ? have(l.itemId) : null;
                  const over = outgoing && l.itemId && (wanted.get(l.itemId) || 0) > (avail || 0) + 0.0001;
                  return (
                    <div key={l.key} className="wh-line">
                      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                        <span className="small muted nowrap" style={{ width: 20 }}>{i + 1}.</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Typeahead
                            items={activeItems}
                            value={l.itemId}
                            focusRef={l.key === focusKey ? focusRef : null}
                            onChange={(v) => v && pick(l.key, v)}
                            getLabel={(x) => x.name}
                            getSub={(x) => `${x.category || 'Uncategorised'} · ${qty(have(x.id))} ${x.baseUnit} here`}
                            placeholder="Search item…"
                            onAddNew={(n) => { setNewName(n); setAddingItem(l.key); }}
                            addNewLabel="Add new item"
                          />
                        </div>
                        <button className="btn btn-ghost btn-icon" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove line">
                          <Trash2 size={15} color="var(--danger)" />
                        </button>
                      </div>
                      <div className="row wrap" style={{ gap: 8, paddingLeft: 28 }}>
                        <div style={{ width: 100 }}>
                          <label className="small muted">Qty</label>
                          <Input type="number" min="0" step="any" value={l.qty} onChange={(e) => updLine(l.key, { qty: e.target.value })} />
                        </div>
                        <div style={{ width: 112 }}>
                          <label className="small muted">Unit</label>
                          <Select value={l.unit} onChange={(e) => updLine(l.key, { unit: e.target.value })} options={units_.length ? units_ : ['—']} disabled={!it} />
                        </div>
                        <div style={{ width: 118 }} className="cost-only">
                          <label className="small muted">Rate (optional)</label>
                          <Input type="number" min="0" step="any" value={l.rate} placeholder={it ? String(it.costPrice || 0) : '0'} onChange={(e) => updLine(l.key, { rate: e.target.value })} />
                        </div>
                        <div className="spacer hide-mobile" />
                        {it && (
                          <div style={{ textAlign: 'right' }}>
                            <label className="small muted">In base unit</label>
                            <div className="num" style={{ paddingTop: 6 }}>{qty(baseQty(l))} {it.baseUnit}</div>
                          </div>
                        )}
                      </div>
                      {it && (
                        <div className="row wrap" style={{ gap: 8, paddingLeft: 28, marginTop: 7 }}>
                          <span className={`small ${over ? '' : 'muted'}`} style={over ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                            {over && <TriangleAlert size={12} style={{ verticalAlign: -1 }} />} {qty(avail)} {it.baseUnit} in this warehouse
                          </span>
                          {fromShop && <span className="small muted">Shop stock: {qty(itemStock(it.id, data))} {it.baseUnit}</span>}
                          {type === 'to-shop' && <span className="small muted">Shop has {qty(itemStock(it.id, data))} {it.baseUnit}</span>}
                          {it.altUnit && Number(it.conversionRate) > 0 && <span className="small muted">1 {it.altUnit} = {it.conversionRate} {it.baseUnit}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <Empty icon={PackagePlus} title="No items yet" message="Add the first item." action={<Button variant="primary" icon={Plus} onClick={addLine}>Add item</Button>} />}
            <button type="button" className="pb-add" onClick={addLine}><Plus size={15} /> Add another item</button>
          </Card>
          <Card title="Note" subtitle="Optional — printed on the document">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition of goods, who checked them, anything worth recording…" />
          </Card>
        </div>

        <div className="col">
          <Card title="Summary">
            <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}><span className="muted">Movement</span><span className="spacer" /><strong>{MOVE_TYPES[type]?.label}</strong></div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}><span className="muted">Items</span><span className="spacer" /><strong>{ready.length}</strong></div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}><span className="muted">Total quantity</span><span className="spacer" /><strong className="num">{qty(units)}</strong></div>
            <div className="cost-only" style={{ display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 6, borderTop: '2px solid var(--border-strong)' }}>
              <span style={{ fontWeight: 700 }}>Value (at rate / cost)</span><span className="spacer" />
              <span className="money" style={{ fontSize: 18 }}>{money(value)}</span>
            </div>
            {short.length > 0 && (
              <div className="mt-2" style={{ padding: '10px 12px', background: 'var(--danger-bg)', border: '1px solid #FECACA', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#B91C1C', display: 'flex', gap: 8 }}>
                <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>
                  Not enough stock: {short.map(([itemId, q]) => {
                    const it = data.items.find((x) => x.id === itemId);
                    return `${it?.name} (need ${qty(q)}, have ${qty(have(itemId))})`;
                  }).join(', ')}.
                </span>
              </div>
            )}
            {shopShort.length > 0 && (
              <div className="mt-2" style={{ padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309', display: 'flex', gap: 8 }}>
                <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>The shop's books show less than this for {shopShort.map(([itemId]) => data.items.find((x) => x.id === itemId)?.name).join(', ')}. Saving takes the shop stock below zero.</span>
              </div>
            )}
            {(type === 'to-shop' || type === 'from-shop') && (
              <div className="mt-2 small muted" style={{ display: 'flex', gap: 6 }}>
                <Info size={13} style={{ flex: 'none', marginTop: 2 }} />
                {type === 'to-shop' ? 'These goods leave the warehouse and are added to the wholesale shop\'s stock.' : 'These goods are taken off the shop\'s stock and added to the warehouse.'}
              </div>
            )}
          </Card>
          <Button variant="primary" size="lg" block icon={Save} onClick={save} loading={busy} disabled={!ok}>Save {MOVE_TYPES[type]?.label}</Button>
        </div>
      </div>

      <Modal open={!!addingItem} title="Add New Item" onClose={() => setAddingItem(null)}>
        <ItemForm
          initialName={newName}
          onSaved={(it) => {
            const key = addingItem;
            setAddingItem(null);
            if (it?.id) {
              pick(key, it.id, it);
              toast(`Item "${it.name}" added`);
            }
          }}
          onCancel={() => setAddingItem(null)}
        />
      </Modal>
    </>
  );
}
