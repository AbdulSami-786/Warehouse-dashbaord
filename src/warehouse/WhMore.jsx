import { useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ChartColumn, ClipboardCheck, ClipboardList, LogOut, Package, ScrollText, Settings,
  ShieldCheck, SlidersHorizontal, Store, Users, Wallet, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { SHOP_PAGES } from '../lib/permissions.js';
import { Card, PageHead } from '../components/ui.jsx';
import { MenuRow } from '../pages/More.jsx';
import { WarehousePicker } from './WarehouseLayout.jsx';

const SECTIONS = [
  { label: 'Record Movement', items: [
    { to: '/warehouse/new/in', icon: ArrowDownToLine, label: 'Stock In', desc: 'Goods received into a warehouse', page: 'whMoves' },
    { to: '/warehouse/new/out', icon: ArrowUpFromLine, label: 'Stock Out', desc: 'Goods sent out to a customer', page: 'whMoves' },
    { to: '/warehouse/new/transfer', icon: ArrowLeftRight, label: 'Transfer', desc: 'Between two warehouses', page: 'whMoves' },
    { to: '/warehouse/new/to-shop', icon: Store, label: 'Shop ⇄ Warehouse', desc: 'Send to the shop, or bring back', page: 'whMoves' },
    { to: '/warehouse/new/adjust', icon: SlidersHorizontal, label: 'Adjustment', desc: 'Damaged, lost, count correction', page: 'whMoves' },
    { to: '/warehouse/count', icon: ClipboardCheck, label: 'Stock Count', desc: 'Count the shelves, fix every difference at once', page: 'whCount' },
  ] },
  { label: 'Records', items: [
    { to: '/warehouse/parties', icon: Users, label: 'Parties & Khata', desc: 'Suppliers and customers — goods, payments, share link', page: 'whParties' },
    { to: '/warehouse/list', icon: Warehouse, label: 'Warehouses', desc: 'Add, edit, archive', page: 'warehouses' },
    { to: '/warehouse/moves', icon: ClipboardList, label: 'All Movements', desc: 'Every document', page: 'whMoves' },
    { to: '/warehouse/expenses', icon: Wallet, label: 'Warehouse Expenses', desc: 'Rent, labour, loading…', page: 'whExpenses' },
    { to: '/warehouse/items', icon: Package, label: 'Items', desc: 'Products shared with the shop', page: 'items' },
  ] },
  { label: 'Reports', items: [
    { to: '/warehouse/all-reports', icon: ChartColumn, label: 'All Reports', desc: 'Shop and every warehouse together', page: 'reports' },
    { to: '/warehouse/reports', icon: ScrollText, label: 'Warehouse Reports', desc: 'In / out by item, warehouse, day', page: 'whReports' },
    { to: '/warehouse/activity', icon: ScrollText, label: 'Activity Log', desc: 'Every change recorded', page: 'whActivity' },
  ] },
  { label: 'System', items: [
    { to: '/warehouse/users', icon: ShieldCheck, label: 'Users', desc: 'Who can sign in, and what they see', super: true },
    { to: '/warehouse/settings', icon: Settings, label: 'Settings', desc: 'Shop, password, backup' },
  ] },
];

export default function WhMore() {
  const navigate = useNavigate();
  const {
    session, me, access, logout, setSystem, settings,
  } = useApp();
  const sections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((it) => (it.super ? access.isSuper : !it.page || access.can(it.page))) }))
    .filter((s) => s.items.length);
  return (
    <>
      <PageHead title="More" subtitle={`${settings.shopName} · Warehouse`}>
        <WarehousePicker style={{ width: '100%' }} />
      </PageHead>
      <div className="col" style={{ gap: 14 }}>
        {access.canAny(SHOP_PAGES) && (
          <Card tight>
            <MenuRow icon={Store} label="Open Wholesale Shop" desc="Billing, parties and khata" onClick={() => { setSystem('shop'); navigate('/'); }} />
            <MenuRow icon={ArrowLeftRight} label="Choose system" desc="Back to the Wholesale / Warehouse chooser" onClick={() => { setSystem(''); navigate('/choose'); }} />
          </Card>
        )}
        {sections.map((s) => (
          <Card key={s.label} title={s.label} tight>
            {s.items.map((it) => <MenuRow key={it.to} {...it} onClick={() => navigate(it.to)} />)}
          </Card>
        ))}
        <Card tight><MenuRow icon={LogOut} tone="danger" label="Sign out" desc={`Signed in as ${me?.name || session?.username}`} onClick={logout} /></Card>
      </div>
    </>
  );
}
