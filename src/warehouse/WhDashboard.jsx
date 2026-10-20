import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Boxes, CircleCheck, ClipboardCheck, ClipboardList, Hourglass, MapPin,
  PackageX, Plus, Store, TrendingUp, Truck, Users, Wallet, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import {
  money, r2, fmtDate, isoDate, qty, today, rangeFor, inRange, daysSince,
} from '../lib/format.js';
import {
  MOVE_TYPES, moveEffect, warehouseExpenseTotal, warehouseStockMap, whPartySummaries,
} from '../lib/calc.js';
import { stockEvents } from '../lib/reports.js';
import {
  Button, Card, Empty, PageHead, Pill, Stat,
} from '../components/ui.jsx';
import { useSelectedWarehouse, WarehousePicker } from './WarehouseLayout.jsx';
import { useWarehouseSummaries } from './Warehouses.jsx';
import { routeText } from './Moves.jsx';

const SLOW_DAYS = 30;

export default function WhDashboard() {
  const {
    data, activeWarehouses, setActiveWarehouse, access,
  } = useApp();
  const navigate = useNavigate();
  const selected = useSelectedWarehouse();
  const [days, setDays] = useState(14);
  const summaries = useWarehouseSummaries().filter((w) => w.status !== 'archived');
  const scoped = selected ? summaries.filter((w) => w.id === selected) : summaries;
  const scopeIds = useMemo(() => new Set(scoped.map((w) => w.id)), [scoped]);
  const whName = (id) => (data.warehouses || []).find((w) => w.id === id)?.name || 'Warehouse';
  const itemOf = (id) => data.items.find((i) => i.id === id);
  const day = today();
  const month = rangeFor('month');
  const canMove = access.can('whMoves');
  const sc = access.seesCost;

  // Parties with something on their khata: largest balances first for whoever
  // sees money, most recent activity first for everyone else.
  const parties = useMemo(() => {
    if (!access.can('whParties')) return [];
    const sums = whPartySummaries(data);
    return (data.whParties || [])
      .filter((p) => p.status !== 'archived')
      .map((p) => ({ ...p, ...sums.get(p.id) }))
      .filter((p) => p.moves > 0 || Math.abs(p.balance) > 0.004)
      .sort((a, b) => (sc ? Math.abs(b.balance) - Math.abs(a.balance) : 0) || String(b.lastDate).localeCompare(String(a.lastDate)))
      .slice(0, 6);
  }, [data, access, sc]);

  const stock = useMemo(() => warehouseStockMap(data), [data]);
  /** itemId -> quantity held across the warehouses in view. */
  const held = useMemo(() => {
    const m = new Map();
    scoped.forEach((w) => (stock.get(w.id) || new Map()).forEach((q, itemId) => m.set(itemId, r2((m.get(itemId) || 0) + q))));
    return m;
  }, [stock, scoped]);

  // Every stock change in these warehouses: this month's, and all of it for "last moved out".
  const allEvents = useMemo(() => stockEvents(data).filter((e) => scopeIds.has(e.location)), [data, scopeIds]);
  const monthEvents = useMemo(() => allEvents.filter((e) => inRange(e.date, month.from, month.to)), [allEvents, month.from, month.to]);

  const kpi = useMemo(() => {
    const todays = (data.whMoves || []).filter((m) => m.status !== 'voided' && m.date === day && (scopeIds.has(m.warehouseId) || scopeIds.has(m.toWarehouseId)));
    const expenses = r2(scoped.reduce((s, w) => s + warehouseExpenseTotal(data.whExpenses, w.id, month.from, month.to), 0));
    let skus = 0;
    let out = 0;
    held.forEach((q) => { if (q > 0.0001) skus += 1; else out += 1; });
    return {
      value: r2(scoped.reduce((s, w) => s + w.value, 0)),
      units: r2(scoped.reduce((s, w) => s + w.units, 0)),
      todayCount: todays.length,
      expenses,
      skus,
      out,
      monthIn: r2(monthEvents.reduce((s, e) => s + e.qtyIn, 0)),
      monthOut: r2(monthEvents.reduce((s, e) => s + e.qtyOut, 0)),
    };
  }, [scoped, data, day, month.from, month.to, held, monthEvents, scopeIds]);

  // Low stock across the warehouses in scope, against each item's alert level.
  const low = useMemo(() => data.items
    .filter((i) => i.status !== 'archived' && Number(i.lowStockAlert) > 0 && held.has(i.id))
    .map((i) => ({ item: i, held: held.get(i.id) || 0 }))
    .filter((x) => x.held <= Number(x.item.lowStockAlert))
    .sort((a, b) => a.held - b.held).slice(0, 6), [data.items, held]);

  // What went out most this month.
  const top = useMemo(() => {
    const m = new Map();
    monthEvents.forEach((e) => { if (e.qtyOut) m.set(e.itemId, r2((m.get(e.itemId) || 0) + e.qtyOut)); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = rows[0]?.[1] || 1;
    return rows.map(([itemId, q]) => ({ item: itemOf(itemId), q, pct: Math.max(4, (q / max) * 100) }));
  }, [monthEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Held, but nothing has gone out for a month or more: money sitting on the shelf.
  const slow = useMemo(() => {
    const lastOut = new Map();
    allEvents.forEach((e) => { if (e.qtyOut && String(e.date) > String(lastOut.get(e.itemId) || '')) lastOut.set(e.itemId, e.date); });
    const firstIn = new Map();
    allEvents.forEach((e) => { if (e.qtyIn && (!firstIn.has(e.itemId) || String(e.date) < firstIn.get(e.itemId))) firstIn.set(e.itemId, e.date); });
    return [...held.entries()]
      .filter(([, q]) => q > 0.0001)
      .map(([itemId, q]) => {
        const since = lastOut.get(itemId) || firstIn.get(itemId);
        return { item: itemOf(itemId), q, since, idle: since ? daysSince(since) : null, never: !lastOut.has(itemId) };
      })
      .filter((x) => x.item && x.idle !== null && x.idle >= SLOW_DAYS)
      .sort((a, b) => b.idle - a.idle)
      .slice(0, 6);
  }, [allEvents, held]); // eslint-disable-line react-hooks/exhaustive-deps

  // One line per warehouse: holdings now, and this month's flow and spend.
  const compare = useMemo(() => summaries.map((w) => {
    const ev = monthEvents.filter((e) => e.location === w.id);
    const cap = Number(String(w.capacity || '').replace(/[^0-9.]/g, ''));
    return {
      ...w,
      monthIn: r2(ev.reduce((s, e) => s + e.qtyIn, 0)),
      monthOut: r2(ev.reduce((s, e) => s + e.qtyOut, 0)),
      monthSpend: warehouseExpenseTotal(data.whExpenses, w.id, month.from, month.to),
      fill: cap > 0 ? Math.min(100, Math.round((w.units / cap) * 100)) : null,
    };
  }), [summaries, monthEvents, data.whExpenses, month.from, month.to]);

  const spendByCat = useMemo(() => {
    const m = new Map();
    (data.whExpenses || []).filter((e) => scopeIds.has(e.warehouseId) && inRange(e.date, month.from, month.to))
      .forEach((e) => m.set(e.category, r2((m.get(e.category) || 0) + (Number(e.amount) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.whExpenses, scopeIds, month.from, month.to]);

  const linesOf = (mid) => (data.whMoveLines || []).filter((l) => l.moveId === mid);
  const recent = useMemo(() => (data.whMoves || [])
    .filter((m) => scopeIds.has(m.warehouseId) || scopeIds.has(m.toWarehouseId))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8)
    .map((m) => {
      const lines = linesOf(m.id);
      return { ...m, units: r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)), count: lines.length };
    }), [data, scopeIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const todayMoves = recent.filter((m) => m.date === day && m.status !== 'voided');

  // Units in and out per day for the chosen number of days.
  const trend = useMemo(() => {
    const ids = scoped.map((w) => w.id);
    const moves = new Map((data.whMoves || []).filter((m) => m.status !== 'voided').map((m) => [m.id, m]));
    const byDay = new Map();
    (data.whMoveLines || []).forEach((l) => {
      const m = moves.get(l.moveId);
      if (!m) return;
      ids.forEach((wid) => {
        const sign = moveEffect(m, wid);
        if (!sign) return;
        // Between two warehouses both in view, a transfer is neither in nor out overall.
        if (m.type === 'transfer' && !selected && ids.includes(m.warehouseId) && ids.includes(m.toWarehouseId)) return;
        if (!byDay.has(m.date)) byDay.set(m.date, { in: 0, out: 0 });
        const d = byDay.get(m.date);
        if (sign > 0) d.in += Number(l.qty) || 0;
        else d.out += Number(l.qty) || 0;
      });
    });
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = isoDate(d);
      const v = byDay.get(k) || { in: 0, out: 0 };
      out.push({ date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), In: r2(v.in), Out: r2(v.out) });
    }
    return out;
  }, [data, scoped, selected, days]);

  const monthMoves = (data.whMoves || []).filter((m) => m.status !== 'voided' && inRange(m.date, month.from, month.to)).length;

  if (!activeWarehouses.length) {
    return (
      <>
        <PageHead title="Warehouse Overview" subtitle="Stock across all your warehouses" />
        <Card>
          <Empty
            icon={Warehouse}
            title="Set up your first warehouse"
            message="Add each godown or store room. Then record goods coming in, going out, moving between warehouses, and going to the shop — every movement keeps the stock of each warehouse exact."
            action={access.can('warehouses') ? <Button variant="primary" icon={Plus} onClick={() => navigate('/warehouse/list')}>Add Warehouse</Button> : null}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead title="Warehouse Overview" subtitle={selected ? whName(selected) : `${activeWarehouses.length} warehouses · ${monthMoves} movements this month`}>
        <WarehousePicker />
      </PageHead>
      {canMove && (
        <div className="wh-quick mb-2">
          <button className="wh-quick-btn in" onClick={() => navigate('/warehouse/new/in')}><ArrowDownToLine size={20} /><span>Stock In</span></button>
          <button className="wh-quick-btn out" onClick={() => navigate('/warehouse/new/out')}><ArrowUpFromLine size={20} /><span>Stock Out</span></button>
          <button className="wh-quick-btn tr" onClick={() => navigate('/warehouse/new/transfer')}><ArrowLeftRight size={20} /><span>Transfer</span></button>
          <button className="wh-quick-btn shop" onClick={() => navigate('/warehouse/new/to-shop')}><Store size={20} /><span>Send to Shop</span></button>
        </div>
      )}
      <div className="stat-grid">
        <Stat className="cost-only" label="Stock Value (at cost)" value={money(kpi.value)} icon={Boxes} tone="#16A34A" onClick={() => navigate('/warehouse/stock')} />
        <Stat label="Units Held" value={qty(kpi.units)} icon={Boxes} tone="#1F2937" note={`${kpi.skus} item${kpi.skus === 1 ? '' : 's'} in stock`} />
        <Stat label="Movements Today" value={kpi.todayCount} icon={ClipboardList} tone="#F59E0B" onClick={() => navigate('/warehouse/moves')} />
        <Stat label="Expenses This Month" value={money(kpi.expenses)} icon={Wallet} tone="#DC2626" onClick={() => navigate('/warehouse/expenses')} />
      </div>
      <div className="stat-grid">
        <Stat label="In This Month" value={qty(kpi.monthIn)} icon={ArrowDownToLine} tone="#16A34A" note="Received, returned, transferred in" />
        <Stat label="Out This Month" value={qty(kpi.monthOut)} icon={ArrowUpFromLine} tone="#DC2626" note="Sent out, to the shop, adjusted" />
        <Stat label="Out of Stock" value={kpi.out} icon={PackageX} tone={kpi.out ? '#DC2626' : '#16A34A'} note="Items held before, none left now" onClick={() => navigate('/warehouse/stock')} />
        <Stat label={`Idle ${SLOW_DAYS}+ days`} value={slow.length >= 6 ? '6+' : slow.length} icon={Hourglass} tone="#B7791F" note="Held, but nothing went out" />
      </div>

      {!selected && (
        <Card title="Warehouses compared" subtitle="Holding now, and this month's movement and spend" tight className="mb-2">
          <div className="table-wrap hide-mobile">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Warehouse</th><th className="r">Items</th><th className="r">Units</th><th className="r cost-only">Value</th>
                  <th className="r">In (month)</th><th className="r">Out (month)</th><th className="r">Spent (month)</th><th>Space used</th><th>Last movement</th>
                </tr>
              </thead>
              <tbody>
                {compare.map((w) => (
                  <tr key={w.id} className="clickable" onClick={() => navigate(`/warehouse/w/${w.id}`)}>
                    <td style={{ fontWeight: 600 }}>{w.name}{w.code && <span className="wh-code" style={{ marginLeft: 6 }}>{w.code}</span>}</td>
                    <td className="r num">{w.itemCount}</td>
                    <td className="r num strong">{qty(w.units)}</td>
                    <td className="r cost-only">{money(w.value)}</td>
                    <td className="r num" style={{ color: 'var(--success)' }}>{w.monthIn ? qty(w.monthIn) : '—'}</td>
                    <td className="r num" style={{ color: 'var(--danger)' }}>{w.monthOut ? qty(w.monthOut) : '—'}</td>
                    <td className="r">{w.monthSpend ? money(w.monthSpend) : '—'}</td>
                    <td style={{ minWidth: 110 }}>
                      {w.fill === null ? <span className="small muted">{w.capacity || '—'}</span> : (
                        <div className="fill-bar" title={`${qty(w.units)} of ${w.capacity}`}><span style={{ width: `${w.fill}%`, background: w.fill > 90 ? 'var(--danger)' : w.fill > 70 ? 'var(--warning)' : 'var(--success)' }} /><em>{w.fill}%</em></div>
                      )}
                    </td>
                    <td className="small muted nowrap">{w.lastMove ? `${fmtDate(w.lastMove.date)} · ${w.lastMove.docNo}` : 'None yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mcards" style={{ padding: 12 }}>
            {compare.map((w) => (
              <div key={w.id} className="mcard" onClick={() => navigate(`/warehouse/w/${w.id}`)}>
                <div className="top"><span className="name">{w.name}</span><span className="amt num">{qty(w.units)} units</span></div>
                <div className="meta">
                  {w.location && <span><MapPin size={11} style={{ verticalAlign: -1 }} /> {w.location}</span>}
                  <span>{w.itemCount} items</span>
                  <span className="cost-only">{money(w.value)}</span>
                  <span style={{ color: 'var(--success)' }}>In {qty(w.monthIn)}</span>
                  <span style={{ color: 'var(--danger)' }}>Out {qty(w.monthOut)}</span>
                  {w.fill !== null && <span>{w.fill}% full</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setActiveWarehouse(w.id); }}>Work in this warehouse</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid-2 mb-2" style={{ alignItems: 'start' }}>
        <Card title="Today" subtitle={`${todayMoves.length} document${todayMoves.length === 1 ? '' : 's'} so far`} tight actions={canMove ? <Button size="sm" icon={ClipboardCheck} onClick={() => navigate('/warehouse/count')}>Stock Count</Button> : null}>
          {todayMoves.length ? todayMoves.map((m) => {
            const incoming = MOVE_TYPES[m.type]?.sign > 0;
            return (
              <div key={m.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/move/${m.id}`)}>
                <span className={`ico ${m.type === 'transfer' ? 'info' : incoming ? 'success' : 'warning'}`}>
                  {m.type === 'transfer' ? <ArrowLeftRight size={15} /> : incoming ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
                </span>
                <div className="body">
                  <div className="t">{m.docNo} · {MOVE_TYPES[m.type]?.label}</div>
                  <div className="s">
                    {routeText(m, whName)} · {m.count} item{m.count === 1 ? '' : 's'}
                    {(m.vehicleNo || m.driverName) && <> · <Truck size={11} style={{ verticalAlign: -1 }} /> {[m.vehicleNo, m.driverName].filter(Boolean).join(' · ')}</>}
                  </div>
                </div>
                <span className="num">{qty(m.units)}</span>
              </div>
            );
          }) : <Empty icon={ClipboardList} title="Nothing moved yet today" message={canMove ? 'Stock In, Stock Out and transfers recorded today show up here.' : 'Movements recorded today show up here.'} />}
        </Card>
        <Card title="Low Stock" tight subtitle="Items at or below their alert level" actions={<Button size="sm" onClick={() => navigate('/warehouse/stock')}>View stock</Button>}>
          {low.length ? low.map(({ item, held: h }) => (
            <div key={item.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/item/${item.id}${selected ? `?wh=${selected}` : ''}`)}>
              <span className="ico warning"><PackageX size={15} /></span>
              <div className="body"><div className="t">{item.name}</div><div className="s">Alert at {item.lowStockAlert} {item.baseUnit}</div></div>
              <span className="num" style={{ color: h <= 0 ? 'var(--danger)' : 'var(--warning)' }}>{qty(h)} {item.baseUnit}</span>
            </div>
          )) : <Empty icon={CircleCheck} title="Stock levels are healthy" message="No item has fallen to its alert level." />}
        </Card>
      </div>

      <div className="grid-2 mb-2" style={{ alignItems: 'start' }}>
        <Card title="Top moving items" subtitle="Most sent out this month" tight>
          {top.length ? (
            <div style={{ padding: '6px 14px 12px' }}>
              {top.map((t) => (
                <div key={t.item?.id || t.q} className="top-move clickable" onClick={() => t.item && navigate(`/warehouse/item/${t.item.id}`)}>
                  <div className="row" style={{ gap: 8 }}><span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{t.item?.name || 'Item'}</span><span className="num small">{qty(t.q)} {t.item?.baseUnit}</span></div>
                  <div className="top-move-bar"><span style={{ width: `${t.pct}%` }} /></div>
                </div>
              ))}
            </div>
          ) : <Empty icon={TrendingUp} title="Nothing went out this month" message="Stock Out and Send to Shop documents show here." />}
        </Card>
        <Card title={`Slow-moving stock (${SLOW_DAYS}+ days)`} subtitle="Held, but nothing has gone out in a while" tight>
          {slow.length ? slow.map((s) => (
            <div key={s.item.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/item/${s.item.id}${selected ? `?wh=${selected}` : ''}`)}>
              <span className="ico warning"><Hourglass size={15} /></span>
              <div className="body">
                <div className="t">{s.item.name}</div>
                <div className="s">{s.never ? `Never sent out · in since ${fmtDate(s.since)}` : `Last sent out ${fmtDate(s.since)}`}</div>
              </div>
              <span className="num" style={{ textAlign: 'right' }}>{qty(s.q)} {s.item.baseUnit}<div className="small muted">{s.idle} days</div></span>
            </div>
          )) : <Empty icon={CircleCheck} title="Everything is moving" message={`No held item has sat for ${SLOW_DAYS} days without going out.`} />}
        </Card>
      </div>

      <div className="grid-2 mb-2" style={{ alignItems: 'start' }}>
        <Card title="Recent Movements" tight actions={<Button size="sm" onClick={() => navigate('/warehouse/moves')}>View all</Button>}>
          {recent.length ? recent.map((m) => {
            const incoming = MOVE_TYPES[m.type]?.sign > 0;
            return (
              <div key={m.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/move/${m.id}`)} style={m.status === 'voided' ? { opacity: 0.55 } : undefined}>
                <span className={`ico ${m.type === 'transfer' ? 'info' : incoming ? 'success' : 'warning'}`}>
                  {m.type === 'transfer' ? <ArrowLeftRight size={15} /> : incoming ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
                </span>
                <div className="body">
                  <div className="t" style={{ textDecoration: m.status === 'voided' ? 'line-through' : 'none' }}>{m.docNo} · {MOVE_TYPES[m.type]?.label}</div>
                  <div className="s">{fmtDate(m.date)} · {routeText(m, whName)} · {m.count} item{m.count === 1 ? '' : 's'}</div>
                </div>
                <span className="num">{qty(m.units)}</span>
              </div>
            );
          }) : <Empty icon={ClipboardList} title="No movements yet" message="Record your first Stock In to get started." action={canMove ? <Button variant="primary" icon={ArrowDownToLine} onClick={() => navigate('/warehouse/new/in')}>Stock In</Button> : null} />}
        </Card>
        <Card title="Spending this month" subtitle={`${money(kpi.expenses)} across ${selected ? whName(selected) : 'all warehouses'}`} tight>
          {spendByCat.length ? (
            <table className="tbl">
              <tbody>
                {spendByCat.map(([c, v]) => (
                  <tr key={c}>
                    <td>{c}</td>
                    <td style={{ width: '42%' }}><div className="top-move-bar"><span style={{ width: `${kpi.expenses ? (v / kpi.expenses) * 100 : 0}%`, background: 'var(--brand-yellow)' }} /></div></td>
                    <td className="r strong">{money(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty icon={Wallet} title="No spending this month" message="Rent, labour and loading costs show here." />}
        </Card>
      </div>

      {access.can('whParties') && (
        <Card
          title="Parties & Khata"
          subtitle={sc ? 'Largest balances — who owes whom' : 'Most recent dealings'}
          tight
          className="mb-2"
          actions={<Button size="sm" onClick={() => navigate('/warehouse/parties')}>All parties</Button>}
        >
          {parties.length ? parties.map((p) => (
            <div key={p.id} className="alert-row clickable" onClick={() => navigate(`/warehouse/party/${p.id}`)}>
              <span className={`ico ${!sc || Math.abs(p.balance) <= 0.004 ? 'info' : p.balance > 0 ? 'danger' : 'warning'}`}><Users size={15} /></span>
              <div className="body">
                <div className="t">{p.name}</div>
                <div className="s">{[p.lastDate && `Last ${fmtDate(p.lastDate)}`, `In ${qty(p.receivedQty)}`, `Out ${qty(p.sentQty)}`].filter(Boolean).join(' · ')}</div>
              </div>
              {sc ? (
                <span className="num" style={{ textAlign: 'right' }}>
                  {money(Math.abs(p.balance))}
                  <div className="small muted">{p.balance > 0.004 ? 'owes you' : p.balance < -0.004 ? 'you owe' : 'settled'}</div>
                </span>
              ) : <span className="num">{p.moves} docs</span>}
            </div>
          )) : (
            <Empty
              icon={Users}
              title="No party dealings yet"
              message="Pick a party in Stock In or Stock Out and its khata shows here."
              action={<Button icon={Plus} onClick={() => navigate('/warehouse/parties')}>Add a party</Button>}
            />
          )}
        </Card>
      )}

      <Card
        title="In vs Out"
        subtitle={`Units per day, last ${days} days`}
        actions={<div className="seg">{[14, 30, 90].map((d) => <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d}d</button>)}</div>}
      >
        <div style={{ width: '100%', height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={trend} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="In" fill="#16A34A" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Out" fill="#D42A24" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      {selected && (
        <div className="mt-2 small muted" style={{ textAlign: 'center' }}>
          <Pill status="partial" label={whName(selected)} /> Showing one warehouse. <button className="btn btn-ghost btn-sm" onClick={() => setActiveWarehouse('all')}>Show all warehouses</button>
        </div>
      )}
    </>
  );
}
