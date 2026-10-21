import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  CalendarCheck, CircleAlert, CircleCheck, Clock, Download, PackageX, Receipt, RefreshCw, Send, TrendingUp, Trophy, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import {
  money, r2, fmtDate, daysSince, pctChange, rangeFor, inRange, rangeLabel, isoDate, BUCKET_META, whatsappUrl,
} from '../lib/format.js';
import {
  billStates, collectedPayments, grossProfit, isOpeningBill, itemStock, methodBalances, partyDue, reorderSuggestion,
} from '../lib/calc.js';
import { exportBackup } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Money, PageHead, Pill, Stat,
} from '../components/ui.jsx';
import { CloseToday } from '../components/forms.jsx';

function reminderText(shop, partyName, bill) {
  return `Assalam-o-Alaikum ${partyName}, ${shop} se. Bill ${bill.billNo} ka ${money(bill.due)} ${daysSince(bill.dueDate)} din se due hai. Meherbani karke payment clear karwa dein. Shukriya.`;
}

export default function Dashboard() {
  const { data, settings, methods, toast, access } = useApp();
  const navigate = useNavigate();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [closing, setClosing] = useState(false);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const states = useMemo(() => billStates(data.bills, data), [data]);

  const kpi = useMemo(() => {
    const live = states.filter((b) => b.status !== 'voided');
    const inPeriod = live.filter((b) => !isOpeningBill(b) && inRange(b.date, range.from, range.to));
    const sales = r2(inPeriod.reduce((s, b) => s + b.net, 0));
    const collections = r2(collectedPayments(data.payments, data.cheques).filter((p) => inRange(p.date, range.from, range.to)).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const cashInHand = r2(methodBalances(methods, data).reduce((s, b) => s + b.balance, 0));
    const outstanding = r2(live.reduce((s, b) => s + b.due, 0));
    const ids = new Set(inPeriod.map((b) => b.id));
    const profit = grossProfit(data.billItems.filter((l) => ids.has(l.billId)), data.bills);
    return { sales, collections, cashInHand, outstanding, profit, billCount: inPeriod.length };
  }, [states, data, range, methods]);

  const monthVsLast = useMemo(() => {
    const cur = rangeFor('month');
    const last = rangeFor('lastMonth');
    const live = states.filter((b) => b.status !== 'voided');
    const sales = (r) => r2(live.filter((b) => !isOpeningBill(b) && inRange(b.date, r.from, r.to)).reduce((s, b) => s + b.net, 0));
    const coll = (r) => r2(collectedPayments(data.payments, data.cheques).filter((p) => inRange(p.date, r.from, r.to)).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const exp = (r) => r2(data.expenses.filter((e) => inRange(e.date, r.from, r.to)).reduce((s, e) => s + (Number(e.amount) || 0), 0));
    const prof = (r) => {
      const ids = new Set(live.filter((b) => inRange(b.date, r.from, r.to)).map((b) => b.id));
      return grossProfit(data.billItems.filter((l) => ids.has(l.billId)), data.bills);
    };
    return [
      { label: 'Sales', curr: sales(cur), prev: sales(last) },
      { label: 'Collections', curr: coll(cur), prev: coll(last) },
      { label: 'Expenses', curr: exp(cur), prev: exp(last) },
      ...(access.seesCost ? [{ label: 'Profit', curr: prof(cur), prev: prof(last) }] : []),
    ].map((x) => ({ ...x, delta: pctChange(x.curr, x.prev) }));
  }, [states, data, access.seesCost]);

  const overdue = useMemo(() => states
    .filter((b) => b.status !== 'voided' && b.due > 0 && b.isOverdue)
    .map((b) => ({ ...b, party: data.parties.find((p) => p.id === b.partyId) }))
    .sort((a, b) => b.overdueDays - a.overdueDays).slice(0, 6), [states, data.parties]);
  const aging = useMemo(() => {
    const out = { '0-7': 0, '8-30': 0, '30+': 0 };
    states.forEach((b) => {
      if (b.status === 'voided' || b.due <= 0) return;
      out[b.bucket] = r2((out[b.bucket] || 0) + b.due);
    });
    return out;
  }, [states]);
  const reorder = useMemo(() => data.parties.filter((p) => p.status !== 'archived')
    .map((p) => ({ party: p, sug: reorderSuggestion(p.id, data.bills) }))
    .filter((x) => x.sug && x.sug.isDue)
    .sort((a, b) => b.sug.overdueBy - a.sug.overdueBy).slice(0, 5), [data.parties, data.bills]);
  const lowStock = useMemo(() => data.items.filter((i) => i.status !== 'archived' && Number(i.lowStockAlert) > 0)
    .map((i) => ({ item: i, stock: itemStock(i.id, data) }))
    .filter((x) => x.stock <= Number(x.item.lowStockAlert))
    .sort((a, b) => a.stock - b.stock).slice(0, 5), [data]);
  const topParties = useMemo(() => {
    const m = new Map();
    states.filter((b) => b.status !== 'voided' && !isOpeningBill(b) && inRange(b.date, range.from, range.to)).forEach((b) => m.set(b.partyId, r2((m.get(b.partyId) || 0) + b.net)));
    return [...m.entries()].map(([pid, revenue]) => ({ party: data.parties.find((p) => p.id === pid), revenue, due: partyDue(pid, states) }))
      .filter((x) => x.party).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  }, [states, data.parties, range]);
  const trend = useMemo(() => {
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = isoDate(d);
      const sales = r2(states.filter((b) => b.status !== 'voided' && b.date === key).reduce((s, b) => s + b.net, 0));
      out.push({ date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), sales });
    }
    return out;
  }, [states]);
  const recent = useMemo(() => [...states].sort((a, b) => new Date(b.date) - new Date(a.date) || b.billNo.localeCompare(a.billNo)).slice(0, 8), [states]);
  const partyName = (pid) => data.parties.find((p) => p.id === pid)?.name || 'Unknown';
  const agingTotal = aging['0-7'] + aging['8-30'] + aging['30+'];

  return (
    <>
      <PageHead title="Dashboard" subtitle={`Showing ${rangeLabel(preset, range)}`}>
        <DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </PageHead>
      <div className="row hide-desktop mb-2" style={{ gap: 8 }}>
        <Button icon={CalendarCheck} onClick={() => setClosing(true)} style={{ flex: 1 }}>Close Today</Button>
        {access.isAdmin && <Button icon={Download} onClick={() => { exportBackup(data, settings.shopName); toast('Backup downloaded'); }} style={{ flex: 1 }}>Backup</Button>}
      </div>
      <div className="stat-grid">
        <Stat label="Sales" value={money(kpi.sales)} icon={TrendingUp} tone="#1F2937" delta={monthVsLast[0].delta} deltaLabel="vs last month" />
        {access.can('accounts')
          ? <Stat label="Cash in Hand" value={money(kpi.cashInHand)} icon={Wallet} tone="#16A34A" onClick={() => navigate('/accounts')} />
          : <Stat label="Collected" value={money(kpi.collections)} icon={Wallet} tone="#16A34A" />}
        <Stat label="Total Outstanding" value={money(kpi.outstanding)} icon={CircleAlert} tone="#DC2626" onClick={() => navigate('/outstanding')} />
        <Stat label="Bills" value={kpi.billCount} icon={Receipt} tone="#F59E0B" onClick={() => navigate('/bills')} />
      </div>
      <div className="hide-desktop mb-2">
        <div className="hscroll">
          <div className="card"><div className="card-body">
            <div className="stat-label"><Clock size={13} /> Overdue</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{overdue.length}</div>
            <div className="small muted">{money(aging['30+'] + aging['8-30'])} aged over 7 days</div>
          </div></div>
          <div className="card"><div className="card-body">
            <div className="stat-label"><RefreshCw size={13} /> Reorder soon</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{reorder.length}</div>
            <div className="small muted">Parties past their usual cycle</div>
          </div></div>
          <div className="card"><div className="card-body">
            <div className="stat-label"><PackageX size={13} /> Low stock</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{lowStock.length}</div>
            <div className="small muted">Items at or below threshold</div>
          </div></div>
        </div>
      </div>

      <div className="grid-2 mb-2 dash-row-2" style={{ alignItems: 'start' }}>
        <div className="col">
          <Card
            title="Overdue Payments"
            tight
            subtitle={overdue.length ? `${overdue.length} bill${overdue.length === 1 ? '' : 's'} past due date` : undefined}
            actions={<Button size="sm" onClick={() => navigate('/outstanding')}>View all</Button>}
          >
            {overdue.length ? overdue.map((b) => (
              <div key={b.id} className="alert-row">
                <span className="ico danger"><CircleAlert size={15} /></span>
                <div className="body">
                  <div className="t">{partyName(b.partyId)}</div>
                  <div className="s">Bill {b.billNo} · due {fmtDate(b.dueDate)} · {b.overdueDays} day{b.overdueDays === 1 ? '' : 's'} late</div>
                </div>
                <Money value={b.due} />
                <a className="btn btn-ghost btn-sm" title="Send WhatsApp reminder" href={whatsappUrl(b.party?.phone, reminderText(settings.shopName, partyName(b.partyId), b))} target="_blank" rel="noreferrer"><Send size={14} /></a>
              </div>
            )) : <Empty icon={CircleCheck} title="Nothing overdue" message="Every credit bill is within its due date." />}
          </Card>
          <Card title="Aging Summary" tight>
            <table className="tbl">
              <tbody>
                {Object.entries(aging).map(([k, v]) => {
                  const meta = BUCKET_META[k];
                  const pct = agingTotal > 0 ? (v / agingTotal) * 100 : 0;
                  return (
                    <tr key={k}>
                      <td style={{ width: 110 }}><Pill status={k === '30+' ? 'overdue' : 'partial'} label={meta.label} /></td>
                      <td>
                        <div style={{ height: 7, background: 'var(--neutral-bg)', borderRadius: 999 }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: meta.color, borderRadius: 999, transition: 'width .3s' }} />
                        </div>
                      </td>
                      <td className="r strong" style={{ width: 120 }}><Money value={v} /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td colSpan={2}>Total outstanding</td><td className="r"><Money value={kpi.outstanding} /></td></tr></tfoot>
            </table>
          </Card>
        </div>
        <div className="col">
          <Card title="Likely to Reorder" tight subtitle="Based on each party's own ordering pattern">
            {reorder.length ? reorder.map(({ party, sug }) => (
              <div key={party.id} className="alert-row">
                <span className="ico info"><RefreshCw size={15} /></span>
                <div className="body">
                  <div className="t">{party.name}</div>
                  <div className="s">Usually orders every {sug.avgDays} days — it has been {sug.sinceDays}</div>
                </div>
                <a className="btn btn-sm" target="_blank" rel="noreferrer" href={whatsappUrl(party.phone, `Assalam-o-Alaikum ${party.name}, ${settings.shopName} se. Koi order banana hai?`)}>
                  <Send size={13} /> Follow up
                </a>
              </div>
            )) : <Empty icon={CircleCheck} title="No reorders due" message="Every party is within their usual ordering cycle." />}
          </Card>
          <Card title="Low Stock" tight actions={<Button size="sm" onClick={() => navigate('/items')}>Manage items</Button>}>
            {lowStock.length ? lowStock.map(({ item, stock }) => (
              <div key={item.id} className="alert-row">
                <span className="ico warning"><PackageX size={15} /></span>
                <div className="body">
                  <div className="t">{item.name}</div>
                  <div className="s">Threshold {item.lowStockAlert} {item.baseUnit}</div>
                </div>
                <span className="num" style={{ color: stock <= 0 ? 'var(--danger)' : 'var(--warning)' }}>{stock} {item.baseUnit}</span>
              </div>
            )) : <Empty icon={CircleCheck} title="Stock levels are healthy" message="No item has fallen to its low-stock threshold." />}
          </Card>
        </div>
      </div>

      <Card title="This Month vs Last Month" className="mb-2">
        <div className="stat-grid" style={{ marginBottom: 0 }}>
          {monthVsLast.map((m) => (
            <div key={m.label} style={{ padding: '2px 0' }}>
              <div className="stat-label">{m.label}</div>
              <div className="stat-value" style={{ fontSize: 20 }}>{money(m.curr)}</div>
              <div className={`stat-delta ${m.delta > 0 ? 'up' : m.delta < 0 ? 'down' : ''}`}>
                {m.delta > 0 ? '▲' : m.delta < 0 ? '▼' : '—'} {Math.abs(m.delta).toFixed(1)}%
                <span className="muted">was {money(m.prev)}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Top Parties" subtitle="Ranked by revenue in the selected period" tight>
          {topParties.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th style={{ width: 34 }}>#</th><th>Party</th><th className="r">Revenue</th><th className="r">Due</th></tr></thead>
                <tbody>
                  {topParties.map((x, i) => (
                    <tr key={x.party.id} className="clickable" onClick={() => navigate(`/party/${x.party.id}`)}>
                      <td>{i === 0 ? <Trophy size={14} color="#F59E0B" /> : <span className="muted small">{i + 1}</span>}</td>
                      <td style={{ fontWeight: 500 }}>{x.party.name}</td>
                      <td className="r strong"><Money value={x.revenue} /></td>
                      <td className="r">{x.due > 0 ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{money(x.due)}</span> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No sales in this period" message="Change the date range or create a bill to see rankings." action={<Button variant="primary" onClick={() => navigate('/bill/new')}>New Bill</Button>} />
          )}
        </Card>
        <Card title="Sales Trend" subtitle="Last 14 days">
          <div style={{ width: '100%', height: 232 }}>
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                <Tooltip formatter={(v) => [money(v), 'Sales']} contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }} />
                <Line type="monotone" dataKey="sales" stroke="#D42A24" strokeWidth={2} dot={{ r: 2.5, fill: '#D42A24' }} activeDot={{ r: 4.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="hide-desktop mt-2">
        <h2 className="h2 mb-1">Recent Bills</h2>
        <div className="mcards">
          {recent.map((b) => (
            <div key={b.id} className={`mcard ${b.due > 0 ? `due-${b.bucket === '30+' ? 30 : b.bucket === '8-30' ? 8 : 0}` : ''}`} onClick={() => navigate(`/bill/${b.id}`)}>
              <div className="top"><span className="name">{partyName(b.partyId)}</span><span className="amt">{money(b.net)}</span></div>
              <div className="meta">
                <Pill status={b.status} /><span>{b.billNo}</span><span>{fmtDate(b.date)}</span>
                {b.due > 0 && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{money(b.due)} due</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <CloseToday open={closing} onClose={() => setClosing(false)} />
    </>
  );
}
