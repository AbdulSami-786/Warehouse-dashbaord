import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Plus, RotateCcw, Search } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate, norm } from '../lib/format.js';
import { billStates, isOpeningBill } from '../lib/calc.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Empty, Modal, Money, PageHead, Pill, SearchBox, Stat,
} from '../components/ui.jsx';
import { ReturnModal } from '../components/forms.jsx';

function PickBill({ open, onClose, onPick }) {
  const { data } = useApp();
  const [q, setQ] = useState('');
  const bills = useMemo(() => {
    const s = norm(q);
    return billStates(data.bills, data).filter((b) => b.status !== 'voided' && !isOpeningBill(b))
      .map((b) => ({ ...b, partyName: data.parties.find((p) => p.id === b.partyId)?.name || '' }))
      .filter((b) => !s || norm(b.billNo).includes(s) || norm(b.partyName).includes(s))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 40);
  }, [data, q]);
  return (
    <Modal open={open} title="Which bill is the return against?" onClose={onClose}>
      <SearchBox value={q} onChange={setQ} placeholder="Search bill number or party…" style={{ marginBottom: 12 }} />
      {bills.length ? (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {bills.map((b) => (
            <div key={b.id} className="typeahead-opt" onClick={() => onPick(b)} style={{ borderBottom: '1px solid #F1F3F5', borderRadius: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{b.billNo} — {b.partyName}</div>
                <div className="sub">{fmtDate(b.date)} · {money(b.net)}</div>
              </div>
              <div className="spacer" />
              <Pill status={b.status} />
            </div>
          ))}
        </div>
      ) : <Empty icon={Search} title="No bills found" message={`Nothing matches "${q}".`} />}
    </Modal>
  );
}

export default function Returns() {
  const { data, settings, toast } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState(false);
  const [bill, setBill] = useState(null);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.returns.map((r) => {
      const b = data.bills.find((x) => x.id === r.billId);
      const party = b ? data.parties.find((p) => p.id === b.partyId) : null;
      const item = data.items.find((i) => i.id === r.itemId);
      return { ...r, bill: b, party, itemName: item?.name || 'Item', unit: item?.baseUnit || '' };
    })
      .filter((r) => !s || norm(r.party?.name).includes(s) || norm(r.itemName).includes(s) || norm(r.bill?.billNo).includes(s))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data, q]);
  const totals = useMemo(() => ({
    count: rows.length,
    value: r2(rows.reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0)),
    restocked: rows.filter((r) => r.restock).length,
  }), [rows]);
  const toExcel = () => {
    exportCSV('Returns', ['Date', 'Bill No', 'Party', 'Item', 'Qty', 'Restocked', 'Value', 'Note'],
      rows.map((r) => [fmtDate(r.date), r.bill?.billNo || '', r.party?.name || '', r.itemName, r.qty, r.restock ? 'Yes' : 'No', Number(r.valueAdjusted).toFixed(2), r.note || '']),
      [`${settings.shopName} — Returns`, `Total value: ${money(totals.value)}`]);
    toast('Returns exported');
  };
  return (
    <>
      <PageHead title="Returns" subtitle={`${totals.count} returns · ${money(totals.value)} adjusted`}>
        <SearchBox value={q} onChange={setQ} placeholder="Party, item, or bill no…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setPicking(true)}>Add Return</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Total Returns" value={totals.count} icon={RotateCcw} tone="#F59E0B" />
        <Stat label="Value Adjusted" value={money(totals.value)} icon={RotateCcw} tone="#DC2626" />
        <Stat label="Restocked" value={`${totals.restocked} of ${totals.count}`} icon={RotateCcw} tone="#16A34A" />
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Bill</th><th>Party</th><th>Item</th><th className="r">Qty</th><th>Restocked</th><th>Note</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => r.bill && navigate(`/bill/${r.bill.id}`)}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      <td style={{ fontWeight: 600 }}>{r.bill?.billNo || '—'}</td>
                      <td>{r.party?.name || '—'}</td>
                      <td>{r.itemName}</td>
                      <td className="r">{r.qty} {r.unit}</td>
                      <td>{r.restock ? <Pill status="paid" label="Yes" /> : <Pill status="voided" label="No" />}</td>
                      <td className="small muted">{r.note || '—'}</td>
                      <td className="r strong"><Money value={r.valueAdjusted} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={7}>{totals.count} returns</td><td className="r">{money(totals.value)}</td></tr></tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((r) => (
                <div key={r.id} className="mcard" onClick={() => r.bill && navigate(`/bill/${r.bill.id}`)}>
                  <div className="top"><span className="name">{r.itemName}</span><span className="amt">{money(r.valueAdjusted)}</span></div>
                  <div className="meta"><span>{r.party?.name}</span><span>{r.bill?.billNo}</span><span>{r.qty} {r.unit}</span><span>{fmtDate(r.date)}</span></div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={RotateCcw}
            title={q ? 'No matching returns' : 'No returns yet'}
            message={q ? `Nothing matches "${q}".` : 'Returns recorded against a bill will appear here.'}
            action={q ? null : <Button variant="primary" icon={Plus} onClick={() => setPicking(true)}>Record a return</Button>}
          />
        )}
      </Card>
      <PickBill open={picking} onClose={() => setPicking(false)} onPick={(b) => { setPicking(false); setBill(b); }} />
      <ReturnModal open={!!bill} onClose={() => setBill(null)} bill={bill} party={bill ? data.parties.find((p) => p.id === bill.partyId) : null} />
    </>
  );
}
