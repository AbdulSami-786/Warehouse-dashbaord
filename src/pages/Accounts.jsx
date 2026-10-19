import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeft, ArrowUpRight, ChevronRight, Download, Landmark, Printer, TriangleAlert, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate } from '../lib/format.js';
import { methodBalances, methodLedger } from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, Empty, Money, PageHead, Pill, Stat,
} from '../components/ui.jsx';

export default function Accounts() {
  const { data, settings, methods, toast } = useApp();
  const navigate = useNavigate();
  const rows = useMemo(() => methodBalances(methods, data), [methods, data]);
  const totals = useMemo(() => ({
    balance: r2(rows.reduce((s, r) => s + r.balance, 0)),
    in: r2(rows.reduce((s, r) => s + r.in, 0)),
    out: r2(rows.reduce((s, r) => s + r.out, 0)),
  }), [rows]);
  const pending = useMemo(() => r2(data.cheques.filter((c) => c.status === 'pending').reduce((s, c) => s + (Number(c.amount) || 0), 0)), [data.cheques]);
  const toExcel = () => {
    exportCSV('Accounts', ['Method', 'Money In', 'Money Out', 'Current Balance'], rows.map((r) => [r.method, r.in.toFixed(2), r.out.toFixed(2), r.balance.toFixed(2)]),
      [`${settings.shopName} — Account Balances`, `Total: ${money(totals.balance)}`]);
    toast('Account balances exported');
  };
  const open = (m) => navigate(`/account/${encodeURIComponent(m)}`);
  return (
    <>
      <PageHead title="Accounts" subtitle="Running balance per payment method — click any row for its full statement">
        <Button icon={Download} onClick={toExcel}>Excel</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Total Cash in Hand" value={money(totals.balance)} icon={Wallet} tone="#16A34A" />
        <Stat label="Total Money In" value={money(totals.in)} icon={Landmark} tone="#1F2937" />
        <Stat label="Total Money Out" value={money(totals.out)} icon={Landmark} tone="#DC2626" />
      </div>
      {pending > 0 && (
        <div style={{ padding: '10px 13px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r)', marginBottom: 16, fontSize: 13, color: '#B45309', display: 'flex', gap: 8, alignItems: 'center' }}>
          <TriangleAlert size={15} style={{ flex: 'none' }} />
          <span>A further <strong>{money(pending)}</strong> is held in cheques awaiting clearance. It is deliberately excluded from these balances until cleared.</span>
        </div>
      )}
      <Card tight>
        <div className="table-wrap hide-mobile">
          <table className="tbl">
            <thead><tr><th>Payment method</th><th className="r">Money in</th><th className="r">Money out</th><th className="r">Current balance</th><th style={{ width: 50 }} /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.method} className="clickable" onClick={() => open(r.method)}>
                  <td style={{ fontWeight: 600 }}>{r.method}</td>
                  <td className="r"><span className="money pos">{money(r.in)}</span></td>
                  <td className="r"><span className="money neg">{money(r.out)}</span></td>
                  <td className="r strong"><span className="money" style={{ fontSize: 15, color: r.balance < 0 ? 'var(--danger)' : undefined }}>{money(r.balance)}</span></td>
                  <td><ChevronRight size={15} className="muted" /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Total</td><td className="r">{money(totals.in)}</td><td className="r">{money(totals.out)}</td><td className="r" style={{ fontSize: 15 }}>{money(totals.balance)}</td><td /></tr>
            </tfoot>
          </table>
        </div>
        <div className="mcards" style={{ padding: 12 }}>
          {rows.map((r) => (
            <div key={r.method} className="mcard" onClick={() => open(r.method)}>
              <div className="top"><span className="name">{r.method}</span><span className="amt" style={{ color: r.balance < 0 ? 'var(--danger)' : 'var(--success)' }}>{money(r.balance)}</span></div>
              <div className="meta">
                <span style={{ color: 'var(--success)' }}>In {money(r.in)}</span>
                <span style={{ color: 'var(--danger)' }}>Out {money(r.out)}</span>
                <span className="spacer" />
                <ChevronRight size={15} className="muted" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

const TYPE_LABEL = {
  payment: 'Payment', expense: 'Expense', salary: 'Salary', supplier: 'Supplier', opening: 'Opening', warehouse: 'Warehouse',
  purchase: 'Purchase',
};

export function AccountStatement() {
  const { method } = useParams();
  const name = decodeURIComponent(method || '');
  const navigate = useNavigate();
  const { data, settings, methods, toast } = useApp();
  const ledger = useMemo(() => methodLedger(name, data), [name, data]);
  const sum = useMemo(() => methodBalances([name], data)[0] || { in: 0, out: 0, balance: 0 }, [name, data]);
  const newestFirst = useMemo(() => [...ledger].reverse(), [ledger]);
  if (!methods.includes(name)) {
    return <Empty icon={Landmark} title="Unknown payment method" message={`"${name}" is not a configured payment method.`} action={<Button onClick={() => navigate('/accounts')}>Back to Accounts</Button>} />;
  }
  const toExcel = () => {
    exportCSV(`Account_${name}`, ['Date', 'Description', 'In', 'Out', 'Running Balance'],
      ledger.map((r) => [fmtDate(r.date), r.desc, r.direction === 'in' ? r.amount.toFixed(2) : '', r.direction === 'out' ? r.amount.toFixed(2) : '', r.runningBalance.toFixed(2)]),
      [`${settings.shopName} — ${name} Statement`, `Closing balance: ${money(sum.balance)}`]);
    toast('Statement exported');
  };
  const toPDF = () => printReport({
    title: `${name} Statement`, subtitle: `${ledger.length} transactions`, shopName: settings.shopName,
    headers: ['Date', 'Description', { label: 'In', align: 'r' }, { label: 'Out', align: 'r' }, { label: 'Balance', align: 'r' }],
    rows: ledger.map((r) => [fmtDate(r.date), r.desc, r.direction === 'in' ? money(r.amount) : '—', r.direction === 'out' ? money(r.amount) : '—', money(r.runningBalance)]),
    totals: ['', 'Closing balance', money(sum.in), money(sum.out), money(sum.balance)],
  });
  return (
    <>
      <PageHead title={name} subtitle="Every transaction through this method, with a running balance">
        <Button icon={ArrowLeft} onClick={() => navigate('/accounts')}>Back</Button>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Money In" value={money(sum.in)} icon={ArrowDownLeft} tone="#16A34A" />
        <Stat label="Money Out" value={money(sum.out)} icon={ArrowUpRight} tone="#DC2626" />
        <Stat label="Current Balance" value={money(sum.balance)} icon={Landmark} tone="#1F2937" />
      </div>
      <Card tight>
        {newestFirst.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Description</th><th>Type</th><th className="r">In</th><th className="r">Out</th><th className="r">Balance</th></tr></thead>
                <tbody>
                  {newestFirst.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      <td>{r.desc}</td>
                      <td><Pill status={r.direction === 'in' ? 'paid' : 'due'} label={TYPE_LABEL[r.relatedType] || 'Transfer'} /></td>
                      <td className="r">{r.direction === 'in' ? <span className="money pos">{money(r.amount)}</span> : <span className="muted">—</span>}</td>
                      <td className="r">{r.direction === 'out' ? <span className="money neg">{money(r.amount)}</span> : <span className="muted">—</span>}</td>
                      <td className="r strong"><Money value={r.runningBalance} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3}>{newestFirst.length} transactions</td><td className="r">{money(sum.in)}</td><td className="r">{money(sum.out)}</td><td className="r" style={{ fontSize: 15 }}>{money(sum.balance)}</td></tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {newestFirst.map((r) => (
                <div key={r.id} className="mcard">
                  <div className="top">
                    <span className="name">{r.desc}</span>
                    <span className="amt" style={{ color: r.direction === 'in' ? 'var(--success)' : 'var(--danger)' }}>{r.direction === 'in' ? '+' : '−'}{money(r.amount)}</span>
                  </div>
                  <div className="meta"><span>{fmtDate(r.date)}</span><span className="spacer" /><span>Balance {money(r.runningBalance)}</span></div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon={Landmark} title="No transactions yet" message={`Nothing has moved through ${name}.`} />}
      </Card>
    </>
  );
}
