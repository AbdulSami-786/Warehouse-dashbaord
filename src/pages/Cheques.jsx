import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CircleCheck, CircleX, Clock, CreditCard, Download, Trash2, TriangleAlert,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, norm, daysBetween } from '../lib/format.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Confirm, Empty, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';

/** Rows recording the same physical cheque: same party, number and bank. */
function siblings(cheques, chq) {
  const k = (s) => String(s || '').trim().toLowerCase();
  if (!k(chq.chequeNo)) return [chq];
  return cheques.filter((x) => x.id === chq.id || (x.partyId === chq.partyId && k(x.chequeNo) === k(chq.chequeNo) && k(x.bankName) === k(chq.bankName)));
}

const statusPill = (c) => (
  <Pill
    status={c.status === 'cleared' ? 'cleared' : c.status === 'bounced' ? 'bounced' : 'partial'}
    label={c.status === 'pending' ? 'Pending' : c.status === 'cleared' ? 'Cleared' : 'Bounced'}
  />
);

export default function Cheques() {
  const { data, settings, mutate, toast } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [bank, setBank] = useState('all');
  const [changing, setChanging] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const banks = useMemo(() => [...new Set(data.cheques.map((c) => c.bankName).filter(Boolean))].sort(), [data.cheques]);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.cheques.map((c) => {
      const party = data.parties.find((p) => p.id === c.partyId);
      const bill = data.bills.find((b) => b.id === c.billId);
      const left = daysBetween(new Date(), c.dateDue);
      const payNote = data.payments.find((p) => p.id === c.paymentId)?.note || '';
      return {
        ...c, party, bill, payNote, partyName: party?.name || 'Unknown',
        overdueToClear: c.status === 'pending' && left < 0, daysLate: c.status === 'pending' ? -left : 0,
      };
    })
      .filter((c) => status === 'all' || c.status === status)
      .filter((c) => bank === 'all' || c.bankName === bank)
      .filter((c) => !s || norm(c.chequeNo).includes(s) || norm(c.partyName).includes(s) || norm(c.bankName).includes(s) || norm(c.accountHolder).includes(s) || norm(c.payNote).includes(s))
      .sort((a, b) => {
        const rank = (c) => (c.status === 'bounced' ? 0 : c.status === 'pending' ? 1 : 2);
        return rank(a) - rank(b) || new Date(b.dateDue) - new Date(a.dateDue);
      });
  }, [data, q, status, bank]);
  const totals = useMemo(() => {
    const sum = (st) => r2(data.cheques.filter((c) => c.status === st).reduce((s, c) => s + (Number(c.amount) || 0), 0));
    return { pending: sum('pending'), cleared: sum('cleared'), bounced: sum('bounced'), pendingCount: data.cheques.filter((c) => c.status === 'pending').length };
  }, [data.cheques]);
  const group = changing ? siblings(data.cheques, changing.cheque) : [];

  const apply = async () => {
    const { cheque, newStatus } = changing;
    setChanging(null);
    await mutate(() => api.setChequeStatus(cheque.id, newStatus), `Cheque ${cheque.chequeNo} marked ${newStatus}`);
  };
  const remove = async () => {
    const c = deleting;
    setDeleting(null);
    await mutate(() => api.deleteCheque(c.id), `Cheque ${c.chequeNo || ''} deleted`);
  };
  const toExcel = () => {
    exportCSV('Cheques', ['Cheque No', 'Bank', 'Account holder', 'Party', 'Bill', 'Issued', 'Clears On', 'Status', 'Amount', 'Note'],
      rows.map((c) => [c.chequeNo, c.bankName, c.accountHolder || '', c.partyName, c.bill?.billNo || '', fmtDate(c.dateIssued), fmtDate(c.dateDue), c.status, Number(c.amount).toFixed(2), c.note || '']),
      [`${settings.shopName} — Cheques`, `Pending ${money(totals.pending)} · Cleared ${money(totals.cleared)} · Bounced ${money(totals.bounced)}`]);
    toast('Cheques exported');
  };
  const actions = (c, mobile = false) => (
    <>
      {c.status !== 'cleared' && (mobile
        ? <Button size="sm" variant="success" style={{ flex: 1 }} onClick={() => setChanging({ cheque: c, newStatus: 'cleared' })}>Cleared</Button>
        : <button className="btn btn-success btn-sm" onClick={() => setChanging({ cheque: c, newStatus: 'cleared' })}>Cleared</button>)}
      {c.status !== 'bounced' && (mobile
        ? <Button size="sm" variant="danger" style={{ flex: 1 }} onClick={() => setChanging({ cheque: c, newStatus: 'bounced' })}>Bounced</Button>
        : <button className="btn btn-danger btn-sm" onClick={() => setChanging({ cheque: c, newStatus: 'bounced' })}>Bounced</button>)}
      {!mobile && c.status !== 'pending' && (
        <button className="btn btn-ghost btn-sm" title="Back to pending" onClick={() => setChanging({ cheque: c, newStatus: 'pending' })}><Clock size={14} /></button>
      )}
      {mobile
        ? <Button size="sm" icon={Trash2} title="Delete this cheque record" onClick={() => setDeleting(c)} />
        : <button className="btn btn-ghost btn-sm" title="Delete this cheque record" onClick={() => setDeleting(c)}><Trash2 size={14} /></button>}
    </>
  );

  return (
    <>
      <PageHead title="Cheques" subtitle={`${totals.pendingCount} pending clearance worth ${money(totals.pending)}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Cheque no, party, bank…" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }} options={[{ value: 'all', label: 'All statuses' }, { value: 'pending', label: 'Pending' }, { value: 'cleared', label: 'Cleared' }, { value: 'bounced', label: 'Bounced' }]} />
        <Select value={bank} onChange={(e) => setBank(e.target.value)} style={{ width: 140 }}>
          <option value="all">All banks</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </Select>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Pending Clearance" value={money(totals.pending)} icon={Clock} tone="#F59E0B" />
        <Stat label="Cleared" value={money(totals.cleared)} icon={CircleCheck} tone="#16A34A" />
        <Stat label="Bounced" value={money(totals.bounced)} icon={CircleX} tone="#DC2626" />
      </div>
      {totals.pending > 0 && (
        <div style={{ padding: '10px 13px', background: 'var(--info-bg)', border: '1px solid #BFDBFE', borderRadius: 'var(--r)', marginBottom: 16, fontSize: 13, color: '#1D4ED8', display: 'flex', gap: 8, alignItems: 'center' }}>
          <TriangleAlert size={15} style={{ flex: 'none' }} />
          <span>{money(totals.pending)} in pending cheques is <strong>not</strong> counted as cash in hand until you mark each one Cleared.</span>
        </div>
      )}
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Cheque No</th><th>Bank</th><th>Account holder</th><th>Party</th><th>Bill</th><th>Issued</th><th>Clears on</th><th>Status</th><th className="r">Amount</th><th style={{ width: 150 }} /></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className={c.status === 'bounced' ? 'age-30' : c.overdueToClear ? 'age-8' : ''}>
                      <td style={{ fontWeight: 600 }}>
                        {c.chequeNo || '—'}
                        {!c.chequeNo && c.payNote && <div className="small muted" style={{ fontWeight: 400 }}>{c.payNote}</div>}
                      </td>
                      <td>{c.bankName || '—'}</td>
                      <td>{c.accountHolder || '—'}</td>
                      <td className="clickable" onClick={() => c.party && navigate(`/party/${c.party.id}`)}>{c.partyName}</td>
                      <td className="clickable" onClick={() => c.bill && navigate(`/bill/${c.bill.id}`)}>{c.bill?.billNo || '—'}</td>
                      <td className="nowrap small">{fmtDate(c.dateIssued)}</td>
                      <td className="nowrap small">
                        {fmtDate(c.dateDue)}
                        {c.overdueToClear && <div style={{ color: 'var(--danger)', fontWeight: 600 }}>{c.daysLate}d past</div>}
                      </td>
                      <td>{statusPill(c)}</td>
                      <td className="r strong"><Money value={c.amount} /></td>
                      <td><div className="row-actions">{actions(c)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((c) => (
                <div key={c.id} className={`mcard ${c.status === 'bounced' ? 'due-30' : c.overdueToClear ? 'due-8' : ''}`}>
                  <div className="top"><span className="name">{c.chequeNo || c.payNote || 'Cheque'}</span><span className="amt">{money(c.amount)}</span></div>
                  <div className="meta">
                    {statusPill(c)}
                    <span>{c.partyName}</span>
                    <span>{c.bankName}</span>
                    {c.accountHolder && <span>{c.accountHolder}</span>}
                    <span>Clears {fmtDate(c.dateDue)}</span>
                  </div>
                  <div className="row" style={{ gap: 7 }}>{actions(c, true)}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={CreditCard}
            title={q || status !== 'all' ? 'No matching cheques' : 'No cheques yet'}
            message={q || status !== 'all' ? 'Try a different filter.' : 'Cheques recorded as a payment method will appear here.'}
          />
        )}
      </Card>
      <Confirm
        open={!!changing}
        title={changing?.newStatus === 'bounced' ? 'Mark cheque as bounced?' : changing?.newStatus === 'cleared' ? 'Mark cheque as cleared?' : 'Move cheque back to pending?'}
        message={(changing?.newStatus === 'bounced'
          ? `Cheque ${changing?.cheque.chequeNo} for ${money(changing?.cheque.amount)} will be marked Bounced. The related bill's due balance reopens automatically and ${changing?.cheque.partyName} is flagged.`
          : changing?.newStatus === 'cleared'
            ? `Cheque ${changing?.cheque.chequeNo} for ${money(changing?.cheque.amount)} will count towards cash in hand from now on.`
            : `Cheque ${changing?.cheque.chequeNo} goes back to Pending and stops counting as cash.`)
          + (group.length > 1 ? ` This cheque is split across ${group.length} bills (${money(group.reduce((s, c) => s + (Number(c.amount) || 0), 0))} in total); all of them change together.` : '')}
        confirmLabel={changing?.newStatus === 'bounced' ? 'Mark bounced' : 'Confirm'}
        danger={changing?.newStatus === 'bounced'}
        onConfirm={apply}
        onCancel={() => setChanging(null)}
      />
      <Confirm
        open={!!deleting}
        danger
        title="Delete this cheque record?"
        confirmLabel="Delete cheque"
        message={deleting ? `Cheque ${deleting.chequeNo || '(no number)'}${deleting.bankName ? ` from ${deleting.bankName}` : ''} for ${money(deleting.amount)} will be removed permanently. The payment behind it stays and becomes an ordinary payment`
          + (deleting.status !== 'cleared' ? ', so the bill it belongs to will read as paid.' : '.') + ' This cannot be undone.' : ''}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
