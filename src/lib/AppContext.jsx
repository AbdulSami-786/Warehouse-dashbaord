import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { PAYMENT_METHODS } from './config.js';
import { getSession, SESSION_KEY } from './localAdapter.js';
import { SESSION_ENDED_EVENT } from './sheetsAdapter.js';
import { clearSyncProblems, DATA_SYNCED_EVENT, isDesktop, onSyncStatus, syncNow as syncDesktop } from './hybridAdapter.js';
import { relockAll } from './partyLock.js';
import { accessFor } from './permissions.js';

const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

const EMPTY = {
  parties: [], items: [], partyItemPrices: [], bills: [], billItems: [], payments: [], returns: [],
  cheques: [], partyAdvances: [], purchases: [], employees: [], employeeTx: [], expenses: [],
  stockLoss: [], assets: [], activityLog: [], partyLedgerLinks: [], suppliers: [], purchaseBills: [],
  supplierPayments: [], supplierReturns: [],
  warehouses: [], whMoves: [], whMoveLines: [], whExpenses: [], whParties: [], whPartyPayments: [], journal: [],
  settings: {
    shopName: 'SGA Balloon Merchant', phone: '', address: '', email: '', logoUrl: '',
    roundingRule: 'nearest1', priceAlertThreshold: 15, defaultCreditDays: 7, customMethods: [],
  },
};

// Which side of the business this tab is working in, chosen after login.
const SYSTEM_KEY = 'jh_system';
const WAREHOUSE_KEY = 'jh_active_warehouse';

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function writePref(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

export function AppProvider({ children }) {
  const [session, setSession] = useState(() => getSession());
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [booted, setBooted] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [system, setSystemState] = useState(() => readPref(SYSTEM_KEY, ''));
  const [activeWarehouse, setActiveWarehouseState] = useState(() => readPref(WAREHOUSE_KEY, 'all'));
  const toastId = useRef(0);
  // Desktop app only: online or not, and what is waiting to upload.
  const [sync, setSync] = useState(null);
  useEffect(() => (isDesktop ? onSyncStatus(setSync) : undefined), []);

  const toast = useCallback((message, type = 'success') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.bootstrap();
      const settings = { ...EMPTY.settings };
      Object.entries(res.settings || {}).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') settings[k] = v;
      });
      // The business was renamed; a name saved before the rename shows as the new one.
      if (String(settings.shopName).trim() === 'J.H Enterprises') settings.shopName = EMPTY.settings.shopName;
      setData({ ...EMPTY, ...res, settings });
      return res;
    } catch (err) {
      if (!silent) toast(err.message || 'Could not load data', 'error');
      throw err;
    } finally {
      if (!silent) setLoading(false);
      setBooted(true);
    }
  }, [toast]);

  useEffect(() => {
    if (session) refresh().catch(() => {});
    else setBooted(true);
  }, [session, refresh]);

  // The desktop app syncs with the Sheet in the background; show what it brought.
  useEffect(() => {
    if (!isDesktop || !session) return undefined;
    const onSynced = () => refresh({ silent: true }).catch(() => {});
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
  }, [session, refresh]);

  /** Sync with the Sheet now, from the connection window. */
  const syncNow = useCallback(() => syncDesktop(), []);

  const logoutRef = useRef(() => {});

  // Sign out when the session ends in this tab or another one.
  useEffect(() => {
    if (!session) return undefined;
    const left = (session.expiresAt || 0) - Date.now();
    if (left <= 0) {
      logoutRef.current();
      return undefined;
    }
    const expired = () => {
      logoutRef.current();
      toast('Your session expired — please sign in again', 'info');
    };
    const MAX_TIMEOUT = 2 ** 31 - 1;
    const timer = left <= MAX_TIMEOUT ? setTimeout(expired, left) : null;
    const onStorage = (e) => { if (e.key === SESSION_KEY && !getSession()) logoutRef.current(); };
    const onVisible = () => { if (document.visibilityState === 'visible' && !getSession()) expired(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SESSION_ENDED_EVENT, expired);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SESSION_ENDED_EVENT, expired);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, toast]);

  // Another tab of the dashboard saved something: show it here too.
  useEffect(() => {
    if (!session) return undefined;
    const onStorage = (e) => { if (e.key === 'jh_db_v1') refresh({ silent: true }).catch(() => {}); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [session, refresh]);

  /** Take over a session the server issued: on sign-in, or after a password change. */
  const adoptSession = useCallback((s) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
  }, []);

  const login = useCallback(async (username, password) => {
    const s = await api.login(username, password);
    adoptSession(s);
    return s;
  }, [adoptSession]);

  const setSystem = useCallback((next) => {
    writePref(SYSTEM_KEY, next);
    setSystemState(next || '');
  }, []);

  const setActiveWarehouse = useCallback((id) => {
    writePref(WAREHOUSE_KEY, id || 'all');
    setActiveWarehouseState(id || 'all');
  }, []);

  const logout = useCallback(() => {
    relockAll();
    // Ends the token on the server too, so a copy of it stops working. The
    // request reads the token before it is removed below; its outcome does not
    // matter, since this device signs out either way.
    if (getSession()) api.logout().catch(() => {});
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setData(EMPTY);
    // Every sign-in asks again which system to work in.
    writePref(SYSTEM_KEY, '');
    setSystemState('');
  }, []);
  logoutRef.current = logout;

  /** Run a write, reload the data, and toast the outcome. */
  const mutate = useCallback(async (fn, successMessage) => {
    let res;
    try {
      res = await fn();
    } catch (err) {
      toast(err.message || 'Something went wrong', 'error');
      // Callers rethrow-and-forget; main.jsx stops an error already shown
      // here from also surfacing as an unhandled rejection.
      if (err && typeof err === 'object') err.toasted = true;
      throw err;
    }
    // The write is done. A reload that fails afterwards (refresh() says so
    // itself) must not read as a failed save, or the same bill gets entered
    // a second time.
    try { await refresh(); } catch { /* already toasted by refresh */ }
    if (successMessage) toast(successMessage, 'success');
    return res;
  }, [refresh, toast]);

  const methods = useMemo(() => [...PAYMENT_METHODS, ...(data.settings?.customMethods || [])], [data.settings]);
  const activeParties = useMemo(() => data.parties.filter((p) => p.status !== 'archived'), [data.parties]);
  const activeItems = useMemo(() => data.items.filter((i) => i.status !== 'archived'), [data.items]);
  const activeSuppliers = useMemo(() => (data.suppliers || []).filter((s) => s.status !== 'archived'), [data.suppliers]);
  const activeWarehouses = useMemo(() => (data.warehouses || []).filter((w) => w.status !== 'archived'), [data.warehouses]);
  const activeWhParties = useMemo(() => (data.whParties || []).filter((p) => p.status !== 'archived'), [data.whParties]);
  // Who is signed in and what they may open: the server's latest word (sent
  // with the data), else what sign-in said.
  const me = data.me || session;
  const access = useMemo(() => accessFor(me), [me]);
  useEffect(() => {
    document.body.classList.toggle('no-cost', !access.seesCost);
  }, [access.seesCost]);

  const value = useMemo(() => ({
    session, login, logout, adoptSession, data, setData, refresh, mutate, loading, booted, toast, toasts, me, access,
    methods, activeParties, activeItems, activeSuppliers, activeWarehouses, activeWhParties,
    settings: data.settings, system, setSystem, activeWarehouse, setActiveWarehouse,
    sync, syncNow, clearSyncProblems,
  }), [session, login, logout, adoptSession, data, refresh, mutate, loading, booted, toast, toasts, me, access,
    methods, activeParties, activeItems, activeSuppliers, activeWarehouses, activeWhParties, system, setSystem,
    activeWarehouse, setActiveWarehouse, sync, syncNow]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
