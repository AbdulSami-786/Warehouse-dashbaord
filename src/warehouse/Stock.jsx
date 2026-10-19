import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Boxes, Download, Package, PackageX, Printer,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import {
  money, r2, fmtDate, norm, qty, rangeFor,
} from '../lib/format.js';
import {
  itemStock, MOVE_TYPES, warehouseItemCard, warehouseStockMap,
} from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';
import { useSelectedWarehouse, WarehousePicker } from './WarehouseLayout.jsx';

export default function Stock() {
  const { data, settings, activeWarehouses, toast, access } = useApp();
  const sc = access.seesCost;
  const navigate = useNavigate();
  const selected = useSelectedWarehouse();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [show, setShow] = useState('in-stock');
  const categories = useMemo(() => [...new Set(data.items.map((i) => i.category).filter(Boolean))].sort(), [data.items]);
  const map = useMemo(() => warehouseStockMap(data), [data]);
  const cols = selected ? activeWarehouses.filter((w) => w.id === selected) : activeWarehouses;
  const rows = useMemo(() => {
    const s = norm(q);
    return data.items
      .filter((i) => i.status !== 'archived')
      .filter((i) => category === 'all' || i.category === category)
      .filter((i) => !s || norm(i.name).includes(s) || norm(i.category).includes(s))
      .map((i) => {
        const per = cols.map((w) => map.get(w.id)?.get(i.id) || 0);
        const total = r2(per.reduce((t, v) => t + v, 0));
        const alert = Number(i.lowStockAlert) || 0;
        return {
          item: i, per, total, shop: itemStock(i.id, data), value: r2(Math.max(0, total) * (Number(i.costPrice) || 0)),
          low: alert > 0 && total <= alert,
        };
      })
      .filter((r) => (show === 'all' ? true : show === 'low' ? r.low : Math.abs(r.total) > 0.0001))
      .sort((a, b) => a.item.name.localeCompare(b.item.name));
  }, [data, q, category, show, cols, map]);
  const totals = useMemo(() => ({
    value: r2(rows.reduce((s, r) => s + r.value, 0)),
    units: r2(rows.reduce((s, r) => s + Math.max(0, r.total), 0)),
    per: cols.map((_, i) => r2(rows.reduce((s, r) => s + r.per[i], 0))),
    low: rows.filter((r) => r.low).length,
  }), [rows, cols]);
  const scope = selected ? cols[0]?.name : 'All warehouses';
  const headers = ['Item', 'Category', ...cols.map((w) => w.code || w.name), ...(cols.length > 1 ? ['Total'] : []), 'Unit', ...(sc ? ['Value'] : [])];
  const tableRows = rows.map((r) => [r.item.name, r.item.category || '', ...r.per.map((v) => qty(v)), ...(cols.length > 1 ? [qty(r.total)] : []), r.item.baseUnit, ...(sc ? [money(r.value)] : [])]);
  const toExcel = () => {
    exportCSV('WarehouseStock', headers, rows.map((r) => [r.item.name, r.item.category || '', ...r.per, ...(cols.length > 1 ? [r.total] : []), r.item.baseUnit, ...(sc ? [r.value.toFixed(2)] : [])]),
      [`${settings.shopName} — Warehouse Stock`, scope, `As at ${fmtDate(new Date())}`, ...(sc ? [`Value ${money(totals.value)}`] : [])]);
    toast('Stock exported');
  };
  const toPDF = () => printReport({
    title: 'Warehouse Stock', subtitle: scope, shopName: settings.shopName,
    headers: headers.map((h, i) => (i >= 2 && h !== 'Unit' ? { label: h, align: 'r' } : h)),
    rows: tableRows,
    totals: ['Total', '', ...totals.per.map((v) => qty(v)), ...(cols.length > 1 ? [qty(totals.units)] : []), '', ...(sc ? [money(totals.value)] : [])],
    meta: [`As at ${fmtDate(new Date())}`, `${rows.length} items`],
  });
  return (
    <>
      <PageHead title="Stock" subtitle={sc ? `${scope} · ${rows.length} items · ${money(totals.value)} at cost` : `${scope} · ${rows.length} items`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search item…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select value={show} onChange={(e) => setShow(e.target.value)} style={{ width: 140 }} options={[{ value: 'in-stock', label: 'In stock' }, { value: 'low', label: 'Low stock' }, { value: 'all', label: 'All items' }]} />
        <WarehousePicker style={{ width: 170 }} />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat className="cost-only" label="Stock Value (at cost)" value={money(totals.value)} icon={Boxes} tone="#16A34A" />
        <Stat label="Units" value={qty(totals.units)} icon={Boxes} tone="#1F2937" />
        <Stat label="Items" value={rows.length} icon={Package} tone="#F59E0B" />
        <Stat label="Low Stock" value={totals.low} icon={PackageX} tone="#DC2626" onClick={() => setShow('low')} note="At or below each item's alert level" />
      </div>
      <Card tight>
        {!cols.length ? (
          <Empty icon={Boxes} title="No warehouses yet" message="Add a warehouse to start keeping stock in it." action={<Button variant="primary" onClick={() => navigate('/warehouse/list')}>Add Warehouse</Button>} />
        ) : rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th>
                    {cols.map((w) => <th key={w.id} className="r" title={w.name}>{w.code || w.name}</th>)}
                    {cols.length > 1 && <th className="r">Total</th>}
                    <th className="r">In shop</th>
                    <th className="r cost-only">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.item.id} className="clickable" onClick={() => navigate(`/warehouse/item/${r.item.id}${selected ? `?wh=${selected}` : ''}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.item.name}{r.low && <> <Pill status="due" label="Low" /></>}</div>
                        <div className="small muted">{[r.item.category, r.item.baseUnit].filter(Boolean).join(' · ')}</div>
                      </td>
                      {r.per.map((v, i) => (
                        <td key={cols[i].id} className="r num" style={{ color: v < 0 ? 'var(--danger)' : v === 0 ? 'var(--text-muted)' : undefined }}>{v ? qty(v) : '—'}</td>
                      ))}
                      {cols.length > 1 && <td className="r strong num">{qty(r.total)}</td>}
                      <td className="r muted num">{qty(r.shop)}</td>
                      <td className="r cost-only"><Money value={r.value} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{rows.length} items</td>
                    {totals.per.map((v, i) => <td key={cols[i].id} className="r">{qty(v)}</td>)}
                    {cols.length > 1 && <td className="r">{qty(totals.units)}</td>}
                    <td />
                    <td className="r cost-only">{money(totals.value)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((r) => (
                <div key={r.item.id} className="mcard" onClick={() => navigate(`/warehouse/item/${r.item.id}${selected ? `?wh=${selected}` : ''}`)}>
                  <div className="top"><span className="name">{r.item.name}</span><span className="amt num">{qty(r.total)} {r.item.baseUnit}</span></div>
                  <div className="meta">
                    {r.low && <Pill status="due" label="Low" />}
                    {cols.length > 1 && r.per.map((v, i) => (v ? <span key={cols[i].id}>{cols[i].code || cols[i].name}: {qty(v)}</span> : null))}
                    <span className="cost-only">{money(r.value)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty icon={Boxes} title={q ? 'No matching items' : show === 'low' ? 'No low stock' : 'Nothing in stock'} message={q ? `Nothing matches "${q}".` : show === 'low' ? 'Every item is above its alert level.' : 'Record a Stock In to bring goods into a warehouse.'} />
        )}
      </Card>
    </>
  );
}

/** Every movement of one item in one warehouse (or each warehouse), with a running balance. */
export function ItemCard() {
  const { itemId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { data, settings, activeWarehouses, toast, access } = useApp();
  const sc = access.seesCost;
  const selected = useSelectedWarehouse();
  const [wid, setWid] = useState(() => search.get('wh') || selected || activeWarehouses[0]?.id || '');
  const [preset, setPreset] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const item = data.items.find((i) => i.id === itemId);
  const rows = useMemo(() => (wid ? warehouseItemCard(wid, itemId, data, range.from, range.to) : []), [wid, itemId, data, range]);
  const map = useMemo(() => warehouseStockMap(data), [data]);
  if (!item) return <Empty icon={Package} title="Item not found" action={<Button onClick={() => navigate('/warehouse/stock')}>Back to Stock</Button>} />;
  const wh = activeWarehouses.find((w) => w.id === wid) || (data.warehouses || []).find((w) => w.id === wid);
  const balance = map.get(wid)?.get(itemId) || 0;
  const inQ = r2(rows.reduce((s, r) => s + r.inQty, 0));
  const outQ = r2(rows.reduce((s, r) => s + r.outQty, 0));
  const toExcel = () => {
    exportCSV(`StockCard_${item.name}`, ['Date', 'Document', 'Type', 'Party / route', 'In', 'Out', 'Balance'],
      rows.map((r) => [fmtDate(r.date), r.docNo, MOVE_TYPES[r.type]?.label, r.party, r.inQty || '', r.outQty || '', r.balance]),
      [`${settings.shopName} — Stock card: ${item.name}`, wh?.name || '', `Balance: ${qty(balance)} ${item.baseUnit}`]);
    toast('Stock card exported');
  };
  const toPDF = () => printReport({
    title: `Stock Card — ${item.name}`, subtitle: wh?.name || '', shopName: settings.shopName,
    headers: ['Date', 'Document', 'Type', 'Party / route', { label: 'In', align: 'r' }, { label: 'Out', align: 'r' }, { label: 'Balance', align: 'r' }],
    rows: rows.map((r) => [fmtDate(r.date), r.docNo, MOVE_TYPES[r.type]?.label, r.party, r.inQty ? qty(r.inQty) : '—', r.outQty ? qty(r.outQty) : '—', qty(r.balance)]),
    totals: ['', '', '', 'Totals', qty(inQ), qty(outQ), qty(balance)],
    meta: [`Unit: ${item.baseUnit}`],
  });
  return (
    <>
      <PageHead title={item.name} subtitle={`Stock card · ${[item.category, item.baseUnit].filter(Boolean).join(' · ')}`}>
        <Button icon={ArrowLeft} onClick={() => navigate(-1)}>Back</Button>
        <Select value={wid} onChange={(e) => setWid(e.target.value)} style={{ width: 190 }}>
          {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label={`In ${wh?.name || 'warehouse'}`} value={`${qty(balance)} ${item.baseUnit}`} icon={Boxes} tone="#1F2937" />
        <Stat label="Received (period)" value={qty(inQ)} icon={ArrowDownToLine} tone="#16A34A" />
        <Stat label="Sent out (period)" value={qty(outQ)} icon={ArrowUpFromLine} tone="#DC2626" />
        <Stat label="In the shop" value={`${qty(itemStock(item.id, data))} ${item.baseUnit}`} icon={Package} tone="#1F2937" />
      </div>
      {activeWarehouses.length > 1 && (
        <div className="chips mb-2">
          {activeWarehouses.map((w) => {
            const v = map.get(w.id)?.get(itemId) || 0;
            return (
              <button key={w.id} className={`chip ${w.id === wid ? 'chip-active' : ''}`} onClick={() => setWid(w.id)}>
                {w.name}: <strong>{qty(v)}</strong>
              </button>
            );
          })}
        </div>
      )}
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} presets={[{ value: 'all', label: 'All time' }, { value: 'month', label: 'This month' }, { value: 'lastMonth', label: 'Last month' }]} /></div>
      <Card tight title="Movements" subtitle={preset === 'all' ? 'Running balance from the first movement' : 'Running balance is the true balance at each date'}>
        {rows.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Document</th><th>Type</th><th>Party / route</th><th className="r">In</th><th className="r">Out</th><th className="r">Balance</th></tr></thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/warehouse/move/${r.moveId}`)}>
                    <td className="nowrap">{fmtDate(r.date)}</td>
                    <td style={{ fontWeight: 600 }}>{r.docNo}</td>
                    <td><Pill status={MOVE_TYPES[r.type]?.tone} label={MOVE_TYPES[r.type]?.label} /></td>
                    <td className="small">{r.party || '—'}</td>
                    <td className="r num" style={{ color: 'var(--success)' }}>{r.inQty ? `+${qty(r.inQty)}` : ''}</td>
                    <td className="r num" style={{ color: 'var(--danger)' }}>{r.outQty ? `−${qty(r.outQty)}` : ''}</td>
                    <td className="r strong num">{qty(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={4}>{rows.length} movements</td><td className="r">{qty(inQ)}</td><td className="r">{qty(outQ)}</td><td className="r">{qty(balance)}</td></tr></tfoot>
            </table>
          </div>
        ) : <Empty icon={Boxes} title="No movements" message={`${item.name} has not moved in or out of ${wh?.name || 'this warehouse'} in this period.`} />}
      </Card>
    </>
  );
}
