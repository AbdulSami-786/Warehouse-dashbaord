import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ChevronRight, Lock, Pencil, Phone, Plus, Send, Users,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, norm, whatsappUrl } from '../lib/format.js';
import { billStates, isOpeningBill, partyDue, advanceAvailable } from '../lib/calc.js';
import { canOpen, isLocked } from '../lib/partyLock.js';
import {
  Button, Card, Confirm, Empty, Modal, PageHead, Pill, SearchBox,
} from '../components/ui.jsx';
import { PartyForm } from '../components/forms.jsx';
import ImportButton from '../components/ImportButton.jsx';

export default function Parties() {
  const { data, settings, mutate } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(null);
  const states = useMemo(() => billStates(data.bills, data), [data]);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.parties
      .filter((p) => (archived ? p.status === 'archived' : p.status !== 'archived'))
      .filter((p) => !s || norm(p.name).includes(s) || norm(p.phone).includes(s))
      .map((p) => ({
        ...p,
        due: partyDue(p.id, states),
        advance: advanceAvailable(p.id, data.partyAdvances),
        billCount: data.bills.filter((b) => b.partyId === p.id && b.status !== 'voided' && !isOpeningBill(b)).length,
        hidden: !canOpen(p),
      }))
      .sort((a, b) => (b.hidden ? 0 : b.due) - (a.hidden ? 0 : a.due) || a.name.localeCompare(b.name));
  }, [data, states, q, archived]);

  const toggle = async () => {
    const p = toggling;
    setToggling(null);
    await mutate(() => api.archiveParty(p.id), p.status === 'archived' ? 'Party restored' : 'Party archived');
  };
  const dash = <span className="muted">—</span>;

  return (
    <>
      <PageHead title="Parties" subtitle={`${rows.length} ${archived ? 'archived' : 'active'} ${rows.length === 1 ? 'party' : 'parties'}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search name or phone…" />
        <Button onClick={() => setArchived((v) => !v)}>{archived ? 'Show active' : 'Show archived'}</Button>
        <ImportButton kind="parties" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Party</Button>
      </PageHead>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Party</th><th>Phone</th><th className="r">Bills</th><th className="r">Credit limit</th><th className="r">Advance</th><th className="r">Outstanding</th><th style={{ width: 130 }} /></tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/party/${p.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {p.name}
                          {isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} aria-label="Password locked" />}
                        </div>
                        {p.address && <div className="small muted">{p.address}</div>}
                      </td>
                      <td>{p.phone || dash}</td>
                      <td className="r">{p.hidden ? dash : p.billCount}</td>
                      <td className="r">
                        {p.hidden ? dash : Number(p.creditLimit) > 0
                          ? <span className={p.due > p.creditLimit ? 'money neg' : 'num'}>{money(p.creditLimit)}</span> : dash}
                      </td>
                      <td className="r">{p.hidden ? dash : p.advance > 0 ? <span className="money pos">{money(p.advance)}</span> : dash}</td>
                      <td className="r strong">
                        {p.hidden ? <span className="muted small"><Lock size={12} style={{ verticalAlign: -1 }} /> Locked</span>
                          : p.due > 0 ? <span className="money neg">{money(p.due)}</span> : <Pill status="paid" label="Clear" />}
                      </td>
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
                <div key={p.id} className="mcard" onClick={() => navigate(`/party/${p.id}`)}>
                  <div className="top">
                    <span className="name">{p.name}{isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} />}</span>
                    <span className="amt" style={{ color: p.hidden ? 'var(--text-muted)' : p.due > 0 ? 'var(--danger)' : 'var(--success)' }}>
                      {p.hidden ? 'Locked' : p.due > 0 ? money(p.due) : 'Clear'}
                    </span>
                  </div>
                  <div className="meta">
                    {p.phone && <span><Phone size={12} style={{ verticalAlign: -2 }} /> {p.phone}</span>}
                    {!p.hidden && <span>{p.billCount} bill{p.billCount === 1 ? '' : 's'}</span>}
                    {!p.hidden && p.advance > 0 && <span style={{ color: 'var(--success)' }}>Advance {money(p.advance)}</span>}
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
            title={q ? 'No matching parties' : archived ? 'No archived parties' : 'No parties yet'}
            message={q ? `Nothing matches "${q}".` : 'Add your first party to start billing.'}
            action={!q && !archived ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first party</Button> : null}
          />
        )}
      </Card>
      <Modal open={adding} title="Add New Party" onClose={() => setAdding(false)}>
        <PartyForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Party'}`} onClose={() => setEditing(null)}>
        {editing && <PartyForm party={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
      <Confirm
        open={!!toggling}
        title={toggling?.status === 'archived' ? 'Restore party?' : 'Archive party?'}
        message={toggling?.status === 'archived'
          ? `"${toggling?.name}" will appear in billing dropdowns again.`
          : `"${toggling?.name}" will be hidden from billing dropdowns. All their bills and history stay intact — nothing is deleted.`}
        confirmLabel={toggling?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={toggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}
