import { useMemo, useState } from 'react';
import { Building2, Download, Plus, Save } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, today, fmtDate, norm } from '../lib/format.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Empty, Field, Input, Modal, Money, PageHead, SearchBox, Stat, Textarea,
} from '../components/ui.jsx';
import ImportButton from '../components/ImportButton.jsx';

const blank = () => ({ name: '', value: '', date: today(), note: '' });

function AssetModal({ open, onClose }) {
  const { mutate } = useApp();
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ok = f.name.trim() && Number(f.value) > 0;
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.saveAsset({ name: f.name.trim(), value: Number(f.value), date: f.date, note: f.note }), 'Asset added');
      setF(blank());
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} title="Add Asset" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!ok}>Add Asset</Button></>}>
      <Field label="Asset name"><Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Delivery Van (Suzuki Bolan)" /></Field>
      <div className="form-grid">
        <Field label="Value"><Input type="number" min="0" step="any" value={f.value} onChange={set('value')} placeholder="0" /></Field>
        <Field label="Date acquired"><Input type="date" value={f.date} onChange={set('date')} /></Field>
      </div>
      <Field label="Note"><Textarea value={f.note} onChange={set('note')} rows={2} placeholder="Optional details" /></Field>
    </Modal>
  );
}

export default function Assets() {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.assets.filter((a) => !s || norm(a.name).includes(s) || norm(a.note).includes(s)).sort((a, b) => Number(b.value) - Number(a.value));
  }, [data.assets, q]);
  const total = useMemo(() => r2(rows.reduce((s, a) => s + (Number(a.value) || 0), 0)), [rows]);
  const toExcel = () => {
    exportCSV('Assets', ['Asset', 'Value', 'Date Acquired', 'Note'], rows.map((a) => [a.name, Number(a.value).toFixed(2), fmtDate(a.date), a.note || '']),
      [`${settings.shopName} — Assets`, `Total asset value: ${money(total)}`]);
    toast('Assets exported');
  };
  return (
    <>
      <PageHead title="Assets" subtitle={`${rows.length} assets worth ${money(total)}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search assets…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="assets" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Asset</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Total Asset Value" value={money(total)} icon={Building2} tone="#1F2937" />
        <Stat label="Assets Recorded" value={rows.length} icon={Building2} tone="#16A34A" />
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Asset</th><th>Date acquired</th><th>Note</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600 }}>{a.name}</td>
                      <td className="nowrap">{fmtDate(a.date)}</td>
                      <td className="small muted">{a.note || '—'}</td>
                      <td className="r strong"><Money value={a.value} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3}>{rows.length} assets</td><td className="r">{money(total)}</td></tr></tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((a) => (
                <div key={a.id} className="mcard">
                  <div className="top"><span className="name">{a.name}</span><span className="amt">{money(a.value)}</span></div>
                  <div className="meta"><span>Acquired {fmtDate(a.date)}</span>{a.note && <span>{a.note}</span>}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={Building2}
            title={q ? 'No matching assets' : 'No assets recorded'}
            message={q ? `Nothing matches "${q}".` : 'Record vehicles, equipment, fixtures and other business assets. They appear on the Balance Sheet.'}
            action={q ? null : <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first asset</Button>}
          />
        )}
      </Card>
      <AssetModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
