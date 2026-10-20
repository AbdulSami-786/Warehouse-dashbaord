import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, BookOpen, Boxes, Building2, CalendarCheck, CircleAlert, ClipboardList, CreditCard, Download,
  Ellipsis, FilePlus2, Landmark, LayoutDashboard, LogOut, Package, Plus, Receipt, RotateCcw, Scale,
  ScrollText, Settings, ShieldCheck, ShoppingCart, TrendingUp, Truck, UserCog, Users, Wallet, ChartColumn,
  Cloud, CloudOff, RefreshCw, TriangleAlert,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { billStates, partyDue } from '../lib/calc.js';
import { exportBackup } from '../lib/exporters.js';
import { Button, Modal, Skeleton, Toasts } from './ui.jsx';
import { CloseToday } from './forms.jsx';
import { ROLES, SHOP_PAGES, WAREHOUSE_PAGES } from '../lib/permissions.js';

// Public files, relative so they load from a web host and from the desktop app alike.
export const LOGO = `${import.meta.env.BASE_URL}sga-logo.png`;
export const ICON = `${import.meta.env.BASE_URL}app-icon.png`;

export const SHOP_NAV = [
  {
    label: 'Billing',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true, page: 'dashboard' },
      { to: '/bill/new', icon: FilePlus2, label: 'New Bill', page: 'newBill' },
      { to: '/bills', icon: Receipt, label: 'All Bills', page: 'bills' },
      { to: '/returns', icon: RotateCcw, label: 'Returns', page: 'returns' },
    ],
  },
  {
    label: 'Parties & Ledger',
    items: [
      { to: '/parties', icon: Users, label: 'Parties', page: 'parties' },
      { to: '/suppliers', icon: Truck, label: 'Suppliers', page: 'suppliers' },
      { to: '/outstanding', icon: CircleAlert, label: 'Outstanding', badge: 'due', page: 'outstanding' },
      { to: '/ledger-book', icon: BookOpen, label: 'Ledger Book', page: 'ledgerBook' },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/cheques', icon: CreditCard, label: 'Cheques', page: 'cheques' },
      { to: '/accounts', icon: Landmark, label: 'Accounts', page: 'accounts' },
      { to: '/expenses', icon: Wallet, label: 'Expenses', page: 'expenses' },
      { to: '/assets', icon: Building2, label: 'Assets', page: 'assets' },
    ],
  },
  {
    label: 'Stock & Team',
    items: [
      { to: '/items', icon: Package, label: 'Items', page: 'items' },
      { to: '/purchases', icon: ShoppingCart, label: 'Purchases', page: 'purchases' },
      { to: '/stock-loss', icon: Boxes, label: 'Damaged Stock', page: 'stockLoss' },
      { to: '/employees', icon: UserCog, label: 'Employees', page: 'employees' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/reports', icon: ChartColumn, label: 'All Reports', page: 'reports' },
      { to: '/profit', icon: TrendingUp, label: 'Profit Report', page: 'profit' },
      { to: '/balance-sheet', icon: Scale, label: 'Balance Sheet', page: 'balanceSheet' },
      { to: '/audit', icon: ClipboardList, label: 'Audit Summary', page: 'audit' },
      { to: '/activity', icon: ScrollText, label: 'Activity Log', page: 'activity' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/users', icon: ShieldCheck, label: 'Users', super: true },
      { to: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
];

const TABS = [
  { to: '/', icon: LayoutDashboard, label: 'Home', end: true, page: 'dashboard' },
  { to: '/parties', icon: Users, label: 'Parties', page: 'parties' },
  { to: '/bill/new', icon: Plus, label: 'New Bill', primary: true, page: 'newBill' },
  { to: '/outstanding', icon: CircleAlert, label: 'Due', page: 'outstanding' },
  { to: '/more', icon: Ellipsis, label: 'More' },
];

/** Sidebar + topbar frame shared by the shop and the warehouse systems. */
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'not yet');

/** Desktop app: online or offline, and what is waiting to upload. Opens the details. */
function SyncBadge({ compact = false }) {
  const { sync, syncNow, clearSyncProblems } = useApp();
  const [open, setOpen] = useState(false);
  if (!sync) return null;
  const trouble = sync.problems.length > 0 || !!sync.lastError;
  let tone = 'ok';
  let Icon = Cloud;
  let label = 'Online';
  // A background sync only spins the icon: it runs after every save.
  if (!sync.online) {
    tone = 'off'; Icon = CloudOff; label = sync.pending ? `Offline · ${sync.pending} waiting` : 'Offline';
  } else if (trouble) {
    tone = 'bad'; Icon = TriangleAlert; label = 'Sync problem';
  } else if (sync.pending) {
    tone = 'off'; Icon = RefreshCw; label = `${sync.pending} waiting`;
  }
  return (
    <>
      <button className={`sync-badge sync-${tone}`} onClick={() => setOpen(true)} title="Connection and offline changes">
        {sync.syncing ? <RefreshCw size={14} className="spin" /> : <Icon size={14} />}
        {compact ? (sync.pending ? sync.pending : '') : label}
      </button>
      <Modal
        open={open}
        title="Connection"
        onClose={() => setOpen(false)}
        footer={(
          <>
            {(trouble || sync.notes.length > 0) && <Button onClick={clearSyncProblems}>Clear list</Button>}
            <Button variant="primary" icon={RefreshCw} loading={sync.syncing} onClick={syncNow}>Sync now</Button>
          </>
        )}
      >
        <div className="sync-details">
          <p>
            <strong>{sync.online ? 'Connected to the Google Sheet.' : 'No internet connection.'}</strong>{' '}
            Everything you save is kept on this computer straight away and uploads to the Sheet by itself
            {sync.online ? ' within a few seconds.' : ' when the internet is back. Keep working as normal.'}
          </p>
          <p>Changes waiting to upload: <strong>{sync.pending}</strong></p>
          <p className="muted small">Last upload: {when(sync.lastSync)}</p>
          <p className="muted small">Without internet you cannot change users, settings, party passwords or share links, or import files.</p>
          {sync.lastError && <div className="note sync-error"><TriangleAlert size={15} /> {sync.lastError}</div>}
          {sync.notes.length > 0 && (
            <>
              <p><strong>Renumbered bills</strong></p>
              <ul className="sync-problems">
                {sync.notes.map((x, i) => <li key={i}><span className="muted small">{when(x.at)}</span><br />{x.text}</li>)}
              </ul>
            </>
          )}
          {sync.problems.length > 0 && (
            <>
              <p><strong>Not uploaded</strong></p>
              <ul className="sync-problems">
                {sync.problems.map((x, i) => (
                  <li key={i}><span className="muted small">{when(x.at)} · {x.tab} {x.id}</span><br />{x.error}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

export function Frame({
  variant = 'shop', brandSub, nav, badges = {}, title, topbarSub, topActions, mobileTabs, fab,
}) {
  const { session, me, access, logout, settings, toasts, loading, booted, setSystem } = useApp();
  const navigate = useNavigate();
  const switchSystem = () => {
    setSystem('');
    navigate('/choose');
  };
  // Only the pages this user may open; a group with none left disappears.
  const groups = nav
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.super ? access.isSuper : access.can(it.page))) }))
    .filter((g) => g.items.length);
  const tabs = mobileTabs.filter((t) => access.can(t.page));
  const bothSystems = access.canAny(SHOP_PAGES) && access.canAny(WAREHOUSE_PAGES);
  const roleLabel = ROLES.find((r) => r.value === access.role)?.label || '';
  return (
    <div className={`app ${variant === 'warehouse' ? 'app-wh' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-logo"><img src={LOGO} alt={settings.shopName || 'SGA Balloon Merchant'} /></span>
          <span className="brand-sub">{brandSub}</span>
        </div>
        {bothSystems && (
          <button className="nav-item switch-system" onClick={switchSystem} title="Choose Wholesale Shop or Warehouse">
            <ArrowLeftRight size={16} />
            {variant === 'warehouse' ? 'Switch to Wholesale' : 'Switch to Warehouse'}
          </button>
        )}
        <nav style={{ flex: 1, paddingBottom: 12 }}>
          {groups.map((g) => (
            <div key={g.label} className="nav-group">
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <it.icon size={16} />
                  {it.label}
                  {it.badge && badges[it.badge] > 0 && <span className="nav-badge">{badges[it.badge]}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ padding: 12, borderTop: '1px solid rgba(255,255,255,.12)' }}>
          <button className="nav-item" style={{ width: '100%' }} onClick={logout}>
            <LogOut size={16} /> Sign out
            <span className="user-chip">{me?.name || session?.username}</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="shop">
            <span>
              {settings.shopName}
              <small>{topbarSub}</small>
            </span>
            {roleLabel && <span className="role-pill" title={`Signed in as ${me?.name || session?.username}`}>{roleLabel}</span>}
          </div>
          <SyncBadge />
          <div className="spacer" />
          {topActions}
        </header>
        <header className="mobile-topbar">
          <img className="mobile-brand" src={ICON} alt="" />
          <span className="title">{title}</span>
          <SyncBadge compact />
          {bothSystems && <button className="btn btn-ghost btn-icon" onClick={switchSystem} aria-label="Switch system" title="Switch system"><ArrowLeftRight size={17} /></button>}
        </header>
        <main className="page">
          {session?.defaultPassword && (
            <div className="note" style={{ marginBottom: 14, background: 'var(--warning-bg)', borderColor: '#FDE68A', color: '#B45309' }}>
              <CircleAlert size={15} style={{ flex: 'none' }} />
              <span style={{ flex: 1 }}>You signed in with the default password. Anyone who knows it can open your books — change it now.</span>
              <Button size="sm" onClick={() => navigate(variant === 'warehouse' ? '/warehouse/settings' : '/settings')}>Change password</Button>
            </div>
          )}
          {loading && !booted ? <Skeleton rows={6} /> : <Outlet />}
        </main>
      </div>
      {fab}
      <nav className="tabbar">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <t.icon size={20} />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Toasts toasts={toasts} />
    </div>
  );
}

export default function Layout() {
  const { data, settings, toast, access } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [closing, setClosing] = useState(false);
  const owing = useMemo(() => {
    const states = billStates(data.bills, data);
    return data.parties.filter((p) => partyDue(p.id, states) > 0).length;
  }, [data]);
  const title = useMemo(() => {
    for (const g of SHOP_NAV) {
      const hit = g.items.find((it) => (it.end ? location.pathname === it.to : location.pathname.startsWith(it.to)));
      if (hit) return hit.label;
    }
    if (location.pathname.startsWith('/party/')) return 'Party Ledger';
    if (location.pathname.startsWith('/bill/')) return 'Bill';
    if (location.pathname === '/more') return 'More';
    return settings.shopName;
  }, [location.pathname, settings.shopName]);
  const backup = () => {
    try {
      exportBackup(data, settings.shopName);
      toast('Backup downloaded', 'success');
    } catch {
      toast('Backup failed', 'error');
    }
  };
  return (
    <>
      <Frame
        variant="shop"
        brandSub="Wholesale Dashboard"
        nav={SHOP_NAV}
        badges={{ due: owing }}
        title={title}
        topbarSub={settings.phone || 'Wholesale Management'}
        topActions={(
          <>
            {access.canAny(['dashboard', 'bills']) && <Button icon={CalendarCheck} onClick={() => setClosing(true)}>Close Today</Button>}
            {access.isAdmin && <Button icon={Download} onClick={backup}>Backup</Button>}
            {access.can('newBill') && <Button variant="primary" icon={FilePlus2} onClick={() => navigate('/bill/new')}>New Bill</Button>}
          </>
        )}
        mobileTabs={TABS}
        fab={access.can('newBill') ? <button className="fab" onClick={() => navigate('/bill/new')} aria-label="New Bill"><Plus size={25} /></button> : null}
      />
      <CloseToday open={closing} onClose={() => setClosing(false)} />
    </>
  );
}
