import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, BookOpen, Copy, HandCoins, Pencil, Plus, Save, Trash2, X,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { fmtDate, money, norm, r2, today } from '../lib/format.js';
import { journalClaims, journalFieldList, journalOwed } from '../lib/calc.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, SearchBox, Select, Textarea,
} from './ui.jsx';

/** An entry's fields as a list, whether it came from the Sheet (text) or the local copy. */
export const journalFields = journalFieldList;

const blankField = () => ({ label: '', value: '', payment: '' });

/** Take means the party pays us, give means we pay the party. */
const DIRECTIONS = {
  take: { label: 'I will take', note: 'The party will pay me', icon: ArrowDownToLine, doneWord: 'Collected', verb: 'Collect' },
  give: { label: 'I will give', note: 'I will pay the party', icon: ArrowUpFromLine, doneWord: 'Paid', verb: 'Pay' },
};

/** Add or edit one journal entry. Every field name, value and payment is typed by the user. */
function JournalForm({ kind, party, entry = null, last = null, labels, canMoney, settled = 0, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [date, setDate] = useState(entry?.date || today());
  const [title, setTitle] = useState(entry?.title || '');
  const [rows, setRows] = useState(() => {
    const own = journalFields(entry).map((f) => ({ label: f.label || '', value: f.value || '', payment: f.payment ? String(f.payment) : '' }));
    return own.length ? own : [blankField()];
  });
  const [direction, setDirection] = useState(entry?.direction === 'give' ? 'give' : 'take');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setRow = (i, k) => (e) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, [k]: e.target.value } : r)));
  const addRow = () => setRows((rs) => [...rs, blankField()]);
  const dropRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, n) => n !== i) : [blankField()]));
  const lastLabels = journalFields(last).map((f) => f.label).filter(Boolean);
  const copyLast = () => setRows(lastLabels.map((label) => ({ label, value: '', payment: '' })));
  const total = r2(rows.reduce((s, r) => s + (Number(r.payment) > 0 ? Number(r.payment) : 0), 0));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const fields = rows
      .map((r) => ({ label: r.label.trim(), value: r.value.trim(), payment: canMoney && Number(r.payment) > 0 ? r2(r.payment) : '' }))
      .filter((r) => r.label || r.value || r.payment);
    if (!title.trim() && !fields.length) return setErr('Write a title or fill in at least one field');
    if (total > 0 && total < settled - 0.004) return setErr(`${money(settled)} has already been ${DIRECTIONS[direction].doneWord.toLowerCase()} on this entry, so the total cannot go below that.`);
    setErr('');
    setBusy(true);
    try {
      await mutate(() => api.saveJournal({
        id: entry?.id, kind, partyId: party.id, date, title: title.trim(), fields, direction: total > 0 ? direction : '',
      }), entry ? 'Journal entry updated' : 'Journal entry added');
      onSaved?.();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Title" hint="Optional — a short heading for this entry">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sample received, Visit, Complaint…" autoFocus />
        </Field>
      </div>

      <div className="row" style={{ alignItems: 'center', margin: '4px 0 8px' }}>
        <strong style={{ fontSize: 13 }}>Fields</strong>
        <span className="small muted" style={{ marginLeft: 8 }}>Name each field yourself{canMoney ? ' — add a payment where money is involved' : ''}</span>
        <span className="spacer" />
        {!entry && lastLabels.length > 0 && (
          <Button type="button" size="sm" icon={Copy} onClick={copyLast} title="Use the same field names as the last entry">Same as last</Button>
        )}
      </div>

      <datalist id="wh-journal-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist>
      <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: '0 0 30%' }}>
              <Input list="wh-journal-labels" value={r.label} onChange={setRow(i, 'label')} placeholder="Field name" aria-label={`Field ${i + 1} name`} />
            </div>
            <div style={{ flex: 1 }}>
              <Textarea value={r.value} onChange={setRow(i, 'value')} rows={1} placeholder="Value" aria-label={`Field ${i + 1} value`} />
            </div>
            {canMoney && (
              <div style={{ flex: '0 0 22%', minWidth: 90 }}>
                <Input type="number" min="0" step="any" value={r.payment} onChange={setRow(i, 'payment')} placeholder="Payment" aria-label={`Field ${i + 1} payment`} />
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" title="Remove this field" onClick={() => dropRow(i)}><X size={14} /></button>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" icon={Plus} onClick={addRow}>Add field</Button>

      {canMoney && total > 0 && (
        <div style={{ marginTop: 14, padding: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Total payment</strong>
            <span className="spacer" />
            <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
          </div>
          <div className="seg" style={{ width: '100%' }}>
            {Object.entries(DIRECTIONS).map(([key, d]) => (
              <button
                type="button"
                key={key}
                style={{ flex: 1 }}
                className={direction === key ? 'active' : ''}
                disabled={settled > 0 && entry?.direction !== key}
                onClick={() => setDirection(key)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {DIRECTIONS[direction].note}. This amount is added to {party.name}&rsquo;s ledger balance
            {direction === 'take' ? ' as money they owe you' : ' as money you owe them'}; it reduces when you {DIRECTIONS[direction].verb.toLowerCase()} it
            {settled > 0 ? ` (${money(settled)} already ${DIRECTIONS[direction].doneWord.toLowerCase()})` : ''}.
          </div>
        </div>
      )}

      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{entry ? 'Update Entry' : 'Save Entry'}</Button>
      </div>
    </form>
  );
}

/** Collect from, or pay, the party against one journal entry. */
function SettleModal({ claim, party, onClose }) {
  const { methods, mutate } = useApp();
  const [f, setF] = useState({ amount: '', method: 'Cash', date: today(), note: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (claim) setF({ amount: String(claim.outstanding), method: 'Cash', date: today(), note: '' });
  }, [claim?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!claim) return null;
  const d = DIRECTIONS[claim.direction];
  const amt = Number(f.amount) || 0;
  const over = amt > claim.outstanding + 0.004;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (busy || !(amt > 0) || over) return;
    setBusy(true);
    try {
      await mutate(() => api.addJournalPayment({
        journalId: claim.id, amount: amt, method: f.method, date: f.date, note: f.note,
      }), claim.direction === 'take' ? `${money(amt)} collected from ${party.name}` : `${money(amt)} paid to ${party.name}`);
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${d.verb} — ${party.name}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} loading={busy} disabled={!(amt > 0) || over} onClick={save}>{d.verb} {amt > 0 ? money(amt) : ''}</Button></>}
    >
      <div style={{ padding: 12, marginBottom: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
        <span>{claim.title || 'Journal entry'} — still to {claim.direction === 'take' ? 'collect' : 'pay'}</span>
        <span className="spacer" />
        <span className="money" style={{ fontSize: 16 }}>{money(claim.outstanding)}</span>
      </div>
      <div className="form-grid">
        <Field label="Amount" hint={over ? `Only ${money(claim.outstanding)} is left` : amt > 0 ? `Left after this: ${money(r2(claim.outstanding - amt))}` : undefined}>
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} autoFocus />
        </Field>
        <Field label={claim.direction === 'take' ? 'Received in' : 'Paid from'}>
          <Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} />
        </Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="Optional" /></Field>
      </div>
    </Modal>
  );
}

/**
 * A free-form diary for one party, supplier or warehouse party (`kind`: party,
 * supplier, whParty). An entry is notes; give a row a payment and the entry's
 * total also joins that ledger's balance, as money to take or to give.
 */
export default function PartyJournal({ kind, party }) {
  const { data, mutate, access } = useApp();
  const canMoney = kind === 'party' || access.seesCost;
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // 'new' or an entry
  const [deleting, setDeleting] = useState(null);
  const [settling, setSettling] = useState(null); // a claim from journalClaims()
  const [delPay, setDelPay] = useState(null);

  const all = data.journal || [];
  const claims = useMemo(() => new Map(journalClaims(kind, party.id, data).map((c) => [c.id, c])), [kind, party.id, data]);
  const owed = useMemo(() => journalOwed(kind, party.id, data), [kind, party.id, data]);
  const entries = useMemo(() => all
    .filter((e) => e.kind === kind && e.partyId === party.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt))), [all, kind, party.id]);
  const shown = useMemo(() => {
    const s = norm(q);
    if (!s) return entries;
    return entries.filter((e) => norm([e.title, ...journalFields(e).flatMap((f) => [f.label, f.value])].join(' ')).includes(s));
  }, [entries, q]);
  // Every field name used on any ledger, offered as a suggestion while typing a new one.
  const labels = useMemo(() => [...new Set(all.flatMap((e) => journalFields(e).map((f) => f.label)).filter(Boolean))].sort(), [all]);

  useEffect(() => { setEditing(null); setDeleting(null); setSettling(null); setDelPay(null); }, [party.id]);

  const editingEntry = editing && editing !== 'new' ? editing : null;
  const hasMoney = claims.size > 0;

  return (
    <>
      <Card
        title="Journal"
        tight
        subtitle={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · your own notes${canMoney ? ' — a payment on an entry also counts in the ledger balance' : ''}`}
        actions={(
          <>
            {entries.length > 3 && <SearchBox value={q} onChange={setQ} placeholder="Search journal…" />}
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add Entry</Button>
          </>
        )}
      >
        {canMoney && hasMoney && (
          <div className="row" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', gap: 8, alignItems: 'center' }}>
            <span className="small muted">Journal balance</span>
            <span className="spacer" />
            <span className="money" style={{ color: owed > 0.004 ? 'var(--danger)' : owed < -0.004 ? '#B45309' : 'var(--success)' }}>
              {Math.abs(owed) < 0.005 ? 'Settled' : `${money(Math.abs(owed))} — ${owed > 0 ? 'to take' : 'to give'}`}
            </span>
          </div>
        )}
        {shown.length ? (
          <div style={{ display: 'grid' }}>
            {shown.map((e) => {
              const fields = journalFields(e);
              const claim = claims.get(e.id);
              const d = claim ? DIRECTIONS[claim.direction] : null;
              return (
                <div key={e.id} style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                  <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                    <span className="small muted nowrap">{e.date ? fmtDate(e.date) : '—'}</span>
                    {e.title && <strong>{e.title}</strong>}
                    <span className="spacer" />
                    <button className="btn btn-ghost btn-sm" title="Edit entry" onClick={() => setEditing(e)}><Pencil size={14} /></button>
                    <button className="btn btn-ghost btn-sm" title="Delete entry" onClick={() => setDeleting(e)}><Trash2 size={14} /></button>
                  </div>
                  {fields.length > 0 && (
                    <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'minmax(80px, max-content) 1fr auto', gap: '4px 14px', fontSize: 13 }}>
                      {fields.map((f, i) => (
                        <div key={i} style={{ display: 'contents' }}>
                          <dt className="muted" style={{ fontWeight: 600 }}>{f.label || '—'}</dt>
                          <dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{f.value || <span className="muted">—</span>}</dd>
                          <dd style={{ margin: 0, textAlign: 'right' }}>{f.payment && canMoney ? <span className="money">{money(f.payment)}</span> : null}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {claim && canMoney && (
                    <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                      <div className="row wrap" style={{ alignItems: 'center', gap: 10 }}>
                        <d.icon size={15} />
                        <strong>{d.label} {money(claim.amount)}</strong>
                        <span className="small muted">
                          {claim.settled > 0 ? `${d.doneWord} ${money(claim.settled)} · ` : ''}
                          {claim.outstanding > 0.004 ? `${money(claim.outstanding)} left` : 'Fully settled'}
                        </span>
                        <span className="spacer" />
                        {claim.outstanding > 0.004 && (
                          <Button size="sm" variant="primary" icon={HandCoins} onClick={() => setSettling(claim)}>{d.verb}</Button>
                        )}
                      </div>
                      {claim.pays.length > 0 && (
                        <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                          {claim.pays.map((p) => (
                            <div key={p.id} className="row small" style={{ alignItems: 'center', gap: 8 }}>
                              <span className="muted nowrap">{fmtDate(p.date)}</span>
                              <span>{d.doneWord} {money(p.amount)}</span>
                              <span className="muted">{[p.method, p.note].filter(Boolean).join(' · ')}</span>
                              <span className="spacer" />
                              <button className="btn btn-ghost btn-sm" title="Delete this payment" onClick={() => setDelPay(p)}><Trash2 size={13} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={BookOpen}
            title={q ? 'No matching entries' : 'No journal entries yet'}
            message={q ? 'Try a different search.' : `Keep notes about ${party.name} — add any fields you like and change them whenever you need.`}
            action={!q ? <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add first entry</Button> : null}
          />
        )}
      </Card>

      <Modal open={!!editing} title={editingEntry ? 'Edit Journal Entry' : 'New Journal Entry'} onClose={() => setEditing(null)}>
        {editing && (
          <JournalForm
            kind={kind}
            party={party}
            entry={editingEntry}
            last={entries[0] || null}
            labels={labels}
            canMoney={canMoney}
            settled={editingEntry ? claims.get(editingEntry.id)?.settled || 0 : 0}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
      {settling && <SettleModal claim={settling} party={party} onClose={() => setSettling(null)} />}
      <Confirm
        open={!!deleting}
        danger
        title="Delete this entry?"
        confirmLabel="Delete entry"
        message={deleting && claims.get(deleting.id)?.pays.length
          ? 'Money has been recorded on this entry. Delete its payments first, then the entry can be deleted.'
          : 'This journal entry will be removed. If it had a payment, that amount leaves the ledger balance.'}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => { const d = deleting; setDeleting(null); await mutate(() => api.deleteJournal(d.id), 'Journal entry deleted').catch(() => {}); }}
      />
      <Confirm
        open={!!delPay}
        danger
        title="Delete this payment?"
        confirmLabel="Delete payment"
        message={delPay ? `The ${money(delPay.amount)} on ${fmtDate(delPay.date)} will be removed, so that amount is owed again and it leaves the ${delPay.method || 'Cash'} account.` : ''}
        onCancel={() => setDelPay(null)}
        onConfirm={async () => { const d = delPay; setDelPay(null); await mutate(() => api.deleteJournalPayment(d.id), 'Payment deleted').catch(() => {}); }}
      />
    </>
  );
}
