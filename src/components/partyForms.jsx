import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Copy, Info, Lock, LockOpen, Minus, Package, Save, Search, Share2, Trash2,
  TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { CONFIG } from '../lib/config.js';
import { money, r2, today, fmtDate, shareUrl } from '../lib/format.js';
import { partyItemHistory, payableNow } from '../lib/calc.js';
import { isLocked, markUnlocked, relock, tryUnlock } from '../lib/partyLock.js';
import {
  Button, Card, Empty, Field, Input, Modal, Pill, Select,
} from './ui.jsx';
import { ChequeFields, blankCheque } from './forms.jsx';

export function UnlockLedger({ party, onUnlocked, onBack }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (busy || !pw) return;
    setBusy(true);
    setErr('');
    try {
      if (await tryUnlock(party, pw)) onUnlocked();
      else {
        setErr('Wrong password');
        setPw('');
      }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ maxWidth: 420, margin: '48px auto' }}>
      <Card>
        <form onSubmit={submit} style={{ textAlign: 'center' }}>
          <span className="ico" style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', border: '1px solid var(--border)', marginBottom: 12 }}>
            <Lock size={22} />
          </span>
          <h2 className="h2" style={{ marginBottom: 4 }}>{party.name}</h2>
          <p className="small muted" style={{ marginBottom: 16 }}>This ledger is locked. Enter its password to open it.</p>
          <Field error={err}>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Party password" autoFocus autoComplete="off" />
          </Field>
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <Button type="button" icon={ArrowLeft} onClick={onBack}>Back</Button>
            <Button type="submit" variant="primary" icon={LockOpen} loading={busy} disabled={!pw}>Open Ledger</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** `warehouse` for a warehouse party's khata, which keeps its password the same way. */
export function PartyLockModal({ open, onClose, party, warehouse = false }) {
  const { mutate } = useApp();
  const locked = isLocked(party);
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF({ current: '', next: '', confirm: '' });
      setErr('');
    }
  }, [open]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const apply = async (next) => {
    if (busy) return;
    if (next && next.length < 4) return setErr('Use at least 4 characters');
    if (next && next !== f.confirm) return setErr('The two passwords do not match');
    if (locked && !f.current) return setErr('Enter the current password first');
    setErr('');
    setBusy(true);
    // Whoever just set the password should not be locked out of the page they are on.
    if (next) markUnlocked(party.id);
    try {
      await mutate(() => (warehouse ? api.setWhPartyLock : api.setPartyLock)(party.id, next, f.current),
        next ? (locked ? 'Party password changed' : 'Ledger locked with a password') : 'Password removed');
      if (!next) relock(party.id);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={locked ? `Password — ${party.name}` : `Lock ${party.name}'s ledger`}
      onClose={onClose}
      footer={(
        <>
          {locked && <Button variant="danger" icon={Trash2} onClick={() => apply('')} loading={busy}>Remove password</Button>}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} onClick={() => apply(f.next)} loading={busy} disabled={!f.next}>{locked ? 'Change password' : 'Lock ledger'}</Button>
        </>
      )}
    >
      <p className="small muted" style={{ marginBottom: 12 }}>
        {locked
          ? 'This ledger asks for a password before it opens. Change it or remove it below.'
          : 'Once locked, this party’s ledger asks for this password every time it is opened. Other parties are not affected.'}
      </p>
      <div className="form-grid">
        {locked && (
          <Field label="Current password" className="full" hint="This party’s password — or your login password if you have forgotten it">
            <Input type="password" value={f.current} onChange={set('current')} autoFocus autoComplete="off" />
          </Field>
        )}
        <Field label={locked ? 'New password' : 'Password'}>
          <Input type="password" value={f.next} onChange={set('next')} autoFocus={!locked} autoComplete="new-password" />
        </Field>
        <Field label="Type it again">
          <Input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </Field>
      </div>
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

/**
 * Preview how an amount spreads over a party's bills, oldest first. Each bill
 * takes only what is payable now — a cheque still waiting to clear already
 * covers its share, and the server skips that part the same way.
 */
function allocate(amount, bills) {
  let left = r2(Math.max(0, Number(amount) || 0));
  const rows = [];
  for (const b of bills) {
    if (left <= 0.004) break;
    const room = payableNow(b);
    if (room <= 0.004) continue;
    const use = r2(Math.min(room, left));
    rows.push({ bill: b, amount: use, clears: use >= r2(room) - 0.004 });
    left = r2(left - use);
  }
  return { rows, advance: r2(left) };
}

/** Money received against a party's whole account. */
export function SettlePartyModal({ open, onClose, party, bills = [] }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [cheque, setCheque] = useState(null);
  const [busy, setBusy] = useState(false);
  const open_ = useMemo(() => bills.filter((b) => b.status !== 'voided' && payableNow(b) > 0.004)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.billNo).localeCompare(String(b.billNo))), [bills]);
  const owed = useMemo(() => r2(open_.reduce((s, b) => s + payableNow(b), 0)), [open_]);
  const plan = useMemo(() => allocate(amount, open_), [amount, open_]);
  const amt = r2(Number(amount) || 0);
  const reset = () => {
    setAmount('');
    setMethod('Cash');
    setDate(today());
    setNote('');
    setCheque(null);
  };
  const save = async () => {
    if (busy || amt <= 0) return;
    setBusy(true);
    try {
      const res = await mutate(() => api.settleParty({ partyId: party.id, amount: amt, method, date, note, cheque: method === 'Cheque' ? cheque : undefined }), null);
      const n = res?.applied?.length ?? 0;
      const adv = res?.advance ?? 0;
      onClose(`${money(amt)} received — ${n} bill${n === 1 ? '' : 's'} settled` + (adv > 0 ? `, ${money(adv)} kept as advance` : ''));
      reset();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => onClose()}
      title={`Payment from ${party?.name || 'party'}`}
      footer={<><Button onClick={() => onClose()}>Cancel</Button><Button variant="primary" icon={Wallet} onClick={save} disabled={busy || amt <= 0}>{busy ? 'Saving…' : `Receive ${amt > 0 ? money(amt) : ''}`}</Button></>}
    >
      <div className="row wrap" style={{ gap: 12 }}>
        <Field label="Amount received" style={{ flex: '1 1 160px' }}>
          <Input type="number" min="0" step="0.01" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Method" style={{ flex: '1 1 140px' }}>
          <Select value={method} onChange={(e) => { setMethod(e.target.value); setCheque(e.target.value === 'Cheque' ? cheque || blankCheque(date) : null); }} options={methods} />
        </Field>
        <Field label="Date" style={{ flex: '1 1 140px' }}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {method === 'Cheque' && <div style={{ marginBottom: 12 }}><ChequeFields value={cheque} onChange={setCheque} /></div>}
      <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. cash received at shop" /></Field>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <span className="muted small">Total outstanding</span><span className="spacer" />
        <span className="money" style={{ fontWeight: 700 }}>{money(owed)}</span>
      </div>
      {owed > 0 && <Button size="sm" onClick={() => setAmount(String(owed))}>Pay all ({money(owed)})</Button>}
      {amt > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 16, marginBottom: 7 }}>How this will be applied</h3>
          {open_.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Bill</th><th>Date</th><th className="r">Due</th><th className="r">Applied</th><th className="r">Left</th></tr></thead>
                <tbody>
                  {plan.rows.map(({ bill, amount: a, clears }) => (
                    <tr key={bill.id}>
                      <td style={{ fontWeight: 600 }}>{bill.billNo}</td>
                      <td className="nowrap small">{fmtDate(bill.date)}</td>
                      <td className="r">{money(payableNow(bill))}</td>
                      <td className="r strong" style={{ color: 'var(--success)' }}>{money(a)}</td>
                      <td className="r" style={{ color: clears ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{clears ? 'PAID' : money(r2(payableNow(bill) - a))}</td>
                    </tr>
                  ))}
                  {open_.filter((b) => !plan.rows.some((x) => x.bill.id === b.id)).map((b) => (
                    <tr key={b.id} className="muted">
                      <td>{b.billNo}</td><td className="nowrap small">{fmtDate(b.date)}</td>
                      <td className="r">{money(payableNow(b))}</td><td className="r">—</td><td className="r">{money(payableNow(b))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="note"><Info size={14} /><span>This party has no unpaid bills, so the whole {money(amt)} will be held as an advance against their next bill.</span></div>
          )}
          {plan.advance > 0 && open_.length > 0 && (
            <div className="note" style={{ marginTop: 10 }}>
              <Wallet size={14} />
              <span><strong>{money(plan.advance)}</strong> is more than this party owes. It will be kept as an advance, and offered on their next bill.</span>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function EditPaymentModal({ open, onClose, payment, cheque }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (payment) {
      setAmount(String(payment.amount ?? ''));
      setMethod(payment.method || 'Cash');
      setDate((payment.date || '').slice(0, 10));
      setNote(payment.note || '');
    }
  }, [payment]);
  if (!payment) return null;
  const amt = r2(Number(amount) || 0);
  const changed = amt !== r2(payment.amount) || method !== payment.method || date !== (payment.date || '').slice(0, 10) || note !== (payment.note || '');
  const save = async () => {
    if (busy || amt <= 0) return;
    setBusy(true);
    try {
      await mutate(() => api.updatePayment({ id: payment.id, amount: amt, method, date, note }), 'Payment updated');
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit payment"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} disabled={busy || amt <= 0 || !changed}>{busy ? 'Saving…' : 'Save changes'}</Button></>}
    >
      <div className="row wrap" style={{ gap: 12 }}>
        <Field label="Amount" style={{ flex: '1 1 150px' }}><Input type="number" min="0" step="0.01" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Method" style={{ flex: '1 1 140px' }} hint={cheque ? 'A cheque payment keeps its method' : undefined}>
          {/* A cheque stays a cheque, and nothing else can become one here:
              the cheque row is what holds the money back until it clears. */}
          <Select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!!cheque} options={cheque ? [method] : [...new Set([payment.method, ...methods.filter((m) => m !== 'Cheque')])].filter(Boolean)} />
        </Field>
        <Field label="Date" style={{ flex: '1 1 140px' }}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></Field>
      {cheque && (
        <div className="note">
          <span>
            A cheque ({cheque.chequeNo || 'no number'}{cheque.bankName ? ` · ${cheque.bankName}` : ''}) is attached to this payment.
            {' '}Changing the amount updates the cheque to match, so the bill and the cheque register cannot disagree.
          </span>
        </div>
      )}
      <div className="small muted" style={{ marginTop: 10 }}>
        Recorded as {money(payment.amount)} on {(payment.date || '').slice(0, 10)}. To move this payment to a different bill, delete it and record it again.
      </div>
    </Modal>
  );
}

function matchesWords(name, q) {
  const s = String(name || '').toLowerCase();
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => s.includes(w));
}

/** What a party has paid for every item they have bought. */
export function PartyPricesModal({ open, onClose, party, data }) {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const all = useMemo(() => (party ? partyItemHistory(party.id, data) : []), [party, data]);
  const shown = useMemo(() => (q.trim() ? all.filter((x) => matchesWords(x.name, q)) : all), [all, q]);
  const close = () => {
    setQ('');
    setOpenId(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} wide title={`Item prices — ${party?.name || ''}`} footer={<Button onClick={close}>Close</Button>}>
      <div className="field" style={{ marginBottom: 12 }}>
        <div className="input-group">
          <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an item this party has bought…" aria-label="Search items" />
          {q && <Button onClick={() => setQ('')}>Clear</Button>}
        </div>
        <div className="hint">{all.length ? `${party?.name} has bought ${all.length} different item${all.length === 1 ? '' : 's'}.` : 'No past sales to this party yet.'}</div>
      </div>
      {shown.length ? (
        <div className="price-hits">
          {shown.map((x) => {
            const expanded = openId === x.itemId;
            const diff = x.last && x.previous ? r2(x.last.price - x.previous.price) : 0;
            const Trend = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus;
            return (
              <div key={x.itemId} className="price-hit">
                <button type="button" className="price-hit-head" onClick={() => setOpenId(expanded ? null : x.itemId)} aria-expanded={expanded}>
                  <div className="price-hit-name">
                    <strong>{x.name}</strong>
                    {x.status === 'archived' && <Pill status="voided" label="Archived" />}
                    <span className="muted small">{x.times} sale{x.times === 1 ? '' : 's'}</span>
                  </div>
                  <div className="price-hit-last">
                    {x.last ? (
                      <><span className="money">{money(x.last.price)}</span><span className="muted small"> / {x.last.unit || x.unit} · {fmtDate(x.last.date)}</span></>
                    ) : <span className="muted small">only voided bills</span>}
                  </div>
                </button>
                <div className="price-hit-meta">
                  {x.previous && (
                    <span className={diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}>
                      <Trend size={12} />
                      {diff === 0 ? 'same as before' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))} vs previous (${money(x.previous.price)})`}
                    </span>
                  )}
                  {x.minPrice !== x.maxPrice && <span className="muted">range {money(x.minPrice)}–{money(x.maxPrice)}</span>}
                  <span className="muted">{x.totalQty} {x.unit} total · {money(x.totalValue)}</span>
                </div>
                {expanded && (
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="tbl">
                      <thead><tr><th>Bill</th><th>Date</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
                      <tbody>
                        {x.rows.map((r, i) => (
                          <tr key={`${r.billId}-${i}`} style={r.voided ? { opacity: 0.55 } : undefined}>
                            <td style={{ fontWeight: 600 }}>{r.billNo}{r.voided && <> <Pill status="voided" label="Voided" /></>}</td>
                            <td className="nowrap small">{fmtDate(r.date)}</td>
                            <td className="r">{r.qty} {r.unit}</td>
                            <td className="r strong" style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>{money(r.price)}</td>
                            <td className="r">{money(r.lineTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={q ? Search : Package}
          title={q ? 'No match' : 'Nothing bought yet'}
          message={q ? `${party?.name} has never been billed for anything matching “${q}”.` : `Once ${party?.name} has been billed for an item, its price history appears here.`}
        />
      )}
    </Modal>
  );
}

export function AdvanceModal({ open, onClose, party }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy || !(Number(amount) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.addAdvance({ partyId: party.id, amount: Number(amount), method, dateReceived: date, note }), 'Advance recorded');
      setAmount('');
      setNote('');
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={`Add Advance — ${party.name}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!(Number(amount) > 0)}>Record Advance</Button></>}
    >
      <p className="small muted" style={{ marginTop: 0 }}>Money received with no bill attached yet. It becomes available to apply against this party's next bill.</p>
      <Field label="Amount received"><Input type="number" min="0" step="any" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} placeholder="0" /></Field>
      <div className="form-grid">
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={methods.filter((m) => m !== 'Cheque')} /></Field>
        <Field label="Date received"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>
    </Modal>
  );
}

export function SetOffModal({ open, onClose, party, receivable, payable }) {
  const { mutate } = useApp();
  const max = r2(Math.max(0, Math.min(receivable, payable)));
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setAmount(max > 0 ? String(max) : '');
      setDate(today());
      setNote('');
    }
  }, [open, max]);
  const amt = Number(amount) || 0;
  const ok = amt > 0 && amt <= max + 0.004;
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.setOffParty({ partyId: party.id, amount: amt, date, note }), `Set off ${money(amt)}`);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={`Set Off — ${party.name}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!ok}>Set off {amt > 0 ? money(amt) : ''}</Button></>}
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        They owe you {money(receivable)} on sales and you owe them {money(payable)} on purchases. A set-off cancels the same amount from both sides: their oldest bills are marked paid and your purchase dues go down. No cash moves.
      </p>
      <Field label="Amount to set off" hint={`Up to ${money(max)}`}><Input type="number" min="0" step="any" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} placeholder="0" /></Field>
      <div className="form-grid">
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>
      </div>
    </Modal>
  );
}

/** `warehouse` shares a warehouse party's khata instead of a shop customer's bills. */
export function ShareLedgerModal({ open, onClose, party, existing, warehouse = false }) {
  const { mutate, toast } = useApp();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(existing?.token || '');
  useEffect(() => { setToken(existing?.token || ''); }, [existing]);
  const url = shareUrl(token);
  const create = async () => {
    if (busy) return;
    if (pw.length < 6) return toast('Use a password of at least 6 characters', 'error');
    setBusy(true);
    try {
      const res = await mutate(() => (warehouse ? api.createWhShareLink : api.createShareLink)(party.id, pw), 'Share link created');
      setToken(res.token);
      setPw('');
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      await mutate(() => (warehouse ? api.revokeWhShareLink : api.revokeShareLink)(party.id), 'Share link revoked');
      setToken('');
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Could not copy — select and copy manually', 'error');
    }
  };
  return (
    <Modal open={open} title="Share Ledger" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Creates a read-only, password-protected link showing only {party.name}'s {warehouse ? 'goods received and sent, payments and balance' : 'bills and balances'}. No edit, print, download or share controls appear on that page.
      </p>
      {CONFIG.backend !== 'sheets' && (
        <div className="note" style={{ marginBottom: 12 }}>
          <span>While data is kept in this browser only, the link opens only on this computer — the party cannot open it on their own phone.</span>
        </div>
      )}
      {token ? (
        <>
          <Field label="Shareable link">
            <div className="input-group">
              <Input value={url} readOnly onFocus={(e) => e.target.select()} />
              <Button icon={Copy} onClick={copy}>Copy</Button>
            </div>
          </Field>
          <div style={{ padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309' }}>
            Share the password separately from the link. Anyone with both can view this ledger.
          </div>
          <div className="row mt-2" style={{ justifyContent: 'flex-end' }}>
            <Button variant="danger" icon={Trash2} onClick={revoke} loading={busy}>Revoke link</Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Set a password" hint="The party enters this to open their ledger">
            <Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 6 characters" autoFocus />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={Share2} onClick={create} loading={busy}>Create link</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
