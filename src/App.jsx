import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { AppProvider, useApp } from './lib/AppContext.jsx';
import Layout, { SHOP_NAV } from './components/Layout.jsx';
import { Button, Card } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import ChooseSystem from './pages/ChooseSystem.jsx';
import SharedLedger from './pages/SharedLedger.jsx';
import Dashboard from './pages/Dashboard.jsx';
import BillForm from './pages/BillForm.jsx';
import BillView from './pages/BillView.jsx';
import Bills from './pages/Bills.jsx';
import PurchaseView from './pages/PurchaseView.jsx';
import Parties from './pages/Parties.jsx';
import PartyLedger from './pages/PartyLedger.jsx';
import Outstanding from './pages/Outstanding.jsx';
import Items from './pages/Items.jsx';
import Returns from './pages/Returns.jsx';
import Cheques from './pages/Cheques.jsx';
import Employees, { EmployeeLedger } from './pages/Employees.jsx';
import Expenses from './pages/Expenses.jsx';
import StockLoss from './pages/StockLoss.jsx';
import Purchases from './pages/Purchases.jsx';
import Suppliers from './pages/Suppliers.jsx';
import SupplierLedger from './pages/SupplierLedger.jsx';
import Assets from './pages/Assets.jsx';
import Accounts, { AccountStatement } from './pages/Accounts.jsx';
import LedgerBook from './pages/LedgerBook.jsx';
import BalanceSheet from './pages/BalanceSheet.jsx';
import Profit from './pages/Profit.jsx';
import Audit from './pages/Audit.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';
import More from './pages/More.jsx';
import Users from './pages/Users.jsx';
import AllReports from './pages/AllReports.jsx';
import WarehouseLayout, { WH_NAV } from './warehouse/WarehouseLayout.jsx';
import WhDashboard from './warehouse/WhDashboard.jsx';
import Warehouses, { WarehouseDetail } from './warehouse/Warehouses.jsx';
import MoveForm from './warehouse/MoveForm.jsx';
import Moves, { MoveView } from './warehouse/Moves.jsx';
import Stock, { ItemCard } from './warehouse/Stock.jsx';
import StockCount from './warehouse/StockCount.jsx';
import WhExpenses from './warehouse/WhExpenses.jsx';
import WhReports from './warehouse/WhReports.jsx';
import WhMore from './warehouse/WhMore.jsx';
import WhParties, { WhPartyLedgerGate } from './warehouse/WhParties.jsx';

/** The first page of a system this user may open, or null. */
function firstPage(system, access) {
  const nav = system === 'warehouse' ? WH_NAV : SHOP_NAV;
  for (const g of nav) {
    const hit = g.items.find((it) => (it.super ? access.isSuper : it.page && access.can(it.page)));
    if (hit) return hit.to;
  }
  return null;
}

/** Signed in, and a system chosen — otherwise to the login or the chooser. */
function RequireSystem({ system, children }) {
  const { session, booted, system: chosen, access } = useApp();
  if (!booted) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (!chosen) return <Navigate to="/choose" replace />;
  if (chosen !== system) return <Navigate to={chosen === 'warehouse' ? '/warehouse' : '/'} replace />;
  if (!firstPage(system, access)) return <Navigate to="/choose" replace />;
  return children;
}

function RequireSession({ children }) {
  const { session, booted } = useApp();
  if (!booted) return null;
  return session ? children : <Navigate to="/login" replace />;
}

function NoAccess({ system }) {
  const { access } = useApp();
  const navigate = useNavigate();
  const home = firstPage(system, access);
  return (
    <div className="no-access">
      <Card>
        <div style={{ padding: '10px 4px', textAlign: 'center' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: 26, background: 'var(--accent-soft)', color: 'var(--accent)', marginBottom: 12 }}>
            <Lock size={22} />
          </span>
          <h2 className="h2" style={{ marginBottom: 6 }}>You don't have access to this page</h2>
          <p className="muted small" style={{ marginBottom: 16 }}>Ask the super admin to add it to your account.</p>
          {home && <Button variant="primary" onClick={() => navigate(home)}>Go to my pages</Button>}
        </div>
      </Card>
    </div>
  );
}

/** A page this user may open; anyone else sees why not. */
function Page({ page, superOnly = false, system = 'shop', children }) {
  const { access } = useApp();
  const ok = superOnly ? access.isSuper : Array.isArray(page) ? access.canAny(page) : access.can(page);
  return ok ? children : <NoAccess system={system} />;
}

/** The home page of a system, or the user's first page there when it is not theirs. */
function Home({ system, page, children }) {
  const { access } = useApp();
  if (access.can(page)) return children;
  const first = firstPage(system, access);
  return first ? <Navigate to={first} replace /> : <NoAccess system={system} />;
}

function AppRoutes() {
  const { session } = useApp();
  const W = (page, el) => <Page page={page} system="warehouse">{el}</Page>;
  const S = (page, el) => <Page page={page}>{el}</Page>;
  return (
    <Routes>
      <Route path="/share/:token" element={<SharedLedger />} />
      <Route path="/login" element={session ? <Navigate to="/choose" replace /> : <Login />} />
      <Route path="/choose" element={<RequireSession><ChooseSystem /></RequireSession>} />

      <Route element={<RequireSystem system="shop"><Layout /></RequireSystem>}>
        <Route index element={<Home system="shop" page="dashboard"><Dashboard /></Home>} />
        <Route path="bill/new" element={S('newBill', <BillForm />)} />
        <Route path="bill/:id/edit" element={S(['bills', 'newBill'], <BillForm />)} />
        <Route path="bill/:id" element={S(['bills', 'newBill', 'parties', 'outstanding', 'returns'], <BillView />)} />
        <Route path="purchase/:id" element={S('purchases', <PurchaseView />)} />
        <Route path="bills" element={S('bills', <Bills />)} />
        <Route path="parties" element={S('parties', <Parties />)} />
        <Route path="party/:id" element={S(['parties', 'outstanding'], <PartyLedger />)} />
        <Route path="outstanding" element={S('outstanding', <Outstanding />)} />
        <Route path="items" element={S('items', <Items />)} />
        <Route path="returns" element={S('returns', <Returns />)} />
        <Route path="cheques" element={S('cheques', <Cheques />)} />
        <Route path="employees" element={S('employees', <Employees />)} />
        <Route path="employee/:id" element={S('employees', <EmployeeLedger />)} />
        <Route path="expenses" element={S('expenses', <Expenses />)} />
        <Route path="stock-loss" element={S('stockLoss', <StockLoss />)} />
        <Route path="purchases" element={S('purchases', <Purchases />)} />
        <Route path="suppliers" element={S('suppliers', <Suppliers />)} />
        <Route path="supplier/:id" element={S('suppliers', <SupplierLedger />)} />
        <Route path="assets" element={S('assets', <Assets />)} />
        <Route path="accounts" element={S('accounts', <Accounts />)} />
        <Route path="account/:method" element={S('accounts', <AccountStatement />)} />
        <Route path="ledger-book" element={S('ledgerBook', <LedgerBook />)} />
        <Route path="balance-sheet" element={S('balanceSheet', <BalanceSheet />)} />
        <Route path="profit" element={S('profit', <Profit />)} />
        <Route path="audit" element={S('audit', <Audit />)} />
        <Route path="activity" element={S('activity', <Activity scope="shop" />)} />
        <Route path="reports" element={S('reports', <AllReports />)} />
        <Route path="users" element={<Page superOnly><Users /></Page>} />
        <Route path="settings" element={<Settings />} />
        <Route path="more" element={<More />} />
      </Route>

      <Route path="/warehouse" element={<RequireSystem system="warehouse"><WarehouseLayout /></RequireSystem>}>
        <Route index element={<Home system="warehouse" page="whDashboard"><WhDashboard /></Home>} />
        <Route path="list" element={W('warehouses', <Warehouses />)} />
        <Route path="w/:id" element={W('warehouses', <WarehouseDetail />)} />
        <Route path="new/:kind" element={W('whMoves', <MoveForm />)} />
        <Route path="moves" element={W('whMoves', <Moves />)} />
        <Route path="move/:id" element={W(['whMoves', 'whParties'], <MoveView />)} />
        <Route path="parties" element={W('whParties', <WhParties />)} />
        <Route path="party/:id" element={W('whParties', <WhPartyLedgerGate />)} />
        <Route path="count" element={W('whCount', <StockCount />)} />
        <Route path="stock" element={W('whStock', <Stock />)} />
        <Route path="item/:itemId" element={W(['whStock', 'whDashboard', 'whMoves'], <ItemCard />)} />
        <Route path="expenses" element={W('whExpenses', <WhExpenses />)} />
        <Route path="items" element={W('items', <Items />)} />
        <Route path="reports" element={W('whReports', <WhReports />)} />
        <Route path="all-reports" element={W('reports', <AllReports />)} />
        <Route path="activity" element={W('whActivity', <Activity scope="warehouse" />)} />
        <Route path="users" element={<Page superOnly system="warehouse"><Users /></Page>} />
        <Route path="settings" element={<Settings />} />
        <Route path="more" element={<WhMore />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AppProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AppProvider>
  );
}
