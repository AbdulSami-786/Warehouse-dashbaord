import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, BookOpen, Boxes, Building2, CalendarCheck, ChartColumn, ChevronRight, ClipboardList, CreditCard, Download,
  Landmark, LogOut, Package, Receipt, RotateCcw, Scale, ScrollText, Settings, ShieldCheck, ShoppingCart, TrendingUp, Truck,
  UserCog, Wallet, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { exportBackup } from '../lib/exporters.js';
import { WAREHOUSE_PAGES } from '../lib/permissions.js';
import { Button, Card, PageHead } from '../components/ui.jsx';
import { CloseToday } from '../components/forms.jsx';

const SECTIONS = [
  { label: 'Billing', items: [
    { to: '/bills', icon: Receipt, label: 'All Bills', desc: 'Search every bill', page: 'bills' },
    { to: '/returns', icon: RotateCcw, label: 'Returns', desc: 'Returns against bills', page: 'returns' },
  ] },
  { label: 'Buying', items: [{ to: '/suppliers', icon: Truck, label: 'Suppliers', desc: 'Parties you buy from — khata, payments, advances', page: 'suppliers' }] },
  { label: 'Money', items: [
    { to: '/cheques', icon: CreditCard, label: 'Cheques', desc: 'Pending, cleared, bounced', page: 'cheques' },
    { to: '/accounts', icon: Landmark, label: 'Accounts', desc: 'Balance per payment method', page: 'accounts' },
    { to: '/expenses', icon: Wallet, label: 'Expenses', desc: 'Running costs', page: 'expenses' },
    { to: '/assets', icon: Building2, label: 'Assets', desc: 'Business assets', page: 'assets' },
  ] },
  { label: 'Stock & Team', items: [
    { to: '/items', icon: Package, label: 'Items', desc: 'Products and stock', page: 'items' },
    { to: '/purchases', icon: ShoppingCart, label: 'Purchases', desc: 'Stock from suppliers', page: 'purchases' },
    { to: '/stock-loss', icon: Boxes, label: 'Damaged Stock', desc: 'Damaged or expired', page: 'stockLoss' },
    { to: '/employees', icon: UserCog, label: 'Employees', desc: 'Salaries and advances', page: 'employees' },
  ] },
  { label: 'Reports', items: [
    { to: '/reports', icon: ChartColumn, label: 'All Reports', desc: 'Shop and every warehouse together', page: 'reports' },
    { to: '/profit', icon: TrendingUp, label: 'Profit Report', desc: 'By item, party, day', page: 'profit' },
    { to: '/ledger-book', icon: BookOpen, label: 'Ledger Book', desc: 'Debit/credit khata', page: 'ledgerBook' },
    { to: '/balance-sheet', icon: Scale, label: 'Balance Sheet', desc: 'Owns vs owes', page: 'balanceSheet' },
    { to: '/audit', icon: ClipboardList, label: 'Audit Summary', desc: 'Financial health check', page: 'audit' },
    { to: '/activity', icon: ScrollText, label: 'Activity Log', desc: 'Every change recorded', page: 'activity' },
  ] },
  { label: 'System', items: [
    { to: '/users', icon: ShieldCheck, label: 'Users', desc: 'Who can sign in, and what they see', super: true },
    { to: '/settings', icon: Settings, label: 'Settings', desc: 'Shop, rules, password' },
  ] },
];

export function MenuRow({ icon: Icon, label, desc, onClick, tone = 'info' }) {
  return (
    <button className="alert-row" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }} onClick={onClick}>
      <span className={`ico ${tone}`}><Icon size={16} /></span>
      <div className="body"><div className="t">{label}</div><div className="s">{desc}</div></div>
      <ChevronRight size={17} className="muted" />
    </button>
  );
}

export default function More() {
  const navigate = useNavigate();
  const {
    data, settings, session, me, access, logout, toast, setSystem,
  } = useApp();
  const [closing, setClosing] = useState(false);
  const sections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((it) => (it.super ? access.isSuper : !it.page || access.can(it.page))) }))
    .filter((s) => s.items.length);
  return (
    <>
      <PageHead title="More" subtitle={settings.shopName} />
      <div className="row mb-2" style={{ gap: 8 }}>
        {access.canAny(['dashboard', 'bills']) && <Button icon={CalendarCheck} style={{ flex: 1 }} onClick={() => setClosing(true)}>Close Today</Button>}
        {access.isAdmin && <Button icon={Download} style={{ flex: 1 }} onClick={() => { exportBackup(data, settings.shopName); toast('Backup downloaded'); }}>Backup</Button>}
      </div>
      <div className="col" style={{ gap: 14 }}>
        {access.canAny(WAREHOUSE_PAGES) && (
          <Card tight>
            <MenuRow icon={Warehouse} label="Open Warehouse system" desc="Stock in, stock out and transfers across your warehouses" onClick={() => { setSystem('warehouse'); navigate('/warehouse'); }} />
            <MenuRow icon={ArrowLeftRight} label="Choose system" desc="Back to the Wholesale / Warehouse chooser" onClick={() => { setSystem(''); navigate('/choose'); }} />
          </Card>
        )}
        {sections.map((s) => (
          <Card key={s.label} title={s.label} tight>
            {s.items.map((it) => <MenuRow key={it.to} {...it} onClick={() => navigate(it.to)} />)}
          </Card>
        ))}
        <Card tight>
          <MenuRow icon={LogOut} tone="danger" label="Sign out" desc={`Signed in as ${me?.name || session?.username}`} onClick={logout} />
        </Card>
      </div>
      <CloseToday open={closing} onClose={() => setClosing(false)} />
    </>
  );
}
