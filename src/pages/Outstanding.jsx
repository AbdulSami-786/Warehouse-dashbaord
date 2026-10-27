import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, CircleAlert, CircleCheck, Download, Printer, Send,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, fmtDate, norm, BUCKETS, BUCKET_META, whatsappUrl } from '../lib/format.js';
import { billStates, owingItems } from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, Empty, Field, Input, Money, PageHead, Pill, SearchBox, Stat,
} from '../components/ui.jsx';

/** A party's open items are bills and journal entries; say how many of each. */
function itemsText(g) {
  const j = g.bills.filter((b) => b.isJournal).length;
  const n = g.bills.length - j;
  return [n && `${n} bill${n === 1 ? '' : 's'}`, j && `${j} journal`].filter(Boolean).join(' + ');
}

const itemLabel = (b) => (b.isJournal ? `Journal — ${b.billNo}` : b.billNo);

function reminder(shopName, row) {
  return `Assalam-o-Alaikum ${row.party.name}, ${shopName} se. Aap ka total ${money(row.due)} outstanding hai (${itemsText(row)}). Meherbani karke payment clear karwa dein. Shukriya.`;
}

export default function Outstanding() {
  const { data, settings, toast } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [minDays, setMinDays] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [open, setOpen] = useState({});

  const { groups, totals, rows } = useMemo(() => {
    const s = norm(q);
    const owing = owingItems(data, billStates(data.bills, data));
    const byParty = new Map();
    owing.forEach((b) => {
      const party = data.parties.find((p) => p.id === b.partyId);
      if (!party || (s && !norm(party.name).includes(s) && !norm(party.phone).includes(s))) return;
      if (!byParty.has(party.id)) byParty.set(party.id, { party, due: 0, bills: [], oldestDays: 0, buckets: { '0-7': 0, '8-30': 0, '30+': 0 } });
      const g = byParty.get(party.id);
      g.due = r2(g.due + b.due);
      g.bills.push(b);
      g.buckets[b.bucket] = r2(g.buckets[b.bucket] + b.due);
      g.oldestDays = Math.max(g.oldestDays, Math.max(0, b.overdueDays));
    });
    let list = [...byParty.values()];
    if (minDays !== '') list = list.filter((g) => g.oldestDays >= Number(minDays));
    if (minAmount !== '') list = list.filter((g) => g.due >= Number(minAmount));
    list.sort((a, b) => b.due - a.due);
    const sums = { '0-7': 0, '8-30': 0, '30+': 0 };
    list.forEach((g) => BUCKETS.forEach((k) => { sums[k] = r2(sums[k] + g.buckets[k]); }));
    return {
      groups: sums,
      rows: list,
      totals: {
        due: r2(list.reduce((t, g) => t + g.due, 0)),
        parties: list.length,
        bills: list.reduce((t, g) => t + g.bills.filter((b) => !b.isJournal).length, 0),
        journal: list.reduce((t, g) => t + g.bills.filter((b) => b.isJournal).length, 0),
      },
    };
  }, [data, q, minDays, minAmount]);
  const countText = `${totals.bills} bill${totals.bills === 1 ? '' : 's'}${totals.journal ? ` + ${totals.journal} journal` : ''}`;

  const toExcel = () => {
    const out = [];
    rows.forEach((g) => {
      [...g.bills].sort((a, b) => b.overdueDays - a.overdueDays).forEach((b) => out.push([
        g.party.name, g.party.phone || '', itemLabel(b), fmtDate(b.date), b.isJournal ? '' : fmtDate(b.dueDate), Math.max(0, b.overdueDays), BUCKET_META[b.bucket].label, b.due.toFixed(2),
      ]));
    });
    exportCSV('Outstanding', ['Party', 'Phone', 'Bill No', 'Bill Date', 'Due Date', 'Days Overdue', 'Bucket', 'Amount Due'], out, [
      `${settings.shopName} — Outstanding Report`, `Total outstanding: ${money(totals.due)}`,
      `0–7 days: ${money(groups['0-7'])} · 8–30 days: ${money(groups['8-30'])} · 30+ days: ${money(groups['30+'])}`,
    ]);
    toast('Outstanding report exported');
  };
  const toPDF = () => printReport({
    title: 'Outstanding Report', subtitle: `${totals.parties} parties · ${countText}`, shopName: settings.shopName,
    headers: ['Party', 'Phone', { label: '0–7 days', align: 'r' }, { label: '8–30 days', align: 'r' }, { label: '30+ days', align: 'r' }, { label: 'Total Due', align: 'r' }],
    rows: rows.map((g) => [g.party.name, g.party.phone || '—',
      g.buckets['0-7'] ? money(g.buckets['0-7']) : '—', g.buckets['8-30'] ? money(g.buckets['8-30']) : '—', g.buckets['30+'] ? money(g.buckets['30+']) : '—', money(g.due)]),
    totals: ['Totals', '', money(groups['0-7']), money(groups['8-30']), money(groups['30+']), money(totals.due)],
  });
  const filtered = minDays !== '' || minAmount !== '' || q;

  return (
    <>
      <PageHead title="Outstanding" subtitle={`${totals.parties} ${totals.parties === 1 ? 'party owes' : 'parties owe'} ${money(totals.due)} across ${countText}`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search party…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPDF}>PDF</Button>
      </PageHead>
      <div className="stat-grid">
        {BUCKETS.map((k) => <Stat key={k} label={BUCKET_META[k].label} value={money(groups[k])} icon={CircleAlert} tone={BUCKET_META[k].color} />)}
        <Stat label="Total Outstanding" value={money(totals.due)} icon={CircleAlert} tone="#1E293B" />
      </div>
      <Card className="mb-2">
        <div className="row wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
          <Field label="Overdue more than (days)" className="mb-0" style={{ width: 180 }}>
            <Input type="number" min="0" value={minDays} placeholder="Any" onChange={(e) => setMinDays(e.target.value)} style={{ width: 160 }} />
          </Field>
          <Field label="Amount at least" className="mb-0">
            <Input type="number" min="0" value={minAmount} placeholder="Any" onChange={(e) => setMinAmount(e.target.value)} style={{ width: 160 }} />
          </Field>
          {filtered && <Button onClick={() => { setMinDays(''); setMinAmount(''); setQ(''); }}>Clear filters</Button>}
        </div>
      </Card>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 30 }} /><th>Party</th><th>Phone</th><th className="r">Oldest</th>
                    <th className="r">0–7 days</th><th className="r">8–30 days</th><th className="r">30+ days</th><th className="r">Total due</th><th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <Fragment key={g.party.id}>
                      <tr className="clickable" onClick={() => setOpen((o) => ({ ...o, [g.party.id]: !o[g.party.id] }))}>
                        <td>{open[g.party.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                        <td style={{ fontWeight: 600 }}>{g.party.name}</td>
                        <td className="small">{g.party.phone || <span className="muted">—</span>}</td>
                        <td className="r">
                          {g.oldestDays > 0
                            ? <span style={{ color: BUCKET_META[g.oldestDays <= 7 ? '0-7' : g.oldestDays <= 30 ? '8-30' : '30+'].color, fontWeight: 600 }}>{g.oldestDays}d</span>
                            : <span className="muted">—</span>}
                        </td>
                        {BUCKETS.map((k) => (
                          <td key={k} className="r">
                            {g.buckets[k] > 0 ? <span className="num" style={{ color: BUCKET_META[k].color, fontWeight: 600 }}>{money(g.buckets[k])}</span> : <span className="muted">—</span>}
                          </td>
                        ))}
                        <td className="r strong"><span className="money neg">{money(g.due)}</span></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="row-actions">
                            {g.party.phone && <a className="btn btn-ghost btn-sm" title="Send reminder" href={whatsappUrl(g.party.phone, reminder(settings.shopName, g))} target="_blank" rel="noreferrer"><Send size={14} /></a>}
                            <button className="btn btn-ghost btn-sm" title="Open ledger" onClick={() => navigate(`/party/${g.party.id}`)}><ChevronRight size={14} /></button>
                          </div>
                        </td>
                      </tr>
                      {open[g.party.id] && [...g.bills].sort((a, b) => b.overdueDays - a.overdueDays).map((b) => (
                        <tr key={b.id} className={`clickable ${BUCKET_META[b.bucket].cls}`} onClick={() => navigate(b.isJournal ? `/party/${b.partyId}` : `/bill/${b.id}`)}>
                          <td />
                          <td colSpan={2} style={{ paddingLeft: 30 }}><span style={{ fontWeight: 500 }}>{itemLabel(b)}</span><span className="small muted"> · {fmtDate(b.date)}</span></td>
                          <td className="r small">{b.isJournal ? (b.overdueDays > 0 ? `${b.overdueDays}d old` : 'New') : b.overdueDays > 0 ? `${b.overdueDays}d late` : 'Not due'}</td>
                          <td colSpan={3} className="small muted">
                            {b.isJournal
                              ? <>To take, from the journal · <Pill status="neutral" label="Journal" /></>
                              : <>Due {fmtDate(b.dueDate)} · <Pill status={b.status} /></>}
                          </td>
                          <td className="r"><Money value={b.due} /></td>
                          <td />
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{totals.parties} parties</td>
                    {BUCKETS.map((k) => <td key={k} className="r" style={{ color: BUCKET_META[k].color }}>{money(groups[k])}</td>)}
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((g) => {
                const worst = g.buckets['30+'] > 0 ? '30+' : g.buckets['8-30'] > 0 ? '8-30' : '0-7';
                return (
                  <div key={g.party.id} className={`mcard ${BUCKET_META[worst].mcls}`} onClick={() => navigate(`/party/${g.party.id}`)}>
                    <div className="top"><span className="name">{g.party.name}</span><span className="amt" style={{ color: 'var(--danger)' }}>{money(g.due)}</span></div>
                    <div className="meta">
                      <Pill status={worst === '30+' ? 'overdue' : 'partial'} label={BUCKET_META[worst].label} />
                      <span>{itemsText(g)}</span>
                      {g.oldestDays > 0 && <span>{g.oldestDays}d oldest</span>}
                    </div>
                    {g.party.phone && (
                      <a className="btn btn-sm" onClick={(e) => e.stopPropagation()} href={whatsappUrl(g.party.phone, reminder(settings.shopName, g))} target="_blank" rel="noreferrer">
                        <Send size={13} /> Send reminder
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <Empty icon={CircleCheck} title="Nothing outstanding" message={filtered ? 'No party matches these filters.' : 'Every party has cleared their balance. Well collected.'} />
        )}
      </Card>
    </>
  );
}
