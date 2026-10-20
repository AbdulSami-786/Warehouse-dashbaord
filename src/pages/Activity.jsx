import { useMemo, useState } from 'react';
import {
  Ban, Download, Pencil, Plus, ScrollText, Trash2, Undo2,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { fmtDateTime, norm, rangeFor, inRange } from '../lib/format.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';

const ACTIONS = {
  create: { label: 'Created', icon: Plus, status: 'paid' },
  edit: { label: 'Edited', icon: Pencil, status: 'partial' },
  void: { label: 'Voided', icon: Ban, status: 'due' },
  reverse: { label: 'Reversed', icon: Undo2, status: 'due' },
  delete: { label: 'Deleted', icon: Trash2, status: 'bounced' },
};

/** The audit trail. `scope` narrows it to the warehouse side or the shop side. */
export default function Activity({ scope = 'shop' }) {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('all');
  const [entity, setEntity] = useState('all');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  // Warehouse records log as 'warehouse', 'warehouse party', 'warehouse payment'…
  const isWh = (e) => String(e.entityType || '').startsWith('warehouse');
  const inScope = (e) => (scope === 'warehouse' ? isWh(e) : !isWh(e));
  const entities = useMemo(() => [...new Set(data.activityLog.filter(inScope).map((e) => e.entityType))].sort(), [data.activityLog, scope]);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.activityLog
      .filter(inScope)
      .filter((e) => inRange(String(e.timestamp).slice(0, 10), range.from, range.to))
      .filter((e) => action === 'all' || e.action === action)
      .filter((e) => entity === 'all' || e.entityType === entity)
      .filter((e) => !s || norm(e.description).includes(s) || norm(e.entityType).includes(s))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }, [data.activityLog, q, action, entity, range, scope]);
  const counts = useMemo(() => ({
    edits: rows.filter((e) => e.action === 'edit').length,
    voids: rows.filter((e) => e.action === 'void').length,
    reversals: rows.filter((e) => e.action === 'reverse').length,
  }), [rows]);
  const toExcel = () => {
    exportCSV(scope === 'warehouse' ? 'WarehouseActivityLog' : 'ActivityLog', ['Timestamp', 'Action', 'Entity', 'Description', 'User'],
      rows.map((e) => [fmtDateTime(e.timestamp), e.action, e.entityType, e.description, e.user]),
      [`${settings.shopName} — ${scope === 'warehouse' ? 'Warehouse ' : ''}Activity Log`, `${rows.length} entries`]);
    toast('Activity log exported');
  };
  return (
    <>
      <PageHead title={scope === 'warehouse' ? 'Warehouse Activity' : 'Activity Log'} subtitle="Every edit, void and reversal is recorded here — nothing is silently changed">
        <SearchBox value={q} onChange={setQ} placeholder="Search descriptions…" />
        <Select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ width: 130 }}
          options={[{ value: 'all', label: 'All actions' }, { value: 'create', label: 'Created' }, { value: 'edit', label: 'Edited' }, { value: 'void', label: 'Voided' }, { value: 'reverse', label: 'Reversed' }, { value: 'delete', label: 'Deleted' }]}
        />
        {scope !== 'warehouse' && (
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} style={{ width: 130 }}>
            <option value="all">All records</option>
            {entities.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        )}
        <Button icon={Download} onClick={toExcel}>Excel</Button>
      </PageHead>
      <div className="mb-2"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
      <div className="stat-grid">
        <Stat label="Entries" value={rows.length} icon={ScrollText} tone="#1F2937" />
        <Stat label="Edits" value={counts.edits} icon={Pencil} tone="#F59E0B" />
        <Stat label={scope === 'warehouse' ? 'Cancelled' : 'Voids'} value={counts.voids} icon={Ban} tone="#DC2626" />
        {scope !== 'warehouse' && <Stat label="Payment Reversals" value={counts.reversals} icon={Undo2} tone="#DC2626" />}
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th style={{ width: 170 }}>When</th><th style={{ width: 110 }}>Action</th><th style={{ width: 110 }}>Record</th><th>Description</th><th style={{ width: 90 }}>By</th></tr></thead>
                <tbody>
                  {rows.map((e) => {
                    const a = ACTIONS[e.action] || { label: e.action, status: 'neutral' };
                    return (
                      <tr key={e.id}>
                        <td className="nowrap small">{fmtDateTime(e.timestamp)}</td>
                        <td><Pill status={a.status} label={a.label} /></td>
                        <td className="small muted" style={{ textTransform: 'capitalize' }}>{e.entityType}</td>
                        <td>{e.description}</td>
                        <td className="small muted">{e.user}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((e) => {
                const a = ACTIONS[e.action] || { label: e.action, status: 'neutral' };
                return (
                  <div key={e.id} className="mcard">
                    <div className="top"><span className="name" style={{ fontSize: 14 }}>{e.description}</span></div>
                    <div className="meta"><Pill status={a.status} label={a.label} /><span style={{ textTransform: 'capitalize' }}>{e.entityType}</span><span>{fmtDateTime(e.timestamp)}</span></div>
                  </div>
                );
              })}
            </div>
          </>
        ) : <Empty icon={ScrollText} title="No activity in this period" message="Edits, voids and reversals will be recorded here as they happen." />}
      </Card>
    </>
  );
}
