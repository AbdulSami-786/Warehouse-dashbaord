import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, LogOut, Store, Warehouse,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { money, r2, today } from '../lib/format.js';
import { billStates, warehouseStockMap, warehouseStockValue } from '../lib/calc.js';
import { SHOP_PAGES, WAREHOUSE_PAGES } from '../lib/permissions.js';
import { Toasts } from '../components/ui.jsx';
import { LOGO } from '../components/Layout.jsx';

/** After signing in: work in the Wholesale Shop, or in the Warehouses. */
export default function ChooseSystem() {
  const {
    data, session, me, access, logout, setSystem, toasts, booted,
  } = useApp();
  const navigate = useNavigate();
  const canShop = access.canAny(SHOP_PAGES);
  const canWh = access.canAny(WAREHOUSE_PAGES);
  const shop = useMemo(() => {
    const states = billStates(data.bills, data).filter((b) => b.status !== 'voided');
    const day = today();
    return {
      todaySales: r2(states.filter((b) => b.date === day).reduce((s, b) => s + b.net, 0)),
      outstanding: r2(states.reduce((s, b) => s + b.due, 0)),
      parties: data.parties.filter((p) => p.status !== 'archived').length,
    };
  }, [data]);
  const wh = useMemo(() => {
    const live = (data.warehouses || []).filter((w) => w.status !== 'archived');
    const map = warehouseStockMap(data);
    let units = 0;
    for (const [wid, stock] of map) {
      if (!live.some((w) => w.id === wid)) continue;
      for (const q of stock.values()) units += Math.max(0, q);
    }
    const day = today();
    return {
      count: live.length,
      value: warehouseStockValue(data),
      units: r2(units),
      todayMoves: (data.whMoves || []).filter((m) => m.date === day && m.status !== 'voided').length,
    };
  }, [data]);
  const go = (system) => {
    setSystem(system);
    navigate(system === 'warehouse' ? '/warehouse' : '/');
  };
  // Someone given only one of the two systems goes straight into it.
  useEffect(() => {
    if (!booted) return;
    if (canShop && !canWh) go('shop');
    else if (canWh && !canShop) go('warehouse');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, canShop, canWh]);
  const name = me?.name || session?.username;
  return (
    <div className="choose-wrap">
      <div className="choose-inner">
        <div className="choose-head">
          <img className="choose-logo-img" src={LOGO} alt="SGA Balloon Merchant" />
          <p className="muted">Assalam-o-Alaikum{name ? `, ${name}` : ''}. Which system do you want to work in?</p>
        </div>
        {!canShop && !canWh && booted ? (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>No pages have been given to you yet</div>
            <div className="muted">Ask the super admin to choose which pages you can open.</div>
          </div>
        ) : (
          <div className="choose-grid">
            {canShop && (
              <button type="button" className="choose-card shop" onClick={() => go('shop')}>
                <span className="choose-ico"><Store size={28} /></span>
                <span className="choose-title">Wholesale Shop</span>
                <span className="choose-desc">Billing, parties, khata, payments, cheques, purchases, suppliers, expenses and reports.</span>
                {booted && (
                  <span className="choose-stats">
                    <span><b>{money(shop.todaySales)}</b> sales today</span>
                    <span><b>{money(shop.outstanding)}</b> outstanding</span>
                    <span><b>{shop.parties}</b> parties</span>
                  </span>
                )}
                <span className="choose-go">Open Wholesale <ArrowRight size={16} /></span>
              </button>
            )}
            {canWh && (
              <button type="button" className="choose-card wh" onClick={() => go('warehouse')}>
                <span className="choose-ico"><Warehouse size={28} /></span>
                <span className="choose-title">Warehouse</span>
                <span className="choose-desc">Multiple warehouses — stock in, stock out, transfers, sending to the shop, stock counts, expenses and reports.</span>
                {booted && (
                  <span className="choose-stats">
                    <span><b>{wh.count}</b> warehouse{wh.count === 1 ? '' : 's'}</span>
                    {access.seesCost ? <span><b>{money(wh.value)}</b> stock value</span> : <span><b>{wh.units.toLocaleString('en-PK')}</b> units held</span>}
                    <span><b>{wh.todayMoves}</b> movement{wh.todayMoves === 1 ? '' : 's'} today</span>
                  </span>
                )}
                <span className="choose-go">Open Warehouse <ArrowRight size={16} /></span>
              </button>
            )}
          </div>
        )}
        <div className="choose-foot">
          <button type="button" className="btn btn-ghost" onClick={logout}><LogOut size={15} /> Sign out</button>
          {canShop && canWh && <span className="small muted">You can switch any time from the sidebar.</span>}
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}
