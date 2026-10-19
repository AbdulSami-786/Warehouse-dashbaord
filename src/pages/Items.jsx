import { useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, Download, Package, Pencil, Plus,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, norm } from '../lib/format.js';
import { itemStock, warehouseStockMap } from '../lib/calc.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Confirm, Empty, Modal, Money, PageHead, Pill, SearchBox, Select,
} from '../components/ui.jsx';
import { ItemForm } from '../components/forms.jsx';
import ImportButton from '../components/ImportButton.jsx';

export default function Items() {
  const { data, settings, mutate, toast, access } = useApp();
  const sc = access.seesCost;
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toggling, setToggling] = useState(null);
  const categories = useMemo(() => [...new Set(data.items.map((i) => i.category).filter(Boolean))].sort(), [data.items]);
  const hasWarehouses = (data.warehouses || []).length > 0;
  const whStock = useMemo(() => warehouseStockMap(data), [data]);

  const rows = useMemo(() => {
    const s = norm(q);
    return data.items
      .filter((i) => (archived ? i.status === 'archived' : i.status !== 'archived'))
      .filter((i) => category === 'all' || i.category === category)
      .filter((i) => !s || norm(i.name).includes(s) || norm(i.category).includes(s))
      .map((i) => {
        const stock = itemStock(i.id, data);
        let inWh = 0;
        for (const m of whStock.values()) inWh += m.get(i.id) || 0;
        return {
          ...i, stock, inWh: r2(inWh),
          low: Number(i.lowStockAlert) > 0 && stock <= Number(i.lowStockAlert),
          value: r2(stock * (Number(i.costPrice) || 0)),
        };
      })
      .sort((a, b) => (b.low ? 1 : 0) - (a.low ? 1 : 0) || a.name.localeCompare(b.name));
  }, [data, q, category, archived, whStock]);
  const total = useMemo(() => r2(rows.reduce((s, i) => s + i.value, 0)), [rows]);

  const toggle = async () => {
    const it = toggling;
    setToggling(null);
    await mutate(() => api.archiveItem(it.id), it.status === 'archived' ? 'Item restored' : 'Item archived');
  };
  const toExcel = () => {
    exportCSV('Items', ['Item', 'Category', 'Base Unit', 'Alt Unit', 'Conversion', ...(sc ? ['Cost Price'] : []), 'Shop Stock', ...(hasWarehouses ? ['Warehouse Stock'] : []), 'Low Alert', ...(sc ? ['Stock Value'] : [])],
      rows.map((i) => [i.name, i.category, i.baseUnit, i.altUnit || '', i.conversionRate || '', ...(sc ? [Number(i.costPrice).toFixed(2)] : []), i.stock, ...(hasWarehouses ? [i.inWh] : []), i.lowStockAlert, ...(sc ? [i.value.toFixed(2)] : [])]),
      [`${settings.shopName} — Items`, ...(sc ? [`Total stock value: ${money(total)}`] : [])]);
    toast('Items exported');
  };

  return (
    <>
      <PageHead title="Items" subtitle={sc ? `${rows.length} items · ${money(total)} stock value at cost` : `${rows.length} items`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search items…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button onClick={() => setArchived((v) => !v)}>{archived ? 'Show active' : 'Show archived'}</Button>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="items" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Item</Button>
      </PageHead>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th><th>Units</th>{sc && <th className="r">Cost price</th>}<th className="r">Shop stock</th>
                    {hasWarehouses && <th className="r">In warehouses</th>}
                    <th className="r">Low alert</th>{sc && <th className="r">Stock value</th>}<th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{i.name}</div>
                        {i.lastPurchaseDate && <div className="small muted">Last purchased {fmtDate(i.lastPurchaseDate)}</div>}
                      </td>
                      <td>{i.category || <span className="muted">—</span>}</td>
                      <td className="small">
                        {i.baseUnit}
                        {i.altUnit && Number(i.conversionRate) > 0 && <div className="muted">1 {i.altUnit} = {i.conversionRate} {i.baseUnit}</div>}
                      </td>
                      {sc && <td className="r"><Money value={i.costPrice} /></td>}
                      <td className="r strong">
                        <span className="num" style={{ color: i.low ? 'var(--danger)' : undefined }}>{i.stock} {i.baseUnit}</span>
                        {i.low && <div><Pill status="due" label="Low stock" /></div>}
                      </td>
                      {hasWarehouses && <td className="r">{i.inWh ? <span className="num">{i.inWh} {i.baseUnit}</span> : <span className="muted">—</span>}</td>}
                      <td className="r muted">{Number(i.lowStockAlert) > 0 ? i.lowStockAlert : '—'}</td>
                      {sc && <td className="r strong"><Money value={i.value} /></td>}
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(i)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title={i.status === 'archived' ? 'Restore' : 'Archive'} onClick={() => setToggling(i)}>
                            {i.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={(hasWarehouses ? 7 : 6) - (sc ? 0 : 1)}>{rows.length} items</td>
                    {sc && <td className="r">{money(total)}</td>}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((i) => (
                <div key={i.id} className="mcard" onClick={() => setEditing(i)}>
                  <div className="top"><span className="name">{i.name}</span>{sc && <span className="amt">{money(i.costPrice)}</span>}</div>
                  <div className="meta">
                    {i.low && <Pill status="due" label="Low stock" />}
                    <span style={{ color: i.low ? 'var(--danger)' : undefined, fontWeight: 600 }}>{i.stock} {i.baseUnit}</span>
                    {hasWarehouses && i.inWh > 0 && <span>+{i.inWh} in warehouses</span>}
                    {i.category && <span>{i.category}</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={Package}
            title={q ? 'No matching items' : 'No items yet'}
            message={q ? `Nothing matches "${q}".` : 'Add items to start building bills.'}
            action={q ? null : <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first item</Button>}
          />
        )}
      </Card>
      <Modal open={adding} title="Add New Item" onClose={() => setAdding(false)}>
        <ItemForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Item'}`} onClose={() => setEditing(null)}>
        {editing && <ItemForm item={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
      <Confirm
        open={!!toggling}
        title={toggling?.status === 'archived' ? 'Restore item?' : 'Archive item?'}
        message={toggling?.status === 'archived'
          ? `"${toggling?.name}" will appear in billing dropdowns again.`
          : `"${toggling?.name}" will be hidden from billing dropdowns. Its sales history stays intact — nothing is deleted.`}
        confirmLabel={toggling?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={toggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}
