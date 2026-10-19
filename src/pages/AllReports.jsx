import { useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Boxes, ChartColumn, CircleAlert, Download, MapPin, Printer, Receipt, TrendingUp, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import {
  money, qty, r2, fmtDate, norm, rangeFor, rangeLabel, inRange,
} from '../lib/format.js';
import { billStates, collectedPayments, grossProfit } from '../lib/calc.js';
import {
  SHOP, expensesMerged, locationSummary, salesByItem, salesByParty, stockEvents, stockMatrix,
} from '../lib/reports.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, DateRange, Empty, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'stock', label: 'Stock' },
  { value: 'moves', label: 'Movements' },
  { value: 'sales', label: 'Sales' },
  { value: 'expenses', label: 'Expenses' },
];
const SHOW_MAX = 400;

/** The shop and every warehouse in one place. */
export default function AllReports() {
  const { data, settings, toast, access } = useApp();
  const sc = access.seesCost;
  const [tab, setTab] = useState('overview');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [loc, setLoc] = useState('all');
  const [q, setQ] = useState('');
  const [stockShow, setStockShow] = useState('in-stock');
  const [salesBy, setSalesBy] = useState('item');
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const period = rangeLabel(preset, range);

  const matrix = useMemo(() => stockMatrix(data), [data]);
  const locs = matrix.locations;
  const locName = (id) => locs.find((l) => l.id === id)?.name || 'Warehouse';
  const summary = useMemo(() => locationSummary(data, range.from, range.to), [data, range]);
  const events = useMemo(() => stockEvents(data, range.from, range.to), [data, range]);
  const expenses = useMemo(() => expensesMerged(data, range.from, range.to), [data, range]);
  const items = useMemo(() => salesByItem(data, range.from, range.to), [data, range]);
  const parties = useMemo(() => salesByParty(data, range.from, range.to), [data, range]);

  const kpi = useMemo(() => {
    const live = billStates(data.bills, data).filter((b) => b.status !== 'voided');
    const inPeriod = live.filter((b) => inRange(b.date, range.from, range.to));
    const ids = new Set(inPeriod.map((b) => b.id));
    const spent = expenses.filter((e) => loc === 'all' || e.location === loc);
    const scope = loc === 'all' ? summary : summary.filter((s) => s.id === loc);
    return {
      sales: r2(inPeriod.reduce((s, b) => s + b.net, 0)),
      bills: inPeriod.length,
      collected: r2(collectedPayments(data.payments, data.cheques).filter((p) => inRange(p.date, range.from, range.to)).reduce((s, p) => s + (Number(p.amount) || 0), 0)),
      outstanding: r2(live.reduce((s, b) => s + b.due, 0)),
      profit: grossProfit(data.billItems.filter((l) => ids.has(l.billId)), data.bills),
      expenses: r2(spent.reduce((s, e) => s + e.amount, 0)),
      units: r2(scope.reduce((s, l) => s + l.units, 0)),
      value: r2(scope.reduce((s, l) => s + l.value, 0)),
      qtyIn: r2(scope.reduce((s, l) => s + l.qtyIn, 0)),
      qtyOut: r2(scope.reduce((s, l) => s + l.qtyOut, 0)),
    };
  }, [data, range, expenses, summary, loc]);

  /* -------------------------------------------------------------- stock */
  const stockCols = loc === 'all' ? locs : locs.filter((l) => l.id === loc);
  const stockRows = useMemo(() => {
    const s = norm(q);
    return matrix.rows
      .filter((r) => !s || norm(r.item.name).includes(s) || norm(r.item.category).includes(s))
      .map((r) => {
        const total = loc === 'all' ? r.total : r.per[loc] || 0;
        return { ...r, shown: total, shownValue: r2(Math.max(0, total) * (Number(r.item.costPrice) || 0)) };
      })
      .filter((r) => (stockShow === 'all' ? true : stockShow === 'low' ? r.low : r.shown !== 0))
      .sort((a, b) => a.item.name.localeCompare(b.item.name));
  }, [matrix, q, loc, stockShow]);
  const stockTotal = useMemo(() => ({
    per: Object.fromEntries(stockCols.map((l) => [l.id, r2(stockRows.reduce((s, r) => s + (r.per[l.id] || 0), 0))])),
    units: r2(stockRows.reduce((s, r) => s + r.shown, 0)),
    value: r2(stockRows.reduce((s, r) => s + r.shownValue, 0)),
  }), [stockRows, stockCols]);

  /* ---------------------------------------------------------- movements */
  const moveRows = useMemo(() => {
    const s = norm(q);
    return events
      .filter((e) => loc === 'all' || e.location === loc)
      .filter((e) => !s || norm(e.itemName).includes(s) || norm(e.ref).includes(s) || norm(e.party).includes(s) || norm(e.kind).includes(s));
  }, [events, loc, q]);
  const moveTotal = useMemo(() => ({
    qtyIn: r2(moveRows.reduce((s, e) => s + e.qtyIn, 0)),
    qtyOut: r2(moveRows.reduce((s, e) => s + e.qtyOut, 0)),
  }), [moveRows]);

  /* ---------------------------------------------------------- expenses */
  const expRows = useMemo(() => expenses.filter((e) => loc === 'all' || e.location === loc)
    .filter((e) => !norm(q) || norm(e.category).includes(norm(q)) || norm(e.note).includes(norm(q))), [expenses, loc, q]);
  const expByCat = useMemo(() => {
    const m = new Map();
    expRows.forEach((e) => m.set(e.category, r2((m.get(e.category) || 0) + e.amount)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [expRows]);
  const expTotal = r2(expRows.reduce((s, e) => s + e.amount, 0));

  /* ------------------------------------------------------------- export */
  const meta = [`${settings.shopName}`, `Period: ${period}`, `Location: ${loc === 'all' ? 'All locations' : locName(loc)}`];
  const exportNow = (kind) => {
    const csv = kind === 'csv';
    let title = '';
    let headers = [];
    let rows = [];
    if (tab === 'overview') {
      title = 'Locations';
      headers = ['Location', 'Items in stock', 'Units', ...(sc ? ['Value at cost'] : []), 'In (period)', 'Out (period)', 'Expenses (period)'];
      rows = summary.map((l) => [l.name, l.items, csv ? l.units : qty(l.units), ...(sc ? [csv ? l.value : money(l.value)] : []), csv ? l.qtyIn : qty(l.qtyIn), csv ? l.qtyOut : qty(l.qtyOut), csv ? l.expenses : money(l.expenses)]);
    } else if (tab === 'stock') {
      title = 'Stock — all locations';
      headers = ['Item', 'Category', ...stockCols.map((l) => l.name), ...(loc === 'all' ? ['Total'] : []), 'Unit', ...(sc ? ['Value'] : [])];
      rows = stockRows.map((r) => [r.item.name, r.item.category || '', ...stockCols.map((l) => (csv ? r.per[l.id] : qty(r.per[l.id]))), ...(loc === 'all' ? [csv ? r.total : qty(r.total)] : []), r.item.baseUnit, ...(sc ? [csv ? r.shownValue : money(r.shownValue)] : [])]);
    } else if (tab === 'moves') {
      title = 'Stock movements — all locations';
      headers = ['Date', 'Location', 'Movement', 'Item', 'In', 'Out', 'Ref', 'Party'];
      rows = moveRows.map((e) => [fmtDate(e.date), e.locationName, e.kind, e.itemName, e.qtyIn || '', e.qtyOut || '', e.ref, e.party]);
    } else if (tab === 'sales') {
      if (salesBy === 'item') {
        title = 'Sales by item';
        headers = ['Item', 'Bills', 'Qty sold', 'Sales', ...(sc ? ['Gross profit'] : [])];
        rows = items.map((g) => [g.item?.name || 'Item', g.bills, csv ? g.qty : qty(g.qty), csv ? g.amount : money(g.amount), ...(sc ? [csv ? g.profit : money(g.profit)] : [])]);
      } else {
        title = 'Sales by party';
        headers = ['Party', 'Bills', 'Billed', 'Paid', 'Still due'];
        rows = parties.map((g) => [g.party?.name || 'Unknown', g.bills, ...(csv ? [g.amount, g.paid, g.due] : [money(g.amount), money(g.paid), money(g.due)])]);
      }
    } else {
      title = 'Expenses — shop and warehouses';
      headers = ['Date', 'Location', 'Category', 'Paid from', 'Note', 'Amount'];
      rows = expRows.map((e) => [fmtDate(e.date), e.locationName, e.category, e.method || '', e.note || '', csv ? e.amount : money(e.amount)]);
    }
    if (csv) {
      exportCSV(`AllReports_${tab}`, headers, rows, meta);
      toast('Report exported');
    } else {
      printReport({
        title, subtitle: `${period} · ${loc === 'all' ? 'All locations' : locName(loc)}`, shopName: settings.shopName,
        headers: headers.map((h, i) => (i > 0 && /Units|In|Out|Qty|Value|Sales|Paid|due|Billed|Amount|profit|Expenses|Total|Bills|Items/i.test(h) ? { label: h, align: 'r' } : h)),
        rows,
      });
    }
  };

  const filters = (
    <div className="row wrap mb-2" style={{ gap: 8, alignItems: 'center' }}>
      <DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      <Select value={loc} onChange={(e) => setLoc(e.target.value)} style={{ width: 190 }} aria-label="Location">
        <option value="all">All locations</option>
        {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </Select>
      {tab !== 'overview' && <SearchBox value={q} onChange={setQ} placeholder={tab === 'stock' || tab === 'sales' ? 'Search item…' : 'Search…'} style={{ minWidth: 200 }} />}
    </div>
  );

  return (
    <>
      <PageHead title="All Reports" subtitle={`Shop and every warehouse together · ${period}`}>
        <Button icon={Download} onClick={() => exportNow('csv')}>Excel</Button>
        <Button icon={Printer} onClick={() => exportNow('pdf')}>PDF</Button>
      </PageHead>
      <div className="seg mb-2">
        {TABS.map((t) => <button key={t.value} className={tab === t.value ? 'active' : ''} onClick={() => setTab(t.value)}>{t.label}</button>)}
      </div>
      {filters}

      {tab === 'overview' && (
        <>
          <div className="stat-grid">
            <Stat label="Sales" value={money(kpi.sales)} icon={TrendingUp} tone="#D42A24" note={`${kpi.bills} bill${kpi.bills === 1 ? '' : 's'}`} />
            <Stat label="Collected" value={money(kpi.collected)} icon={Wallet} tone="#16A34A" />
            <Stat label="Outstanding (all time)" value={money(kpi.outstanding)} icon={CircleAlert} tone="#DC2626" />
            {sc
              ? <Stat label="Gross Profit" value={money(kpi.profit)} icon={ChartColumn} tone="#1F2937" />
              : <Stat label="Expenses" value={money(kpi.expenses)} icon={Receipt} tone="#B7791F" />}
          </div>
          <div className="stat-grid">
            <Stat label="Units held now" value={qty(kpi.units)} icon={Boxes} tone="#1F2937" note={sc ? `${money(kpi.value)} at cost` : undefined} />
            <Stat label="Units in" value={qty(kpi.qtyIn)} icon={ArrowDownToLine} tone="#16A34A" note="Received, returned, transferred in" />
            <Stat label="Units out" value={qty(kpi.qtyOut)} icon={ArrowUpFromLine} tone="#DC2626" note="Sold, sent, lost" />
            {sc && <Stat label="Expenses" value={money(kpi.expenses)} icon={Receipt} tone="#B7791F" note="Shop and warehouses" />}
          </div>
          <Card title="By location" subtitle="Stock now, and what moved in the period" tight>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Location</th><th className="r">Items in stock</th><th className="r">Units</th>{sc && <th className="r">Value at cost</th>}<th className="r">In</th><th className="r">Out</th><th className="r">Expenses</th></tr>
                </thead>
                <tbody>
                  {summary.filter((l) => loc === 'all' || l.id === loc).map((l) => (
                    <tr key={l.id}>
                      <td style={{ fontWeight: 600 }}><MapPin size={12} className="muted" style={{ verticalAlign: -1 }} /> {l.name}{l.id === SHOP && <> <Pill status="partial" label="Shop" /></>}</td>
                      <td className="r num">{l.items}</td>
                      <td className="r num strong">{qty(l.units)}</td>
                      {sc && <td className="r"><Money value={l.value} /></td>}
                      <td className="r num" style={{ color: 'var(--success)' }}>{l.qtyIn ? qty(l.qtyIn) : '—'}</td>
                      <td className="r num" style={{ color: 'var(--danger)' }}>{l.qtyOut ? qty(l.qtyOut) : '—'}</td>
                      <td className="r"><Money value={l.expenses} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {summary.filter((l) => loc === 'all' || l.id === loc).map((l) => (
                <div key={l.id} className="mcard">
                  <div className="top"><span className="name">{l.name}</span><span className="amt num">{qty(l.units)} units</span></div>
                  <div className="meta">
                    <span>{l.items} items</span>
                    {sc && <span>{money(l.value)}</span>}
                    <span style={{ color: 'var(--success)' }}>In {qty(l.qtyIn)}</span>
                    <span style={{ color: 'var(--danger)' }}>Out {qty(l.qtyOut)}</span>
                    {l.expenses > 0 && <span>Spent {money(l.expenses)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {tab === 'stock' && (
        <Card
          tight
          title="Stock in every location"
          subtitle={`${stockRows.length} items · ${qty(stockTotal.units)} units${sc ? ` · ${money(stockTotal.value)} at cost` : ''}`}
          actions={<Select value={stockShow} onChange={(e) => setStockShow(e.target.value)} style={{ width: 150 }} options={[{ value: 'in-stock', label: 'In stock' }, { value: 'low', label: 'Low / out' }, { value: 'all', label: 'All items' }]} />}
        >
          {stockRows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Item</th>
                      {stockCols.map((l) => <th key={l.id} className="r" title={l.name}>{l.id === SHOP ? 'Shop' : l.code || l.name}</th>)}
                      {loc === 'all' && <th className="r">Total</th>}
                      {sc && <th className="r">Value</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {stockRows.slice(0, SHOW_MAX).map((r) => (
                      <tr key={r.item.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{r.item.name}{r.low && <> <Pill status="due" label={r.out ? 'Out' : 'Low'} /></>}</div>
                          <div className="small muted">{[r.item.category, r.item.baseUnit].filter(Boolean).join(' · ')}</div>
                        </td>
                        {stockCols.map((l) => {
                          const v = r.per[l.id] || 0;
                          return <td key={l.id} className="r num" style={{ color: v < 0 ? 'var(--danger)' : v === 0 ? 'var(--text-muted)' : undefined }}>{v ? qty(v) : '—'}</td>;
                        })}
                        {loc === 'all' && <td className="r strong num">{qty(r.total)}</td>}
                        {sc && <td className="r"><Money value={r.shownValue} /></td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{stockRows.length} items</td>
                      {stockCols.map((l) => <td key={l.id} className="r">{qty(stockTotal.per[l.id])}</td>)}
                      {loc === 'all' && <td className="r">{qty(stockTotal.units)}</td>}
                      {sc && <td className="r">{money(stockTotal.value)}</td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {stockRows.slice(0, SHOW_MAX).map((r) => (
                  <div key={r.item.id} className="mcard">
                    <div className="top"><span className="name">{r.item.name}</span><span className="amt num">{qty(r.shown)} {r.item.baseUnit}</span></div>
                    <div className="meta">
                      {r.low && <Pill status="due" label={r.out ? 'Out' : 'Low'} />}
                      {stockCols.map((l) => (r.per[l.id] ? <span key={l.id}>{l.id === SHOP ? 'Shop' : l.code || l.name}: {qty(r.per[l.id])}</span> : null))}
                      {sc && <span>{money(r.shownValue)}</span>}
                    </div>
                  </div>
                ))}
              </div>
              {stockRows.length > SHOW_MAX && <div className="small muted" style={{ padding: 12 }}>Showing the first {SHOW_MAX}. Search, or export to Excel for the full list.</div>}
            </>
          ) : <Empty icon={Boxes} title="Nothing to show" message={q ? `No item matches "${q}".` : 'No stock in this view.'} />}
        </Card>
      )}

      {tab === 'moves' && (
        <Card tight title="Every stock movement" subtitle={`${moveRows.length} entries · in ${qty(moveTotal.qtyIn)} · out ${qty(moveTotal.qtyOut)}`}>
          {moveRows.length ? (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Location</th><th>Movement</th><th>Item</th><th className="r">In</th><th className="r">Out</th><th>Ref</th><th>Party</th></tr></thead>
                  <tbody>
                    {moveRows.slice(0, SHOW_MAX).map((e, i) => (
                      <tr key={`${e.ref}-${e.itemId}-${i}`}>
                        <td className="nowrap small">{fmtDate(e.date)}</td>
                        <td className="small">{e.locationName}</td>
                        <td className="small">{e.kind}</td>
                        <td style={{ fontWeight: 500 }}>{e.itemName}</td>
                        <td className="r num" style={{ color: 'var(--success)' }}>{e.qtyIn ? qty(e.qtyIn) : ''}</td>
                        <td className="r num" style={{ color: 'var(--danger)' }}>{e.qtyOut ? qty(e.qtyOut) : ''}</td>
                        <td className="small muted">{e.ref || '—'}</td>
                        <td className="small muted">{e.party || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={4}>{moveRows.length} entries</td><td className="r">{qty(moveTotal.qtyIn)}</td><td className="r">{qty(moveTotal.qtyOut)}</td><td colSpan={2} /></tr></tfoot>
                </table>
              </div>
              <div className="mcards" style={{ padding: 12 }}>
                {moveRows.slice(0, SHOW_MAX).map((e, i) => (
                  <div key={`${e.ref}-${e.itemId}-${i}`} className="mcard">
                    <div className="top">
                      <span className="name">{e.itemName}</span>
                      <span className="amt num" style={{ color: e.qtyIn ? 'var(--success)' : 'var(--danger)' }}>{e.qtyIn ? `+${qty(e.qtyIn)}` : `−${qty(e.qtyOut)}`}</span>
                    </div>
                    <div className="meta"><span>{fmtDate(e.date)}</span><span>{e.locationName}</span><span>{e.kind}</span>{e.ref && <span>{e.ref}</span>}</div>
                  </div>
                ))}
              </div>
              {moveRows.length > SHOW_MAX && <div className="small muted" style={{ padding: 12 }}>Showing the latest {SHOW_MAX}. Narrow the period, or export to Excel for all of them.</div>}
            </>
          ) : <Empty icon={ArrowDownToLine} title="No movements" message="Nothing moved in this period and location." />}
        </Card>
      )}

      {tab === 'sales' && (
        <Card
          tight
          title={salesBy === 'item' ? 'Sales by item' : 'Sales by party'}
          subtitle={`${kpi.bills} bills · ${money(kpi.sales)} · sales are made at the shop`}
          actions={<div className="seg">{[['item', 'By item'], ['party', 'By party']].map(([v, l]) => <button key={v} className={salesBy === v ? 'active' : ''} onClick={() => setSalesBy(v)}>{l}</button>)}</div>}
        >
          {salesBy === 'item' ? (
            items.filter((g) => !norm(q) || norm(g.item?.name).includes(norm(q))).length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Item</th><th className="r">Bills</th><th className="r">Qty sold</th><th className="r">Sales</th>{sc && <th className="r">Gross profit</th>}</tr></thead>
                  <tbody>
                    {items.filter((g) => !norm(q) || norm(g.item?.name).includes(norm(q))).map((g) => (
                      <tr key={g.itemId}>
                        <td style={{ fontWeight: 600 }}>{g.item?.name || 'Item'}</td>
                        <td className="r num">{g.bills}</td>
                        <td className="r num">{qty(g.qty)} <span className="small muted">{g.item?.baseUnit}</span></td>
                        <td className="r strong"><Money value={g.amount} /></td>
                        {sc && <td className="r" style={{ color: g.profit < 0 ? 'var(--danger)' : 'var(--success)' }}>{money(g.profit)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={TrendingUp} title="No sales" message="Nothing was sold in this period." />
          ) : parties.filter((g) => !norm(q) || norm(g.party?.name).includes(norm(q))).length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Party</th><th className="r">Bills</th><th className="r">Billed</th><th className="r">Paid</th><th className="r">Still due</th></tr></thead>
                <tbody>
                  {parties.filter((g) => !norm(q) || norm(g.party?.name).includes(norm(q))).map((g) => (
                    <tr key={g.partyId}>
                      <td style={{ fontWeight: 600 }}>{g.party?.name || 'Unknown'}</td>
                      <td className="r num">{g.bills}</td>
                      <td className="r strong"><Money value={g.amount} /></td>
                      <td className="r"><Money value={g.paid} /></td>
                      <td className="r">{g.due > 0 ? <span className="money neg">{money(g.due)}</span> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={TrendingUp} title="No sales" message="Nothing was billed in this period." />}
        </Card>
      )}

      {tab === 'expenses' && (
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
          <Card tight title="Expenses" subtitle={`${expRows.length} entries · ${money(expTotal)}`}>
            {expRows.length ? (
              <>
                <div className="table-wrap hide-mobile">
                  <table className="tbl">
                    <thead><tr><th>Date</th><th>Location</th><th>Category</th><th>Paid from</th><th>Note</th><th className="r">Amount</th></tr></thead>
                    <tbody>
                      {expRows.slice(0, SHOW_MAX).map((e) => (
                        <tr key={e.id}>
                          <td className="nowrap small">{fmtDate(e.date)}</td>
                          <td className="small">{e.locationName}</td>
                          <td>{e.category}</td>
                          <td className="small">{e.method || '—'}</td>
                          <td className="small muted">{e.note || '—'}</td>
                          <td className="r strong"><Money value={e.amount} /></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td colSpan={5}>{expRows.length} entries</td><td className="r">{money(expTotal)}</td></tr></tfoot>
                  </table>
                </div>
                <div className="mcards" style={{ padding: 12 }}>
                  {expRows.slice(0, SHOW_MAX).map((e) => (
                    <div key={e.id} className="mcard">
                      <div className="top"><span className="name">{e.category}</span><span className="amt">{money(e.amount)}</span></div>
                      <div className="meta"><span>{fmtDate(e.date)}</span><span>{e.locationName}</span>{e.note && <span>{e.note}</span>}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : <Empty icon={Receipt} title="No expenses" message="Nothing was spent in this period and location." />}
          </Card>
          <Card title="By category" tight>
            {expByCat.length ? (
              <table className="tbl">
                <tbody>{expByCat.map(([c, v]) => <tr key={c}><td>{c}</td><td className="r strong"><Money value={v} /></td></tr>)}</tbody>
                <tfoot><tr><td>Total</td><td className="r">{money(expTotal)}</td></tr></tfoot>
              </table>
            ) : <Empty title="Nothing to summarise" message="Expenses appear here." />}
          </Card>
        </div>
      )}
    </>
  );
}
