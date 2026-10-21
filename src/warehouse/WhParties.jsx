import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, ChevronRight, ClipboardList, Download, HandCoins,
  KeyRound, Lock, Package, Pencil, Phone, Plus, Printer, Save, Scale, Send, Share2, Trash2, TriangleAlert, Users,
  Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import {
  money, norm, qty, r2, fmtDate, today, whatsappUrl, shareUrl, nameKey, phoneKey,
} from '../lib/format.js';
import {
  whPartyItems, whPartyLedger, whPartySummaries, whPartyTotals,
} from '../lib/calc.js';
import { exportCSV, printReport, raw, esc } from '../lib/exporters.js';
import { canOpen, isLocked, relock } from '../lib/partyLock.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Select, Stat, Textarea,
} from '../components/ui.jsx';
import { PartyLockModal, ShareLedgerModal, UnlockLedger } from '../components/partyForms.jsx';
import ImportButton from '../components/ImportButton.jsx';
import PartyJournal from '../components/PartyJournal.jsx';

/** A khata balance in words, from our side: above zero the party owes us. */
export function balanceWords(b) {
  if (b > 0.004) return 'They owe you';
  if (b < -0.004) return 'You owe them';
  return 'Settled';
}

const balanceTone = (b) => (b > 0.004 ? 'var(--danger)' : b < -0.004 ? '#B45309' : 'var(--success)');

/** Add or edit a warehouse party. Staff never see or set the opening balance. */
export function WhPartyForm({ party = null, initialName = '', onSaved, onCancel }) {
  const { data, mutate, access } = useApp();
  const sc = access.seesCost;
  const ob = Number(party?.openingBalance) || 0;
  const [f, setF] = useState({
    name: String(party?.name ?? initialName ?? ''),
    phone: String(party?.phone ?? ''),
    city: String(party?.city ?? ''),
    address: String(party?.address ?? ''),
    note: String(party?.note ?? ''),
    opening: ob ? String(Math.abs(ob)) : '',
    side: ob > 0 ? 'theyOwe' : 'weOwe',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const others = (data.whParties || []).filter((p) => p.id !== party?.id);
  const dupName = f.name.trim() ? others.find((p) => nameKey(p.name) === nameKey(f.name)) : null;
  const ph = phoneKey(f.phone);
  const dupPhone = ph ? others.find((p) => phoneKey(p.phone) === ph) : null;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Party name is required');
    if (dupName || dupPhone) return undefined;
    const amt = Number(f.opening) || 0;
    if (amt < 0) return setErr('Enter the opening balance as a plain amount, then choose who owes whom');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveWhParty({
        id: party?.id, name: f.name.trim(), phone: f.phone.trim(), city: f.city.trim(), address: f.address.trim(), note: f.note.trim(),
        ...(sc ? { openingBalance: f.side === 'theyOwe' ? amt : -amt } : {}),
      }), party ? 'Party updated' : `Party "${f.name.trim()}" added`);
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Party name" className="full" error={err || (dupName ? `"${dupName.name}" is already a warehouse party` : '')}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. City Balloon Factory" />
        </Field>
        <Field label="Phone" error={dupPhone ? `This number is already on "${dupPhone.name}"` : ''}>
          <Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" inputMode="tel" />
        </Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} placeholder="e.g. Lahore" /></Field>
        {sc && (
          <>
            <Field label="Opening balance" hint="What stood between you before this khata — 0 if nothing">
              <Input type="number" min="0" step="any" value={f.opening} onChange={set('opening')} placeholder="0" />
            </Field>
            <Field label="Who owes whom">
              <Select value={f.side} onChange={set('side')}>
                <option value="weOwe">We owe them</option>
                <option value="theyOwe">They owe us</option>
              </Select>
            </Field>
          </>
        )}
        <Field label="Address" className="full">
          <Textarea value={f.address} onChange={set('address')} rows={2} placeholder="Factory, market or area" />
        </Field>
        <Field label="Note" className="full"><Input value={f.note} onChange={set('note')} placeholder="Optional — what they supply, terms…" /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy} disabled={!!dupName || !!dupPhone}>{party ? 'Update Party' : 'Add Party'}</Button>
      </div>
    </form>
  );
}

/** Money either way with a warehouse party: we paid them, or they paid us. */
export function WhPartyPaymentModal({ open, onClose, party, balance = 0 }) {
  const { methods, mutate } = useApp();
  const blank = () => ({ direction: balance > 0.004 ? 'received' : 'paid', amount: '', method: 'Cash', date: today(), note: '' });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF(blank()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amt = Number(f.amount) || 0;
  const paid = f.direction === 'paid';
  const after = r2(balance + (paid ? amt : -amt));
  const save = async () => {
    if (busy || !(amt > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.addWhPartyPayment({
        partyId: party.id, direction: f.direction, amount: amt, method: f.method, date: f.date, note: f.note,
      }), paid ? `Payment to ${party.name} recorded` : `Money from ${party.name} recorded`);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  if (!party) return null;
  return (
    <Modal
      open={open}
      title={`Payment — ${party.name}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!(amt > 0)}>{paid ? 'Pay' : 'Receive'} {amt > 0 ? money(amt) : ''}</Button></>}
    >
      <div style={{ padding: 12, marginBottom: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
        <span>{balanceWords(balance)}</span>
        <span className="spacer" />
        <span className="money" style={{ fontSize: 16, color: balanceTone(balance) }}>{money(Math.abs(balance))}</span>
      </div>
      <div className="seg mb-2" style={{ width: '100%' }}>
        <button type="button" style={{ flex: 1 }} className={paid ? 'active' : ''} onClick={() => setF((x) => ({ ...x, direction: 'paid' }))}>We paid them</button>
        <button type="button" style={{ flex: 1 }} className={!paid ? 'active' : ''} onClick={() => setF((x) => ({ ...x, direction: 'received' }))}>They paid us</button>
      </div>
      <div className="form-grid">
        <Field label="Amount" hint={amt > 0 ? `Balance after this: ${money(Math.abs(after))} — ${balanceWords(after).toLowerCase()}` : undefined}>
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} placeholder="0" autoFocus />
        </Field>
        <Field label={paid ? 'Paid from' : 'Received in'}><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="e.g. against GRN-2026-0012" /></Field>
      </div>
    </Modal>
  );
}

/** Everyone goods come from and go to, each with a khata. */
export default function WhParties() {
  const { data, settings, mutate, access, toast } = useApp();
  const sc = access.seesCost;
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toggling, setToggling] = useState(null);
  const sums = useMemo(() => whPartySummaries(data), [data]);
  const list = useMemo(() => (data.whParties || [])
    .filter((p) => (archived ? p.status === 'archived' : p.status !== 'archived'))
    .map((p) => ({ ...p, ...(sums.get(p.id) || {}), hidden: !canOpen(p) })), [data.whParties, sums, archived]);
  const rows = useMemo(() => {
    const s = norm(q);
    return list
      .filter((p) => !s || norm([p.name, p.phone, p.city, p.address].join(' ')).includes(s))
      .filter((p) => {
        if (filter === 'all') return true;
        if (p.hidden) return false;
        return filter === 'oweUs' ? p.balance > 0.004 : p.balance < -0.004;
      })
      .sort((a, b) => (sc ? Math.abs(b.hidden ? 0 : b.balance) - Math.abs(a.hidden ? 0 : a.balance) : 0)
        || String(b.lastDate).localeCompare(String(a.lastDate)) || a.name.localeCompare(b.name));
  }, [list, q, filter, sc]);
  const totals = useMemo(() => {
    const open_ = list.filter((p) => !p.hidden);
    return {
      oweUs: r2(open_.reduce((s, p) => s + Math.max(0, p.balance), 0)),
      weOwe: r2(open_.reduce((s, p) => s + Math.max(0, -p.balance), 0)),
      unrated: open_.reduce((s, p) => s + p.unrated, 0),
      receivedQty: r2(open_.reduce((s, p) => s + p.receivedQty, 0)),
      sentQty: r2(open_.reduce((s, p) => s + p.sentQty, 0)),
    };
  }, [list]);
  const toggle = async () => {
    const p = toggling;
    setToggling(null);
    await mutate(() => api.archiveWhParty(p.id), p.status === 'archived' ? 'Party restored' : 'Party archived').catch(() => {});
  };
  const toExcel = () => {
    exportCSV('WarehouseParties', ['Party', 'Phone', 'City', 'Documents', 'Units received', 'Units sent', 'Last activity', ...(sc ? ['Received value', 'Sent value', 'Paid to them', 'Received from them', 'Balance', 'Position'] : [])],
      rows.map((p) => [p.name, p.phone, p.city, p.hidden ? '' : p.moves, p.hidden ? '' : p.receivedQty, p.hidden ? '' : p.sentQty, p.lastDate ? fmtDate(p.lastDate) : '',
        ...(sc ? (p.hidden ? ['Locked', '', '', '', '', ''] : [p.receivedValue, p.sentValue, p.paid, p.received, Math.abs(p.balance), balanceWords(p.balance)]) : [])]),
      [`${settings.shopName} — Warehouse Parties`]);
    toast('Parties exported');
  };
  const dash = <span className="muted">—</span>;
  const balanceCell = (p) => {
    if (p.hidden) return <span className="muted small"><Lock size={12} style={{ verticalAlign: -1 }} /> Locked</span>;
    if (Math.abs(p.balance) <= 0.004) return <Pill status="paid" label="Settled" />;
    return (
      <>
        <span className="money" style={{ color: balanceTone(p.balance) }}>{money(Math.abs(p.balance))}</span>
        <div className="small muted">{p.balance > 0 ? 'owes you' : 'you owe'}</div>
      </>
    );
  };

  return (
    <>
      <PageHead title="Warehouse Parties" subtitle={`${list.length} ${archived ? 'archived' : 'active'} · who goods come from and go to`}>
        <SearchBox value={q} onChange={setQ} placeholder="Name, phone or city…" />
        <Button onClick={() => setArchived((v) => !v)}>{archived ? 'Show active' : 'Show archived'}</Button>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="whParties" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Party</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Parties" value={list.length} icon={Users} tone="#1F2937" />
        {sc ? (
          <>
            <Stat label="They Owe You" value={money(totals.oweUs)} icon={ArrowUpFromLine} tone="#DC2626" onClick={() => setFilter('oweUs')} note="Goods sent and not yet paid for" />
            <Stat label="You Owe Them" value={money(totals.weOwe)} icon={ArrowDownToLine} tone="#B45309" onClick={() => setFilter('weOwe')} note="Goods received and not yet paid for" />
            <Stat label="Lines Without Rate" value={totals.unrated} icon={TriangleAlert} tone={totals.unrated ? '#EA580C' : '#16A34A'} note={totals.unrated ? 'They count as 0 until a rate is set' : 'Every line has a rate'} />
          </>
        ) : (
          <>
            <Stat label="Units Received" value={qty(totals.receivedQty)} icon={ArrowDownToLine} tone="#16A34A" />
            <Stat label="Units Sent" value={qty(totals.sentQty)} icon={ArrowUpFromLine} tone="#DC2626" />
          </>
        )}
      </div>

      {sc && (
        <div className="seg mb-2" style={{ flexWrap: 'wrap' }}>
          {[['all', 'All'], ['oweUs', 'They owe you'], ['weOwe', 'You owe them']].map(([k, label]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      )}

      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Party</th><th>Phone</th><th className="r">Docs</th><th className="r">Received</th><th className="r">Sent</th><th>Last activity</th>
                    <th className="r cost-only">Balance</th><th style={{ width: 120 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/warehouse/party/${p.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {p.name}
                          {isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} aria-label="Password locked" />}
                        </div>
                        {(p.city || p.note) && <div className="small muted">{[p.city, p.note].filter(Boolean).join(' · ')}</div>}
                      </td>
                      <td>{p.phone || dash}</td>
                      <td className="r">{p.hidden ? dash : p.moves}</td>
                      <td className="r num">{p.hidden ? dash : qty(p.receivedQty)}</td>
                      <td className="r num">{p.hidden ? dash : qty(p.sentQty)}</td>
                      <td className="small">{p.hidden || !p.lastDate ? dash : fmtDate(p.lastDate)}</td>
                      <td className="r strong cost-only">{balanceCell(p)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          {p.phone && (
                            <a className="btn btn-ghost btn-sm" title="WhatsApp" href={whatsappUrl(p.phone, `Assalam-o-Alaikum ${p.name}, ${settings.shopName} se.`)} target="_blank" rel="noreferrer"><Send size={14} /></a>
                          )}
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(p)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title={p.status === 'archived' ? 'Restore' : 'Archive'} onClick={() => setToggling(p)}>
                            {p.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((p) => (
                <div key={p.id} className="mcard" onClick={() => navigate(`/warehouse/party/${p.id}`)}>
                  <div className="top">
                    <span className="name">{p.name}{isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} />}</span>
                    {sc ? (
                      <span className="amt" style={{ color: p.hidden ? 'var(--text-muted)' : balanceTone(p.balance) }}>
                        {p.hidden ? 'Locked' : Math.abs(p.balance) <= 0.004 ? 'Settled' : money(Math.abs(p.balance))}
                      </span>
                    ) : <span className="amt num">{p.hidden ? 'Locked' : `${p.moves} docs`}</span>}
                  </div>
                  <div className="meta">
                    {p.phone && <span><Phone size={12} style={{ verticalAlign: -2 }} /> {p.phone}</span>}
                    {p.city && <span>{p.city}</span>}
                    {!p.hidden && <span>In {qty(p.receivedQty)} · Out {qty(p.sentQty)}</span>}
                    {sc && !p.hidden && Math.abs(p.balance) > 0.004 && <span style={{ color: balanceTone(p.balance), fontWeight: 600 }}>{p.balance > 0 ? 'owes you' : 'you owe'}</span>}
                    <span className="spacer" />
                    <ChevronRight size={15} className="muted" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={Users}
            title={q || filter !== 'all' ? 'No matching parties' : archived ? 'No archived parties' : 'No warehouse parties yet'}
            message={q || filter !== 'all' ? 'Try a different search or filter.' : 'Add the factories, suppliers and customers your warehouse deals with — or add one straight from Stock In.'}
            action={!q && !archived && filter === 'all' ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first party</Button> : null}
          />
        )}
      </Card>

      <Modal open={adding} title="Add Warehouse Party" onClose={() => setAdding(false)}>
        {adding && <WhPartyForm onSaved={(p) => { setAdding(false); if (p?.id) navigate(`/warehouse/party/${p.id}`); }} onCancel={() => setAdding(false)} />}
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Party'}`} onClose={() => setEditing(null)}>
        {editing && <WhPartyForm party={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
      <Confirm
        open={!!toggling}
        title={toggling?.status === 'archived' ? 'Restore party?' : 'Archive party?'}
        message={toggling?.status === 'archived'
          ? `"${toggling?.name}" will appear in the Stock In and Stock Out lists again.`
          : `"${toggling?.name}" will be hidden from the Stock In and Stock Out lists. Its khata and every document stay — nothing is deleted.`}
        confirmLabel={toggling?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={toggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}

/** Locked khatas ask for their password; unlocking lasts ten minutes. */
export function WhPartyLedgerGate() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data } = useApp();
  const party = (data.whParties || []).find((p) => p.id === id);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!party || !isLocked(party)) return undefined;
    const t = setInterval(() => { if (!canOpen(party)) tick((n) => n + 1); }, 15000);
    return () => clearInterval(t);
  }, [party]);
  if (party && !canOpen(party)) {
    return <UnlockLedger party={party} onUnlocked={() => tick((n) => n + 1)} onBack={() => navigate('/warehouse/parties')} />;
  }
  return <WhPartyLedger onRelock={() => { relock(id); tick((n) => n + 1); }} />;
}

const KIND_PILL = {
  opening: { status: 'neutral', label: 'Opening' },
  in: { status: 'paid', label: 'Goods in' },
  out: { status: 'due', label: 'Goods out' },
  paid: { status: 'partial', label: 'Paid' },
  received: { status: 'cleared', label: 'Received' },
};

function WhPartyLedger({ onRelock }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, mutate, toast, access } = useApp();
  const sc = access.seesCost;
  const canMove = access.can('whMoves');
  const [view, setView] = useState('statement');
  const [payOpen, setPayOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [delPay, setDelPay] = useState(null);
  const party = (data.whParties || []).find((p) => p.id === id);
  const rows = useMemo(() => whPartyLedger(id, data), [id, data]);
  const totals = useMemo(() => whPartyTotals(rows), [rows]);
  const items = useMemo(() => whPartyItems(rows), [rows]);
  const link = (data.partyLedgerLinks || []).find((l) => l.partyId === id);
  const journalCount = (data.journal || []).filter((e) => e.kind === 'whParty' && e.partyId === id).length;

  if (!party) {
    return <Empty icon={Users} title="Party not found" message="This party may have been removed." action={<Button onClick={() => navigate('/warehouse/parties')}>Back to Parties</Button>} />;
  }
  const bal = totals.balance;
  const archived = party.status === 'archived';
  const lineText = (l) => `${l.name} × ${qty(l.qty)} ${l.unit || ''}`.trim() + (sc && l.rated ? ` @ ${money(l.rate)}` : '');
  const detailOf = (r) => {
    if (r.kind === 'in' || r.kind === 'out') return [r.lines.map(lineText).join(', '), r.reference && `Ref ${r.reference}`].filter(Boolean).join(' · ');
    if (r.kind === 'paid' || r.kind === 'received') return [r.method, r.note].filter(Boolean).join(' · ');
    return '';
  };
  const lastDate = rows.filter((r) => r.kind !== 'opening').map((r) => String(r.date)).sort().pop();

  const toExcel = () => {
    exportCSV(`Khata_${party.name}`, ['Date', 'Entry', 'Details', 'Qty in', 'Qty out', ...(sc ? ['Debit (+)', 'Credit (−)', 'Balance'] : [])],
      rows.map((r) => [r.date ? fmtDate(r.date) : '', r.voided ? `${r.title} (cancelled)` : r.title, detailOf(r), r.inQty || '', r.outQty || '',
        ...(sc ? [r.debit || '', r.credit || '', r.balance] : [])]),
      [`${settings.shopName} — Warehouse Khata`, party.name, party.phone || '', ...(sc ? [`Balance: ${money(Math.abs(bal))} — ${balanceWords(bal)}`] : [])]);
    toast('Khata exported');
  };
  const print = () => printReport({
    title: 'Khata Statement',
    subtitle: [party.name, party.phone, party.city].filter(Boolean).join(' · '),
    shopName: settings.shopName,
    headers: ['Date', 'Particulars', { label: 'Qty in', align: 'r' }, { label: 'Qty out', align: 'r' },
      ...(sc ? [{ label: 'Debit (+)', align: 'r' }, { label: 'Credit (−)', align: 'r' }, { label: 'Balance', align: 'r' }] : [])],
    rows: rows.map((r) => [
      r.date ? fmtDate(r.date) : '—',
      raw(`<span style="${r.voided ? 'text-decoration:line-through' : ''}">${esc(r.title)}</span>${detailOf(r) ? `<br/><span style="color:#6B7280;font-size:10px">${esc(detailOf(r))}</span>` : ''}`),
      r.inQty ? qty(r.inQty) : '—', r.outQty ? qty(r.outQty) : '—',
      ...(sc ? [r.debit ? money(r.debit) : '—', r.credit ? money(r.credit) : '—', money(r.balance)] : []),
    ]),
    totals: ['', 'Totals', qty(totals.receivedQty), qty(totals.sentQty),
      ...(sc ? [money(r2(rows.reduce((s, r) => s + r.debit, 0))), money(r2(rows.reduce((s, r) => s + r.credit, 0))), money(bal)] : [])],
    meta: sc ? [`Balance: ${money(Math.abs(bal))} — ${balanceWords(bal)}`, 'Above zero the party owes you; below zero you owe the party.'] : [],
  });
  const waText = sc
    ? `${settings.shopName}\n${party.name} — Khata\n\nGoods received from you: ${money(totals.receivedValue)} (${qty(totals.receivedQty)} units)\nGoods sent to you: ${money(totals.sentValue)} (${qty(totals.sentQty)} units)\nPaid to you: ${money(totals.paid)}\nReceived from you: ${money(totals.received)}\n*Balance: ${money(Math.abs(bal))} — ${bal < -0.004 ? 'we owe you' : bal > 0.004 ? 'you owe us' : 'settled'}*`
      + (link ? `\n\nFull khata: ${shareUrl(link.token)}` : '')
    : `${settings.shopName}\n${party.name}\n\nGoods received from you: ${qty(totals.receivedQty)} units\nGoods sent to you: ${qty(totals.sentQty)} units`;
  const rowActions = (r, mobile = false) => {
    if (!sc || !r.paymentId) return null;
    return <Button size="sm" icon={Trash2} onClick={(e) => { e.stopPropagation(); setDelPay(r.paymentId); }} title="Delete this payment">{mobile ? 'Delete' : null}</Button>;
  };
  const go = (r) => { if (r.moveId) navigate(`/warehouse/move/${r.moveId}`); };
  const delRec = delPay ? (data.whPartyPayments || []).find((p) => p.id === delPay) : null;

  return (
    <>
      <PageHead title={party.name} subtitle={[party.phone, party.city, party.address].filter(Boolean).join(' · ') || 'Warehouse party'}>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={print}>Print</Button>
        {sc && <Button icon={Share2} onClick={() => setShareOpen(true)}>Share</Button>}
        {isLocked(party) && <Button icon={Lock} onClick={onRelock} title="Close and lock this khata now">Lock now</Button>}
        <Button icon={isLocked(party) ? KeyRound : Lock} onClick={() => setLockOpen(true)}>{isLocked(party) ? 'Password' : 'Set Password'}</Button>
        <Button icon={Pencil} onClick={() => setEditOpen(true)}>Edit</Button>
        <Button icon={archived ? ArchiveRestore : Archive} onClick={() => setArchiving(true)}>{archived ? 'Restore' : 'Archive'}</Button>
        {sc && <Button variant="primary" icon={HandCoins} onClick={() => setPayOpen(true)}>Payment</Button>}
        {canMove && !archived && <Button icon={ArrowUpFromLine} onClick={() => navigate(`/warehouse/new/out?party=${party.id}`)}>Stock Out</Button>}
        {canMove && !archived && <Button variant="primary" icon={ArrowDownToLine} onClick={() => navigate(`/warehouse/new/in?party=${party.id}`)}>Stock In</Button>}
      </PageHead>

      {archived && (
        <div className="note mb-2"><span>This party is archived — it is hidden from the Stock In and Stock Out lists. Its khata stays as it was.</span></div>
      )}

      <div className="stat-grid">
        {sc ? (
          <>
            <Stat label="Goods Received" value={money(totals.receivedValue)} icon={ArrowDownToLine} tone="#16A34A" note={`${qty(totals.receivedQty)} units from them`} />
            <Stat label="Goods Sent" value={money(totals.sentValue)} icon={ArrowUpFromLine} tone="#DC2626" note={`${qty(totals.sentQty)} units to them`} />
            <Stat label="Paid to Them" value={money(totals.paid)} icon={Wallet} tone="#1F2937" note={`Received from them ${money(totals.received)}`} />
            <Stat label="Balance" value={money(Math.abs(bal))} icon={Scale} tone={bal > 0.004 ? '#DC2626' : bal < -0.004 ? '#B45309' : '#16A34A'} note={balanceWords(bal)} noteTone={balanceTone(bal)} />
          </>
        ) : (
          <>
            <Stat label="Units Received" value={qty(totals.receivedQty)} icon={ArrowDownToLine} tone="#16A34A" />
            <Stat label="Units Sent" value={qty(totals.sentQty)} icon={ArrowUpFromLine} tone="#DC2626" />
            <Stat label="Documents" value={totals.moves} icon={ClipboardList} tone="#1F2937" />
            <Stat label="Last Activity" value={lastDate ? fmtDate(lastDate) : '—'} icon={Package} tone="#1F2937" />
          </>
        )}
      </div>

      {sc && totals.unrated > 0 && (
        <div className="mb-2" style={{ padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#B45309', display: 'flex', gap: 8 }}>
          <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
          <span>{totals.unrated} item line{totals.unrated === 1 ? ' has' : 's have'} no rate yet, so {totals.unrated === 1 ? 'it adds' : 'they add'} nothing to the balance. Open the document and use <strong>Set rates</strong>.</span>
        </div>
      )}

      <div className="row wrap mb-2" style={{ gap: 8 }}>
        {party.phone && (
          <>
            <a className="btn btn-sm" href={`tel:${party.phone}`}><Phone size={13} /> Call</a>
            <a className="btn btn-sm" target="_blank" rel="noreferrer" href={whatsappUrl(party.phone, waText)}><Send size={13} /> Send khata on WhatsApp</a>
          </>
        )}
        {link && sc && <span className="pill pill-cleared">Share link is on</span>}
        {party.note && <span className="small muted">{party.note}</span>}
      </div>

      <div className="row mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg">
          <button className={view === 'statement' ? 'active' : ''} onClick={() => setView('statement')}>Khata</button>
          <button className={view === 'items' ? 'active' : ''} onClick={() => setView('items')}>Items</button>
          <button className={view === 'journal' ? 'active' : ''} onClick={() => setView('journal')}>Journal{journalCount ? ` (${journalCount})` : ''}</button>
        </div>
        <span className="small muted">
          {view === 'journal' ? 'Your own notes with any fields you choose — separate from stock and payments'
            : view === 'statement'
            ? sc ? 'Goods at their line rates and money either way, with one running balance — below zero means you owe them' : 'Every document with this party, oldest first'
            : 'What came from and went to this party, item by item'}
        </span>
      </div>

      {view === 'statement' && (
        <Card title="Khata" tight subtitle={`${rows.length} entries${sc ? ` · balance ${money(bal)}` : ''}`} actions={<Button size="sm" icon={Printer} onClick={print}>Print</Button>}>
          {rows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl stmt-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>Date</th><th>Particulars</th>
                      <th className="r" style={{ width: 90 }}>Qty in</th><th className="r" style={{ width: 90 }}>Qty out</th>
                      <th className="r cost-only" style={{ width: 110 }}>Debit (+)</th><th className="r cost-only" style={{ width: 110 }}>Credit (−)</th>
                      <th className="r cost-only" style={{ width: 120 }}>Balance</th><th className="cost-only" style={{ width: 50 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className={r.moveId ? 'clickable' : ''} onClick={() => go(r)} style={r.voided ? { opacity: 0.55 } : undefined}>
                        <td className="nowrap small">{r.date ? fmtDate(r.date) : '—'}</td>
                        <td>
                          <div style={{ fontWeight: 600, textDecoration: r.voided ? 'line-through' : 'none' }}>
                            <Pill status={r.voided ? 'voided' : KIND_PILL[r.kind].status} label={r.voided ? 'Cancelled' : KIND_PILL[r.kind].label} />{' '}{r.title}
                          </div>
                          {detailOf(r) && <div className="small muted">{detailOf(r)}</div>}
                          {sc && r.unrated > 0 && <div className="small" style={{ color: '#B45309', fontWeight: 600 }}>{r.unrated} line{r.unrated === 1 ? '' : 's'} without a rate</div>}
                        </td>
                        <td className="r num">{r.inQty ? qty(r.inQty) : <span className="muted">—</span>}</td>
                        <td className="r num">{r.outQty ? qty(r.outQty) : <span className="muted">—</span>}</td>
                        <td className="r strong cost-only">{r.debit > 0 ? <Money value={r.debit} /> : <span className="muted">—</span>}</td>
                        <td className="r strong cost-only">{r.credit > 0 ? <span className="money pos">{money(r.credit)}</span> : <span className="muted">—</span>}</td>
                        <td className="r strong cost-only"><span className="money" style={{ color: balanceTone(r.balance) }}>{money(r.balance)}</span></td>
                        <td className="cost-only" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}>{sc ? `Closing balance — ${balanceWords(bal).toLowerCase()}` : 'Totals'}</td>
                      <td className="r">{qty(totals.receivedQty)}</td>
                      <td className="r">{qty(totals.sentQty)}</td>
                      <td className="r cost-only">{money(r2(rows.reduce((s, r) => s + r.debit, 0)))}</td>
                      <td className="r cost-only">{money(r2(rows.reduce((s, r) => s + r.credit, 0)))}</td>
                      <td className="r cost-only" style={{ fontSize: 14 }}>{money(bal)}</td>
                      <td className="cost-only" />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((r) => (
                  <div key={r.id} className="mcard" onClick={() => go(r)} style={r.voided ? { opacity: 0.55 } : undefined}>
                    <div className="top">
                      <span className="name" style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>{r.title}</span>
                      <span className="amt" style={{ color: r.debit > 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {sc ? (r.debit > 0 ? `+${money(r.debit)}` : r.credit > 0 ? `−${money(r.credit)}` : '—') : r.inQty ? `+${qty(r.inQty)}` : r.outQty ? `−${qty(r.outQty)}` : '—'}
                      </span>
                    </div>
                    {detailOf(r) && <div className="small muted">{detailOf(r)}</div>}
                    <div className="meta">
                      <Pill status={r.voided ? 'voided' : KIND_PILL[r.kind].status} label={r.voided ? 'Cancelled' : KIND_PILL[r.kind].label} />
                      <span>{r.date ? fmtDate(r.date) : '—'}</span>
                      {sc && r.unrated > 0 && <span style={{ color: '#B45309', fontWeight: 600 }}>{r.unrated} without rate</span>}
                      <span className="spacer" />
                      {sc && <span style={{ fontWeight: 700 }}>Bal {money(r.balance)}</span>}
                    </div>
                    {sc && r.paymentId && <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>{rowActions(r, true)}</div>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty
              icon={ClipboardList}
              title="No entries yet"
              message={`Nothing has been recorded with ${party.name} yet.`}
              action={canMove && !archived ? <Button variant="primary" icon={ArrowDownToLine} onClick={() => navigate(`/warehouse/new/in?party=${party.id}`)}>Record Stock In</Button> : null}
            />
          )}
        </Card>
      )}

      {view === 'items' && (
        <Card title="Items" tight subtitle={`${items.length} item${items.length === 1 ? '' : 's'} moved with ${party.name}`}>
          {items.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th className="r">Received</th><th className="r">Sent</th>
                    <th className="r cost-only">Received value</th><th className="r cost-only">Sent value</th><th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((x) => (
                    <tr key={x.key} className={x.itemId ? 'clickable' : ''} onClick={() => x.itemId && navigate(`/warehouse/item/${x.itemId}`)}>
                      <td style={{ fontWeight: 600 }}>{x.name}</td>
                      <td className="r num">{x.inQty ? `${qty(x.inQty)} ${x.unit}` : <span className="muted">—</span>}</td>
                      <td className="r num">{x.outQty ? `${qty(x.outQty)} ${x.unit}` : <span className="muted">—</span>}</td>
                      <td className="r cost-only">{x.inValue ? <Money value={x.inValue} /> : <span className="muted">—</span>}</td>
                      <td className="r cost-only">{x.outValue ? <Money value={x.outValue} /> : <span className="muted">—</span>}</td>
                      <td className="small nowrap">{x.lastDate ? fmtDate(x.lastDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Package} title="No goods yet" message="Items appear here once goods are received from or sent to this party." />}
        </Card>
      )}

      {view === 'journal' && <PartyJournal kind="whParty" party={party} />}

      <Modal open={editOpen} title={`Edit ${party.name}`} onClose={() => setEditOpen(false)}>
        {editOpen && <WhPartyForm party={party} onSaved={() => setEditOpen(false)} onCancel={() => setEditOpen(false)} />}
      </Modal>
      {sc && <WhPartyPaymentModal open={payOpen} onClose={() => setPayOpen(false)} party={party} balance={bal} />}
      {sc && <ShareLedgerModal open={shareOpen} onClose={() => setShareOpen(false)} party={party} existing={link} warehouse />}
      <PartyLockModal open={lockOpen} onClose={() => setLockOpen(false)} party={party} warehouse />
      <Confirm
        open={archiving}
        title={archived ? 'Restore party?' : 'Archive party?'}
        message={archived
          ? `"${party.name}" will appear in the Stock In and Stock Out lists again.`
          : `"${party.name}" will be hidden from the Stock In and Stock Out lists. Its khata and every document stay — nothing is deleted.`}
        confirmLabel={archived ? 'Restore' : 'Archive'}
        onConfirm={async () => { setArchiving(false); await mutate(() => api.archiveWhParty(party.id), archived ? 'Party restored' : 'Party archived').catch(() => {}); }}
        onCancel={() => setArchiving(false)}
      />
      <Confirm
        open={!!delPay}
        danger
        title="Delete this payment?"
        confirmLabel="Delete payment"
        message={delRec ? `${money(delRec.amount)} ${delRec.direction === 'paid' ? 'paid to' : 'received from'} ${party.name} by ${delRec.method} on ${fmtDate(delRec.date)} will be removed, and the balance goes back by that much. This cannot be undone.` : ''}
        onCancel={() => setDelPay(null)}
        onConfirm={async () => { const pid = delPay; setDelPay(null); await mutate(() => api.deleteWhPartyPayment(pid), 'Payment deleted').catch(() => {}); }}
      />
    </>
  );
}
