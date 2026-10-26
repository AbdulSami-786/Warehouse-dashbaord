import { Fragment, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, ClipboardList, Lock, Receipt, ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';
import {
  money, r2, fmtDate, qty, BUCKET_META,
} from '../lib/format.js';
import {
  billStates, partyLedger, whPartyKhata, whPartyTotals,
} from '../lib/calc.js';
import {
  Button, Empty, Field, Input, Money, Pill,
} from '../components/ui.jsx';
import { BillPreview } from '../components/forms.jsx';
import { LOGO } from '../components/Layout.jsx';

const ACUNNITY_LOGO = `${import.meta.env.BASE_URL}mylogo.jpeg`;
const ACUNNITY_PHONE = '03032385244';

/** Top bar of the shared ledger: Acunnity's logo, slogan and contact number. */
function AcunnityNav() {
  return (
    <div style={{ background: '#fff', borderBottom: '1px solid var(--border, #e5e7eb)', padding: '8px 16px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <img src={ACUNNITY_LOGO} alt="Acunnity" style={{ height: 40, width: 'auto', borderRadius: 6 }} />
        <div style={{ flex: 1, minWidth: 180, fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
          Make your dashboard from Acunnity
        </div>
        <a href={`tel:${ACUNNITY_PHONE}`} style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}>
          {ACUNNITY_PHONE}
        </a>
      </div>
    </div>
  );
}

/**
 * Every entry on the account in date order — bills, payments, cheques, returns
 * and journal money — with a running balance. Worked out by the same
 * partyLedger() as the shop's own Account Statement.
 */
function FullStatement({ data, onBill }) {
  const [openGroups, setOpenGroups] = useState({});
  const ledger = useMemo(() => partyLedger('shared', {
    ...data,
    bills: (data.bills || []).map((b) => ({ ...b, partyId: 'shared' })),
    payments: (data.payments || []).map((p) => ({ ...p, partyId: 'shared' })),
    partyAdvances: (data.partyAdvances || []).map((a) => ({ ...a, partyId: 'shared' })),
    journal: (data.journal || []).map((e) => ({ ...e, kind: 'party', partyId: 'shared' })),
    journalPayments: data.journalPayments || [],
    items: [...new Map((data.billItems || []).map((l) => [l.itemId, { id: l.itemId, name: l.itemName }])).values()],
  }), [data]);
  const rows = useMemo(
    () => ledger.flatMap((r) => (r.parts && openGroups[r.id] ? [r, ...r.parts.map((p) => ({ ...p, isPart: true }))] : [r])),
    [ledger, openGroups],
  );
  const closing = ledger.length ? ledger[ledger.length - 1].balance : 0;
  const toggle = (r) => setOpenGroups((g) => ({ ...g, [r.id]: !g[r.id] }));
  const open = (r) => {
    if (r.parts) toggle(r);
    else if (r.billId && !r.isPart) onBill(r.billId);
  };
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head"><h2 className="h2">Account Statement</h2></div>
      {ledger.length ? (
        <>
          <div className="table-wrap hide-mobile">
            <table className="tbl stmt-tbl">
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Date</th><th>Particulars</th><th style={{ width: 108 }}>Method</th>
                  <th className="r" style={{ width: 110 }}>Debit (+)</th><th className="r" style={{ width: 110 }}>Credit (−)</th>
                  <th className="r" style={{ width: 120 }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.isPart ? `part-${r.id}` : r.id}
                    style={r.isPart ? { background: 'var(--neutral-bg)' } : undefined}
                    className={`${(r.billId && !r.voided && !r.isPart) || r.parts ? 'clickable' : ''} stmt-${r.type}`}
                    onClick={() => open(r)}
                  >
                    <td className="nowrap small">{r.isPart ? '' : fmtDate(r.date)}</td>
                    <td style={r.isPart ? { paddingLeft: 28 } : undefined}>
                      <div style={{ fontWeight: r.isPart ? 500 : 600, textDecoration: r.voided ? 'line-through' : 'none' }}>
                        {r.parts && (openGroups[r.id] ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />)}
                        {r.parts && ' '}
                        {r.isPart ? `↳ Bill ${r.billNo || ''}` : r.title}
                      </div>
                      {r.detail && <div className="small muted">{r.detail}</div>}
                    </td>
                    <td className="small">{r.method ? <Pill status="neutral" label={r.method} /> : <span className="muted">—</span>}</td>
                    <td className="r strong">{r.debit > 0 ? <Money value={r.debit} /> : <span className="muted">—</span>}</td>
                    <td className="r strong">
                      {r.credit > 0 ? <span className="money pos">{money(r.credit)}</span>
                        : r.pending > 0 ? <span className="money" style={{ color: '#B45309' }}>({money(r.pending)})</span>
                          : r.struck ? <span className="muted small" style={{ textDecoration: 'line-through' }}>{money(r.originalAmount)}</span>
                            : <span className="muted">—</span>}
                    </td>
                    <td className="r strong">{!r.isPart && <span className="money" style={{ color: r.balance > 0 ? 'var(--danger)' : 'var(--success)' }}>{money(r.balance)}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Closing balance{closing < -0.004 && ' (in your favour)'}</td>
                  <td className="r">{money(r2(ledger.reduce((s, r) => s + r.debit, 0)))}</td>
                  <td className="r">{money(r2(ledger.reduce((s, r) => s + r.credit, 0)))}</td>
                  <td className="r" style={{ fontSize: 14 }}>{money(closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="mcards" style={{ padding: 12 }}>
            {rows.map((r) => (
              <div
                key={r.isPart ? `part-${r.id}` : r.id}
                className="mcard"
                style={r.isPart ? { marginLeft: 18, background: 'var(--neutral-bg)' } : undefined}
                onClick={() => open(r)}
              >
                <div className="top">
                  <span className="name" style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>{r.isPart ? `↳ Bill ${r.billNo || ''}` : r.title}</span>
                  <span className="amt" style={{ color: r.debit > 0 ? 'var(--danger)' : r.pending > 0 ? '#B45309' : 'var(--success)' }}>
                    {r.debit > 0 ? `+${money(r.debit)}` : r.credit > 0 ? `−${money(r.credit)}` : r.pending > 0 ? `(${money(r.pending)})` : '—'}
                  </span>
                </div>
                {r.detail && <div className="small muted">{r.detail}</div>}
                <div className="meta">
                  <span>{fmtDate(r.date)}</span>
                  {r.method && <Pill status="neutral" label={r.method} />}
                  <span className="spacer" />
                  {r.parts && <span className="small" style={{ fontWeight: 600 }}>{openGroups[r.id] ? 'Hide bills' : `${r.parts.length} bills`}</span>}
                  {!r.isPart && <span style={{ fontWeight: 700 }}>Bal {money(r.balance)}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : <Empty icon={Receipt} title="No entries yet" message="There is nothing on your account yet." />}
    </div>
  );
}

function Statement({ data }) {
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState('statement');
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
      <AcunnityNav />
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
        <div className="seg mb-2" style={{ marginBottom: 12 }}>
          <button className={view === 'statement' ? 'active' : ''} onClick={() => setView('statement')}>Full Statement</button>
          <button className={view === 'bills' ? 'active' : ''} onClick={() => setView('bills')}>Bills Only</button>
        </div>
        {view === 'statement' && <FullStatement data={data} onBill={setOpenId} />}
        {view === 'bills' && <div className="card" style={{ overflow: 'hidden' }}>
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
        </div>}
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

/**
 * A warehouse party's own khata, as the party sees it. Worked out by the same
 * whPartyKhata() as the dashboard, then worded from the party's side: what
 * they gave (goods supplied, money paid) and what they got.
 */
function WarehouseStatement({ data }) {
  const [openId, setOpenId] = useState(null);
  const rows = useMemo(() => whPartyKhata({
    openingBalance: data.openingBalance, moves: data.moves || [], lines: data.lines || [], payments: data.payments || [],
  }), [data]);
  const t = useMemo(() => whPartyTotals(rows), [rows]);
  // Our balance above zero means the party owes the shop.
  const owes = (b) => (b > 0.004 ? `You owe ${money(b)}` : b < -0.004 ? `We owe you ${money(-b)}` : 'Settled');
  const tone = (b) => (b > 0.004 ? 'var(--danger)' : b < -0.004 ? 'var(--success)' : 'var(--text)');
  const label = (r) => {
    if (r.kind === 'opening') return 'Opening balance';
    if (r.kind === 'in') return `Goods you supplied — ${r.docNo}`;
    if (r.kind === 'out') return `Goods we sent you — ${r.docNo}`;
    if (r.kind === 'paid') return 'Payment we made to you';
    return 'Payment you made';
  };
  const lineText = (l) => `${l.name} × ${qty(l.qty)} ${l.unit || ''}`.trim() + (l.rated ? ` @ ${money(l.rate)}` : '');
  const detail = (r) => {
    if (r.lines) return [r.lines.map(lineText).join(', '), r.reference && `Ref ${r.reference}`].filter(Boolean).join(' · ');
    return [r.method, r.note].filter(Boolean).join(' · ');
  };
  const gave = (r) => r.credit;
  const got = (r) => r.debit;
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <AcunnityNav />
      <div style={{ background: 'linear-gradient(160deg, #B91F19, #7A130F)', color: '#fff', padding: '22px 20px 26px', borderBottom: '4px solid var(--brand-yellow)' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <img src={LOGO} alt={data.shopName} style={{ height: 52, width: 'auto', background: '#fff', borderRadius: 10, padding: '4px 8px' }} />
          <div>
            <div className="small" style={{ color: '#FFD9D6', marginBottom: 3 }}>{data.shopName}</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{data.party?.name}</h1>
            <div className="small" style={{ color: '#FFD9D6', marginTop: 3 }}>Khata statement{data.party?.city ? ` · ${data.party.city}` : ''}</div>
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 860, margin: '-14px auto 0', padding: '0 16px 40px' }}>
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 16 }}>
            <div><div className="small muted">Goods you supplied</div><div className="money" style={{ fontSize: 18 }}>{money(t.receivedValue)}</div><div className="small muted">{qty(t.receivedQty)} units</div></div>
            <div><div className="small muted">Goods we sent you</div><div className="money" style={{ fontSize: 18 }}>{money(t.sentValue)}</div><div className="small muted">{qty(t.sentQty)} units</div></div>
            <div><div className="small muted">We paid you</div><div className="money" style={{ fontSize: 18 }}>{money(t.paid)}</div></div>
            <div><div className="small muted">You paid us</div><div className="money" style={{ fontSize: 18 }}>{money(t.received)}</div></div>
            <div><div className="small muted">Balance</div><div className="money" style={{ fontSize: 18, color: tone(t.balance) }}>{owes(t.balance)}</div></div>
          </div>
        </div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head"><h2 className="h2">Your Khata</h2></div>
          {rows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead><tr><th style={{ width: 96 }}>Date</th><th>Details</th><th className="r">You gave</th><th className="r">You got</th><th className="r">Balance</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <Fragment key={r.id}>
                        <tr className={r.lines ? 'clickable' : ''} onClick={() => r.lines && setOpenId(openId === r.id ? null : r.id)} style={r.voided ? { opacity: 0.55 } : undefined}>
                          <td className="nowrap small">{r.date ? fmtDate(r.date) : '—'}</td>
                          <td>
                            <div style={{ fontWeight: 600, textDecoration: r.voided ? 'line-through' : 'none' }}>
                              {r.lines && (openId === r.id ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />)}
                              {r.lines && ' '}{label(r)}{r.voided && ' (cancelled)'}
                            </div>
                            {detail(r) && <div className="small muted">{detail(r)}</div>}
                          </td>
                          <td className="r strong">{gave(r) > 0 ? money(gave(r)) : <span className="muted">—</span>}</td>
                          <td className="r strong">{got(r) > 0 ? money(got(r)) : <span className="muted">—</span>}</td>
                          <td className="r small" style={{ color: tone(r.balance), fontWeight: 600 }}>{owes(r.balance)}</td>
                        </tr>
                        {openId === r.id && r.lines && (
                          <tr className="items-detail-row">
                            <td colSpan={5} style={{ padding: 0 }}>
                              <div className="items-detail">
                                <table className="tbl items-detail-tbl">
                                  <thead><tr><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
                                  <tbody>
                                    {r.lines.map((l) => (
                                      <tr key={l.id}>
                                        <td style={{ fontWeight: 500 }}>{l.name}</td>
                                        <td className="r">{qty(l.qty)}</td>
                                        <td>{l.unit}{l.note && <span className="small muted"> ({l.note})</span>}</td>
                                        <td className="r">{l.rated ? money(l.rate) : <span className="muted">—</span>}</td>
                                        <td className="r strong">{l.rated ? money(l.value) : <span className="muted">—</span>}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}>Totals</td>
                      <td className="r">{money(r2(rows.reduce((s, r) => s + r.credit, 0)))}</td>
                      <td className="r">{money(r2(rows.reduce((s, r) => s + r.debit, 0)))}</td>
                      <td className="r" style={{ color: tone(t.balance) }}>{owes(t.balance)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((r) => (
                  <div key={r.id} className="mcard" onClick={() => r.lines && setOpenId(openId === r.id ? null : r.id)} style={r.voided ? { opacity: 0.55 } : undefined}>
                    <div className="top">
                      <span className="name" style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>{label(r)}</span>
                      <span className="amt">{gave(r) > 0 ? `+${money(gave(r))}` : got(r) > 0 ? `−${money(got(r))}` : '—'}</span>
                    </div>
                    {detail(r) && <div className="small muted">{detail(r)}</div>}
                    <div className="meta">
                      <span>{r.date ? fmtDate(r.date) : '—'}</span>
                      {r.voided && <span>Cancelled</span>}
                      <span className="spacer" />
                      <span style={{ fontWeight: 700, color: tone(r.balance) }}>{owes(r.balance)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : <Empty icon={ClipboardList} title="Nothing yet" message="There are no entries on your khata yet." />}
        </div>
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
  if (data) return data.kind === 'warehouse' ? <WarehouseStatement data={data} /> : <Statement data={data} />;
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
