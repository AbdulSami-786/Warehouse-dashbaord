import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CreditCard, History, PackagePlus, Plus, Save, Trash2, TriangleAlert, Wallet, Warehouse, X,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { UNITS } from '../lib/config.js';
import { money, r2, today, addDays, fmtDate, uid } from '../lib/format.js';
import {
  billTotals, billState, billStates, partyDue, advanceAvailable, itemStock, warehouseStockMap, unitFactor,
} from '../lib/calc.js';
import { printBill } from '../lib/exporters.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, Money, PageHead, Pill, Select, Textarea, Typeahead,
} from '../components/ui.jsx';
import { BillPreview, ChequeFields, ItemForm, PartyForm, blankCheque } from '../components/forms.jsx';

const DRAFTS_KEY = 'jh_billDrafts';
const lineBox = { border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 11, background: '#FCFCFD' };
const warnBox = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', background: 'var(--warning-bg)',
  border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#B45309',
};
const newPay = () => ({ key: uid('p'), method: 'Cash', amount: '', cheque: null });

function hasContent(form) {
  return !!(form && (form.partyId || (form.lines && form.lines.length) || form.note));
}

/** Unsaved bills survive a refresh. `?party=` opens a fresh tab for that party. */
function loadDrafts(partyId) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DRAFTS_KEY) || 'null'); } catch { saved = null; }
  let tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((t) => t && t.key) : [];
  let active = Math.min(Math.max(0, Number(saved?.active) || 0), Math.max(0, tabs.length - 1));
  if (partyId) {
    const empty = tabs.findIndex((t) => !hasContent(t.form));
    const form = { partyId };
    if (empty >= 0) {
      tabs = tabs.map((t, i) => (i === empty ? { ...t, form } : t));
      active = empty;
    } else {
      tabs = [...tabs, { key: uid('tab'), label: '', form }];
      active = tabs.length - 1;
    }
  }
  return tabs.length ? { tabs: tabs.map((t, i) => ({ ...t, label: `Bill ${i + 1}` })), active } : null;
}

function saveDrafts(tabs, active) {
  try {
    if (tabs.some((t) => hasContent(t.form))) localStorage.setItem(DRAFTS_KEY, JSON.stringify({ tabs, active }));
    else localStorage.removeItem(DRAFTS_KEY);
  } catch { /* storage full */ }
}

function SumRow({ label, value, showSign = false, muted = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span className={muted ? 'muted' : ''} style={{ fontSize: 13.5 }}>{label}</span>
      <span className="spacer" />
      <Money value={value} showSign={showSign} className={muted ? 'small' : ''} />
    </div>
  );
}

/**
 * Pick goods that go out of a warehouse: which warehouse, which item, how many.
 * Only items the chosen warehouse actually holds are offered, and the quantity
 * cannot be more than it holds (less what other lines of this bill already take).
 */
function WarehousePick({ open, onClose, warehouses, items, availableAt, priceFor, onAdd }) {
  const [whId, setWhId] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!open) return;
    setWhId(warehouses[0]?.id || '');
    setItemId('');
    setQty('1');
    setPrice('');
    setRound((r) => r + 1);
  }, [open, warehouses]);

  const available = itemId && whId ? availableAt(itemId, whId) : 0;
  const stocked = useMemo(
    () => (whId ? items.filter((i) => availableAt(i.id, whId) > 0) : []),
    [items, whId, availableAt],
  );
  const item = items.find((i) => i.id === itemId);
  const qtyNum = Number(qty);
  const error = !itemId ? '' : !(qtyNum > 0) ? 'Enter a quantity' : qtyNum > available + 0.0001 ? `Only ${available} ${item?.baseUnit || ''} available` : '';
  const ready = !!itemId && !!whId && qtyNum > 0 && !error;

  const pick = (v) => {
    setItemId(v || '');
    setPrice(v ? String(priceFor(v)?.price ?? '') : '');
  };
  const add = (another) => {
    if (!ready) return;
    onAdd({ itemId, warehouseId: whId, qty: String(qtyNum), price });
    if (another) {
      setItemId('');
      setQty('1');
      setPrice('');
      setRound((r) => r + 1);
    } else onClose();
  };

  return (
    <Modal
      open={open}
      title="Add items from a warehouse"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => add(true)} disabled={!ready}>Add &amp; add another</Button>
          <Button variant="primary" icon={Plus} onClick={() => add(false)} disabled={!ready}>Add to bill</Button>
        </>
      )}
    >
      <div className="form-grid">
        <Field label="Warehouse" className="full">
          <Select
            value={whId}
            onChange={(e) => { setWhId(e.target.value); setItemId(''); setPrice(''); setRound((r) => r + 1); }}
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
          />
        </Field>
        <Field
          label="Item"
          className="full"
          hint={whId && !stocked.length ? 'This warehouse has no stock of any item.' : ''}
        >
          <Typeahead
            key={`${whId}-${round}`}
            items={stocked}
            value={itemId}
            onChange={pick}
            getLabel={(i) => i.name}
            getSub={(i) => `${availableAt(i.id, whId)} ${i.baseUnit} in stock`}
            placeholder="Search an item in this warehouse…"
            autoFocus
          />
        </Field>
        <Field label={item ? `Quantity (${item.baseUnit})` : 'Quantity'} hint={itemId ? `${available} ${item?.baseUnit || ''} in this warehouse` : ''} error={error}>
          <Input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Rate">
          <Input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function BillForm() {
  const { data, settings, methods, activeParties, activeItems, mutate, toast, access } = useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const [search] = useSearchParams();
  const editing = id ? data.bills.find((b) => b.id === id) : null;
  const [initial] = useState(() => (id ? null : loadDrafts(search.get('party'))));
  const start = initial ? initial.tabs[initial.active]?.form : null;

  const [partyId, setPartyId] = useState(() => start?.partyId ?? '');
  const [date, setDate] = useState(() => start?.date ?? today());
  const [lines, setLines] = useState(() => start?.lines ?? []);
  const [pays, setPays] = useState(() => start?.pays ?? [newPay()]);
  const [dueDate, setDueDate] = useState(() => start?.dueDate ?? addDays(today(), settings.defaultCreditDays));
  const [applyAdvance, setApplyAdvance] = useState(() => start?.applyAdvance ?? 0);
  const [note, setNote] = useState(() => start?.note ?? '');
  const [pending, setPending] = useState(() => start?.pending ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [addParty, setAddParty] = useState(false);
  const [addItem, setAddItem] = useState(false);
  const [newName, setNewName] = useState('');
  const [historyFor, setHistoryFor] = useState(null);
  const [priceAlerts, setPriceAlerts] = useState(null);
  const [tabs, setTabs] = useState(() => initial?.tabs ?? [{ key: uid('tab'), label: 'Bill 1', form: null }]);
  const [activeTab, setActiveTab] = useState(() => initial?.active ?? 0);
  const [savedId, setSavedId] = useState(null);

  // Load the bill being edited.
  useEffect(() => {
    if (!editing) return;
    setPartyId(editing.partyId);
    setDate(editing.date);
    setDueDate(editing.dueDate);
    setNote(editing.note || '');
    setPending(editing.delivery === 'pending');
    // New bills are saved in the base unit, so a line stored in the alternate unit
    // is from before conversion existed: its rate is per that unit, and it stays so.
    setLines(data.billItems.filter((l) => l.billId === editing.id).map((l) => ({
      key: uid('l'), itemId: l.itemId, qty: String(l.qty), price: String(l.price), unit: l.unit, costPriceAtSale: l.costPriceAtSale, warehouseId: l.warehouseId || '',
      legacy: unitFactor(data.items.find((i) => i.id === l.itemId), l.unit) > 1,
    })));
    setPays([newPay()]);
  }, [editing, data.billItems, data.items]);

  const party = activeParties.find((p) => p.id === partyId) || data.parties.find((p) => p.id === partyId);

  useEffect(() => {
    if (party && !editing) setDueDate(addDays(date, party.defaultDueDays || settings.defaultCreditDays));
  }, [party, date, settings.defaultCreditDays, editing]);

  // Rates are per base unit; an older price recorded per bag is brought to that.
  const perBase = useCallback((x) => {
    const item = data.items.find((i) => i.id === x.itemId);
    const f = unitFactor(item, x.unit);
    return f > 1 ? { ...x, price: r2(Number(x.price) / f), unit: item.baseUnit } : x;
  }, [data.items]);
  const priceHistory = useCallback((pid, itemId) => data.partyItemPrices
    .filter((x) => x.partyId === pid && x.itemId === itemId)
    .sort((a, b) => new Date(b.date) - new Date(a.date)).map(perBase), [data.partyItemPrices, perBase]);
  const lastPrice = useCallback((pid, itemId) => priceHistory(pid, itemId)[0] || null, [priceHistory]);

  // What this party usually orders.
  const frequent = useMemo(() => {
    if (!partyId) return [];
    const theirs = new Set(data.bills.filter((b) => b.partyId === partyId).map((b) => b.id));
    const count = new Map();
    data.billItems.filter((l) => theirs.has(l.billId)).forEach((l) => count.set(l.itemId, (count.get(l.itemId) || 0) + 1));
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([iid]) => data.items.find((i) => i.id === iid)).filter((i) => i && i.status !== 'archived');
  }, [partyId, data.bills, data.billItems, data.items]);

  const focusRef = useRef(null);
  const [focusKey, setFocusKey] = useState(null);

  const [whPick, setWhPick] = useState(false);

  /** `given` carries what the warehouse picker already chose: quantity, rate, warehouse. */
  const addLine = (itemId = '', given = {}) => {
    const item = data.items.find((i) => i.id === itemId);
    const last = itemId && partyId ? lastPrice(partyId, itemId) : null;
    const key = uid('l');
    const rate = given.price !== undefined && given.price !== '' ? String(given.price) : last ? String(last.price) : '';
    setLines((ls) => [...ls, {
      key, itemId, qty: given.qty ?? '1', price: rate,
      unit: last?.unit || item?.baseUnit || 'Piece', costPriceAtSale: item?.costPrice ?? 0,
      autoFilled: !!last && rate === String(last.price), warehouseId: given.warehouseId || '',
    }]);
    if (!itemId) setFocusKey(key);
    return key;
  };

  useEffect(() => {
    if (focusKey) {
      focusRef.current?.focus();
      setFocusKey(null);
    }
  }, [focusKey]);

  // Ctrl+Shift+A adds a line, unless a dialog is open.
  const addLineRef = useRef(addLine);
  addLineRef.current = addLine;
  const dialogOpen = addParty || addItem || whPick || !!historyFor;
  const dialogRef = useRef(dialogOpen);
  dialogRef.current = dialogOpen;
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyA' || !e.shiftKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || dialogRef.current) return;
      e.preventDefault();
      addLineRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const updLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key, itemId) => {
    const item = data.items.find((i) => i.id === itemId);
    const last = partyId ? lastPrice(partyId, itemId) : null;
    updLine(key, {
      itemId, price: last ? String(last.price) : '', unit: last?.unit || item?.baseUnit || 'Piece',
      costPriceAtSale: item?.costPrice ?? 0, autoFilled: !!last,
    });
  };
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  /** A price far from what this party last paid is probably a typo. */
  const priceAlert = (l) => {
    if (!partyId || !l.itemId || !l.price) return null;
    const last = lastPrice(partyId, l.itemId);
    if (!last) return null;
    const was = Number(last.price);
    const now = Number(l.price);
    if (!was || !now) return null;
    const pct = Math.abs((now - was) / was) * 100;
    if (pct <= (Number(settings.priceAlertThreshold) || 15)) return null;
    const item = data.items.find((i) => i.id === l.itemId);
    return { itemName: item?.name, oldPrice: was, newPrice: now, pct, up: now > was, lastDate: last.date };
  };

  // How many base units a line takes: 2 bags of 12 packets is 24.
  const baseQty = (l) => (Number(l.qty) || 0) * (l.legacy ? 1 : unitFactor(data.items.find((i) => i.id === l.itemId), l.unit));

  // Where stock can be taken from: the shop, or any active warehouse.
  const warehouses = useMemo(() => (data.warehouses || []).filter((w) => w.status !== 'archived'), [data.warehouses]);
  const whStock = useMemo(() => warehouseStockMap(data), [data]);
  // Stock in a place, not counting what this bill itself already took when it is being edited.
  const stockAt = (itemId, whId) => {
    const own = editing
      ? data.billItems.filter((x) => x.billId === editing.id && x.itemId === itemId && (x.warehouseId || '') === (whId || ''))
        .reduce((s, x) => s + (Number(x.qty) || 0), 0)
      : 0;
    const have = whId ? whStock.get(whId)?.get(itemId) || 0 : itemStock(itemId, data);
    return r2(have + own);
  };
  // What a warehouse can still give this bill: its stock less what other lines here already take.
  const availableAt = (itemId, whId) => r2(stockAt(itemId, whId)
    - lines.filter((l) => l.itemId === itemId && l.warehouseId === whId).reduce((s, l) => s + baseQty(l), 0));

  const valid = useMemo(() => lines.filter((l) => l.itemId && Number(l.qty) > 0 && Number(l.price) >= 0), [lines]);
  const totals = useMemo(() => billTotals(valid.map((l) => ({ qty: baseQty(l), price: Number(l.price) })), settings.roundingRule), [valid, settings.roundingRule, data.items]);
  const paidNow = useMemo(() => r2(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0)), [pays]);
  const advance = useMemo(() => (partyId ? advanceAvailable(partyId, data.partyAdvances) : 0), [partyId, data.partyAdvances]);
  const credit = useMemo(() => r2(Math.max(0, totals.total - paidNow - Number(applyAdvance || 0))), [totals.total, paidNow, applyAdvance]);
  const overpaid = r2(paidNow + Number(applyAdvance || 0) - totals.total);
  const advanceTooMuch = r2(Number(applyAdvance) || 0) > advance + 0.004;
  // Money beyond the bill has nowhere to go on this bill, so it is not saved.
  const blocked = overpaid > 0.004 || advanceTooMuch;

  const savedState = useMemo(() => {
    if (!savedId) return null;
    const b = data.bills.find((x) => x.id === savedId);
    return b ? billState(b, data) : null;
  }, [savedId, data]);

  const overLimit = useMemo(() => {
    if (!party || !Number(party.creditLimit) || credit <= 0) return null;
    const owing = partyDue(party.id, billStates(data.bills, data));
    const after = r2(owing + credit);
    return after <= Number(party.creditLimit) ? null : { existing: owing, after, limit: Number(party.creditLimit) };
  }, [party, credit, data]);

  const updPay = (key, patch) => setPays((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const fillPay = (key) => {
    const others = r2(pays.filter((p) => p.key !== key).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    updPay(key, { amount: String(r2(Math.max(0, totals.total - others - Number(applyAdvance || 0)))) });
  };

  /* ---- Tabs: several bills written side by side ---- */
  const formNow = useCallback(() => ({ partyId, date, lines, pays, dueDate, applyAdvance, note, pending }),
    [partyId, date, lines, pays, dueDate, applyAdvance, note, pending]);
  const loadForm = useCallback((f) => {
    setPartyId(f?.partyId ?? '');
    setDate(f?.date ?? today());
    setLines(f?.lines ?? []);
    setPays(f?.pays ?? [newPay()]);
    setDueDate(f?.dueDate ?? addDays(today(), settings.defaultCreditDays));
    setApplyAdvance(f?.applyAdvance ?? 0);
    setNote(f?.note ?? '');
    setPending(f?.pending ?? false);
  }, [settings.defaultCreditDays]);

  useEffect(() => {
    if (id) return;
    saveDrafts(tabs.map((t, i) => (i === activeTab ? { ...t, form: formNow() } : t)), activeTab);
  }, [id, tabs, activeTab, formNow]);

  const clearAll = () => {
    setTabs([{ key: uid('tab'), label: 'Bill 1', form: null }]);
    setActiveTab(0);
    loadForm(null);
    setConfirmClear(false);
    toast('Unsaved bills removed');
  };
  const anyUnsaved = !editing && (tabs.length > 1 || !!partyId || lines.length > 0 || !!note);
  const switchTab = (i) => {
    if (i === activeTab) return;
    setTabs((ts) => ts.map((t, j) => (j === activeTab ? { ...t, form: formNow() } : t)));
    loadForm(tabs[i]?.form);
    setActiveTab(i);
  };
  const newTab = () => {
    const f = formNow();
    setTabs((ts) => {
      const kept = ts.map((t, j) => (j === activeTab ? { ...t, form: f } : t));
      return [...kept, { key: uid('tab'), label: `Bill ${kept.length + 1}`, form: null }];
    });
    loadForm(null);
    setActiveTab(tabs.length);
  };
  const closeTab = (i) => {
    if (tabs.length === 1) return;
    const kept = tabs.map((t, j) => (j === activeTab ? { ...t, form: formNow() } : t)).filter((_, j) => j !== i);
    const next = i === activeTab ? Math.min(i, kept.length - 1) : i < activeTab ? activeTab - 1 : activeTab;
    if (i === activeTab) loadForm(kept[next].form);
    setTabs(kept.map((t, j) => ({ ...t, label: `Bill ${j + 1}` })));
    setActiveTab(next);
  };
  /** After a save, the finished tab goes away. */
  const finishTab = () => {
    if (tabs.length === 1) {
      setTabs([{ key: uid('tab'), label: 'Bill 1', form: null }]);
      setActiveTab(0);
      loadForm(null);
      return;
    }
    const kept = tabs.filter((_, j) => j !== activeTab);
    const next = Math.min(activeTab, kept.length - 1);
    setTabs(kept.map((t, j) => ({ ...t, label: `Bill ${j + 1}` })));
    setActiveTab(next);
    loadForm(kept[next].form);
  };
  const tabReady = useCallback((f) => {
    if (!f?.partyId) return false;
    return (f.lines || []).some((l) => l.itemId && Number(l.qty) > 0 && Number(l.price) >= 0);
  }, []);

  const save = async () => {
    if (saving) return;
    if (!partyId) return toast('Select a party first', 'error');
    if (!valid.length) return toast('Add at least one item', 'error');
    setSaving(true);
    try {
      const payload = {
        id: editing?.id, partyId, date,
        // Someone who cannot see cost leaves it to the server, which knows it.
        lines: valid.map((l) => ({ itemId: l.itemId, qty: baseQty(l), price: Number(l.price), unit: baseQty(l) === Number(l.qty) ? l.unit : data.items.find((i) => i.id === l.itemId).baseUnit, warehouseId: l.warehouseId || '', ...(access.seesCost ? { costPriceAtSale: l.costPriceAtSale } : {}) })),
        payments: pays.filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method, amount: Number(p.amount), cheque: p.cheque, note: '' })),
        advanceApplied: Number(applyAdvance) || 0,
        subtotal: totals.subtotal, roundOff: totals.roundOff, total: totals.total,
        dueDate: credit > 0 ? dueDate : '', note, delivery: pending ? 'pending' : 'delivered',
      };
      const res = await mutate(() => api.saveBill(payload), editing ? 'Bill updated' : 'Bill saved');
      if (editing) navigate(`/bill/${res.id}`);
      else setSavedId(res.id);
    } catch { /* toasted */ } finally {
      setSaving(false);
    }
  };

  const trySave = () => {
    if (blocked) {
      toast(advanceTooMuch ? `Only ${money(advance)} advance is available` : `Payment exceeds the total by ${money(overpaid)}`, 'error');
      return;
    }
    const alerts = valid.map(priceAlert).filter(Boolean);
    if (alerts.length) setPriceAlerts(alerts);
    else save();
  };

  const itemName = (iid) => data.items.find((i) => i.id === iid)?.name || '';

  return (
    <>
      <PageHead
        title={editing ? `Edit Bill ${editing.billNo}` : 'New Bill'}
        subtitle={editing ? 'Editing keeps the original bill number and history' : 'Select a party, add items, then record payment'}
      >
        <Button onClick={() => navigate(-1)}>Cancel</Button>
        {anyUnsaved && <Button icon={Trash2} onClick={() => setConfirmClear(true)} title="Remove every bill on this page that has not been saved">Clear unsaved bills</Button>}
        <Button variant="primary" icon={Save} onClick={trySave} loading={saving} disabled={!partyId || !valid.length || blocked}>
          {editing ? 'Update Bill' : 'Save Bill'}
        </Button>
      </PageHead>

      {!editing && (
        <div className="bill-tabs" role="tablist" aria-label="Bills in progress">
          {tabs.map((t, i) => {
            const form = i === activeTab ? null : t.form;
            const pid = i === activeTab ? partyId : form?.partyId;
            const p = pid ? data.parties.find((x) => x.id === pid) : null;
            const ready = i === activeTab ? !!(partyId && valid.length) : tabReady(t.form);
            const label = p ? p.name : t.label;
            return (
              <div key={t.key} className={`bill-tab ${i === activeTab ? 'active' : ''}`}>
                <button type="button" role="tab" aria-selected={i === activeTab} onClick={() => switchTab(i)}>
                  <span className={`dot ${ready ? 'on' : ''}`} aria-hidden="true" />
                  {label}
                </button>
                {tabs.length > 1 && (
                  <button type="button" className="x" onClick={() => closeTab(i)} title={`Close ${label}`} aria-label={`Close ${label}`}><X size={13} /></button>
                )}
              </div>
            );
          })}
          <button type="button" className="bill-tab-add" onClick={newTab} title="Write another bill alongside this one"><Plus size={14} /> Add bill</button>
        </div>
      )}

      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Party">
            <div className="form-grid">
              <Field label="Select party" className="full">
                <Typeahead
                  items={activeParties}
                  value={partyId}
                  onChange={(v) => setPartyId(v || '')}
                  getLabel={(p) => p.name}
                  getSub={(p) => p.phone || ''}
                  placeholder="Type a party name or phone…"
                  onAddNew={(n) => { setNewName(n); setAddParty(true); }}
                  addNewLabel="Add new party"
                  autoFocus={!editing}
                />
              </Field>
              <Field label="Bill date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              {credit > 0 && (
                <Field label="Credit due date" hint="Editable — defaults from this party's terms">
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
              )}
            </div>
            {party && (
              <div className="row wrap" style={{ gap: 8, marginTop: 2 }}>
                {party.phone && <span className="small muted">{party.phone}</span>}
                {advance > 0 && <span className="pill pill-cleared"><Wallet size={11} /> Advance available {money(advance)}</span>}
                {Number(party.creditLimit) > 0 && <span className="small muted">Credit limit {money(party.creditLimit)}</span>}
              </div>
            )}
            {overLimit && (
              <div style={warnBox} className="mt-1">
                <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>This credit bill takes {party.name} to <strong>{money(overLimit.after)}</strong> owing, above their {money(overLimit.limit)} credit limit.</span>
              </div>
            )}
          </Card>

          <Card
            title="Items"
            actions={(
              <div className="row wrap" style={{ gap: 8 }}>
                {warehouses.length > 0 && (
                  <Button size="sm" icon={Warehouse} onClick={() => setWhPick(true)} title="Add items that go out of a warehouse">
                    From warehouse
                  </Button>
                )}
                <Button size="sm" icon={Plus} onClick={() => addLine()} title="Add line (Ctrl+Shift+A)">
                  Add line <kbd className="kbd-hint">Ctrl+Shift+A</kbd>
                </Button>
              </div>
            )}
          >
            {frequent.length > 0 && (
              <div className="mb-2">
                <div className="small muted mb-1">Frequently ordered by {party?.name}</div>
                <div className="chips">
                  {frequent.map((i) => (
                    <button key={i.id} className="chip" onClick={() => addLine(i.id)}>
                      <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} />{i.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {lines.length ? (
              <div className="col" style={{ gap: 12 }}>
                {lines.map((l, idx) => {
                  const item = data.items.find((i) => i.id === l.itemId);
                  const alert = priceAlert(l);
                  const last = l.itemId && partyId ? lastPrice(partyId, l.itemId) : null;
                  const stock = l.itemId ? stockAt(l.itemId, l.warehouseId) : null;
                  const fromName = l.warehouseId ? warehouses.find((w) => w.id === l.warehouseId)?.name || 'warehouse' : 'shop';
                  const units = item ? [item.baseUnit, ...(item.altUnit ? [item.altUnit] : [])] : UNITS;
                  return (
                    <div key={l.key} style={lineBox}>
                      <div className="row line-head" style={{ gap: 8, marginBottom: 8 }}>
                        <span className="small muted nowrap line-no" style={{ width: 20 }}>{idx + 1}.</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Typeahead
                            items={activeItems}
                            value={l.itemId}
                            focusRef={l.key === focusKey ? focusRef : null}
                            onChange={(v) => v && pickItem(l.key, v)}
                            getLabel={(i) => i.name}
                            getSub={(i) => `${i.category || 'Uncategorised'} · ${i.baseUnit}`}
                            placeholder="Search item…"
                            onAddNew={(n) => { setNewName(n); setAddItem(true); }}
                            addNewLabel="Add new item"
                          />
                        </div>
                        <button className="btn btn-ghost btn-icon" onClick={() => removeLine(l.key)} aria-label="Remove line" title="Remove line">
                          <Trash2 size={15} color="var(--danger)" />
                        </button>
                      </div>
                      <div className="row wrap line-fields" style={{ gap: 8, paddingLeft: 28 }}>
                        <div style={{ width: 92 }}>
                          <label className="small muted">Qty</label>
                          <Input type="number" min="0" step="any" value={l.qty} onChange={(e) => updLine(l.key, { qty: e.target.value })} />
                        </div>
                        <div style={{ width: 112 }}>
                          <label className="small muted">Unit</label>
                          <Select value={l.unit} onChange={(e) => updLine(l.key, { unit: e.target.value, legacy: false })} options={units} />
                        </div>
                        <div style={{ width: 118 }}>
                          <label className="small muted">{item?.altUnit ? `Rate / ${l.legacy ? l.unit : item.baseUnit}` : 'Rate'}</label>
                          <Input type="number" min="0" step="any" value={l.price} onChange={(e) => updLine(l.key, { price: e.target.value, autoFilled: false })} />
                        </div>
                        {warehouses.length > 0 && (
                          <div style={{ minWidth: 150 }}>
                            <label className="small muted">Taken from</label>
                            <Select value={l.warehouseId || ''} onChange={(e) => updLine(l.key, { warehouseId: e.target.value })}>
                              <option value="">Shop</option>
                              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                            </Select>
                          </div>
                        )}
                        <div className="spacer hide-mobile" />
                        <div className="line-amount" style={{ textAlign: 'right' }}>
                          <label className="small muted">Amount</label>
                          <div className="money" style={{ fontSize: 16, paddingTop: 6 }}>{money(baseQty(l) * (Number(l.price) || 0))}</div>
                        </div>
                      </div>
                      <div className="row wrap line-meta" style={{ gap: 8, paddingLeft: 28, marginTop: 7 }}>
                        {l.autoFilled && last && <span className="pill pill-cleared">Auto-filled from {fmtDate(last.date)}</span>}
                        {l.itemId && last && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setHistoryFor(l.itemId)}><History size={13} /> Price history</button>
                        )}
                        {l.itemId && item?.altUnit && Number(item.conversionRate) > 0 && (
                          <span className="small muted">1 {item.altUnit} = {item.conversionRate} {item.baseUnit}</span>
                        )}
                        {l.itemId && baseQty(l) !== (Number(l.qty) || 0) && (
                          <span className="small muted">{l.qty} {l.unit} = {baseQty(l)} {item.baseUnit} × {money(Number(l.price) || 0)}</span>
                        )}
                        {stock !== null && (baseQty(l) > stock
                          ? <span className="pill pill-due"><TriangleAlert size={11} />Only {stock} {item?.baseUnit} in {fromName}</span>
                          : <span className="small muted">{l.warehouseId ? `In ${fromName}` : 'Stock'}: {stock} {item?.baseUnit}</span>)}
                        {alert && (
                          <span className="pill pill-partial">
                            <TriangleAlert size={11} />{alert.up ? 'Up' : 'Down'} {alert.pct.toFixed(0)}% vs last {money(alert.oldPrice)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty
                icon={PackagePlus}
                title="No items yet"
                message="Add the first item to start building this bill."
                action={<Button variant="primary" icon={Plus} onClick={() => addLine()}>Add item</Button>}
              />
            )}
          </Card>

          <Card title="Delivery" subtitle="Whether the goods go out with this bill">
            <label className="row" style={{ gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} style={{ width: 17, height: 17, marginTop: 1, flexShrink: 0 }} />
              <span>
                <span style={{ fontWeight: 600 }}>Not delivered yet</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Tick for goods still to be sent. The bill still counts as a sale and as money owed. Open the bill and use Delivery to tick items as they go out — some now, the rest later.
                </span>
              </span>
            </label>
          </Card>

          <Card title="Note" subtitle="Optional — appears on the bill">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery instructions, reference, anything worth recording…" />
          </Card>
        </div>

        <div className="col">
          <Card title="Bill Total">
            <SumRow label="Subtotal" value={totals.subtotal} />
            {totals.roundOff !== 0 && <SumRow label="Round off" value={totals.roundOff} showSign muted />}
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 5, borderTop: '2px solid var(--border-strong)' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Total</span>
              <span className="spacer" />
              <span className="money" style={{ fontSize: 21 }}>{money(totals.total)}</span>
            </div>
            <div className="small muted mt-1">
              Rounding: {settings.roundingRule === 'exact' ? 'exact' : `nearest ${String(settings.roundingRule).replace('nearest', '')}`} (change in Settings)
            </div>
          </Card>

          <Card title="Payment" subtitle="Split across any methods — the remainder becomes Credit" actions={<Button size="sm" icon={Plus} onClick={() => setPays((ps) => [...ps, newPay()])}>Add method</Button>}>
            {advance > 0 && (r2(applyAdvance) > 0 ? (
              <Field
                label="Advance applied"
                hint={`${money(advance)} available in total`}
                error={advanceTooMuch ? `Only ${money(advance)} is available` : ''}
              >
                <div className="input-group">
                  <Input type="number" min="0" max={Math.min(advance, totals.total)} step="any" value={applyAdvance} onChange={(e) => setApplyAdvance(e.target.value)} />
                  <Button onClick={() => setApplyAdvance(0)} icon={X}>Remove</Button>
                </div>
              </Field>
            ) : (
              <div className="note" style={{ marginBottom: 12 }}>
                <Wallet size={14} />
                <span style={{ flex: 1 }}><strong>{party?.name || 'This party'}</strong> has <strong>{money(advance)}</strong> advance with you.</span>
                <Button size="sm" variant="primary" disabled={totals.total <= 0} onClick={() => setApplyAdvance(String(Math.min(advance, totals.total)))}>Apply to this bill</Button>
              </div>
            ))}
            {pays.map((p) => (
              <div key={p.key} style={{ marginBottom: 12 }}>
                <div className="row pay-row" style={{ gap: 7 }}>
                  <Select value={p.method} className="pay-method" onChange={(e) => updPay(p.key, { method: e.target.value, cheque: e.target.value === 'Cheque' ? blankCheque(date) : null })} options={methods} style={{ width: 132 }} />
                  <Input type="number" min="0" step="any" placeholder="0" className="pay-amount" value={p.amount} onChange={(e) => updPay(p.key, { amount: e.target.value })} />
                  <Button size="sm" className="pay-full" onClick={() => fillPay(p.key)} title="Fill remaining balance">Full</Button>
                  {pays.length > 1 && (
                    <button className="btn btn-ghost btn-icon pay-remove" onClick={() => setPays((ps) => (ps.length > 1 ? ps.filter((x) => x.key !== p.key) : ps))} aria-label="Remove payment method">
                      <Trash2 size={15} color="var(--danger)" /><span className="hide-desktop" style={{ marginLeft: 6 }}>Remove</span>
                    </button>
                  )}
                </div>
                {p.method === 'Cheque' && <ChequeFields value={p.cheque} onChange={(c) => updPay(p.key, { cheque: c })} />}
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 11, marginTop: 4 }}>
              <SumRow label="Paid now" value={paidNow} muted />
              {Number(applyAdvance) > 0 && <SumRow label="From advance" value={Number(applyAdvance)} muted />}
              {credit > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, padding: '10px 12px', background: 'var(--danger-bg)', border: '1px solid #FECACA', borderRadius: 'var(--r-sm)' }}>
                  <CreditCard size={16} color="#B91C1C" style={{ flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#B91C1C' }}>On Credit</div>
                    <div className="small" style={{ color: '#B91C1C' }}>Due {fmtDate(dueDate)}</div>
                  </div>
                  <span className="money" style={{ color: '#B91C1C', fontSize: 16 }}>{money(credit)}</span>
                </div>
              ) : overpaid > 0 ? (
                <div style={{ ...warnBox, marginTop: 9 }}>
                  <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
                  <span>Payment exceeds the total by <strong>{money(overpaid)}</strong>. Reduce a payment line.</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, padding: '10px 12px', background: 'var(--success-bg)', border: '1px solid #BBF7D0', borderRadius: 'var(--r-sm)', color: '#15803D', fontWeight: 700 }}>Fully paid</div>
              )}
            </div>
          </Card>
          <Button variant="primary" size="lg" block icon={Save} onClick={trySave} loading={saving} disabled={!partyId || !valid.length || blocked}>
            {editing ? 'Update Bill' : 'Save Bill'}
          </Button>
        </div>
      </div>

      <div className={`sticky-total ${valid.length ? 'on' : ''}`}>
        <div><div className="lbl">TOTAL</div><div className="val">{money(totals.total)}</div></div>
        <div className="spacer" />
        {credit > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div className="lbl">ON CREDIT</div>
            <div className="val" style={{ color: '#FCA5A5', fontSize: 16 }}>{money(credit)}</div>
          </div>
        )}
        <Button variant="primary" onClick={trySave} loading={saving} disabled={!partyId || blocked}>Save</Button>
      </div>

      <BillPreview
        open={!!savedId}
        onClose={() => { setSavedId(null); finishTab(); }}
        bill={savedState}
        lines={savedId ? data.billItems.filter((l) => l.billId === savedId) : []}
        payments={savedId ? data.payments.filter((p) => p.billId === savedId) : []}
        cheques={data.cheques}
        returns={savedId ? data.returns.filter((r) => r.billId === savedId) : []}
        itemName={(iid) => data.items.find((i) => i.id === iid)?.name || 'Item'}
        party={savedState ? data.parties.find((p) => p.id === savedState.partyId) : null}
        shopName={settings.shopName}
        onPrint={() => {
          if (!savedState) return;
          printBill({
            bill: savedState,
            lines: data.billItems.filter((l) => l.billId === savedId).map((l) => ({ ...l, itemName: data.items.find((i) => i.id === l.itemId)?.name || 'Item' })),
            party: data.parties.find((p) => p.id === savedState.partyId),
            payments: data.payments.filter((p) => p.billId === savedId && !p.reversed),
            settings,
            state: savedState,
          });
        }}
      />

      <Confirm
        open={confirmClear}
        title="Clear unsaved bills?"
        message={`This removes ${tabs.length === 1 ? 'the bill' : `all ${tabs.length} bills`} on this page that ${tabs.length === 1 ? 'has' : 'have'} not been saved. Saved bills are not affected.`}
        confirmLabel="Clear all"
        danger
        onConfirm={clearAll}
        onCancel={() => setConfirmClear(false)}
      />
      <WarehousePick
        open={whPick}
        onClose={() => setWhPick(false)}
        warehouses={warehouses}
        items={activeItems}
        availableAt={availableAt}
        priceFor={(iid) => (partyId ? lastPrice(partyId, iid) : null)}
        onAdd={(g) => addLine(g.itemId, g)}
      />
      <Modal open={addParty} title="Add New Party" onClose={() => setAddParty(false)}>
        <PartyForm initialName={newName} onSaved={(p) => { setPartyId(p.id); setAddParty(false); toast(`Party "${p.name}" added`); }} onCancel={() => setAddParty(false)} />
      </Modal>
      <Modal open={addItem} title="Add New Item" onClose={() => setAddItem(false)}>
        <ItemForm initialName={newName} onSaved={(i) => { setAddItem(false); addLine(i.id); toast(`Item "${i.name}" added`); }} onCancel={() => setAddItem(false)} />
      </Modal>
      <Modal open={!!historyFor} title={`Price History — ${itemName(historyFor)}`} onClose={() => setHistoryFor(null)}>
        <div className="small muted mb-2">Prices charged to {party?.name} for this item.</div>
        {historyFor && priceHistory(partyId, historyFor).length ? (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Unit</th><th className="r">Price</th></tr></thead>
            <tbody>
              {priceHistory(partyId, historyFor).map((h, i) => (
                <tr key={h.id}>
                  <td>{fmtDate(h.date)} {i === 0 && <Pill status="cleared" label="Latest" />}</td>
                  <td>{h.unit}</td>
                  <td className="r strong"><Money value={h.price} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title="No price history" message="This is the first time this party is buying this item." />}
      </Modal>
      <Modal
        open={!!priceAlerts}
        title="Confirm price change"
        onClose={() => setPriceAlerts(null)}
        footer={(
          <>
            <Button onClick={() => setPriceAlerts(null)}>Go back and fix</Button>
            <Button variant="primary" onClick={() => { setPriceAlerts(null); save(); }}>Prices are correct, save</Button>
          </>
        )}
      >
        <p style={{ marginTop: 0, fontSize: 14 }}>
          {priceAlerts?.length === 1 ? 'One price differs' : `${priceAlerts?.length} prices differ`} from what {party?.name} last paid by more than {settings.priceAlertThreshold}%.
        </p>
        {priceAlerts?.map((a, i) => (
          <div key={i} style={{ ...lineBox, marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>{a.itemName}</div>
            <div className="row small" style={{ gap: 8, marginTop: 4 }}>
              <span className="muted">Last paid {money(a.oldPrice)} on {fmtDate(a.lastDate)}</span>
              <span>→</span>
              <span style={{ fontWeight: 700, color: a.up ? 'var(--danger)' : 'var(--success)' }}>
                {money(a.newPrice)} ({a.up ? '+' : '−'}{a.pct.toFixed(0)}%)
              </span>
            </div>
          </div>
        ))}
      </Modal>
    </>
  );
}
