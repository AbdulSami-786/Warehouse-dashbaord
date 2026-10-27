import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeftRight, Ban, BookOpen, ChevronDown, ChevronRight, CircleCheck, Download, EllipsisVertical, HandCoins, KeyRound,
  Lock, Pencil, Phone, Plus, Printer, Receipt, RotateCcw, Search, Send, Share2, ShoppingCart, Trash2, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, BUCKET_META, whatsappUrl } from '../lib/format.js';
import {
  billStates, isOpeningBill, partyCredit, advanceAvailable, partyPendingCheques, reorderSuggestion, combinedPartyLedger,
  ledgerFilterMatch, LEDGER_FILTERS, supplierForParty, supplierBalance, SYSTEM_METHODS, journalOwed, partName,
} from '../lib/calc.js';
import { exportCSV, printReport, billPDF, raw, esc } from '../lib/exporters.js';
import { canOpen, isLocked, relock } from '../lib/partyLock.js';
import {
  ActionSheet, Button, Card, Confirm, Empty, Money, PageHead, Pill, Stat,
} from '../components/ui.jsx';
import { BillPreview, PaymentModal, ReturnModal } from '../components/forms.jsx';
import PartyJournal from '../components/PartyJournal.jsx';
import {
  AdvanceModal, EditPaymentModal, PartyLockModal, PartyPricesModal, SetOffModal, SettlePartyModal, ShareLedgerModal,
  UnlockLedger,
} from '../components/partyForms.jsx';
import { PurchaseBillModal, SupplierPaymentModal } from '../components/supplierForms.jsx';

/** Locked ledgers ask for their password; unlocking lasts ten minutes. */
export default function PartyLedgerGate() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data } = useApp();
  const party = data.parties.find((p) => p.id === id);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!party || !isLocked(party)) return undefined;
    const t = setInterval(() => { if (!canOpen(party)) tick((n) => n + 1); }, 15000);
    return () => clearInterval(t);
  }, [party]);
  if (party && !canOpen(party)) {
    return <UnlockLedger party={party} onUnlocked={() => tick((n) => n + 1)} onBack={() => navigate('/parties')} />;
  }
  return <PartyLedger onRelock={() => { relock(id); tick((n) => n + 1); }} />;
}

function PartyLedger({ onRelock }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, mutate, toast, access } = useApp();
  const buys = access.canAny(['purchases', 'suppliers']);
  const [lockOpen, setLockOpen] = useState(false);
  const [payBill, setPayBill] = useState(null);
  const [returnBill, setReturnBill] = useState(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [sheetBill, setSheetBill] = useState(null);
  const [voidBill, setVoidBill] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [view, setView] = useState('statement');
  const [filter, setFilter] = useState('all');
  const [previewId, setPreviewId] = useState(null);
  const [editPay, setEditPay] = useState(null);
  const [delPay, setDelPay] = useState(null);
  const [delCheque, setDelCheque] = useState(null);
  const [delAdvance, setDelAdvance] = useState(null);
  const [delOrphan, setDelOrphan] = useState(null);
  const [journalAct, setJournalAct] = useState(null); // an edit/delete asked for on a journal row
  const [delJpay, setDelJpay] = useState(null); // a journal collection row
  const [delGroup, setDelGroup] = useState(null); // a combined payment row
  const [pricesOpen, setPricesOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [payThemOpen, setPayThemOpen] = useState(false);
  const [setOffOpen, setSetOffOpen] = useState(false);
  const [delSupPay, setDelSupPay] = useState(null);
  const [linking, setLinking] = useState(false);
  const [openGroups, setOpenGroups] = useState({});

  const party = data.parties.find((p) => p.id === id);
  const supplier = supplierForParty(id, data.suppliers);
  const journalCount = (data.journal || []).filter((e) => e.kind === 'party' && e.partyId === id).length;
  const states = useMemo(() => billStates(data.bills, data), [data]);
  const bills = useMemo(() => {
    const mine = states.filter((b) => b.partyId === id);
    const rank = (b) => (b.status === 'voided' ? 3 : b.due > 0 ? 0 : 1);
    return mine.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.overdueDays - a.overdueDays : 0) || new Date(b.date) - new Date(a.date));
  }, [states, id]);
  const totals = useMemo(() => {
    const live = bills.filter((b) => b.status !== 'voided');
    const credit = partyCredit(id, live);
    return {
      billed: r2(live.reduce((s, b) => s + b.net, 0)),
      paid: r2(live.reduce((s, b) => s + b.paid, 0) + credit),
      credit,
      due: r2(live.reduce((s, b) => s + b.due, 0)),
      advance: advanceAvailable(id, data.partyAdvances),
      pendingCheques: partyPendingCheques(id, data),
    };
  }, [bills, id, data]);
  const owedToThem = supplier ? supplierBalance(supplier.id, data) : 0;
  // What the journal leaves open: above zero they owe us, below zero we owe them.
  const journalBal = journalOwed('party', id, data);
  const net = r2(totals.due + journalBal - owedToThem);
  // Bills still unpaid plus the journal's money to take, as on the Parties list.
  const journalDue = Math.max(0, journalBal);
  const outstanding = r2(totals.due + journalDue);
  const reorder = useMemo(() => reorderSuggestion(id, data.bills), [id, data.bills]);
  const ledger = useMemo(() => combinedPartyLedger(id, data), [id, data]);
  const shown = useMemo(() => ledger.filter((r) => ledgerFilterMatch(r, filter)), [ledger, filter]);
  const countOf = (f) => ledger.filter((r) => ledgerFilterMatch(r, f)).length;
  const rows = useMemo(() => shown.flatMap((r) => (r.parts && openGroups[r.id] ? [r, ...r.parts.map((p) => ({ ...p, isPart: true }))] : [r])), [shown, openGroups]);
  const link = data.partyLedgerLinks.find((l) => l.partyId === id);

  if (!party) {
    return <Empty title="Party not found" message="This party may have been removed." action={<Button onClick={() => navigate('/parties')}>Back to Parties</Button>} />;
  }

  const deleteEntry = (row) => {
    if (!row.isAdvance) return setDelPay(row.paymentId);
    const adv = data.partyAdvances.find((a) => a.id === row.advanceId);
    return adv ? setDelAdvance(adv) : setDelOrphan(row);
  };
  const itemName = (iid) => data.items.find((i) => i.id === iid)?.name || 'Item';
  const linesOf = (bid) => data.billItems.filter((l) => l.billId === bid);
  const netLabel = net > 0.004 ? `${party.name} owes you` : net < -0.004 ? `You owe ${party.name}` : 'Account is settled';
  const netMeta = supplier ? [`You owe them (purchases): ${money(owedToThem)}`, `Net: ${netLabel} ${money(Math.abs(net))}`] : [];
  const closing = ledger.length ? ledger[ledger.length - 1].balance : 0;

  const exportExcel = () => {
    exportCSV(`Ledger_${party.name}`, ['Bill No', 'Date', 'Status', 'Total', 'Paid', 'Due', 'Due Date'],
      bills.map((b) => [b.billNo, fmtDate(b.date), b.status, b.net.toFixed(2), b.paid.toFixed(2), b.due.toFixed(2), b.due > 0 ? fmtDate(b.dueDate) : '']),
      [`${settings.shopName} — Party Ledger`, party.name, party.phone || '', `Outstanding: ${money(outstanding)}`, ...(journalDue > 0.004 ? [`Includes journal: ${money(journalDue)}`] : []), ...netMeta]);
    toast('Ledger exported');
  };
  // The bills table: every bill with what was paid and what is due.
  const billsPDF = () => printReport({
    title: 'Party Ledger', subtitle: `${party.name}${party.phone ? ` · ${party.phone}` : ''}`, shopName: settings.shopName,
    headers: ['Bill No', 'Date', 'Status', { label: 'Total', align: 'r' }, { label: 'Paid', align: 'r' }, { label: 'Due', align: 'r' }, 'Due Date'],
    rows: bills.map((b) => [b.billNo, fmtDate(b.date), raw(`<span class="pill pill-${esc(b.status)}">${esc(b.status)}</span>`), money(b.net), money(b.paid), money(b.due), b.due > 0 ? fmtDate(b.dueDate) : '—']),
    totals: ['', '', 'Total', money(totals.billed), money(totals.paid), money(totals.due), ''],
    meta: [...(totals.advance > 0 ? [`Advance balance: ${money(totals.advance)}`] : []), ...netMeta],
  });
  // The statement as filtered: everything, or only bills, payments, journal…
  const printStatement = () => filter === 'sales' ? billsPDF() : printReport({
    title: filter === 'all' ? 'Account Statement' : `Account Statement — ${LEDGER_FILTERS.find((f) => f.value === filter)?.label}`,
    subtitle: `${party.name}${party.phone ? ` · ${party.phone}` : ''}`, shopName: settings.shopName,
    headers: ['Date', 'Particulars', 'Method', { label: 'Debit', align: 'r' }, { label: 'Credit', align: 'r' }, { label: 'Balance', align: 'r' }],
    rows: shown.map((r) => [
      fmtDate(r.date),
      r.detail ? raw(`${esc(r.title)}<br/><span style="color:#6B7280;font-size:10px">${esc(r.detail)}</span>`) : r.title,
      r.method || '—',
      r.debit > 0 ? money(r.debit) : '—',
      r.credit > 0 ? money(r.credit) : r.pending > 0 ? `(${money(r.pending)})` : '—',
      money(r.balance),
    ]),
    totals: ['', filter === 'all' ? 'Closing balance' : 'Total shown · closing balance', '', money(shown.reduce((s, r) => s + r.debit, 0)), money(shown.reduce((s, r) => s + r.credit, 0)), money(closing)],
  });
  const buyFrom = async () => {
    if (linking) return;
    if (supplier) return setBuyOpen(true);
    setLinking(true);
    try {
      const s = await mutate(() => api.linkPartySupplier(id), null);
      if (s?.id) setBuyOpen(true);
    } catch { /* toasted */ } finally {
      setLinking(false);
    }
  };
  const doVoid = async () => {
    const b = voidBill;
    setVoidBill(null);
    await mutate(() => api.voidBill(b.id, 'Voided from party ledger'), `Bill ${b.billNo} voided`);
  };
  const waText = `${settings.shopName}\n${party.name} — Ledger Summary\n\nTotal billed: ${money(totals.billed)}\nPaid: ${money(totals.paid)}\n*Outstanding: ${money(outstanding)}*`
    + (totals.advance > 0 ? `\nAdvance with us: ${money(totals.advance)}` : '')
    + (supplier && Math.abs(owedToThem) > 0.004
      ? `\nWe owe you for purchases: ${money(owedToThem)}\n*Net balance: ${money(Math.abs(net))} ${net >= 0 ? 'you owe us' : 'we owe you'}*` : '');
  const previewBill = previewId ? states.find((b) => b.id === previewId) : null;
  const rowActions = (r, mobile = false) => {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    return (
      <>
        {r.billId && <Button size="sm" icon={Receipt} onClick={stop(() => setPreviewId(r.billId))} title="Open bill receipt">{mobile ? 'View bill' : null}</Button>}
        {r.paymentId && !r.reversed && (
          <>
            {!r.isAdvance && !SYSTEM_METHODS.includes(r.method) && <Button size="sm" icon={Pencil} onClick={stop(() => setEditPay(r.paymentId))} title="Edit this payment">{mobile ? 'Edit' : null}</Button>}
            <Button size="sm" icon={Trash2} onClick={stop(() => deleteEntry(r))} title={r.isAdvance ? 'Delete this advance' : 'Delete this payment'}>{mobile ? 'Delete' : null}</Button>
          </>
        )}
        {r.type === 'journal' && r.journalId && (
          <>
            <Button size="sm" icon={Pencil} onClick={stop(() => { setView('journal'); setJournalAct({ id: r.journalId, mode: 'edit' }); })} title="Edit this journal entry">{mobile ? 'Edit' : null}</Button>
            <Button size="sm" icon={Trash2} onClick={stop(() => { setView('journal'); setJournalAct({ id: r.journalId, mode: 'delete' }); })} title="Delete this journal entry">{mobile ? 'Delete' : null}</Button>
          </>
        )}
        {r.journalPaymentId && !r.parts && <Button size="sm" icon={Trash2} onClick={stop(() => setDelJpay(r))} title="Remove this journal payment">{mobile ? 'Remove' : null}</Button>}
        {r.parts && String(r.id).startsWith('grp-') && <Button size="sm" icon={Trash2} onClick={stop(() => setDelGroup(r))} title="Delete this whole payment">{mobile ? 'Delete all' : null}</Button>}
        {r.chequeId && <Button size="sm" icon={Ban} onClick={stop(() => setDelCheque(r.chequeId))} title="Delete this cheque record">{mobile ? 'Delete cheque' : null}</Button>}
        {r.supplierPaymentId && <Button size="sm" icon={Trash2} onClick={stop(() => setDelSupPay(r.supplierPaymentId))} title="Delete this payment to them">{mobile ? 'Delete' : null}</Button>}
      </>
    );
  };

  return (
    <>
      <PageHead title={party.name} subtitle={[party.phone, party.address].filter(Boolean).join(' · ') || 'Party ledger'}>
        <Button icon={Download} onClick={exportExcel}>Excel</Button>
        <Button icon={Printer} onClick={printStatement}>PDF</Button>
        <Button icon={Search} onClick={() => setPricesOpen(true)}>Item Prices</Button>
        <Button icon={Share2} onClick={() => setShareOpen(true)}>Share</Button>
        {isLocked(party) && <Button icon={Lock} onClick={onRelock} title="Close and lock this ledger now">Lock now</Button>}
        <Button icon={isLocked(party) ? KeyRound : Lock} onClick={() => setLockOpen(true)}>{isLocked(party) ? 'Password' : 'Set Password'}</Button>
        <Button icon={Wallet} onClick={() => setAdvOpen(true)}>Add Advance</Button>
        {buys && <Button icon={ShoppingCart} onClick={buyFrom} loading={linking} title="Record goods you bought from this party">Buy from Party</Button>}
        {supplier && <Button icon={Send} onClick={() => setPayThemOpen(true)} title="Record money you paid this party for goods bought">Pay Party</Button>}
        {supplier && totals.due > 0.004 && owedToThem > 0.004 && <Button icon={ArrowLeftRight} onClick={() => setSetOffOpen(true)} title="Settle sales against purchases without cash">Set Off</Button>}
        <Button variant="primary" icon={HandCoins} onClick={() => setSettleOpen(true)}>Payment</Button>
        <Button variant="primary" icon={Plus} onClick={() => navigate(`/bill/new?party=${party.id}`)}>New Bill</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Billed" value={money(totals.billed)} icon={Receipt} tone="#1F2937" />
        <Stat label="Total Paid" value={money(totals.paid)} icon={CircleCheck} tone="#16A34A" />
        <Stat
          label="Outstanding"
          value={money(outstanding)}
          icon={Receipt}
          tone="#DC2626"
          note={[journalDue > 0.004 ? `Includes ${money(journalDue)} from the journal` : '', totals.pendingCheques > 0 ? `${money(totals.pendingCheques)} in uncleared cheques` : '', totals.credit > 0 ? `${money(totals.credit)} overpaid — party is in credit` : ''].filter(Boolean).join(' · ') || null}
          noteTone="#EA580C"
        />
        <Stat label="Advance Balance" value={money(totals.advance)} icon={Wallet} tone="#16A34A" />
        {Math.abs(journalBal) > 0.004 && (
          <Stat
            label="Journal Balance"
            value={money(Math.abs(journalBal))}
            icon={BookOpen}
            tone={journalBal > 0 ? '#DC2626' : '#B45309'}
            note={journalBal > 0 ? 'To take, from the journal' : 'To give, from the journal'}
            noteTone={journalBal > 0 ? '#DC2626' : '#B45309'}
            onClick={() => setView('journal')}
          />
        )}
        {supplier && (
          <Stat
            label="You Owe Them (Purchases)"
            value={money(owedToThem)}
            icon={ShoppingCart}
            tone="#EA580C"
            onClick={() => navigate(`/supplier/${supplier.id}`)}
            note={owedToThem < -0.004 ? 'Paid ahead — they hold it as advance' : 'Tap for purchase khata'}
          />
        )}
        {(supplier || Math.abs(journalBal) > 0.004) && (
          <Stat label="Net Balance" value={money(Math.abs(net))} icon={ArrowLeftRight} tone={net > 0.004 ? '#DC2626' : '#16A34A'} note={netLabel} noteTone={net > 0.004 ? '#DC2626' : '#16A34A'} />
        )}
      </div>

      <div className="row wrap mb-2" style={{ gap: 8 }}>
        {party.phone && (
          <>
            <a className="btn btn-sm" href={`tel:${party.phone}`}><Phone size={13} /> Call</a>
            <a className="btn btn-sm" target="_blank" rel="noreferrer" href={whatsappUrl(party.phone, waText)}><Send size={13} /> Send ledger on WhatsApp</a>
          </>
        )}
        {Number(party.creditLimit) > 0 && (
          <span className={`pill ${outstanding > party.creditLimit ? 'pill-due' : 'pill-neutral'}`}>
            Credit limit {money(party.creditLimit)}{outstanding > party.creditLimit ? ' — exceeded' : ''}
          </span>
        )}
        {reorder?.isDue && <span className="pill pill-partial">Usually orders every {reorder.avgDays} days — it has been {reorder.sinceDays}</span>}
      </div>

      <div className="row mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg">
          <button className={view === 'statement' ? 'active' : ''} onClick={() => setView('statement')}>Full Statement</button>
          <button className={view === 'bills' ? 'active' : ''} onClick={() => setView('bills')}>Bills Only</button>
          <button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')}>Journal{journalCount ? ` (${journalCount})` : ''}</button>
        </div>
        <span className="small muted">
          {view === 'journal' ? 'Your own notes with any fields you choose — separate from bills and payments'
            : view === 'statement'
            ? supplier ? 'Sales and purchases together, with one running balance — below zero means you owe them' : 'Every bill, payment and return as its own entry, with a running balance'
            : 'One row per bill'}
        </span>
      </div>

      {view === 'statement' && (
        <Card
          title="Account Statement"
          tight
          subtitle={`${filter === 'all' ? ledger.length : `${shown.length} of ${ledger.length}`} entries · closing balance ${money(closing)}`}
          actions={<Button size="sm" icon={Printer} onClick={printStatement}>Print</Button>}
        >
          {ledger.length > 0 && (
            <div className="seg" style={{ margin: '10px 12px', flexWrap: 'wrap' }}>
              {LEDGER_FILTERS.filter((f) => supplier || (f.value !== 'purchases' && f.value !== 'paid')).map((f) => (
                <button key={f.value} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>
                  {f.label} <span className="muted small">({countOf(f.value)})</span>
                </button>
              ))}
            </div>
          )}
          {ledger.length > 0 && !shown.length ? <Empty icon={Receipt} title="Nothing here" message="No entries of this kind for this party." /> : ledger.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl stmt-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>Date</th><th>Particulars</th><th style={{ width: 108 }}>Method</th>
                      <th className="r" style={{ width: 110 }}>Debit (+)</th><th className="r" style={{ width: 110 }}>Credit (−)</th>
                      <th className="r" style={{ width: 120 }}>Balance</th><th style={{ width: 140 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.isPart ? `part-${r.id}` : r.id}
                        style={r.isPart ? { background: 'var(--neutral-bg)' } : undefined}
                        className={`${r.billId || r.side === 'purchase' || r.parts ? 'clickable' : ''} stmt-${r.type}`}
                        onClick={() => {
                          if (r.parts) setOpenGroups((g) => ({ ...g, [r.id]: !g[r.id] }));
                          else if (r.billId) navigate(`/bill/${r.billId}`);
                          else if (r.purchaseBillId) navigate(`/purchase/${r.purchaseBillId}`);
                          else if (r.side === 'purchase' && supplier) navigate(`/supplier/${supplier.id}`);
                        }}
                      >
                        <td className="nowrap small">{r.isPart ? '' : fmtDate(r.date)}</td>
                        <td style={r.isPart ? { paddingLeft: 28 } : undefined}>
                          <div style={{ fontWeight: r.isPart ? 500 : 600, textDecoration: r.voided ? 'line-through' : 'none' }}>
                            {r.parts && (openGroups[r.id] ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />)}
                            {r.parts && ' '}
                            {r.side === 'purchase' && <><Pill status="partial" label="Purchase" />{' '}</>}
                            {r.isPart ? `↳ ${partName(r)}` : r.title}
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
                        <td onClick={(e) => e.stopPropagation()}><div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>{rowActions(r)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>{filter === 'all' ? 'Closing balance' : 'Total shown · closing balance'}{closing < -0.004 && ' (you owe them)'}</td>
                      <td className="r">{money(shown.reduce((s, r) => s + r.debit, 0))}</td>
                      <td className="r">{money(shown.reduce((s, r) => s + r.credit, 0))}</td>
                      <td className="r" style={{ fontSize: 14 }}>{money(closing)}</td>
                      <td />
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
                    onClick={() => { if (r.parts) setOpenGroups((g) => ({ ...g, [r.id]: !g[r.id] })); }}
                  >
                    <div className="top">
                      <span className="name" style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>{r.isPart ? `↳ ${partName(r)}` : r.title}</span>
                      <span className="amt" style={{ color: r.debit > 0 ? 'var(--danger)' : r.pending > 0 ? '#B45309' : 'var(--success)' }}>
                        {r.debit > 0 ? `+${money(r.debit)}` : r.credit > 0 ? `−${money(r.credit)}` : r.pending > 0 ? `(${money(r.pending)})` : '—'}
                      </span>
                    </div>
                    {r.detail && <div className="small muted">{r.detail}</div>}
                    <div className="meta">
                      <span>{fmtDate(r.date)}</span>
                      {r.method && <Pill status="neutral" label={r.method} />}
                      <span className="spacer" />
                      {r.parts && <span className="small" style={{ fontWeight: 600 }}>{openGroups[r.id] ? 'Hide parts' : `${r.parts.length} parts`}</span>}
                      {!r.isPart && <span style={{ fontWeight: 700 }}>Bal {money(r.balance)}</span>}
                    </div>
                    {(r.billId || (r.paymentId && !r.reversed) || r.chequeId || r.supplierPaymentId || (r.type === 'journal' && r.journalId) || (r.journalPaymentId && !r.parts) || r.parts) && (
                      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>{rowActions(r, true)}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty icon={Receipt} title="No entries yet" message={`Nothing has been recorded for ${party.name} yet.`} action={<Button variant="primary" onClick={() => navigate(`/bill/new?party=${party.id}`)}>Create first bill</Button>} />
          )}
        </Card>
      )}

      {view === 'journal' && <PartyJournal kind="party" party={party} action={journalAct} onActionDone={() => setJournalAct(null)} />}

      {view === 'bills' && (
        <Card title="Bills" subtitle="Due and partly paid bills are shown first" tight>
          {bills.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Bill</th><th>Date</th><th>Items</th><th>Status</th><th>Due date</th>
                      <th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th><th style={{ width: 150 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((b) => {
                      const cls = b.due > 0 && b.isOverdue ? BUCKET_META[b.bucket].cls : '';
                      const lines = linesOf(b.id);
                      return (
                        <Fragment key={b.id}>
                          <tr className={`clickable ${cls}`} onClick={() => navigate(`/bill/${b.id}`)}>
                            <td style={{ fontWeight: 600 }}>{b.billNo}</td>
                            <td className="nowrap">{fmtDate(b.date)}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              {lines.length ? (
                                <button className="btn btn-sm btn-ghost" onClick={() => setExpanded((x) => ({ ...x, [b.id]: !x[b.id] }))} title={expanded[b.id] ? 'Hide items' : 'Show what was bought'} style={{ gap: 5 }}>
                                  {expanded[b.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                  {lines.length} item{lines.length === 1 ? '' : 's'}
                                </button>
                              ) : <span className="muted small">—</span>}
                            </td>
                            <td>
                              <Pill status={b.status} />
                              {b.isOverdue && b.due > 0 && <div className="small" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 2 }}>{b.overdueDays}d late</div>}
                            </td>
                            <td className="nowrap small">{b.due > 0 ? fmtDate(b.dueDate) : <span className="muted">—</span>}</td>
                            <td className="r strong"><Money value={b.net} /></td>
                            <td className="r"><Money value={b.paid} /></td>
                            <td className="r strong">{b.due > 0 ? <span className="money neg">{money(b.due)}</span> : <span className="muted">—</span>}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <div className="row-actions">
                                {b.due > 0 && b.status !== 'voided' && <button className="btn btn-primary btn-sm" onClick={() => setPayBill(b)}>Pay</button>}
                                {b.status !== 'voided' && !isOpeningBill(b) && (
                                  <>
                                    <button className="btn btn-ghost btn-sm" title="Add return" onClick={() => setReturnBill(b)}><RotateCcw size={14} /></button>
                                    <button className="btn btn-ghost btn-sm" title="Edit bill" onClick={() => navigate(`/bill/${b.id}/edit`)}><Pencil size={14} /></button>
                                    <button className="btn btn-ghost btn-sm" title="Void bill" onClick={() => setVoidBill(b)}><Ban size={14} color="var(--danger)" /></button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                          {expanded[b.id] && (
                            <tr className="items-detail-row">
                              <td colSpan={9} style={{ padding: 0 }}>
                                <div className="items-detail">
                                  <table className="tbl items-detail-tbl">
                                    <thead><tr><th style={{ width: 30 }}>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
                                    <tbody>
                                      {lines.map((l, i) => (
                                        <tr key={l.id}>
                                          <td className="muted">{i + 1}</td>
                                          <td style={{ fontWeight: 500 }}>{itemName(l.itemId)}</td>
                                          <td className="r">{l.qty}</td>
                                          <td>{l.unit}</td>
                                          <td className="r"><Money value={l.price} /></td>
                                          <td className="r strong"><Money value={r2(l.qty * l.price)} /></td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr>
                                        <td colSpan={5}>Bill {b.billNo} total{b.returned > 0 && ` (after ${money(b.returned)} returned)`}</td>
                                        <td className="r">{money(b.net)}</td>
                                      </tr>
                                    </tfoot>
                                  </table>
                                  <div className="items-detail-actions">
                                    <Button size="sm" icon={Receipt} onClick={() => navigate(`/bill/${b.id}`)}>Open full bill</Button>
                                    {b.status !== 'voided' && <Button size="sm" icon={Printer} onClick={() => navigate(`/bill/${b.id}`)}>Print</Button>}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>Totals</td>
                      <td className="r">{money(totals.billed)}</td>
                      <td className="r">{money(totals.paid)}</td>
                      <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {bills.map((b) => (
                  <div key={b.id} className={`mcard ${b.due > 0 && b.isOverdue ? BUCKET_META[b.bucket].mcls : ''}`} onClick={() => setSheetBill(b)}>
                    <div className="top"><span className="name">{b.billNo}</span><span className="amt">{money(b.net)}</span></div>
                    <div className="meta">
                      <Pill status={b.status} />
                      <span>{fmtDate(b.date)}</span>
                      {b.due > 0 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{money(b.due)} due{b.isOverdue ? ` · ${b.overdueDays}d late` : ''}</span>}
                      <span className="spacer" />
                      <EllipsisVertical size={15} className="muted" />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty icon={Receipt} title="No bills yet" message={`${party.name} has no bills recorded.`} action={<Button variant="primary" onClick={() => navigate(`/bill/new?party=${party.id}`)}>Create first bill</Button>} />
          )}
        </Card>
      )}

      {data.partyAdvances.some((a) => a.partyId === id) && (
        <Card title="Advance / Deposit History" tight className="mt-2">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="r">Received</th><th className="r">Applied</th><th className="r">Remaining</th><th style={{ width: 48 }} /></tr></thead>
              <tbody>
                {data.partyAdvances.filter((a) => a.partyId === id).map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.dateReceived)}</td>
                    <td>{a.method || 'Cash'}</td>
                    <td className="muted small">{a.note || '—'}</td>
                    <td className="r"><Money value={a.amount} /></td>
                    <td className="r"><Money value={a.applied || 0} /></td>
                    <td className="r strong"><span className="money pos">{money((a.amount || 0) - (a.applied || 0))}</span></td>
                    <td><Button size="sm" icon={Trash2} onClick={() => setDelAdvance(a)} title="Delete this advance" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <BillPreview
        open={!!previewId}
        onClose={() => setPreviewId(null)}
        bill={previewBill}
        lines={previewId ? linesOf(previewId) : []}
        payments={previewId ? data.payments.filter((p) => p.billId === previewId) : []}
        cheques={data.cheques}
        returns={previewId ? data.returns.filter((r) => r.billId === previewId) : []}
        itemName={itemName}
        party={party}
        shopName={settings.shopName}
        onPrint={() => { const b = previewId; setPreviewId(null); navigate(`/bill/${b}`); }}
        onPDF={() => {
          if (!previewBill) return;
          billPDF({
            bill: previewBill, lines: linesOf(previewBill.id).map((l) => ({ ...l, itemName: itemName(l.itemId) })), party,
            payments: data.payments.filter((p) => p.billId === previewBill.id && !p.reversed), settings, state: previewBill,
          });
        }}
      />
      <PartyPricesModal open={pricesOpen} onClose={() => setPricesOpen(false)} party={party} data={data} />
      <EditPaymentModal
        open={!!editPay}
        onClose={() => setEditPay(null)}
        payment={editPay ? data.payments.find((p) => p.id === editPay) : null}
        cheque={editPay ? data.cheques.find((c) => c.paymentId === editPay) : null}
      />
      <Confirm
        open={!!delPay}
        danger
        title="Delete this payment?"
        confirmLabel="Delete payment"
        message={(() => {
          const p = data.payments.find((x) => x.id === delPay);
          if (!p) return '';
          const c = data.cheques.find((x) => x.paymentId === p.id);
          return `${money(p.amount)} by ${p.method} on ${fmtDate(p.date)} will be removed permanently and the bill will show it as unpaid again.`
            + (c ? ` The attached cheque ${c.chequeNo || ''} will be deleted too.` : '') + ' This cannot be undone.';
        })()}
        onCancel={() => setDelPay(null)}
        onConfirm={async () => { const pid = delPay; setDelPay(null); await mutate(() => api.deletePayment(pid), 'Payment deleted'); }}
      />
      <Confirm
        open={!!delJpay}
        danger
        title="Remove this journal payment?"
        confirmLabel="Remove payment"
        message={delJpay ? `The ${money(delJpay.originalAmount)} collected on ${fmtDate(delJpay.date)} will be removed, so that amount is owed again on the journal entry.` : ''}
        onCancel={() => setDelJpay(null)}
        onConfirm={async () => { const r = delJpay; setDelJpay(null); await mutate(() => api.deleteJournalPayment(r.journalPaymentId), 'Journal payment removed').catch(() => {}); }}
      />
      <Confirm
        open={!!delGroup}
        danger
        title="Delete this whole payment?"
        confirmLabel="Delete all parts"
        message={delGroup ? `${money(delGroup.originalAmount)} on ${fmtDate(delGroup.date)} will be removed from ${delGroup.parts.length} places (${delGroup.parts.map(partName).join(', ')}). Those bills and journal amounts will be owed again. This cannot be undone.` : ''}
        onCancel={() => setDelGroup(null)}
        onConfirm={async () => {
          const g = delGroup;
          setDelGroup(null);
          await mutate(async () => {
            for (const part of g.parts) {
              if (part.journalPaymentId) await api.deleteJournalPayment(part.journalPaymentId);
              else if (part.paymentId) await api.deletePayment(part.paymentId);
            }
          }, 'Payment deleted').catch(() => {});
        }}
      />
      <Confirm
        open={!!delCheque}
        danger
        title="Delete this cheque record?"
        confirmLabel="Delete cheque"
        message={(() => {
          const c = data.cheques.find((x) => x.id === delCheque);
          return c ? `Cheque ${c.chequeNo || '(no number)'}${c.bankName ? ` from ${c.bankName}` : ''} for ${money(c.amount)} will be removed. The payment itself stays and becomes an ordinary ${c.status === 'cleared' ? 'cleared ' : ''}payment. This cannot be undone.` : '';
        })()}
        onCancel={() => setDelCheque(null)}
        onConfirm={async () => { const cid = delCheque; setDelCheque(null); await mutate(() => api.deleteCheque(cid), 'Cheque deleted'); }}
      />
      <Confirm
        open={!!delAdvance}
        danger
        title="Delete this advance?"
        confirmLabel="Delete advance"
        message={delAdvance ? `${money(delAdvance.amount)} received on ${fmtDate(delAdvance.dateReceived)} will be removed permanently, along with the receipt that recorded it.`
          + (Number(delAdvance.applied) > 0 ? ` ${money(delAdvance.applied)} of it has already been applied to bills — those payments are removed too, so those bills will show as unpaid again.` : '')
          + ' This cannot be undone.' : ''}
        onCancel={() => setDelAdvance(null)}
        onConfirm={async () => {
          const a = delAdvance;
          setDelAdvance(null);
          const res = await mutate(() => api.deleteAdvance(a.id), null);
          const n = res?.reopened?.length ?? 0;
          toast(`Advance of ${money(a.amount)} deleted` + (n ? ` — ${n} bill${n === 1 ? '' : 's'} reopened` : ''));
        }}
      />
      <Confirm
        open={!!delOrphan}
        danger
        title="Delete this advance receipt?"
        confirmLabel="Delete receipt"
        message={delOrphan ? `${money(delOrphan.originalAmount)} on ${fmtDate(delOrphan.date)} will be removed. Its advance record could not be found, so only this receipt line goes. This cannot be undone.` : ''}
        onCancel={() => setDelOrphan(null)}
        onConfirm={async () => { const r = delOrphan; setDelOrphan(null); await mutate(() => api.deletePayment(r.paymentId, 'Orphaned advance receipt', true), 'Advance receipt deleted'); }}
      />
      <SettlePartyModal open={settleOpen} onClose={(msg) => { setSettleOpen(false); if (msg) toast(msg); }} party={party} bills={bills} />
      <PaymentModal open={!!payBill} onClose={() => setPayBill(null)} bill={payBill} state={payBill} party={party} />
      <ReturnModal open={!!returnBill} onClose={() => setReturnBill(null)} bill={returnBill} party={party} />
      <AdvanceModal open={advOpen} onClose={() => setAdvOpen(false)} party={party} />
      <ShareLedgerModal open={shareOpen} onClose={() => setShareOpen(false)} party={party} existing={link} />
      <PartyLockModal open={lockOpen} onClose={() => setLockOpen(false)} party={party} />
      {supplier && (
        <>
          <PurchaseBillModal open={buyOpen} onClose={() => setBuyOpen(false)} supplierId={supplier.id} />
          <SupplierPaymentModal open={payThemOpen} onClose={() => setPayThemOpen(false)} supplierId={supplier.id} />
          <SetOffModal open={setOffOpen} onClose={() => setSetOffOpen(false)} party={party} receivable={totals.due} payable={owedToThem} />
        </>
      )}
      <Confirm
        open={!!delSupPay}
        danger
        title="Delete this payment to them?"
        confirmLabel="Delete payment"
        message={(() => {
          const p = (data.supplierPayments || []).find((x) => x.id === delSupPay);
          return p ? `${money(p.amount)} (${p.method}) on ${fmtDate(p.date)} will be removed permanently, and you will owe them that much again.`
            + (p.method === 'Set-off' ? ' This was a set-off: the matching Set-off payments on their sale bills stay until you delete those too.' : '')
            + ' This cannot be undone.' : '';
        })()}
        onCancel={() => setDelSupPay(null)}
        onConfirm={async () => { const pid = delSupPay; setDelSupPay(null); await mutate(() => api.deleteSupplierPayment(pid), 'Payment deleted'); }}
      />
      <ActionSheet
        open={!!sheetBill}
        title={sheetBill ? `Bill ${sheetBill.billNo} — ${money(sheetBill.net)}` : ''}
        onClose={() => setSheetBill(null)}
        items={sheetBill ? [
          { label: 'Open bill', icon: Receipt, onClick: () => navigate(`/bill/${sheetBill.id}`) },
          ...(sheetBill.due > 0 && sheetBill.status !== 'voided' ? [{ label: `Add payment (${money(sheetBill.due)} due)`, icon: Plus, onClick: () => setPayBill(sheetBill) }] : []),
          ...(sheetBill.status !== 'voided' && !isOpeningBill(sheetBill) ? [
            { label: 'Add return', icon: RotateCcw, onClick: () => setReturnBill(sheetBill) },
            { label: 'Edit bill', icon: Pencil, onClick: () => navigate(`/bill/${sheetBill.id}/edit`) },
            { label: 'Void bill', icon: Ban, danger: true, onClick: () => setVoidBill(sheetBill) },
          ] : []),
        ] : []}
      />
      <Confirm
        open={!!voidBill}
        title="Void this bill?"
        message={`Bill ${voidBill?.billNo} will be marked Voided. It stays in your history with its bill number — nothing is deleted — but it stops counting towards sales and dues.`}
        confirmLabel="Void bill"
        danger
        onConfirm={doVoid}
        onCancel={() => setVoidBill(null)}
      />
    </>
  );
}
