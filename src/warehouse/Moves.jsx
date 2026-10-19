import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Ban, CircleCheck, ClipboardList, Download, Plus, Printer,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import {
  money, r2, fmtDate, fmtDateTime, norm, qty, rangeFor, inRange,
} from '../lib/format.js';
import { MOVE_TYPES, moveEffect } from '../lib/calc.js';
import { exportCSV, printReport, esc } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';
import { useSelectedWarehouse, WarehousePicker } from './WarehouseLayout.jsx';
import ImportButton from '../components/ImportButton.jsx';

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  ...Object.entries(MOVE_TYPES).map(([value, m]) => ({ value, label: m.label })),
];

/** Where a movement goes, in words: "Main → Branch", "→ Shop", "Ahmed Traders". */
export function routeText(m, whName) {
  if (m.type === 'transfer') return `${whName(m.warehouseId)} → ${whName(m.toWarehouseId)}`;
  if (m.type === 'to-shop') return `${whName(m.warehouseId)} → Shop`;
  if (m.type === 'from-shop') return `Shop → ${whName(m.warehouseId)}`;
  if (m.type === 'in') return `${m.partyName || 'Supplier'} → ${whName(m.warehouseId)}`;
  if (m.type === 'out') return `${whName(m.warehouseId)} → ${m.partyName || 'Customer'}`;
  return `${whName(m.warehouseId)}${m.reason ? ` · ${m.reason}` : ''}`;
}

export default function Moves() {
  const { data, settings, toast } = useApp();
  const navigate = useNavigate();
  const selected = useSelectedWarehouse();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const whName = (id) => (data.warehouses || []).find((w) => w.id === id)?.name || 'Warehouse';
  const rows = useMemo(() => {
    const s = norm(q);
    const lines = new Map();
    (data.whMoveLines || []).forEach((l) => {
      if (!lines.has(l.moveId)) lines.set(l.moveId, []);
      lines.get(l.moveId).push(l);
    });
    const itemName = (id) => data.items.find((i) => i.id === id)?.name || '';
    return (data.whMoves || [])
      .filter((m) => showCancelled || m.status !== 'voided')
      .filter((m) => !selected || m.warehouseId === selected || m.toWarehouseId === selected)
      .filter((m) => type === 'all' || m.type === type)
      .filter((m) => inRange(m.date, range.from, range.to))
      .map((m) => {
        const ls = lines.get(m.id) || [];
        const value = r2(ls.reduce((t, l) => t + (Number(l.qty) || 0) * (l.rate === '' || l.rate == null ? Number(data.items.find((i) => i.id === l.itemId)?.costPrice) || 0 : Number(l.rate) || 0), 0));
        return { ...m, lines: ls, units: r2(ls.reduce((t, l) => t + (Number(l.qty) || 0), 0)), value, route: routeText(m, whName), items: ls.map((l) => itemName(l.itemId)).join(', ') };
      })
      .filter((m) => !s || norm([m.docNo, m.partyName, m.reference, m.vehicleNo, m.driverName, m.note, m.items, m.route].join(' ')).includes(s))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [data, q, type, range, selected, showCancelled]);
  const totals = useMemo(() => {
    const live = rows.filter((m) => m.status !== 'voided');
    let inQ = 0;
    let outQ = 0;
    live.forEach((m) => {
      const ids = selected ? [selected] : [m.warehouseId, m.toWarehouseId].filter(Boolean);
      if (m.type === 'transfer' && !selected) return;
      ids.forEach((wid) => {
        const sign = moveEffect(m, wid);
        if (sign > 0) inQ += m.units;
        if (sign < 0) outQ += m.units;
      });
    });
    return { count: live.length, inQ: r2(inQ), outQ: r2(outQ), value: r2(live.reduce((t, m) => t + m.value, 0)) };
  }, [rows, selected]);
  const toExcel = () => {
    const out = [];
    rows.forEach((m) => m.lines.forEach((l) => {
      const it = data.items.find((i) => i.id === l.itemId);
      out.push([m.docNo, fmtDate(m.date), MOVE_TYPES[m.type]?.label, m.route, it?.name || '', l.qty, l.unit, l.rate ?? '', m.reference, m.vehicleNo, m.status === 'voided' ? 'Cancelled' : 'Active']);
    }));
    exportCSV('WarehouseMovements', ['Doc No', 'Date', 'Type', 'Route', 'Item', 'Qty', 'Unit', 'Rate', 'Reference', 'Vehicle', 'Status'], out,
      [`${settings.shopName} — Warehouse Movements`, selected ? whName(selected) : 'All warehouses']);
    toast('Movements exported');
  };
  return (
    <>
      <PageHead title="All Movements" subtitle={`${totals.count} documents · ${selected ? whName(selected) : 'all warehouses'}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Doc no, item, party, vehicle…" />
        <Select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 160 }} options={TYPE_OPTIONS} />
        <WarehousePicker style={{ width: 170 }} />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="whMoves" />
        <Button variant="primary" icon={Plus} onClick={() => navigate('/warehouse/new/in')}>Stock In</Button>
      </PageHead>
      <div className="row mb-2" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
        <span className="spacer" />
        <label className="row small" style={{ gap: 7, cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} style={{ width: 16, height: 16 }} /> Show cancelled
        </label>
      </div>
      <div className="stat-grid">
        <Stat label="Documents" value={totals.count} icon={ClipboardList} tone="#1F2937" />
        <Stat label="Units In" value={qty(totals.inQ)} icon={ArrowDownToLine} tone="#16A34A" note={!selected ? 'Transfers between warehouses not counted' : undefined} />
        <Stat label="Units Out" value={qty(totals.outQ)} icon={ArrowUpFromLine} tone="#DC2626" />
        <Stat className="cost-only" label="Value Moved" value={money(totals.value)} icon={ClipboardList} tone="#1F2937" />
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Document</th><th>Date</th><th>Type</th><th>Route</th><th>Items</th><th className="r">Qty</th><th className="r cost-only">Value</th></tr></thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className="clickable" onClick={() => navigate(`/warehouse/move/${m.id}`)} style={m.status === 'voided' ? { opacity: 0.55 } : undefined}>
                      <td style={{ fontWeight: 600, textDecoration: m.status === 'voided' ? 'line-through' : 'none' }}>
                        {m.docNo}
                        {m.reference && <div className="small muted" style={{ fontWeight: 400 }}>Ref {m.reference}</div>}
                      </td>
                      <td className="nowrap">{fmtDate(m.date)}</td>
                      <td>{m.status === 'voided' ? <Pill status="voided" label="Cancelled" /> : <Pill status={MOVE_TYPES[m.type]?.tone} label={MOVE_TYPES[m.type]?.label} />}</td>
                      <td className="small">{m.route}</td>
                      <td className="small muted" style={{ maxWidth: 260 }}>{m.items}</td>
                      <td className="r strong num">{qty(m.units)}</td>
                      <td className="r cost-only"><Money value={m.value} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={5}>{rows.length} documents</td><td /><td className="r cost-only">{money(totals.value)}</td></tr></tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((m) => (
                <div key={m.id} className="mcard" onClick={() => navigate(`/warehouse/move/${m.id}`)} style={m.status === 'voided' ? { opacity: 0.55 } : undefined}>
                  <div className="top"><span className="name">{m.docNo}</span><span className="amt num">{qty(m.units)}</span></div>
                  <div className="small muted">{m.route}</div>
                  <div className="meta">
                    {m.status === 'voided' ? <Pill status="voided" label="Cancelled" /> : <Pill status={MOVE_TYPES[m.type]?.tone} label={MOVE_TYPES[m.type]?.label} />}
                    <span>{fmtDate(m.date)}</span><span>{m.lines.length} item{m.lines.length === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={ClipboardList}
            title={q || type !== 'all' ? 'No matching movements' : 'No movements in this period'}
            message={q || type !== 'all' ? 'Try a different filter.' : 'Stock in, stock out, transfers and adjustments appear here.'}
            action={<Button variant="primary" icon={Plus} onClick={() => navigate('/warehouse/new/in')}>Record Stock In</Button>}
          />
        )}
      </Card>
    </>
  );
}

const DOC_TITLE = {
  in: 'Goods Received Note', out: 'Delivery Challan / Gate Pass', transfer: 'Stock Transfer Note',
  'to-shop': 'Dispatch to Shop', 'from-shop': 'Receipt from Shop', 'adjust-in': 'Stock Adjustment', 'adjust-out': 'Stock Adjustment',
};

export function MoveView() {
  const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { data, settings, mutate, access } = useApp();
  const sc = access.seesCost;
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const move = (data.whMoves || []).find((m) => m.id === id);
  const justSaved = search.get('saved') === '1';
  useEffect(() => {
    if (justSaved) {
      const t = setTimeout(() => setSearch({}, { replace: true }), 6000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [justSaved, setSearch]);
  if (!move) return <Empty icon={ClipboardList} title="Movement not found" action={<Button onClick={() => navigate('/warehouse/moves')}>Back to Movements</Button>} />;
  const wh = (wid) => (data.warehouses || []).find((w) => w.id === wid);
  const whName = (wid) => wh(wid)?.name || 'Warehouse';
  const lines = (data.whMoveLines || []).filter((l) => l.moveId === move.id).map((l) => {
    const it = data.items.find((i) => i.id === l.itemId);
    const rate = l.rate === '' || l.rate == null ? Number(it?.costPrice) || 0 : Number(l.rate) || 0;
    return { ...l, item: it, rate, value: r2((Number(l.qty) || 0) * rate) };
  });
  const units = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
  const value = r2(lines.reduce((s, l) => s + l.value, 0));
  const meta = MOVE_TYPES[move.type] || {};
  const cancelled = move.status === 'voided';
  const docTitle = DOC_TITLE[move.type] || 'Stock Movement';
  const route = routeText(move, whName);

  const print = () => {
    const src = wh(move.warehouseId);
    const sign = `<div class="sign"><div>Prepared by${move.createdBy ? ` (${esc(move.createdBy)})` : ''}</div><div>${move.type === 'in' ? 'Received by' : 'Checked by'}</div><div>${move.type === 'in' ? 'Delivered by' : 'Received by'}</div></div>`;
    printReport({
      title: docTitle,
      subtitle: [src?.name, src?.location, src?.phone].filter(Boolean).join(' · '),
      shopName: settings.shopName,
      headers: ['#', 'Item', { label: 'Qty', align: 'r' }, 'Unit', ...(sc ? [{ label: 'Rate', align: 'r' }, { label: 'Value', align: 'r' }] : [])],
      rows: lines.map((l, i) => [i + 1, l.item?.name || 'Item', qty(l.qty), [l.unit, l.note && `(${l.note})`].filter(Boolean).join(' '), ...(sc ? [money(l.rate), money(l.value)] : [])]),
      totals: ['', 'Total', qty(units), '', ...(sc ? ['', money(value)] : [])],
      meta: [
        `No. ${move.docNo}`, `Date: ${fmtDate(move.date)}`, route,
        ...(move.reference ? [`Ref: ${move.reference}`] : []), ...(move.vehicleNo ? [`Vehicle: ${move.vehicleNo}`] : []),
        ...(move.driverName ? [`Driver: ${move.driverName}`] : []), ...(move.reason ? [`Reason: ${move.reason}`] : []),
        ...(move.note ? [`Note: ${move.note}`] : []), ...(cancelled ? ['CANCELLED'] : []),
      ],
      footerHtml: sign,
    });
  };
  const doVoid = async () => {
    setVoiding(false);
    await mutate(() => api.voidWhMove(move.id, reason), `${move.docNo} cancelled`).catch(() => {});
    setReason('');
  };
  return (
    <>
      <PageHead title={`${move.docNo}`} subtitle={`${meta.label} · ${fmtDate(move.date)} · ${route}`}>
        <Button icon={ArrowLeft} onClick={() => navigate('/warehouse/moves')}>Movements</Button>
        <Button icon={Printer} variant={justSaved ? 'primary' : ''} onClick={print}>Print {move.type === 'out' ? 'Gate Pass' : move.type === 'in' ? 'GRN' : 'Document'}</Button>
        {!cancelled && <Button icon={Ban} onClick={() => setVoiding(true)}>Cancel</Button>}
      </PageHead>
      {justSaved && (
        <div style={{ padding: '12px 14px', background: 'var(--success-bg)', border: '1px solid #BBF7D0', borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center', color: '#15803D' }}>
          <CircleCheck size={17} />
          <div style={{ flex: 1 }}><strong>Saved.</strong> Stock has been updated. Print the document for the driver or for your records.</div>
          <Button size="sm" onClick={() => navigate(`/warehouse/new/${move.type === 'from-shop' ? 'to-shop' : move.type.startsWith('adjust') ? 'adjust' : move.type}`)}>Record another</Button>
        </div>
      )}
      {cancelled && (
        <div style={{ padding: '12px 14px', background: 'var(--neutral-bg)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center' }}>
          <Ban size={17} className="muted" />
          <div>
            <div style={{ fontWeight: 700 }}>This movement is cancelled</div>
            <div className="small muted">{move.voidReason || 'No reason recorded'}{move.voidedAt ? ` · ${fmtDateTime(move.voidedAt)}` : ''} — kept in history, not counted in stock.</div>
          </div>
        </div>
      )}
      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Items" tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th style={{ width: 34 }}>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r cost-only">Rate</th><th className="r cost-only">Value</th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id} className="clickable" onClick={() => navigate(`/warehouse/item/${l.itemId}?wh=${move.type === 'transfer' ? move.toWarehouseId : move.warehouseId}`)}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{l.item?.name || 'Item'}</td>
                      <td className="r num">{qty(l.qty)}</td>
                      <td>{l.unit}{l.note && <span className="small muted"> ({l.note})</span>}</td>
                      <td className="r cost-only"><Money value={l.rate} /></td>
                      <td className="r strong cost-only"><Money value={l.value} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2}>{lines.length} item{lines.length === 1 ? '' : 's'}</td><td className="r">{qty(units)}</td><td /><td className="cost-only" /><td className="r cost-only">{money(value)}</td></tr></tfoot>
              </table>
            </div>
          </Card>
          {move.note && <Card title="Note"><p style={{ margin: 0, fontSize: 13.5 }}>{move.note}</p></Card>}
        </div>
        <div className="col">
          <Card title="Details">
            <table className="tbl kv-tbl">
              <tbody>
                <tr><td className="muted">Type</td><td className="r"><Pill status={cancelled ? 'voided' : meta.tone} label={cancelled ? 'Cancelled' : meta.label} /></td></tr>
                <tr><td className="muted">{move.type === 'transfer' ? 'From' : 'Warehouse'}</td><td className="r strong">{whName(move.warehouseId)}</td></tr>
                {move.type === 'transfer' && <tr><td className="muted">To</td><td className="r strong">{whName(move.toWarehouseId)}</td></tr>}
                {move.partyName && <tr><td className="muted">{move.type === 'in' ? 'Received from' : 'Sent to'}</td><td className="r">{move.partyName}</td></tr>}
                {move.reason && <tr><td className="muted">Reason</td><td className="r">{move.reason}</td></tr>}
                {move.reference && <tr><td className="muted">Reference</td><td className="r">{move.reference}</td></tr>}
                {move.vehicleNo && <tr><td className="muted">Vehicle</td><td className="r">{move.vehicleNo}</td></tr>}
                {move.driverName && <tr><td className="muted">Driver</td><td className="r">{move.driverName}</td></tr>}
                <tr><td className="muted">Recorded</td><td className="r small">{fmtDateTime(move.createdAt)}{move.createdBy ? ` · ${move.createdBy}` : ''}</td></tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
      <Modal
        open={voiding}
        title={`Cancel ${move.docNo}?`}
        onClose={() => setVoiding(false)}
        footer={<><Button onClick={() => setVoiding(false)}>Keep it</Button><Button variant="danger" icon={Ban} onClick={doVoid}>Cancel movement</Button></>}
      >
        <p className="small">
          The stock change is undone: {meta.sign > 0 || move.type === 'transfer' ? 'goods that came in go back out' : 'goods that went out come back in'}
          {move.type === 'to-shop' ? ', and the shop\'s stock goes down again' : move.type === 'from-shop' ? ', and the shop\'s stock goes up again' : ''}.
          The document stays in history, struck through.
        </p>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. entered twice" autoFocus /></Field>
      </Modal>
    </>
  );
}
