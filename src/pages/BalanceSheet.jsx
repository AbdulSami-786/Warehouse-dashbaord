import { useMemo } from 'react';
import {
  Download, Printer, Scale, TrendingDown, TrendingUp,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate } from '../lib/format.js';
import { balanceSheet } from '../lib/calc.js';
import { exportCSV, printReport, raw, esc } from '../lib/exporters.js';
import {
  Button, Card, Money, PageHead, Stat,
} from '../components/ui.jsx';

function Side({ title, rows, total, totalLabel, tone }) {
  return (
    <Card title={title} tight>
      <table className="tbl">
        <tbody>
          {rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="r strong"><Money value={r.value} /></td></tr>)}
          {!rows.length && <tr><td colSpan={2} className="muted tc" style={{ padding: 22 }}>Nothing recorded</td></tr>}
        </tbody>
        <tfoot><tr><td>{totalLabel}</td><td className="r" style={{ fontSize: 15, color: tone }}>{money(total)}</td></tr></tfoot>
      </table>
    </Card>
  );
}

export default function BalanceSheet() {
  const { data, settings, methods, toast } = useApp();
  const bs = useMemo(() => balanceSheet({ ...data, methods }), [data, methods]);
  const asAt = fmtDate(new Date());
  const toExcel = () => {
    const rows = [
      ['OWNS (Assets)', ''], ...bs.owns.map((r) => [r.label, r.value.toFixed(2)]), ['Total Owns', bs.totalOwns.toFixed(2)], ['', ''],
      ['OWES (Liabilities)', ''], ...bs.owes.map((r) => [r.label, r.value.toFixed(2)]), ['Total Owes', bs.totalOwes.toFixed(2)], ['', ''],
      ['NET WORTH', bs.net.toFixed(2)],
    ];
    exportCSV('BalanceSheet', ['Item', 'Amount'], rows, [`${settings.shopName} — Balance Sheet`, `As at ${asAt}`]);
    toast('Balance sheet exported');
  };
  const toPDF = () => printReport({
    title: 'Balance Sheet', subtitle: `As at ${asAt}`, shopName: settings.shopName,
    headers: ['Item', { label: 'Amount', align: 'r' }],
    rows: [
      [raw('<strong>OWNS (Assets)</strong>'), ''], ...bs.owns.map((r) => [raw(`&nbsp;&nbsp;${esc(r.label)}`), money(r.value)]),
      [raw('<strong>Total Owns</strong>'), raw(`<strong>${money(bs.totalOwns)}</strong>`)], ['', ''],
      [raw('<strong>OWES (Liabilities)</strong>'), ''], ...bs.owes.map((r) => [raw(`&nbsp;&nbsp;${esc(r.label)}`), money(r.value)]),
      [raw('<strong>Total Owes</strong>'), raw(`<strong>${money(bs.totalOwes)}</strong>`)],
    ],
    totals: ['NET WORTH', money(bs.net)],
  });
  return (
    <>
      <PageHead title="Balance Sheet" subtitle={`Auto-generated from your data · As at ${asAt}`}>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Total Owns" value={money(bs.totalOwns)} icon={TrendingUp} tone="#16A34A" />
        <Stat label="Total Owes" value={money(bs.totalOwes)} icon={TrendingDown} tone="#DC2626" />
        <Stat label="Net Worth" value={money(bs.net)} icon={Scale} tone="#1F2937" />
      </div>
      <div className="grid-2">
        <Side title="Owns" rows={bs.owns} total={bs.totalOwns} totalLabel="Total Owns" tone="var(--success)" />
        <Side title="Owes" rows={bs.owes} total={bs.totalOwes} totalLabel="Total Owes" tone="var(--danger)" />
      </div>
      <Card title="Cash & Bank Breakdown" tight className="mt-2">
        <table className="tbl">
          <thead><tr><th>Payment method</th><th className="r">Balance</th></tr></thead>
          <tbody>
            {bs.balances.map((b) => (
              <tr key={b.method}><td>{b.method}</td><td className="r strong"><span className="money" style={{ color: b.balance < 0 ? 'var(--danger)' : undefined }}>{money(b.balance)}</span></td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total cash &amp; bank</td><td className="r">{money(r2(bs.balances.reduce((s, b) => s + b.balance, 0)))}</td></tr></tfoot>
        </table>
      </Card>
      <div style={{ marginTop: 16, padding: '13px 15px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Scale size={20} color="var(--accent)" />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700 }}>Net worth of the business</div>
          <div className="small muted">What you own minus what you owe, from live data.</div>
        </div>
        <span className="money" style={{ fontSize: 24, color: bs.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(bs.net)}</span>
      </div>
    </>
  );
}
