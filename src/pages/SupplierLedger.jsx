import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Ban, Download, HandCoins, Link2, ListChecks, Pencil, Phone, Printer, Receipt, ShoppingCart, Trash2,
  Truck, Undo2, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, norm, rangeFor, nameKey } from '../lib/format.js';
import {
  billStates, combinedSupplierLedger, ledgerFilterMatch, LEDGER_FILTERS, lineReceived, partyDue, purchaseLines,
  receiptProgress, supplierBalance, supplierBillStates, journalOwed,
} from '../lib/calc.js';
import { exportCSV, printReport } from '../lib/exporters.js';
import {
  Button, Card, Confirm, DateRange, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';
import { LineProgressModal, ProgressCount } from '../components/forms.jsx';
import PartyJournal from '../components/PartyJournal.jsx';
import {
  EditPurchaseModal, PurchaseBillModal, SupplierForm, SupplierPaymentModal, SupplierReturnModal,
} from '../components/supplierForms.jsx';
import { SettlePartyModal } from '../components/partyForms.jsx';

const SUPPLIER_VIEW = { supplierView: true };

export default function SupplierLedger() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, mutate, toast } = useApp();
  const [preset, setPreset] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [dialog, setDialog] = useState(null);
  const [payBillId, setPayBillId] = useState('');
  const [openBillId, setOpenBillId] = useState(null);
  const [q, setQ] = useState('');
  const [editLine, setEditLine] = useState(null);
  const [delLine, setDelLine] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [delEntry, setDelEntry] = useState(null);
  const [receiving, setReceiving] = useState(false);
  const [filter, setFilter] = useState('all');
  const [linkTo, setLinkTo] = useState('');
  const [linking, setLinking] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const sup = data.suppliers.find((s) => s.id === id);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const balance = supplierBalance(id, data);
  const bills = useMemo(() => supplierBillStates(id, data), [id, data]);
  const ledger = useMemo(() => combinedSupplierLedger(id, data, range.from, range.to), [id, data, range]);
  const party = sup?.partyId ? data.parties.find((p) => p.id === sup.partyId) : null;
  // An unlinked party with the very same name is almost certainly the same business.
  const sameName = !party && sup ? data.parties.find((p) => nameKey(p.name) === nameKey(sup.name) && !data.suppliers.some((s) => s.partyId === p.id)) : null;
  const linkable = useMemo(() => data.parties
    .filter((p) => p.status !== 'archived' && !data.suppliers.some((s) => s.partyId === p.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name))), [data.parties, data.suppliers]);
  const partyBills = useMemo(() => (party ? billStates(data.bills, data).filter((b) => b.partyId === party.id) : []), [party, data]);
  const openBill = bills.find((b) => b.id === openBillId) || null;
  const s = norm(q);
  const shownBills = useMemo(() => {
    if (!s) return bills;
    const itemName = (iid) => data.items.find((i) => i.id === iid)?.name || '';
    return bills.filter((b) => norm([b.purchaseNo, b.invoiceNo, b.note, b.voidReason, fmtDate(b.date), b.date, b.total, b.due,
      ...purchaseLines(b.id, data).map((l) => `${itemName(l.itemId)} ${l.qty} ${l.costPrice}`)].filter((x) => x != null).join(' ')).includes(s));
  }, [bills, s, data]);
  const filtered = useMemo(() => ledger.filter((r) => ledgerFilterMatch(r, filter, SUPPLIER_VIEW)), [ledger, filter]);
  const rows = useMemo(() => (s ? filtered.filter((r) => norm([r.title, r.detail, r.debit, r.credit, r.date ? fmtDate(r.date) : '', r.date].filter(Boolean).join(' ')).includes(s)) : filtered), [filtered, s]);
  const totals = useMemo(() => ({
    bought: r2(bills.filter((b) => b.status !== 'voided').reduce((t, b) => t + b.total, 0)),
    paid: r2(data.supplierPayments.filter((p) => p.supplierId === id).reduce((t, p) => t + (Number(p.amount) || 0), 0)),
    returned: r2(data.supplierReturns.filter((r) => r.supplierId === id).reduce((t, r) => t + (Number(r.value) || 0), 0)),
  }), [bills, data, id]);

  if (!sup) {
    return <Card><Empty icon={Truck} title="Supplier not found" action={<Button onClick={() => navigate('/suppliers')}>Back to suppliers</Button>} /></Card>;
  }

  const label = balance > 0.004 ? 'You owe' : balance < -0.004 ? 'Advance they hold' : 'Account clear';
  const headers = party
    ? ['Date', 'Entry', 'Detail', 'You owe more (+)', 'You owe less (−)', 'Balance']
    : ['Date', 'Entry', 'Detail', 'Purchased (+)', 'Paid / Returned (−)', 'Balance'];
  const exportRows = rows.map((r) => [r.type === 'opening' ? '' : fmtDate(r.date), r.title, r.detail || '', r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '', r.balance.toFixed(2)]);
  const toExcel = () => {
    exportCSV(`Supplier ${sup.name}`, headers, exportRows, [`${settings.shopName} — Supplier ledger: ${sup.name}`, `${label}: ${money(Math.abs(balance))}`]);
    toast('Ledger exported');
  };
  const toPrint = () => printReport({
    title: `Supplier Ledger — ${sup.name}`, subtitle: [sup.phone, sup.address].filter(Boolean).join(' · '), shopName: settings.shopName,
    headers: headers.map((h, i) => (i >= 3 ? { label: h, align: 'r' } : h)), rows: exportRows, meta: [`${label}: ${money(Math.abs(balance))}`],
  });
  const doVoid = async () => {
    const b = voiding;
    setVoiding(null);
    await mutate(() => api.voidPurchaseBill(b.id, voidReason), `Purchase ${b.purchaseNo} cancelled`).catch(() => {});
    setVoidReason('');
    setOpenBillId(null);
  };
  const doDeleteEntry = async () => {
    const e = delEntry;
    setDelEntry(null);
    if (e.type === 'payment') await mutate(() => api.deleteSupplierPayment(e.paymentId), 'Payment deleted').catch(() => {});
    else if (e.type === 'return') await mutate(() => api.deleteSupplierReturn(e.returnId), 'Return deleted').catch(() => {});
  };
  const doDeleteLine = async () => {
    const l = delLine;
    setDelLine(null);
    await mutate(() => api.deletePurchase(l.id), 'Purchase line deleted').catch(() => {});
  };
  const link = async (partyId) => {
    if (!partyId || linking) return null;
    setLinking(true);
    try {
      await mutate(() => api.linkPartySupplier(partyId, sup.id), 'Linked — their sales now show here');
      setLinkTo('');
      return partyId;
    } catch {
      return null;
    } finally {
      setLinking(false);
    }
  };
  /** Sell to this supplier: their party side is created and linked first if needed. */
  const newSale = async () => {
    if (party) return navigate(`/bill/new?party=${party.id}`);
    if (linking) return undefined;
    let pid = sameName?.id;
    if (!pid) {
      setLinking(true);
      try {
        const p = await mutate(() => api.saveParty({ name: sup.name, phone: sup.phone || '', address: sup.address || '' }), null);
        pid = p?.id;
      } catch {
        pid = null;
      } finally {
        setLinking(false);
      }
    }
    if (pid && (await link(pid))) navigate(`/bill/new?party=${pid}`);
    return undefined;
  };
  const openLines = openBill ? purchaseLines(openBill.id, data) : [];
  const itemName = (iid) => data.items.find((i) => i.id === iid)?.name || 'Item';
  const unitOf = (iid) => data.items.find((i) => i.id === iid)?.baseUnit || '';
  const printBill = (b) => printReport({
    title: `Purchase ${b.purchaseNo}`, subtitle: [sup.name, sup.phone].filter(Boolean).join(' · '), shopName: settings.shopName,
    headers: ['Item', { label: 'Qty', align: 'r' }, { label: 'Cost', align: 'r' }, { label: 'Total', align: 'r' }],
    rows: purchaseLines(b.id, data).map((l) => [itemName(l.itemId), `${l.qty} ${unitOf(l.itemId)}`.trim(), money(l.costPrice), money(r2(l.qty * l.costPrice))]),
    totals: ['Total', '', '', money(b.total)],
    meta: [`Date: ${fmtDate(b.date)}`, ...(b.invoiceNo ? [`Supplier invoice: ${b.invoiceNo}`] : []), `Paid: ${money(b.paid)}`, `Due: ${money(b.due)}`,
      ...(b.status === 'voided' ? ['CANCELLED'] : []), ...(b.note ? [`Note: ${b.note}`] : [])],
  });
  const net = party ? r2(balance - partyDue(party.id, billStates(data.bills, data)) - journalOwed('party', party.id, data)) : 0;

  return (
    <>
      <PageHead title={sup.name} subtitle={[sup.phone, sup.address, sup.status === 'archived' ? 'Archived' : ''].filter(Boolean).join(' · ') || 'Supplier'}>
        <Button icon={ArrowLeft} onClick={() => navigate('/suppliers')}>Suppliers</Button>
        {party && <Button icon={HandCoins} onClick={() => navigate(`/party/${party.id}`)}>Party Ledger (net)</Button>}
        <Button icon={Pencil} onClick={() => setDialog('edit')}>Edit</Button>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button icon={Printer} onClick={toPrint}>Print</Button>
      </PageHead>
      <div className="row mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" icon={ShoppingCart} onClick={() => setDialog('buy')}>New Purchase</Button>
        <Button icon={Wallet} onClick={() => { setPayBillId(''); setDialog('pay'); }}>Pay Supplier</Button>
        <Button icon={HandCoins} onClick={() => setDialog('advance')}>Give Advance</Button>
        <Button icon={Undo2} onClick={() => setDialog('return')}>Return Goods</Button>
        <Button icon={Receipt} onClick={newSale} loading={linking} title="Sell goods to this supplier">New Sale</Button>
        {party && <Button icon={Wallet} onClick={() => setReceiveOpen(true)} title="Money received from them for goods you sold them">Receive Payment</Button>}
        {sup.phone && <a className="btn" href={`tel:${sup.phone}`}><Phone size={15} /> Call</a>}
        <span className="spacer" />
        <SearchBox value={q} onChange={setQ} placeholder="Search item, PUR no, invoice, note…" style={{ minWidth: 240 }} />
      </div>
      {!party && (
        <Card tight>
          <div className="row wrap" style={{ gap: 8, padding: '10px 12px', alignItems: 'center' }}>
            <Link2 size={16} />
            <span className="small" style={{ flex: '1 1 240px' }}>
              {sameName
                ? <>Party <strong>{sameName.name}</strong> has the same name. Link them to see sales and purchases together.</>
                : 'Do you also sell to this supplier? Link them to their party to see sales and purchases together.'}
            </span>
            {sameName ? (
              <Button size="sm" variant="primary" icon={Link2} loading={linking} onClick={() => link(sameName.id)}>Link</Button>
            ) : (
              <>
                <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} style={{ width: 200 }}>
                  <option value="">Choose a party…</option>
                  {linkable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Button size="sm" variant="primary" icon={Link2} loading={linking} disabled={!linkTo} onClick={() => link(linkTo)}>Link</Button>
              </>
            )}
          </div>
        </Card>
      )}
      <div className="stat-grid">
        <Stat label={label} value={money(Math.abs(balance))} icon={Wallet} tone={balance > 0.004 ? '#DC2626' : '#16A34A'} />
        <Stat label="Total purchased" value={money(totals.bought)} icon={ShoppingCart} tone="#1F2937" />
        <Stat label="Total paid" value={money(totals.paid)} icon={Wallet} tone="#16A34A" />
        <Stat label="Returned to supplier" value={money(totals.returned)} icon={Undo2} tone="#F59E0B" />
        {party && (
          <Stat
            label="Net balance"
            value={money(Math.abs(net))}
            icon={HandCoins}
            tone={net > 0.004 ? '#DC2626' : '#16A34A'}
            note={net > 0.004 ? `You owe ${party.name}` : net < -0.004 ? `${party.name} owes you` : 'Account is settled'}
            onClick={() => navigate(`/party/${party.id}`)}
          />
        )}
      </div>

      <Card title="Purchase bills" subtitle="Payments made against a bill settle that bill; other payments settle the oldest first" tight>
        {bills.length > 0 && !shownBills.length ? <Empty icon={ShoppingCart} title="No matching purchases" message={`Nothing matches "${q}".`} /> : bills.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Purchase</th><th>Date</th><th>Invoice</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th><th>Status</th><th style={{ width: 90 }} /></tr></thead>
              <tbody>
                {shownBills.map((b) => {
                  const rcv = b.status !== 'voided' ? receiptProgress(purchaseLines(b.id, data)).state : 'received';
                  return (
                    <tr key={b.id} className="clickable" onClick={() => navigate(`/purchase/${b.id}`)}>
                      <td className="strong">{b.purchaseNo}</td>
                      <td className="nowrap">{fmtDate(b.date)}</td>
                      <td>{b.invoiceNo || <span className="muted">—</span>}</td>
                      <td className="r"><Money value={b.total} /></td>
                      <td className="r"><Money value={b.paid} /></td>
                      <td className="r strong">{b.due > 0 ? <span className="money neg">{money(b.due)}</span> : '—'}</td>
                      <td>
                        <Pill status={b.status} label={b.status === 'voided' ? 'Cancelled' : undefined} />
                        {rcv !== 'received' && <div style={{ marginTop: 3 }}><Pill status={rcv === 'partial' ? 'part-received' : 'not-received'} /></div>}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {b.status !== 'voided' && b.due > 0 && <Button size="sm" onClick={() => { setPayBillId(b.id); setDialog('pay'); }}>Pay</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={ShoppingCart} title="No purchases yet" message="Record stock bought from this supplier." action={<Button variant="primary" icon={ShoppingCart} onClick={() => setDialog('buy')}>New Purchase</Button>} />
        )}
      </Card>

      <div className="mt-2 mb-2">
        <DateRange value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} presets={[{ value: 'all', label: 'All time' }, { value: 'month', label: 'This month' }, { value: 'lastMonth', label: 'Last month' }]} />
      </div>
      <Card
        title="Ledger"
        tight
        subtitle={party ? `Purchases and sales to ${party.name} together — balance is what you owe them, net` : 'Purchases add to what you owe; payments and returns reduce it'}
      >
        <div className="seg" style={{ margin: '10px 12px', flexWrap: 'wrap' }}>
          {LEDGER_FILTERS.map((f) => (
            <button key={f.value} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>
              {f.label} <span className="muted small">({ledger.filter((r) => ledgerFilterMatch(r, f.value, SUPPLIER_VIEW)).length})</span>
            </button>
          ))}
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Entry</th><th className="r">{headers[3]}</th><th className="r">{headers[4]}</th><th className="r">Balance</th><th style={{ width: 44 }} /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    style={r.voided ? { opacity: 0.55 } : undefined}
                    className={(r.side === 'sale' && r.billId) || r.purchaseBillId ? 'clickable' : ''}
                    onClick={() => {
                      if (r.side === 'sale' && r.billId) navigate(`/bill/${r.billId}`);
                      else if (r.purchaseBillId) navigate(`/purchase/${r.purchaseBillId}`);
                    }}
                  >
                    <td className="nowrap">{r.type === 'opening' ? '—' : fmtDate(r.date)}</td>
                    <td>
                      <div style={{ fontWeight: 600, textDecoration: r.voided || r.struck ? 'line-through' : 'none' }}>
                        {r.side === 'sale' && <><Pill status="paid" label="Sale" />{' '}</>}
                        {r.title}
                      </div>
                      {r.detail && <div className="small muted">{r.detail}</div>}
                    </td>
                    <td className="r">{r.debit ? <Money value={r.debit} /> : r.pending > 0 ? <span className="money" style={{ color: '#B45309' }}>({money(r.pending)})</span> : ''}</td>
                    <td className="r">{r.credit ? <Money value={r.credit} /> : ''}</td>
                    <td className="r strong">
                      <span className={`money ${r.balance > 0.004 ? 'neg' : r.balance < -0.004 ? 'pos' : ''}`}>{money(Math.abs(r.balance))}{r.balance < -0.004 ? ' adv' : ''}</span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {(r.type === 'payment' || r.type === 'return') && (
                        <button className="btn btn-ghost btn-sm" title="Delete this entry" onClick={() => setDelEntry(r)}><Trash2 size={14} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Truck}
            title="No entries"
            message={(filter === 'sales' || filter === 'received') && !party ? 'Nothing sold to this supplier yet. Use New Sale, or link their party above.' : 'Nothing recorded in this period.'}
          />
        )}
      </Card>

      <div className="mt-2"><PartyJournal kind="supplier" party={sup} /></div>

      <Modal
        open={!!openBill && !editLine && !delLine && !receiving}
        title={openBill ? `Purchase ${openBill.purchaseNo}` : ''}
        onClose={() => setOpenBillId(null)}
        footer={openBill && openBill.status !== 'voided' ? (
          <>
            <Button icon={Ban} variant="danger" onClick={() => setVoiding(openBill)}>Cancel purchase</Button>
            <span className="spacer" />
            <Button icon={Printer} onClick={() => printBill(openBill)}>Print</Button>
            <Button icon={ListChecks} onClick={() => setReceiving(true)}>Receiving</Button>
            {openBill.due > 0 && <Button variant="primary" icon={Wallet} onClick={() => { setPayBillId(openBill.id); setOpenBillId(null); setDialog('pay'); }}>Pay {money(openBill.due)}</Button>}
          </>
        ) : openBill ? <Button icon={Printer} onClick={() => printBill(openBill)}>Print</Button> : null}
      >
        {openBill && (
          <>
            <div className="small muted mb-2">
              {fmtDate(openBill.date)}{openBill.invoiceNo ? ` · Supplier invoice ${openBill.invoiceNo}` : ''}{openBill.note ? ` · ${openBill.note}` : ''}
              {openBill.status === 'voided' ? ` · CANCELLED${openBill.voidReason ? ` — ${openBill.voidReason}` : ''}` : ''}
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th className="r">Qty</th><th className="r">Cost</th><th className="r">Total</th>
                    {openBill.status !== 'voided' && <th className="r">Received</th>}
                    {openBill.status !== 'voided' && <th style={{ width: 76 }} />}
                  </tr>
                </thead>
                <tbody>
                  {openLines.map((l) => (
                    <tr key={l.id}>
                      <td>{itemName(l.itemId)}</td>
                      <td className="r">{l.qty}</td>
                      <td className="r"><Money value={l.costPrice} /></td>
                      <td className="r strong"><Money value={r2(l.qty * l.costPrice)} /></td>
                      {openBill.status !== 'voided' && <td className="r nowrap"><ProgressCount done={lineReceived(l)} qty={Number(l.qty) || 0} /></td>}
                      {openBill.status !== 'voided' && (
                        <td className="nowrap">
                          <button className="btn btn-ghost btn-sm" title="Edit this line" onClick={() => setEditLine(l)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title="Delete this line" onClick={() => setDelLine(l)}><Trash2 size={14} /></button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3}>Total</td><td className="r">{money(openBill.total)}</td></tr>
                  <tr><td colSpan={3}>Paid</td><td className="r">{money(openBill.paid)}</td></tr>
                  {openBill.returned > 0 && <tr><td colSpan={3}>Returned</td><td className="r">{money(openBill.returned)}</td></tr>}
                  <tr><td colSpan={3}>Due</td><td className="r">{money(openBill.due)}</td></tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={!!voiding}
        title="Cancel this purchase?"
        onClose={() => setVoiding(null)}
        footer={<><Button onClick={() => setVoiding(null)}>Keep it</Button><Button variant="danger" icon={Ban} onClick={doVoid}>Cancel purchase</Button></>}
      >
        <p className="small">
          {voiding?.purchaseNo} will stop counting: its items come out of stock and its total comes off what you owe. It stays visible, struck through. Any payment made against it stays and counts toward this supplier's other bills, or as an advance.
        </p>
        <Field label="Reason"><Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. entered twice" autoFocus /></Field>
      </Modal>
      <EditPurchaseModal purchase={editLine} onClose={() => setEditLine(null)} />
      <LineProgressModal
        open={receiving && !!openBill}
        onClose={() => setReceiving(false)}
        title={openBill ? `Goods received — ${openBill.purchaseNo}` : ''}
        verb="Received"
        lines={openLines.map((l) => ({ id: l.id, name: itemName(l.itemId), qty: Number(l.qty) || 0, unit: unitOf(l.itemId), done: lineReceived(l) }))}
        onSave={(changes) => mutate(() => api.setPurchaseReceipt(openBill.id, changes.map((c) => ({ id: c.id, receivedQty: c.qty }))), 'Receiving updated')}
      />
      <Confirm
        open={!!delLine}
        danger
        title="Delete this line?"
        message={delLine && openBill ? `${itemName(delLine.itemId)} ${delLine.qty} @ ${money(delLine.costPrice)}. `
          + (openLines.length > 1 ? `The stock comes back out and ${openBill.purchaseNo}'s total drops by ${money(r2(delLine.qty * delLine.costPrice))}.`
            : `This is the only line, so purchase ${openBill.purchaseNo} is removed. Any payment made on it stays on this supplier's account.`) : ''}
        confirmLabel="Delete"
        onConfirm={doDeleteLine}
        onCancel={() => setDelLine(null)}
      />
      <Confirm
        open={!!delEntry}
        danger
        title={delEntry?.type === 'payment' ? (delEntry.isAdvance ? 'Delete this advance?' : 'Delete this payment?') : 'Delete this return?'}
        message={delEntry ? `${delEntry.title} — ${money(delEntry.credit)}. ` + (delEntry.type === 'payment'
          ? 'The money goes back into your account balance and the supplier balance goes up again.'
          : 'The items go back into stock and the supplier balance goes up again.') : ''}
        confirmLabel="Delete"
        onConfirm={doDeleteEntry}
        onCancel={() => setDelEntry(null)}
      />
      <Modal open={dialog === 'edit'} title={`Edit ${sup.name}`} onClose={() => setDialog(null)}>
        {dialog === 'edit' && <SupplierForm supplier={sup} onSaved={() => setDialog(null)} onCancel={() => setDialog(null)} />}
      </Modal>
      <PurchaseBillModal open={dialog === 'buy'} supplierId={id} onClose={() => setDialog(null)} />
      <SupplierPaymentModal open={dialog === 'pay'} supplierId={id} purchaseBillId={payBillId} onClose={() => setDialog(null)} />
      <SupplierPaymentModal open={dialog === 'advance'} supplierId={id} advance onClose={() => setDialog(null)} />
      <SupplierReturnModal open={dialog === 'return'} supplierId={id} onClose={() => setDialog(null)} />
      {party && <SettlePartyModal open={receiveOpen} party={party} bills={partyBills} onClose={(msg) => { setReceiveOpen(false); if (msg) toast(msg); }} />}
    </>
  );
}
