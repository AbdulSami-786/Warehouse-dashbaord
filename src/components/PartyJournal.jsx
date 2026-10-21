import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Copy, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { fmtDate, norm, today } from '../lib/format.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, SearchBox, Textarea,
} from './ui.jsx';

/** An entry's fields as a list, whether it came from the Sheet (text) or the local copy. */
export function journalFields(entry) {
  let list = entry?.fields;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  return Array.isArray(list) ? list : [];
}

const blankField = () => ({ label: '', value: '' });

/** Add or edit one journal entry. Every field name and value is typed by the user. */
function JournalForm({ kind, party, entry = null, last = null, labels, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [date, setDate] = useState(entry?.date || today());
  const [title, setTitle] = useState(entry?.title || '');
  const [rows, setRows] = useState(() => {
    const own = journalFields(entry).map((f) => ({ ...f }));
    return own.length ? own : [blankField()];
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setRow = (i, k) => (e) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, [k]: e.target.value } : r)));
  const addRow = () => setRows((rs) => [...rs, blankField()]);
  const dropRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, n) => n !== i) : [blankField()]));
  const lastLabels = journalFields(last).map((f) => f.label).filter(Boolean);
  const copyLast = () => setRows(lastLabels.map((label) => ({ label, value: '' })));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const fields = rows
      .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
      .filter((r) => r.label || r.value);
    if (!title.trim() && !fields.length) return setErr('Write a title or fill in at least one field');
    setErr('');
    setBusy(true);
    try {
      await mutate(() => api.saveJournal({ id: entry?.id, kind, partyId: party.id, date, title: title.trim(), fields }),
        entry ? 'Journal entry updated' : 'Journal entry added');
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
        <span className="small muted" style={{ marginLeft: 8 }}>Name each field yourself</span>
        <span className="spacer" />
        {!entry && lastLabels.length > 0 && (
          <Button type="button" size="sm" icon={Copy} onClick={copyLast} title="Use the same field names as the last entry">Same as last</Button>
        )}
      </div>

      <datalist id="wh-journal-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist>
      <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: '0 0 34%' }}>
              <Input list="wh-journal-labels" value={r.label} onChange={setRow(i, 'label')} placeholder="Field name" aria-label={`Field ${i + 1} name`} />
            </div>
            <div style={{ flex: 1 }}>
              <Textarea value={r.value} onChange={setRow(i, 'value')} rows={1} placeholder="Value" aria-label={`Field ${i + 1} value`} />
            </div>
            <button type="button" className="btn btn-ghost btn-sm" title="Remove this field" onClick={() => dropRow(i)}><X size={14} /></button>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" icon={Plus} onClick={addRow}>Add field</Button>

      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{entry ? 'Update Entry' : 'Save Entry'}</Button>
      </div>
    </form>
  );
}

/**
 * A free-form diary for one party, supplier or warehouse party (`kind`: party, supplier, whParty). Entries are notes only: they never
 * touch stock, payments or the khata balance.
 */
export default function PartyJournal({ kind, party }) {
  const { data, mutate } = useApp();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // 'new' or an entry
  const [deleting, setDeleting] = useState(null);

  const all = data.journal || [];
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

  useEffect(() => { setEditing(null); setDeleting(null); }, [party.id]);

  return (
    <>
      <Card
        title="Journal"
        tight
        subtitle={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · your own notes — they never change stock, payments or the balance`}
        actions={(
          <>
            {entries.length > 3 && <SearchBox value={q} onChange={setQ} placeholder="Search journal…" />}
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add Entry</Button>
          </>
        )}
      >
        {shown.length ? (
          <div style={{ display: 'grid' }}>
            {shown.map((e) => {
              const fields = journalFields(e);
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
                    <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'minmax(80px, max-content) 1fr', gap: '4px 14px', fontSize: 13 }}>
                      {fields.map((f, i) => (
                        <div key={i} style={{ display: 'contents' }}>
                          <dt className="muted" style={{ fontWeight: 600 }}>{f.label || '—'}</dt>
                          <dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{f.value || <span className="muted">—</span>}</dd>
                        </div>
                      ))}
                    </dl>
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

      <Modal open={!!editing} title={editing && editing !== 'new' ? 'Edit Journal Entry' : 'New Journal Entry'} onClose={() => setEditing(null)}>
        {editing && (
          <JournalForm
            kind={kind}
            party={party}
            entry={editing === 'new' ? null : editing}
            last={entries[0] || null}
            labels={labels}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
      <Confirm
        open={!!deleting}
        danger
        title="Delete this entry?"
        confirmLabel="Delete entry"
        message="This journal entry will be removed. It has no effect on stock, payments or the balance."
        onCancel={() => setDeleting(null)}
        onConfirm={async () => { const d = deleting; setDeleting(null); await mutate(() => api.deleteJournal(d.id), 'Journal entry deleted').catch(() => {}); }}
      />
    </>
  );
}
