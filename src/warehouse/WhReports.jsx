import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ArrowDownToLine, ArrowUpFromLine, Download, Printer, Store, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import {
  money, r2, fmtDate, qty, rangeFor, inRange,
} from '../lib/format.js';
import { MOVE_TYPES, moveEffect, warehouseExpenseTotal } from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Money, PageHead, Select, Stat,
} from '../components/ui.jsx';
import { useSelectedWarehouse, WarehousePicker } from './WarehouseLayout.jsx';

/** Movement summary for a period: what came in and went out, by warehouse, item and type. */
export default function WhReports() {
  const { data, settings, toast, access } = useApp();
  const sc = access.seesCost;
  const selected = useSelectedWarehouse();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [by, setBy] = useState('item');
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const whs = useMemo(() => (data.warehouses || []).filter((w) => (selected ? w.id === selected : w.status !== 'archived')), [data.warehouses, selected]);

  // One row per (warehouse, line) with its signed effect on that warehouse.
  const flows = useMemo(() => {
    const moves = new Map((data.whMoves || []).filter((m) => m.status !== 'voided' && inRange(m.date, range.from, range.to)).map((m) => [m.id, m]));
    const out = [];
    (data.whMoveLines || []).forEach((l) => {
      const m = moves.get(l.moveId);
      if (!m) return;
      const it = data.items.find((i) => i.id === l.itemId);
      const rate = l.rate === '' || l.rate == null ? Number(it?.costPrice) || 0 : Number(l.rate) || 0;
      whs.forEach((w) => {
        const sign = moveEffect(m, w.id);
        if (!sign) return;
        const q = Number(l.qty) || 0;
        out.push({ wid: w.id, itemId: l.itemId, type: m.type, date: m.date, inQ: sign > 0 ? q : 0, outQ: sign < 0 ? q : 0, value: r2(q * rate), sign });
      });
    });
    return out;
  }, [data, range, whs]);

  const totals = useMemo(() => ({
    inQ: r2(flows.reduce((s, f) => s + f.inQ, 0)),
    outQ: r2(flows.reduce((s, f) => s + f.outQ, 0)),
    inV: r2(flows.filter((f) => f.sign > 0).reduce((s, f) => s + f.value, 0)),
    outV: r2(flows.filter((f) => f.sign < 0).reduce((s, f) => s + f.value, 0)),
    toShop: r2(flows.filter((f) => f.type === 'to-shop').reduce((s, f) => s + f.outQ, 0)),
    expenses: r2(whs.reduce((s, w) => s + warehouseExpenseTotal(data.whExpenses, w.id, range.from, range.to), 0)),
  }), [flows, whs, data.whExpenses, range]);

  const groups = useMemo(() => {
    const keyOf = (f) => (by === 'item' ? f.itemId : by === 'warehouse' ? f.wid : by === 'type' ? f.type : f.date);
    const labelOf = (k) => {
      if (by === 'item') return data.items.find((i) => i.id === k)?.name || 'Item';
      if (by === 'warehouse') return (data.warehouses || []).find((w) => w.id === k)?.name || 'Warehouse';
      if (by === 'type') return MOVE_TYPES[k]?.label || k;
      return k;
    };
    const m = new Map();
    flows.forEach((f) => {
      const k = keyOf(f);
      if (!m.has(k)) m.set(k, { key: k, label: labelOf(k), inQ: 0, outQ: 0, inV: 0, outV: 0, unit: by === 'item' ? data.items.find((i) => i.id === k)?.baseUnit || '' : '' });
      const g = m.get(k);
      g.inQ = r2(g.inQ + f.inQ);
      g.outQ = r2(g.outQ + f.outQ);
      if (f.sign > 0) g.inV = r2(g.inV + f.value);
      else g.outV = r2(g.outV + f.value);
    });
    return [...m.values()].sort((a, b) => (by === 'day' ? String(a.key).localeCompare(String(b.key)) : (b.inQ + b.outQ) - (a.inQ + a.outQ)));
  }, [flows, by, data]);

  const chart = useMemo(() => {
    const m = new Map();
    flows.forEach((f) => {
      if (!m.has(f.date)) m.set(f.date, { in: 0, out: 0 });
      const d = m.get(f.date);
      d.in = r2(d.in + f.inQ);
      d.out = r2(d.out + f.outQ);
    });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31)
      .map(([d, v]) => ({ date: new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), In: v.in, Out: v.out }));
  }, [flows]);

  const head = { item: 'Item', warehouse: 'Warehouse', type: 'Movement type', day: 'Date' }[by];
  const labelText = (g) => (by === 'day' ? fmtDate(g.label) : g.label);
  const scope = selected ? whs[0]?.name : 'All warehouses';
  const period = range.from && range.to ? `${fmtDate(range.from)} — ${fmtDate(range.to)}` : 'All time';
  const toExcel = () => {
    exportCSV(`WarehouseReport_by_${by}`, [head, 'Qty In', 'Qty Out', 'Net', ...(sc ? ['Value In', 'Value Out'] : [])],
      groups.map((g) => [labelText(g), g.inQ, g.outQ, r2(g.inQ - g.outQ), ...(sc ? [g.inV.toFixed(2), g.outV.toFixed(2)] : [])]),
      [`${settings.shopName} — Warehouse Report`, scope, period]);
    toast('Report exported');
  };
  const toPDF = () => printReport({
    title: 'Warehouse Movement Report', subtitle: `${scope} · by ${head.toLowerCase()}`, shopName: settings.shopName,
    headers: [head, { label: 'In', align: 'r' }, { label: 'Out', align: 'r' }, { label: 'Net', align: 'r' }, ...(sc ? [{ label: 'Value in', align: 'r' }, { label: 'Value out', align: 'r' }] : [])],
    rows: groups.map((g) => [labelText(g), qty(g.inQ), qty(g.outQ), qty(r2(g.inQ - g.outQ)), ...(sc ? [money(g.inV), money(g.outV)] : [])]),
    totals: ['Totals', qty(totals.inQ), qty(totals.outQ), qty(r2(totals.inQ - totals.outQ)), ...(sc ? [money(totals.inV), money(totals.outV)] : [])],
    meta: [period, `Warehouse expenses: ${money(totals.expenses)}`],
  });
  return (
    <>
      <PageHead title="Warehouse Reports" subtitle={`${scope} · ${period}`}>
        <Select value={by} onChange={(e) => setBy(e.target.value)} style={{ width: 170 }} options={[{ value: 'item', label: 'By item' }, { value: 'warehouse', label: 'By warehouse' }, { value: 'type', label: 'By movement type' }, { value: 'day', label: 'By day' }]} />
        <WarehousePicker style={{ width: 170 }} />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="stat-grid">
        <Stat label="Units In" value={qty(totals.inQ)} icon={ArrowDownToLine} tone="#16A34A" note={sc ? money(totals.inV) : undefined} />
        <Stat label="Units Out" value={qty(totals.outQ)} icon={ArrowUpFromLine} tone="#DC2626" note={sc ? money(totals.outV) : undefined} />
        <Stat label="Sent to Shop" value={qty(totals.toShop)} icon={Store} tone="#B7791F" />
        <Stat label="Running Costs" value={money(totals.expenses)} icon={Wallet} tone="#F59E0B" />
      </div>
      {chart.length > 1 && (
        <Card title="In vs Out" subtitle="Units per day" className="mb-2">
          <div style={{ width: '100%', height: 230 }}>
            <ResponsiveContainer>
              <BarChart data={chart} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="In" fill="#16A34A" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Out" fill="#DC2626" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      <Card title={`Movements by ${head.toLowerCase()}`} tight>
        {groups.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>{head}</th><th className="r">In</th><th className="r">Out</th><th className="r">Net</th><th className="r cost-only">Value in</th><th className="r cost-only">Value out</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td style={{ fontWeight: 600 }}>{labelText(g)}{g.unit && <span className="small muted"> · {g.unit}</span>}</td>
                    <td className="r num" style={{ color: 'var(--success)' }}>{g.inQ ? qty(g.inQ) : '—'}</td>
                    <td className="r num" style={{ color: 'var(--danger)' }}>{g.outQ ? qty(g.outQ) : '—'}</td>
                    <td className="r strong num">{qty(r2(g.inQ - g.outQ))}</td>
                    <td className="r cost-only"><Money value={g.inV} /></td>
                    <td className="r cost-only"><Money value={g.outV} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Totals</td>
                  <td className="r">{qty(totals.inQ)}</td>
                  <td className="r">{qty(totals.outQ)}</td>
                  <td className="r">{qty(r2(totals.inQ - totals.outQ))}</td>
                  <td className="r cost-only">{money(totals.inV)}</td>
                  <td className="r cost-only">{money(totals.outV)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : <Empty icon={ArrowDownToLine} title="No movements in this period" message="Change the date range or warehouse." />}
      </Card>
    </>
  );
}
