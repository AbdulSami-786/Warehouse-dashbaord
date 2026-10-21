import { useMemo, useState } from 'react';
import {
  CircleAlert, Download, Printer, TrendingUp, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate, isoDate, pctChange, rangeFor, inRange } from '../lib/format.js';
import { billStates, isOpeningBill, methodBalances, periodSummary } from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Money, PageHead, Stat,
} from '../components/ui.jsx';

export default function Audit() {
  const { data, settings, methods, toast } = useApp();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const now = useMemo(() => periodSummary(data, range.from, range.to), [data, range]);
  // The same number of days immediately before.
  const prev = useMemo(() => {
    if (!range.from || !range.to) return null;
    const from = new Date(range.from);
    const to = new Date(range.to);
    const days = Math.max(1, Math.round((to - from) / 864e5) + 1);
    const end = new Date(from);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    return periodSummary(data, isoDate(start), isoDate(end));
  }, [data, range]);
  const balances = useMemo(() => methodBalances(methods, data), [methods, data]);
  const cash = r2(balances.reduce((s, b) => s + b.balance, 0));
  const newCredit = useMemo(() => r2(billStates(data.bills, data).filter((b) => b.status !== 'voided' && !isOpeningBill(b) && inRange(b.date, range.from, range.to)).reduce((s, b) => s + b.due, 0)), [data, range]);
  const period = range.from && range.to ? `${fmtDate(range.from)} — ${fmtDate(range.to)}` : 'All time';
  const metrics = [
    { label: 'Total sales', value: now.sales, prev: prev?.sales, tone: '#1F2937' },
    { label: 'Collections received', value: now.collections, prev: prev?.collections, tone: '#16A34A' },
    { label: 'Gross profit', value: now.grossProfit, prev: prev?.grossProfit, tone: '#16A34A' },
    { label: 'Expenses', value: now.expenses, prev: prev?.expenses, tone: '#DC2626' },
    { label: 'Salaries paid', value: now.salaries, prev: prev?.salaries, tone: '#DC2626' },
    { label: 'Net profit after costs', value: now.netProfit, prev: prev?.netProfit, tone: '#1E293B', strong: true },
  ];
  const extra = [
    ['Bills issued', now.billCount, prev?.billCount ?? ''],
    ['New credit given', newCredit, ''],
    ['Outstanding (all time)', now.outstanding, ''],
    ['Cash in hand (now)', cash, ''],
  ];
  const toExcel = () => {
    exportCSV('AuditSummary', ['Metric', 'This period', 'Previous period', 'Change %'], [
      ...metrics.map((m) => [m.label, m.value.toFixed(2), m.prev !== undefined ? m.prev.toFixed(2) : '', m.prev !== undefined ? pctChange(m.value, m.prev).toFixed(1) : '']),
      ['Bills issued', now.billCount, prev?.billCount ?? '', ''],
      ['New credit given', newCredit.toFixed(2), '', ''],
      ['Outstanding (all time)', now.outstanding.toFixed(2), '', ''],
      ['Cash in hand (now)', cash.toFixed(2), '', ''],
    ], [`${settings.shopName} — Audit / Account Summary`, period]);
    toast('Audit summary exported');
  };
  const toPDF = () => printReport({
    title: 'Audit / Account Summary', subtitle: period, shopName: settings.shopName,
    headers: ['Metric', { label: 'This period', align: 'r' }, { label: 'Previous', align: 'r' }, { label: 'Change', align: 'r' }],
    rows: [
      ...metrics.map((m) => {
        const ch = m.prev !== undefined ? pctChange(m.value, m.prev) : null;
        return [m.label, money(m.value), m.prev !== undefined ? money(m.prev) : '—', ch !== null ? `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%` : '—'];
      }),
      ['Bills issued', now.billCount, prev?.billCount ?? '—', ''],
      ['New credit given', money(newCredit), '', ''],
      ['Outstanding (all time)', money(now.outstanding), '', ''],
      ['Cash in hand (now)', money(cash), '', ''],
    ],
  });
  return (
    <>
      <PageHead title="Audit / Account Summary" subtitle={period}>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="stat-grid">
        <Stat label="Total Sales" value={money(now.sales)} icon={TrendingUp} tone="#1F2937" delta={prev ? pctChange(now.sales, prev.sales) : undefined} deltaLabel="vs previous" />
        <Stat label="Collections" value={money(now.collections)} icon={Wallet} tone="#16A34A" delta={prev ? pctChange(now.collections, prev.collections) : undefined} deltaLabel="vs previous" />
        <Stat label="Net Profit" value={money(now.netProfit)} icon={TrendingUp} tone="#16A34A" delta={prev ? pctChange(now.netProfit, prev.netProfit) : undefined} deltaLabel="vs previous" />
        <Stat label="Outstanding" value={money(now.outstanding)} icon={CircleAlert} tone="#DC2626" />
      </div>
      <div className="grid-2">
        <Card title="Financial Summary" tight subtitle={prev ? 'Compared with the previous period of the same length' : undefined}>
          <table className="tbl">
            <thead><tr><th>Metric</th><th className="r">This period</th>{prev && <th className="r">Previous</th>}{prev && <th className="r">Change</th>}</tr></thead>
            <tbody>
              {metrics.map((m) => {
                const ch = m.prev !== undefined ? pctChange(m.value, m.prev) : null;
                return (
                  <tr key={m.label} style={m.strong ? { background: '#FAFBFC' } : undefined}>
                    <td style={{ fontWeight: m.strong ? 700 : 500 }}>{m.label}</td>
                    <td className="r strong"><span className="money" style={{ color: m.tone, fontSize: m.strong ? 15 : undefined }}>{money(m.value)}</span></td>
                    {prev && <td className="r muted"><Money value={m.prev} className="small" /></td>}
                    {prev && (
                      <td className="r">
                        <span style={{ fontWeight: 600, fontSize: 12.5, color: ch > 0 ? 'var(--success)' : ch < 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                          {ch > 0 ? '▲' : ch < 0 ? '▼' : '—'} {Math.abs(ch).toFixed(1)}%
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <div className="col">
          <Card title="Position Right Now" tight>
            <table className="tbl">
              <tbody>
                <tr><td>Bills issued this period</td><td className="r strong">{extra[0][1]}</td></tr>
                <tr><td>New credit given this period</td><td className="r strong"><span className="money neg">{money(newCredit)}</span></td></tr>
                <tr><td>Total outstanding (all time)</td><td className="r strong"><span className="money neg">{money(now.outstanding)}</span></td></tr>
                <tr><td>Cash in hand (all methods)</td><td className="r strong"><span className="money pos">{money(cash)}</span></td></tr>
              </tbody>
            </table>
          </Card>
          <Card title="Balance by Method" tight>
            <table className="tbl">
              <tbody>{balances.map((b) => <tr key={b.method}><td>{b.method}</td><td className="r strong"><Money value={b.balance} /></td></tr>)}</tbody>
              <tfoot><tr><td>Total</td><td className="r">{money(cash)}</td></tr></tfoot>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}
