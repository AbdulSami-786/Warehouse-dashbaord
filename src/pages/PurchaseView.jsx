import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Ban, ListChecks, Pencil, Printer, Send, ShoppingCart, Trash2, Truck, Undo2, Wallet,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, fmtDate, fmtDateTime, whatsappUrl } from '../lib/format.js';
import {
  supplierBillStates, purchaseLines, receiptProgress, lineReceived,
} from '../lib/calc.js';
import { printReport } from '../lib/exporters.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, Money, PageHead, Pill,
} from '../components/ui.jsx';
import { LineProgressModal, ProgressCount } from '../components/forms.jsx';
import { EditPurchaseModal, SupplierPaymentModal, SupplierReturnModal } from '../components/supplierForms.jsx';

function SumRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span className={strong ? '' : 'muted'} style={{ fontSize: 13.5, fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span className="spacer" />
      <Money value={value} />
    </div>
  );
}

export default function PurchaseView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, mutate } = useApp();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [retOpen, setRetOpen] = useState(false);
  const [rcvOpen, setRcvOpen] = useState(false);
  const [delPay, setDelPay] = useState(null);
  const [delRet, setDelRet] = useState(null);

  // The route takes either a purchase line id or a purchase bill id.
  const line = data.purchases.find((p) => p.id === id) || data.purchases.find((p) => p.purchaseBillId === id) || null;
  const pbill = line?.purchaseBillId ? data.purchaseBills.find((b) => b.id === line.purchaseBillId) : null;
  const state = useMemo(() => (pbill && supplierBillStates(pbill.supplierId, data).find((b) => b.id === pbill.id)) || null, [pbill, data]);
  const supplier = pbill ? data.suppliers.find((s) => s.id === pbill.supplierId) : null;
  const lines = state ? purchaseLines(state.id, data) : line ? [line] : [];
  const payments = useMemo(() => (state ? data.supplierPayments.filter((p) => p.purchaseBillId === state.id) : []), [state, data.supplierPayments]);
  const returns = useMemo(() => (state ? data.supplierReturns.filter((r) => r.purchaseBillId === state.id) : []), [state, data.supplierReturns]);

  if (!line) {
    return <Empty icon={ShoppingCart} title="Purchase not found" message="This purchase may have been removed." action={<Button onClick={() => navigate('/purchases')}>Back to Purchases</Button>} />;
  }

  const cancelled = state?.status === 'voided';
  const item = (iid) => data.items.find((i) => i.id === iid);
  const nameOf = (iid) => item(iid)?.name || 'Item';
  const total = state ? state.total : r2(lines.reduce((s, l) => s + l.qty * l.costPrice, 0));
  const supName = supplier?.name || line.supplierName || '';
  const title = state ? `Purchase ${state.purchaseNo}` : `Purchase — ${nameOf(line.itemId)}`;
  const receipt = receiptProgress(lines);
  const date = state?.date || line.date;

  const print = () => printReport({
    title, subtitle: [supName, supplier?.phone].filter(Boolean).join(' · '), shopName: settings.shopName,
    headers: ['#', 'Item', { label: 'Qty', align: 'r' }, { label: 'Cost', align: 'r' }, { label: 'Total', align: 'r' }],
    rows: lines.map((l, i) => [i + 1, nameOf(l.itemId), `${l.qty} ${item(l.itemId)?.baseUnit || ''}`.trim(), money(l.costPrice), money(r2(l.qty * l.costPrice))]),
    totals: ['', 'Total', '', '', money(total)],
    meta: [
      `Date: ${fmtDate(date)}`,
      ...(state?.invoiceNo ? [`Supplier invoice: ${state.invoiceNo}`] : []),
      ...(state ? [`Paid: ${money(state.paid)}`, ...(state.returned > 0 ? [`Returned: ${money(state.returned)}`] : []), `Due: ${money(state.due)}`] : [`Paid from: ${line.method || '—'}`]),
      ...(cancelled ? ['CANCELLED'] : []),
      ...(state?.note || line.note ? [`Note: ${state?.note || line.note}`] : []),
    ],
  });
  const waText = [
    `*${settings.shopName}*`, `${title} — ${fmtDate(date)}`, '',
    ...lines.map((l) => `${nameOf(l.itemId)} — ${l.qty} × ${money(l.costPrice)} = ${money(l.qty * l.costPrice)}`), '',
    `Total: ${money(total)}`, ...(state ? [`Paid: ${money(state.paid)}`, `Due: ${money(state.due)}`] : []),
  ].join('\n');

  const doDelete = async () => {
    const l = deleting;
    setDeleting(null);
    const last = lines.length === 1;
    await mutate(() => api.deletePurchase(l.id), 'Purchase line deleted').catch(() => {});
    if (last) navigate('/purchases');
    else if (l.id === id) navigate(`/purchase/${lines.find((x) => x.id !== l.id).id}`, { replace: true });
  };
  const doVoid = async () => {
    setVoidOpen(false);
    await mutate(() => api.voidPurchaseBill(state.id, voidReason), `${title} cancelled`).catch(() => {});
    setVoidReason('');
  };

  return (
    <>
      <PageHead title={title} subtitle={`${supName || 'No supplier'} · ${fmtDate(date)}`}>
        <Button icon={ArrowLeft} onClick={() => navigate(-1)}>Back</Button>
        <Button icon={Printer} onClick={print}>Print</Button>
        {supplier?.phone && <a className="btn" href={whatsappUrl(supplier.phone, waText)} target="_blank" rel="noreferrer"><Send size={15} /> WhatsApp</a>}
        {state && !cancelled && (
          <>
            <Button icon={ListChecks} onClick={() => setRcvOpen(true)}>Receiving</Button>
            <Button icon={Undo2} onClick={() => setRetOpen(true)}>Return</Button>
            <Button icon={Ban} onClick={() => setVoidOpen(true)}>Cancel</Button>
            {state.due > 0 && <Button variant="primary" icon={Wallet} onClick={() => setPayOpen(true)}>Pay Supplier</Button>}
          </>
        )}
        {!state && (
          <>
            <Button icon={Pencil} onClick={() => setEditing(line)}>Edit</Button>
            <Button icon={Trash2} onClick={() => setDeleting(line)}>Delete</Button>
          </>
        )}
      </PageHead>

      {cancelled && (
        <div style={{ padding: '12px 14px', background: 'var(--neutral-bg)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center' }}>
          <Ban size={17} className="muted" />
          <div>
            <div style={{ fontWeight: 700 }}>This purchase is cancelled</div>
            <div className="small muted">{state.voidReason || 'No reason recorded'}{state.voidedAt ? ` · ${fmtDateTime(state.voidedAt)}` : ''} — kept in history, not counted in stock or what you owe.</div>
          </div>
        </div>
      )}
      {!cancelled && receipt.state !== 'received' && (
        <div style={{ padding: '12px 14px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center' }}>
          <ListChecks size={17} color="#B45309" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#B45309' }}>{receipt.state === 'partial' ? 'Partly received' : 'Goods not received yet'}</div>
            <div className="small" style={{ color: '#B45309' }}>
              Still to come:{' '}
              {lines.filter((l) => lineReceived(l) < l.qty - 0.0001).map((l) => `${nameOf(l.itemId)} (${+(l.qty - lineReceived(l)).toFixed(3)})`).join(', ')}
            </div>
          </div>
          {state && <Button size="sm" onClick={() => setRcvOpen(true)}>Update</Button>}
        </div>
      )}

      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Items" tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Cost</th><th className="r">Amount</th>
                    {!cancelled && <th className="r">Received</th>}
                    {!cancelled && <th style={{ width: 76 }} />}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{nameOf(l.itemId)}</td>
                      <td className="r">{l.qty}</td>
                      <td>{item(l.itemId)?.baseUnit || ''}</td>
                      <td className="r"><Money value={l.costPrice} /></td>
                      <td className="r strong"><Money value={r2(l.qty * l.costPrice)} /></td>
                      {!cancelled && <td className="r nowrap"><ProgressCount done={lineReceived(l)} qty={Number(l.qty) || 0} /></td>}
                      {!cancelled && (
                        <td className="nowrap">
                          <button className="btn btn-ghost btn-sm" title="Edit this line" onClick={() => setEditing(l)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title="Delete this line" onClick={() => setDeleting(l)}><Trash2 size={14} /></button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ fontSize: 15 }}>Total</td>
                    <td className="r" style={{ fontSize: 15 }}>{money(total)}</td>
                    {!cancelled && <td colSpan={2} />}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {state && (
            <Card title="Payments to supplier" tight>
              {payments.length ? (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="r">Amount</th><th style={{ width: 50 }} /></tr></thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id}>
                          <td>{fmtDate(p.date)}</td>
                          <td>{p.method}</td>
                          <td className="small muted">{p.note || '—'}</td>
                          <td className="r strong">{money(p.amount)}</td>
                          <td><button className="btn btn-ghost btn-sm" title="Delete this payment" onClick={() => setDelPay(p)}><Trash2 size={14} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="No payments on this purchase"
                  message="Payments made to the supplier's account (not to this purchase) settle their oldest purchases first."
                  action={!cancelled && state.due > 0 ? <Button variant="primary" onClick={() => setPayOpen(true)}>Pay supplier</Button> : null}
                />
              )}
            </Card>
          )}

          {returns.length > 0 && (
            <Card title="Returned to supplier" tight>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Item</th><th className="r">Qty</th><th>Note</th><th className="r">Value</th><th style={{ width: 50 }} /></tr></thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{nameOf(r.itemId)}</td>
                        <td className="r">{r.qty}</td>
                        <td className="small muted">{r.note || '—'}</td>
                        <td className="r strong"><Money value={r.value} /></td>
                        <td><button className="btn btn-ghost btn-sm" title="Delete this return" onClick={() => setDelRet(r)}><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="col">
          <Card title="Summary">
            {state && (
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <span className="muted">Status</span><span className="spacer" />
                <Pill status={state.status} label={cancelled ? 'Cancelled' : undefined} />
              </div>
            )}
            <SumRow label="Total" value={total} strong />
            {state && <SumRow label="Paid" value={state.paid} />}
            {state?.returned > 0 && <SumRow label="Returned" value={state.returned} />}
            {state ? (
              <div style={{ display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 6, borderTop: '2px solid var(--border-strong)' }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>You owe</span>
                <span className="spacer" />
                <span className="money" style={{ fontSize: 19, color: state.due > 0 ? 'var(--danger)' : 'var(--success)' }}>{money(state.due)}</span>
              </div>
            ) : <div className="small muted mt-2">Paid from {line.method || '—'} when it was recorded.</div>}
          </Card>
          <Card title="Supplier">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{supName || '—'}</div>
            {supplier?.phone && <div className="small muted">{supplier.phone}</div>}
            {supplier?.address && <div className="small muted">{supplier.address}</div>}
            {state?.invoiceNo && <div className="small muted">Their invoice: {state.invoiceNo}</div>}
            {supplier && <Button className="mt-2" block icon={Truck} onClick={() => navigate(`/supplier/${supplier.id}`)}>Open supplier khata</Button>}
          </Card>
          {(state?.note || line.note) && <Card title="Note"><p style={{ margin: 0, fontSize: 13.5 }}>{state?.note || line.note}</p></Card>}
        </div>
      </div>

      <EditPurchaseModal purchase={editing} onClose={() => setEditing(null)} />
      <Confirm
        open={!!deleting}
        danger
        title="Delete this line?"
        message={deleting ? `${nameOf(deleting.itemId)} ${deleting.qty} @ ${money(deleting.costPrice)}. `
          + (state && lines.length > 1 ? `The stock comes back out and ${state.purchaseNo}'s total drops by ${money(r2(deleting.qty * deleting.costPrice))}.`
            : state ? `This is the only line, so purchase ${state.purchaseNo} is removed. Any payment made on it stays on the supplier's account.`
              : 'The stock comes back out.') : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
      <Modal
        open={voidOpen}
        title="Cancel this purchase?"
        onClose={() => setVoidOpen(false)}
        footer={<><Button onClick={() => setVoidOpen(false)}>Keep it</Button><Button variant="danger" icon={Ban} onClick={doVoid}>Cancel purchase</Button></>}
      >
        <p className="small">{state?.purchaseNo} will stop counting: its items come out of stock and its total comes off what you owe. It stays visible, struck through.</p>
        <Field label="Reason"><Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. entered twice" autoFocus /></Field>
      </Modal>
      <Confirm
        open={!!delPay}
        danger
        title="Delete this payment?"
        message={delPay ? `${money(delPay.amount)} (${delPay.method}) on ${fmtDate(delPay.date)}. What you owe the supplier goes back up by this amount.` : ''}
        confirmLabel="Delete"
        onConfirm={async () => { const p = delPay; setDelPay(null); await mutate(() => api.deleteSupplierPayment(p.id), 'Payment deleted').catch(() => {}); }}
        onCancel={() => setDelPay(null)}
      />
      <Confirm
        open={!!delRet}
        danger
        title="Delete this return?"
        message={delRet ? `${nameOf(delRet.itemId)} × ${delRet.qty}, value ${money(delRet.value)}. The items go back into stock and what you owe goes back up.` : ''}
        confirmLabel="Delete"
        onConfirm={async () => { const r = delRet; setDelRet(null); await mutate(() => api.deleteSupplierReturn(r.id), 'Return deleted').catch(() => {}); }}
        onCancel={() => setDelRet(null)}
      />
      {state && (
        <>
          <SupplierPaymentModal open={payOpen} supplierId={state.supplierId} purchaseBillId={state.id} onClose={() => setPayOpen(false)} />
          <SupplierReturnModal open={retOpen} supplierId={state.supplierId} purchaseBillId={state.id} onClose={() => setRetOpen(false)} />
          <LineProgressModal
            open={rcvOpen}
            onClose={() => setRcvOpen(false)}
            title={`Goods received — ${state.purchaseNo}`}
            verb="Received"
            lines={lines.map((l) => ({ id: l.id, name: nameOf(l.itemId), qty: Number(l.qty) || 0, unit: item(l.itemId)?.baseUnit || '', done: lineReceived(l) }))}
            onSave={(changes) => mutate(() => api.setPurchaseReceipt(state.id, changes.map((c) => ({ id: c.id, receivedQty: c.qty }))), 'Receiving updated')}
          />
        </>
      )}
    </>
  );
}
