import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardCheck, Eraser, Printer, Save, TriangleAlert, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import {
  money, qty, r2, today, fmtDate, norm,
} from '../lib/format.js';
import { warehouseStockMap } from '../lib/calc.js';
import { printReport } from '../lib/exporters.js';
import {
  Button, Card, Empty, Field, Input, PageHead, Select, SearchBox, Stat,
} from '../components/ui.jsx';
import { useSelectedWarehouse } from './WarehouseLayout.jsx';

const DRAFT_KEY = 'jh_stockCount';

function readDraft(wid) {
  try { return JSON.parse(localStorage.getItem(`${DRAFT_KEY}:${wid}`) || 'null') || {}; } catch { return {}; }
}
function writeDraft(wid, counts) {
  try {
    if (Object.keys(counts).length) localStorage.setItem(`${DRAFT_KEY}:${wid}`, JSON.stringify(counts));
    else localStorage.removeItem(`${DRAFT_KEY}:${wid}`);
  } catch { /* storage full */ }
}

/**
 * Count what is physically on the shelves and let the books follow. Every
 * difference becomes one adjustment document — shortages out, surpluses in —
 * so a count is recorded and traceable rather than typed over the stock.
 */
export default function StockCount() {
  const {
    data, settings, activeWarehouses, mutate, access,
  } = useApp();
  const navigate = useNavigate();
  const selected = useSelectedWarehouse();
  const [wid, setWid] = useState(selected || activeWarehouses[0]?.id || '');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('held');
  const [counts, setCounts] = useState(() => (wid ? readDraft(wid) : {}));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => { if (!wid && activeWarehouses[0]) setWid(activeWarehouses[0].id); }, [wid, activeWarehouses]);
  useEffect(() => { setCounts(wid ? readDraft(wid) : {}); setDone(null); }, [wid]);
  useEffect(() => { if (wid) writeDraft(wid, counts); }, [wid, counts]);

  const books = useMemo(() => warehouseStockMap(data).get(wid) || new Map(), [data, wid]);
  const wh = activeWarehouses.find((w) => w.id === wid);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.items
      .filter((i) => i.status !== 'archived')
      .filter((i) => scope === 'all' || books.has(i.id) || counts[i.id] !== undefined)
      .filter((i) => !s || norm(i.name).includes(s) || norm(i.category).includes(s))
      .map((i) => {
        const have = r2(books.get(i.id) || 0);
        const raw = counts[i.id];
        const counted = raw === undefined || raw === '' ? null : Number(raw);
        const diff = counted === null || !Number.isFinite(counted) ? null : r2(counted - have);
        return { item: i, have, raw: raw ?? '', counted, diff };
      })
      .sort((a, b) => a.item.name.localeCompare(b.item.name));
  }, [data.items, books, counts, q, scope]);

  const entered = useMemo(() => Object.entries(counts).filter(([, v]) => v !== '' && v !== undefined), [counts]);
  const bad = entered.filter(([, v]) => !(Number(v) >= 0));
  const stats = useMemo(() => {
    let short = 0;
    let extra = 0;
    let shortQ = 0;
    let extraQ = 0;
    let value = 0;
    entered.forEach(([itemId, v]) => {
      const d = r2(Number(v) - (books.get(itemId) || 0));
      const cost = Number(data.items.find((i) => i.id === itemId)?.costPrice) || 0;
      if (d < -0.0001) { short += 1; shortQ += -d; value += d * cost; }
      if (d > 0.0001) { extra += 1; extraQ += d; value += d * cost; }
    });
    return { short, extra, shortQ: r2(shortQ), extraQ: r2(extraQ), value: r2(value), counted: entered.length };
  }, [entered, books, data.items]);

  const setCount = (itemId, v) => setCounts((c) => ({ ...c, [itemId]: v }));
  const matchBooks = () => setCounts((c) => {
    const next = { ...c };
    rows.forEach((r) => { if (next[r.item.id] === undefined || next[r.item.id] === '') next[r.item.id] = String(r.have); });
    return next;
  });

  const printSheet = () => printReport({
    title: `Stock Count Sheet — ${wh?.name || 'Warehouse'}`,
    subtitle: `Date ${fmtDate(date)} · Count every item and write the quantity found`,
    shopName: settings.shopName,
    headers: ['#', 'Item', 'Category', 'Unit', { label: 'Counted', align: 'r' }, 'Remarks'],
    rows: rows.map((r, i) => [i + 1, r.item.name, r.item.category || '', r.item.baseUnit, '', '']),
    footerHtml: '<div class="sign"><div>Counted by</div><div>Checked by</div><div>Approved by</div></div>',
  });

  const save = async () => {
    if (busy || !wid || !entered.length || bad.length) return;
    setBusy(true);
    try {
      const res = await mutate(() => api.saveStockCount({
        warehouseId: wid, date, note, counts: entered.map(([itemId, counted]) => ({ itemId, counted: Number(counted) })),
      }), 'Stock count saved — the books now match what you counted');
      setDone(res);
      setCounts({});
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };

  if (!activeWarehouses.length) {
    return (
      <>
        <PageHead title="Stock Count" subtitle="Count the shelves and correct the books" />
        <Card><Empty icon={Warehouse} title="Add a warehouse first" message="A count is taken in one warehouse at a time." action={<Button variant="primary" onClick={() => navigate('/warehouse/list')}>Add Warehouse</Button>} /></Card>
      </>
    );
  }

  return (
    <>
      <PageHead title="Stock Count" subtitle={`${wh?.name || ''} · type what you find on the shelves; differences are adjusted for you`}>
        <Button icon={Printer} onClick={printSheet}>Print Count Sheet</Button>
        <Button icon={Eraser} onClick={() => setCounts({})} disabled={!entered.length}>Clear</Button>
        <Button variant="primary" icon={Save} loading={busy} onClick={save} disabled={!entered.length || bad.length > 0}>Save Count</Button>
      </PageHead>

      {done && (
        <div className="note mb-2" style={{ background: 'var(--success-bg)', borderColor: '#BBF7D0', color: '#15803D' }}>
          <ClipboardCheck size={15} />
          <span style={{ flex: 1 }}>
            Saved: {done.shortages} shortage{done.shortages === 1 ? '' : 's'} and {done.surpluses} surplus item{done.surpluses === 1 ? '' : 's'} adjusted
            {(done.moves || []).length ? ` (${done.moves.map((m) => m.docNo).join(', ')})` : ''}.
          </span>
          {(done.moves || []).map((m) => <Button key={m.id} size="sm" onClick={() => navigate(`/warehouse/move/${m.id}`)}>Open {m.docNo}</Button>)}
        </div>
      )}

      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Field label="Warehouse">
          <Select value={wid} onChange={(e) => setWid(e.target.value)}>
            {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Count date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Month-end count" /></Field>
      </div>

      <div className="stat-grid">
        <Stat label="Items counted" value={stats.counted} icon={ClipboardCheck} tone="#1F2937" note={`${rows.length} in this list`} />
        <Stat label="Short" value={stats.short} icon={TriangleAlert} tone="#DC2626" note={stats.shortQ ? `${qty(stats.shortQ)} units missing` : 'Nothing missing'} />
        <Stat label="Extra" value={stats.extra} icon={ClipboardCheck} tone="#16A34A" note={stats.extraQ ? `${qty(stats.extraQ)} units found` : 'Nothing extra'} />
        {access.seesCost && <Stat label="Value of difference" value={money(stats.value)} icon={ClipboardCheck} tone={stats.value < 0 ? '#DC2626' : '#16A34A'} note="At cost price" />}
      </div>

      <Card
        tight
        title="Count"
        subtitle="Leave an item empty to skip it — only counted items are adjusted"
        actions={(
          <div className="row wrap" style={{ gap: 8 }}>
            <SearchBox value={q} onChange={setQ} placeholder="Search item…" style={{ minWidth: 180 }} />
            <Select value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: 170 }} options={[{ value: 'held', label: 'Items in this warehouse' }, { value: 'all', label: 'All items' }]} />
            <Button size="sm" onClick={matchBooks} title="Fill every empty count with the book quantity, then correct only what differs">Fill from books</Button>
          </div>
        )}
      >
        {rows.length ? (
          <div className="count-list">
            {rows.map((r) => (
              <div key={r.item.id} className={`count-row ${r.diff === null ? '' : r.diff < 0 ? 'short' : r.diff > 0 ? 'extra' : 'ok'}`}>
                <div className="count-name">
                  <div style={{ fontWeight: 600 }}>{r.item.name}</div>
                  <div className="small muted">{[r.item.category, r.item.baseUnit].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="count-books"><span className="small muted">Books</span><span className="num">{qty(r.have)}</span></div>
                <label className="count-input">
                  <span className="small muted">Counted</span>
                  <Input type="number" min="0" step="any" inputMode="decimal" value={r.raw} placeholder="—" onChange={(e) => setCount(r.item.id, e.target.value)} aria-label={`Counted ${r.item.name}`} />
                </label>
                <div className="count-diff">
                  <span className="small muted">Difference</span>
                  <span className="num strong">{r.diff === null ? '—' : r.diff === 0 ? '✓' : `${r.diff > 0 ? '+' : ''}${qty(r.diff)}`}</span>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty icon={ClipboardCheck} title="No items here" message={scope === 'held' ? 'This warehouse holds nothing yet. Switch to "All items" to count goods that are not on the books.' : 'No item matches your search.'} />}
      </Card>
    </>
  );
}
