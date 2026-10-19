import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Receipt, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, BUCKET_META } from '../lib/format.js';
import { billStates } from '../lib/calc.js';
import {
  Button, Empty, Field, Input, Money, Pill,
} from '../components/ui.jsx';
import { BillPreview } from '../components/forms.jsx';
import { LOGO } from '../components/Layout.jsx';

function Statement({ data }) {
  const [openId, setOpenId] = useState(null);
  const bills = useMemo(() => {
    const states = billStates(data.bills, data);
    const rank = (b) => (b.status === 'voided' ? 2 : b.due > 0 ? 0 : 1);
    return states.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.overdueDays - a.overdueDays : 0) || new Date(b.date) - new Date(a.date));
  }, [data]);
  const totals = useMemo(() => {
    const live = bills.filter((b) => b.status !== 'voided');
    return {
      billed: r2(live.reduce((s, b) => s + b.net, 0)),
      paid: r2(live.reduce((s, b) => s + b.paid + (b.overpaid || 0) - (b.carriedIn || 0), 0)),
      due: r2(live.reduce((s, b) => s + b.due, 0)),
      advance: r2((data.partyAdvances || []).reduce((s, a) => s + (Number(a.amount) || 0) - (Number(a.applied) || 0), 0)),
    };
  }, [bills, data.partyAdvances]);
  const itemName = (iid) => (data.billItems || []).filter((l) => l.billId === openId).find((l) => l.itemId === iid)?.itemName || 'Item';
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ background: 'linear-gradient(160deg, #B91F19, #7A130F)', color: '#fff', padding: '22px 20px 26px', borderBottom: '4px solid var(--brand-yellow)' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <img src={LOGO} alt={data.shopName} style={{ height: 52, width: 'auto', background: '#fff', borderRadius: 10, padding: '4px 8px' }} />
          <div>
            <div className="small" style={{ color: '#FFD9D6', marginBottom: 3 }}>{data.shopName}</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{data.party?.name}</h1>
            <div className="small" style={{ color: '#FFD9D6', marginTop: 3 }}>Account statement</div>
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 860, margin: '-14px auto 0', padding: '0 16px 40px' }}>
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 16 }}>
            <div><div className="small muted">Total billed</div><div className="money" style={{ fontSize: 18 }}>{money(totals.billed)}</div></div>
            <div><div className="small muted">Total paid</div><div className="money" style={{ fontSize: 18, color: 'var(--success)' }}>{money(totals.paid)}</div></div>
            <div><div className="small muted">Balance due</div><div className="money" style={{ fontSize: 18, color: totals.due > 0 ? 'var(--danger)' : 'var(--success)' }}>{money(totals.due)}</div></div>
            {totals.advance > 0 && <div><div className="small muted">Advance with shop</div><div className="money" style={{ fontSize: 18, color: 'var(--success)' }}>{money(totals.advance)}</div></div>}
          </div>
        </div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head"><h2 className="h2">Your Bills</h2></div>
          {bills.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead><tr><th>Bill</th><th>Date</th><th>Status</th><th>Due date</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th><th style={{ width: 78 }} /></tr></thead>
                  <tbody>
                    {bills.map((b) => (
                      <tr key={b.id} className={b.due > 0 && b.isOverdue ? BUCKET_META[b.bucket].cls : ''}>
                        <td style={{ fontWeight: 600 }}>{b.billNo}</td>
                        <td className="nowrap">{fmtDate(b.date)}</td>
                        <td><Pill status={b.status} /></td>
                        <td className="nowrap small">{b.due > 0 ? fmtDate(b.dueDate) : <span className="muted">—</span>}</td>
                        <td className="r strong"><Money value={b.net} /></td>
                        <td className="r"><Money value={b.paid} /></td>
                        <td className="r strong">{b.due > 0 ? <span className="money neg">{money(b.due)}</span> : <span className="muted">—</span>}</td>
                        <td><Button size="sm" icon={Receipt} onClick={() => setOpenId(b.id)}>Bill</Button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={4}>Totals</td><td className="r">{money(totals.billed)}</td><td className="r">{money(totals.paid)}</td><td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td></tr>
                  </tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {bills.map((b) => (
                  <div key={b.id} className={`mcard ${b.due > 0 && b.isOverdue ? BUCKET_META[b.bucket].mcls : ''}`}>
                    <div className="top"><span className="name">{b.billNo}</span><span className="amt">{money(b.net)}</span></div>
                    <div className="meta"><Pill status={b.status} /><span>{fmtDate(b.date)}</span>{b.due > 0 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{money(b.due)} due</span>}</div>
                    <Button size="sm" icon={Receipt} onClick={() => setOpenId(b.id)}>View bill</Button>
                  </div>
                ))}
              </div>
            </>
          ) : <Empty icon={Receipt} title="No bills yet" message="There are no bills on your account." />}
        </div>
        <BillPreview
          open={!!openId}
          onClose={() => setOpenId(null)}
          bill={openId ? bills.find((b) => b.id === openId) : null}
          lines={(data.billItems || []).filter((l) => l.billId === openId)}
          payments={(data.payments || []).filter((p) => p.billId === openId)}
          cheques={data.cheques || []}
          returns={(data.returns || []).filter((r) => r.billId === openId)}
          itemName={itemName}
          party={data.party}
          shopName={data.shopName}
          readOnly
        />
        <div style={{ marginTop: 18, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <ShieldCheck size={14} />Read-only view · {data.shopName}
        </div>
      </div>
    </div>
  );
}

/** The page a customer opens from a shared ledger link. */
export default function SharedLedger() {
  const { token } = useParams();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      setData(await api.openSharedLedger(token, pw));
    } catch (ex) {
      setErr(ex.message || 'Could not open this ledger');
    } finally {
      setBusy(false);
    }
  };
  if (data) return <Statement data={data} />;
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ width: 50, height: 50, borderRadius: 13, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}><Lock size={22} /></div>
          <h1 className="h1">Your Ledger</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>Enter the password you were given to view your account.</p>
        </div>
        <Field label="Password" error={err}><Input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} placeholder="Enter password" /></Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!pw}>View Ledger</Button>
        <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center' }}>This is a read-only view of your own account only.</div>
      </form>
    </div>
  );
}
