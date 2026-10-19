import { useMemo, useState } from 'react';
import { BookOpen, Download, Printer } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate, rangeFor } from '../lib/format.js';
import { ledgerBook } from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Field, Money, PageHead, Stat, Typeahead,
} from '../components/ui.jsx';

export default function LedgerBook() {
  const { data, settings, activeParties, toast } = useApp();
  const [partyId, setPartyId] = useState('');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const rows = useMemo(() => ledgerBook(data, partyId || null, range.from, range.to), [data, partyId, range]);
  const totals = useMemo(() => ({
    debit: r2(rows.reduce((s, r) => s + r.debit, 0)),
    credit: r2(rows.reduce((s, r) => s + r.credit, 0)),
    closing: rows.length ? rows[rows.length - 1].balance : 0,
  }), [rows]);
  const party = data.parties.find((p) => p.id === partyId);
  const scope = party ? party.name : 'Whole business';
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  const toExcel = () => {
    exportCSV(`LedgerBook_${party ? party.name : 'Business'}`, ['Date', 'Reference', 'Party', 'Description', 'Debit', 'Credit', 'Balance'],
      rows.map((r) => [fmtDate(r.date), r.ref, r.party, r.desc, r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '', r.balance.toFixed(2)]),
      [`${settings.shopName} — Ledger Book`, scope, `Debit ${money(totals.debit)} · Credit ${money(totals.credit)} · Closing ${money(totals.closing)}`]);
    toast('Ledger book exported');
  };
  const toPDF = () => printReport({
    title: 'Ledger Book', subtitle: scope, shopName: settings.shopName,
    headers: ['Date', 'Ref', 'Party', 'Description', { label: 'Debit', align: 'r' }, { label: 'Credit', align: 'r' }, { label: 'Balance', align: 'r' }],
    rows: rows.map((r) => [fmtDate(r.date), r.ref, r.party, r.desc, r.debit ? money(r.debit) : '—', r.credit ? money(r.credit) : '—', money(r.balance)]),
    totals: ['', '', '', 'Totals', money(totals.debit), money(totals.credit), money(totals.closing)],
  });
  return (
    <>
      <PageHead title="Ledger Book" subtitle={`${scope} · ${rows.length} entries`}>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <Card className="mb-2">
        <div className="row wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
          <Field label="Filter to a party" className="mb-0" style={{ minWidth: 260, flex: 1 }}>
            <Typeahead items={activeParties} value={partyId} onChange={(v) => setPartyId(v || '')} getLabel={(p) => p.name} getSub={(p) => p.phone || ''} placeholder="Whole business — or search a party…" />
          </Field>
          <div className="mb-0"><DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} /></div>
        </div>
      </Card>
      <div className="stat-grid">
        <Stat label="Total Debit (sales)" value={money(totals.debit)} icon={BookOpen} tone="#1F2937" />
        <Stat label="Total Credit (received)" value={money(totals.credit)} icon={BookOpen} tone="#16A34A" />
        <Stat label="Closing Balance" value={money(totals.closing)} icon={BookOpen} tone="#DC2626" />
      </div>
      <Card tight>
        {newestFirst.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Date</th><th>Ref</th>{!partyId && <th>Party</th>}<th>Description</th><th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th></tr>
                </thead>
                <tbody>
                  {newestFirst.map((r, i) => (
                    <tr key={`${r.date}-${r.ref}-${i}`}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      <td style={{ fontWeight: 600 }}>{r.ref}</td>
                      {!partyId && <td>{r.party}</td>}
                      <td>{r.desc}</td>
                      <td className="r">{r.debit ? <Money value={r.debit} /> : <span className="muted">—</span>}</td>
                      <td className="r">{r.credit ? <span className="money pos">{money(r.credit)}</span> : <span className="muted">—</span>}</td>
                      <td className="r strong"><span className="money" style={{ color: r.balance > 0 ? 'var(--danger)' : undefined }}>{money(r.balance)}</span></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={partyId ? 3 : 4}>{newestFirst.length} entries</td>
                    <td className="r">{money(totals.debit)}</td>
                    <td className="r">{money(totals.credit)}</td>
                    <td className="r" style={{ fontSize: 15 }}>{money(totals.closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {newestFirst.map((r, i) => (
                <div key={`${r.date}-${r.ref}-${i}`} className="mcard">
                  <div className="top">
                    <span className="name">{r.desc}</span>
                    <span className="amt" style={{ color: r.debit ? 'var(--danger)' : 'var(--success)' }}>{r.debit ? money(r.debit) : `−${money(r.credit)}`}</span>
                  </div>
                  <div className="meta"><span>{fmtDate(r.date)}</span>{!partyId && <span>{r.party}</span>}<span className="spacer" /><span>Balance {money(r.balance)}</span></div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon={BookOpen} title="No entries in this period" message="Change the date range or clear the party filter." />}
      </Card>
    </>
  );
}
