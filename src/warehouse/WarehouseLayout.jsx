import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Boxes, ClipboardList, Ellipsis, LayoutDashboard, Package, Plus,
  ScrollText, Settings, SlidersHorizontal, Store, Wallet, Warehouse, ClipboardCheck, ChartColumn, ShieldCheck,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { Frame } from '../components/Layout.jsx';
import { Button, Select } from '../components/ui.jsx';

export const WH_NAV = [
  {
    label: 'Warehouse',
    items: [
      { to: '/warehouse', icon: LayoutDashboard, label: 'Overview', end: true, page: 'whDashboard' },
      { to: '/warehouse/list', icon: Warehouse, label: 'Warehouses', page: 'warehouses' },
      { to: '/warehouse/stock', icon: Boxes, label: 'Stock', page: 'whStock' },
    ],
  },
  {
    label: 'Record Movement',
    items: [
      { to: '/warehouse/new/in', icon: ArrowDownToLine, label: 'Stock In', page: 'whMoves' },
      { to: '/warehouse/new/out', icon: ArrowUpFromLine, label: 'Stock Out', page: 'whMoves' },
      { to: '/warehouse/new/transfer', icon: ArrowLeftRight, label: 'Transfer', page: 'whMoves' },
      { to: '/warehouse/new/to-shop', icon: Store, label: 'Shop ⇄ Warehouse', page: 'whMoves' },
      { to: '/warehouse/new/adjust', icon: SlidersHorizontal, label: 'Adjustment', page: 'whMoves' },
      { to: '/warehouse/count', icon: ClipboardCheck, label: 'Stock Count', page: 'whCount' },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/warehouse/moves', icon: ClipboardList, label: 'All Movements', page: 'whMoves' },
      { to: '/warehouse/expenses', icon: Wallet, label: 'Warehouse Expenses', page: 'whExpenses' },
      { to: '/warehouse/items', icon: Package, label: 'Items', page: 'items' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/warehouse/all-reports', icon: ChartColumn, label: 'All Reports', page: 'reports' },
      { to: '/warehouse/reports', icon: ScrollText, label: 'Warehouse Reports', page: 'whReports' },
      { to: '/warehouse/activity', icon: ScrollText, label: 'Activity Log', page: 'whActivity' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/warehouse/users', icon: ShieldCheck, label: 'Users', super: true },
      { to: '/warehouse/settings', icon: Settings, label: 'Settings' },
    ],
  },
];

const TABS = [
  { to: '/warehouse', icon: LayoutDashboard, label: 'Home', end: true, page: 'whDashboard' },
  { to: '/warehouse/stock', icon: Boxes, label: 'Stock', page: 'whStock' },
  { to: '/warehouse/new/in', icon: Plus, label: 'Stock In', primary: true, page: 'whMoves' },
  { to: '/warehouse/moves', icon: ClipboardList, label: 'Moves', page: 'whMoves' },
  { to: '/warehouse/more', icon: Ellipsis, label: 'More' },
];

/** The warehouse picker in the topbar: one warehouse, or all of them. */
export function WarehousePicker({ style }) {
  const { activeWarehouses, activeWarehouse, setActiveWarehouse } = useApp();
  const valid = activeWarehouse === 'all' || activeWarehouses.some((w) => w.id === activeWarehouse);
  return (
    <Select
      value={valid ? activeWarehouse : 'all'}
      onChange={(e) => setActiveWarehouse(e.target.value)}
      style={{ width: 190, ...style }}
      aria-label="Warehouse"
    >
      <option value="all">All warehouses</option>
      {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ''}</option>)}
    </Select>
  );
}

/** The selected warehouse id, or null for all — ignoring one that was archived. */
export function useSelectedWarehouse() {
  const { activeWarehouses, activeWarehouse } = useApp();
  return activeWarehouse !== 'all' && activeWarehouses.some((w) => w.id === activeWarehouse) ? activeWarehouse : null;
}

export default function WarehouseLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, access } = useApp();
  const title = useMemo(() => {
    for (const g of WH_NAV) {
      const hit = g.items.find((it) => (it.end ? location.pathname === it.to : location.pathname.startsWith(it.to)));
      if (hit) return hit.label;
    }
    if (location.pathname.startsWith('/warehouse/w/')) return 'Warehouse';
    if (location.pathname.startsWith('/warehouse/move/')) return 'Movement';
    if (location.pathname.startsWith('/warehouse/item/')) return 'Item Card';
    if (location.pathname.startsWith('/warehouse/users')) return 'Users';
    return 'Warehouse';
  }, [location.pathname]);
  return (
    <Frame
      variant="warehouse"
      brandSub="Warehouse System"
      nav={WH_NAV}
      title={title}
      topbarSub={settings.phone ? `Warehouse · ${settings.phone}` : 'Warehouse Management'}
      topActions={access.can('whMoves') ? (
        <>
          <Button icon={ArrowUpFromLine} onClick={() => navigate('/warehouse/new/out')}>Stock Out</Button>
          <Button variant="primary" icon={ArrowDownToLine} onClick={() => navigate('/warehouse/new/in')}>Stock In</Button>
        </>
      ) : null}
      mobileTabs={TABS}
      fab={access.can('whMoves') ? <button className="fab" onClick={() => navigate('/warehouse/new/in')} aria-label="Stock In"><Plus size={25} /></button> : null}
    />
  );
}
