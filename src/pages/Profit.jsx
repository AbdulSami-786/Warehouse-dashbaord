import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Download, Package, Printer, TrendingUp } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate, rangeFor, inRange } from '../lib/format.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Money, PageHead, Select, Stat,
} from '../components/ui.jsx';

export default function Profit() {
  const { data, settings, toast } = useApp();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [by, setBy] = useState('item');
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const lines = useMemo(() => {
    const bills = data.bills.filter((b) => b.status !== 'voided' && inRange(b.date, range.from, range.to));
    const byId = new Map(bills.map((b) => [b.id, b]));
    return data.billItems.filter((l) => byId.has(l.billId)).map((l) => {
      const b = byId.get(l.billId);
      const revenue = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      const cost = r2((Number(l.qty) || 0) * (Number(l.costPriceAtSale) || 0));
      return {
        ...l, bill: b, date: b.date, partyId: b.partyId,
        itemName: data.items.find((i) => i.id === l.itemId)?.name || 'Item',
        partyName: data.parties.find((p) => p.id === b.partyId)?.name || 'Unknown',
        revenue, cost, profit: r2(revenue - cost), margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
      };
    });
  }, [data, range]);
  const totals = useMemo(() => {
    const revenue = r2(lines.reduce((s, l) => s + l.revenue, 0));
    const cost = r2(lines.reduce((s, l) => s + l.cost, 0));
    const profit = r2(revenue - cost);
    return { revenue, cost, profit, margin: revenue > 0 ? (profit / revenue) * 100 : 0 };
  }, [lines]);
  const groups = useMemo(() => {
    const key = by === 'item' ? 'itemId' : by === 'party' ? 'partyId' : 'date';
    const label = by === 'item' ? 'itemName' : by === 'party' ? 'partyName' : 'date';
    const m = new Map();
    lines.forEach((l) => {
      const k = l[key];
      if (!m.has(k)) m.set(k, { label: l[label], revenue: 0, cost: 0, profit: 0, qty: 0 });
      const g = m.get(k);
      g.revenue = r2(g.revenue + l.revenue);
      g.cost = r2(g.cost + l.cost);
      g.profit = r2(g.profit + l.profit);
      g.qty = r2(g.qty + (Number(l.qty) || 0));
    });
    return [...m.values()].map((g) => ({ ...g, margin: g.revenue > 0 ? (g.profit / g.revenue) * 100 : 0 }))
      .sort((a, b) => (by === 'day' ? new Date(a.label) - new Date(b.label) : b.profit - a.profit));
  }, [lines, by]);
  const trend = useMemo(() => {
    const m = new Map();
    lines.forEach((l) => m.set(l.date, r2((m.get(l.date) || 0) + l.profit)));
    return [...m.entries()].sort((a, b) => new Date(a[0]) - new Date(b[0])).slice(-30)
      .map(([d, p]) => ({ date: new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), profit: p }));
  }, [lines]);
  const head = by === 'item' ? 'Item' : by === 'party' ? 'Party' : 'Date';
  const labelOf = (g) => (by === 'day' ? fmtDate(g.label) : g.label);
  const toExcel = () => {
    exportCSV(`Profit_by_${by}`, [head, 'Qty', 'Revenue', 'Cost', 'Profit', 'Margin %'],
      groups.map((g) => [labelOf(g), g.qty, g.revenue.toFixed(2), g.cost.toFixed(2), g.profit.toFixed(2), g.margin.toFixed(1)]),
      [`${settings.shopName} — Profit Report`, `Revenue ${money(totals.revenue)} · Cost ${money(totals.cost)} · Profit ${money(totals.profit)}`]);
    toast('Profit report exported');
  };
  const toPDF = () => printReport({
    title: 'Profit Report', subtitle: `By ${head.toLowerCase()}`, shopName: settings.shopName,
    headers: [head, { label: 'Qty', align: 'r' }, { label: 'Revenue', align: 'r' }, { label: 'Cost', align: 'r' }, { label: 'Profit', align: 'r' }, { label: 'Margin', align: 'r' }],
    rows: groups.map((g) => [labelOf(g), g.qty, money(g.revenue), money(g.cost), money(g.profit), `${g.margin.toFixed(1)}%`]),
    totals: ['Totals', '', money(totals.revenue), money(totals.cost), money(totals.profit), `${totals.margin.toFixed(1)}%`],
  });
  const marginColor = (m) => (m >= 15 ? 'var(--success)' : m >= 5 ? 'var(--warning)' : 'var(--danger)');
  return (
    <>
      <PageHead title="Profit Report" subtitle="Gross profit uses the cost price captured at the time of each sale">
        <Select value={by} onChange={(e) => setBy(e.target.value)} style={{ width: 150 }} options={[{ value: 'item', label: 'By item' }, { value: 'party', label: 'By party' }, { value: 'day', label: 'By day' }]} />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="stat-grid">
        <Stat label="Revenue" value={money(totals.revenue)} icon={TrendingUp} tone="#1F2937" />
        <Stat label="Cost of Goods" value={money(totals.cost)} icon={Package} tone="#DC2626" />
        <Stat label="Gross Profit" value={money(totals.profit)} icon={TrendingUp} tone="#16A34A" />
        <Stat label="Margin" value={`${totals.margin.toFixed(1)}%`} icon={TrendingUp} tone="#F59E0B" />
      </div>
      {trend.length > 1 && (
        <Card title="Profit Trend" subtitle="Last 30 days with sales" className="mb-2">
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={trend} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                <Tooltip formatter={(v) => [money(v), 'Profit']} contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }} />
                <Bar dataKey="profit" fill="#16A34A" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      <Card title={`Profit by ${head}`} tight>
        {groups.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>{head}</th><th className="r">Qty sold</th><th className="r">Revenue</th><th className="r">Cost</th><th className="r">Profit</th><th className="r">Margin</th></tr></thead>
                <tbody>
                  {groups.map((g, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{labelOf(g)}</td>
                      <td className="r">{g.qty}</td>
                      <td className="r"><Money value={g.revenue} /></td>
                      <td className="r"><Money value={g.cost} /></td>
                      <td className="r strong"><span className="money" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(g.profit)}</span></td>
                      <td className="r"><span style={{ fontWeight: 600, color: marginColor(g.margin) }}>{g.margin.toFixed(1)}%</span></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Totals</td>
                    <td className="r">{money(totals.revenue)}</td>
                    <td className="r">{money(totals.cost)}</td>
                    <td className="r" style={{ color: 'var(--success)' }}>{money(totals.profit)}</td>
                    <td className="r">{totals.margin.toFixed(1)}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {groups.map((g, i) => (
                <div key={i} className="mcard">
                  <div className="top"><span className="name">{labelOf(g)}</span><span className="amt" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(g.profit)}</span></div>
                  <div className="meta"><span>Revenue {money(g.revenue)}</span><span>Cost {money(g.cost)}</span><span style={{ fontWeight: 600 }}>{g.margin.toFixed(1)}% margin</span></div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon={TrendingUp} title="No sales in this period" message="Change the date range, or record a bill to see profit." />}
      </Card>
    </>
  );
}
