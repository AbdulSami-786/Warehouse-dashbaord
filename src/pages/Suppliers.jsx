import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ChevronRight, Pencil, Phone, Plus, ShoppingCart, Truck, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, norm } from '../lib/format.js';
import { supplierBalance } from '../lib/calc.js';
import {
  Button, Card, Confirm, Empty, Modal, PageHead, Pill, SearchBox, Stat,
} from '../components/ui.jsx';
import { PurchaseBillModal, SupplierForm } from '../components/supplierForms.jsx';
import ImportButton from '../components/ImportButton.jsx';

export default function Suppliers() {
  const { data, mutate } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [buying, setBuying] = useState(false);
  const [toggling, setToggling] = useState(null);
  const all = useMemo(() => data.suppliers.map((s) => ({
    ...s, balance: supplierBalance(s.id, data),
    purchaseCount: data.purchaseBills.filter((b) => b.supplierId === s.id && b.status !== 'voided').length,
  })), [data]);
  const rows = useMemo(() => {
    const s = norm(q);
    return all.filter((x) => (archived ? x.status === 'archived' : x.status !== 'archived'))
      .filter((x) => !s || norm(x.name).includes(s) || norm(x.phone).includes(s))
      .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  }, [all, q, archived]);
  const totals = useMemo(() => ({
    payable: r2(all.reduce((t, s) => t + Math.max(0, s.balance), 0)),
    advance: r2(all.reduce((t, s) => t + Math.max(0, -s.balance), 0)),
  }), [all]);
  const toggle = async () => {
    const s = toggling;
    setToggling(null);
    await mutate(() => api.archiveSupplier(s.id), s.status === 'archived' ? 'Supplier restored' : 'Supplier archived');
  };
  const balance = (b) => (b > 0.004 ? <span className="money neg">{money(b)}</span>
    : b < -0.004 ? <span className="money pos">{money(-b)} advance</span> : <Pill status="paid" label="Clear" />);
  return (
    <>
      <PageHead title="Suppliers" subtitle={`${rows.length} ${archived ? 'archived' : 'active'} supplier${rows.length === 1 ? '' : 's'} — parties you buy from`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search name or phone…" />
        <Button onClick={() => setArchived((v) => !v)}>{archived ? 'Show active' : 'Show archived'}</Button>
        <Button icon={ShoppingCart} onClick={() => setBuying(true)}>New Purchase</Button>
        <ImportButton kind="suppliers" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Supplier</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="You owe suppliers" value={money(totals.payable)} icon={Wallet} tone="#DC2626" />
        <Stat label="Advances with suppliers" value={money(totals.advance)} icon={Wallet} tone="#16A34A" />
        <Stat label="Suppliers" value={all.filter((s) => s.status !== 'archived').length} icon={Truck} tone="#1F2937" />
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Supplier</th><th>Phone</th><th className="r">Purchases</th><th className="r">Balance</th><th style={{ width: 100 }} /></tr></thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => navigate(`/supplier/${s.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        {s.address && <div className="small muted">{s.address}</div>}
                      </td>
                      <td>{s.phone || <span className="muted">—</span>}</td>
                      <td className="r">{s.purchaseCount}</td>
                      <td className="r strong">{balance(s.balance)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(s)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title={s.status === 'archived' ? 'Restore' : 'Archive'} onClick={() => setToggling(s)}>
                            {s.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((s) => (
                <div key={s.id} className="mcard" onClick={() => navigate(`/supplier/${s.id}`)}>
                  <div className="top">
                    <span className="name">{s.name}</span>
                    <span className="amt" style={{ color: s.balance > 0.004 ? 'var(--danger)' : 'var(--success)' }}>
                      {s.balance > 0.004 ? money(s.balance) : s.balance < -0.004 ? `${money(-s.balance)} adv` : 'Clear'}
                    </span>
                  </div>
                  <div className="meta">
                    {s.phone && <span><Phone size={12} style={{ verticalAlign: -2 }} /> {s.phone}</span>}
                    <span>{s.purchaseCount} purchase{s.purchaseCount === 1 ? '' : 's'}</span>
                    <span className="spacer" />
                    <ChevronRight size={15} className="muted" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={Truck}
            title={q ? 'No matching suppliers' : archived ? 'No archived suppliers' : 'No suppliers yet'}
            message={q ? `Nothing matches "${q}".` : 'Add the parties you buy stock from to keep their khata.'}
            action={!q && !archived ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first supplier</Button> : null}
          />
        )}
      </Card>
      <Modal open={adding} title="Add New Supplier" onClose={() => setAdding(false)}>
        <SupplierForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Supplier'}`} onClose={() => setEditing(null)}>
        {editing && <SupplierForm supplier={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
      <PurchaseBillModal open={buying} onClose={() => setBuying(false)} />
      <Confirm
        open={!!toggling}
        title={toggling?.status === 'archived' ? 'Restore supplier?' : 'Archive supplier?'}
        message={toggling?.status === 'archived'
          ? `"${toggling?.name}" will appear in purchase dropdowns again.`
          : `"${toggling?.name}" will be hidden from purchase dropdowns. Their khata stays intact — nothing is deleted.`}
        confirmLabel={toggling?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={toggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}
