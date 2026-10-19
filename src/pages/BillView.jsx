import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Ban, FileDown, ListChecks, PackageOpen, Pencil, Plus, Printer, Receipt, RotateCcw, Send, Truck, Undo2,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, fmtDate, fmtDateTime, qtySummary, whatsappUrl } from '../lib/format.js';
import { billStates, deliveryProgress, lineDelivered } from '../lib/calc.js';
import { billPDF, printBill } from '../lib/exporters.js';
import {
  Button, Card, Empty, Field, Input, Modal, Money, PageHead, Pill,
} from '../components/ui.jsx';
import { LineProgressModal, PaymentModal, ProgressCount, ReturnModal } from '../components/forms.jsx';

function SumRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span className={strong ? '' : 'muted'} style={{ fontSize: 13.5, fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span className="spacer" />
      <Money value={value} />
    </div>
  );
}

const banner = (bg, border) => ({
  padding: '12px 14px', background: bg, border: `1px solid ${border}`, borderRadius: 'var(--r)',
  marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
});

export default function BillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, mutate } = useApp();
  const [payOpen, setPayOpen] = useState(false);
  const [retOpen, setRetOpen] = useState(false);
  const [dlvOpen, setDlvOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [reversing, setReversing] = useState(null);
  const [revReason, setRevReason] = useState('');
  const [busy, setBusy] = useState(false);

  const bill = data.bills.find((b) => b.id === id);
  const state = useMemo(() => (bill ? billStates(data.bills.filter((b) => b.partyId === bill.partyId), data).find((b) => b.id === bill.id) : null), [bill, data]);
  const party = bill ? data.parties.find((p) => p.id === bill.partyId) : null;
  const lines = useMemo(() => (bill ? data.billItems.filter((l) => l.billId === bill.id).map((l) => ({
    ...l, itemName: data.items.find((i) => i.id === l.itemId)?.name || 'Item', delivered: lineDelivered(l, bill),
  })) : []), [bill, data.billItems, data.items]);
  const progress = useMemo(() => deliveryProgress(bill, data.billItems), [bill, data.billItems]);
  const payments = useMemo(() => (bill ? data.payments.filter((p) => p.billId === bill.id) : []), [bill, data.payments]);
  const returns = useMemo(() => (bill ? data.returns.filter((r) => r.billId === bill.id) : []), [bill, data.returns]);
  // By payment, not by bill: an account payment's cheque is written with no
  // bill of its own, though each of its parts belongs to one.
  const cheques = useMemo(() => {
    const ids = new Set(payments.map((p) => p.id));
    return data.cheques.filter((c) => ids.has(c.paymentId));
  }, [payments, data.cheques]);

  if (!bill) {
    return <Empty icon={Receipt} title="Bill not found" message="This bill may have been removed." action={<Button onClick={() => navigate('/bills')}>Back to Bills</Button>} />;
  }

  const live = payments.filter((p) => !p.reversed);
  const doc = { bill, lines, party, payments: live, settings, state, delivery: progress };
  const waText = [
    `*${settings.shopName}*`, `Bill ${bill.billNo} — ${fmtDate(bill.date)}`, '',
    ...lines.map((l) => `${l.itemName} — ${l.qty} ${l.unit} × ${money(l.price)} = ${money(l.qty * l.price)}`), '',
    `Total: ${money(state.net)}`, `Paid: ${money(state.paid)}`,
    state.due > 0 ? `*Balance due: ${money(state.due)}* (due ${fmtDate(bill.dueDate)})` : '*Fully paid — thank you!*',
  ].join('\n');

  const doVoid = async () => {
    setVoidOpen(false);
    try {
      await mutate(() => api.voidBill(bill.id, voidReason), `Bill ${bill.billNo} voided`);
      setVoidReason('');
    } catch { /* toasted */ }
  };
  const setDelivery = async (to) => {
    if (busy) return;
    setBusy(true);
    try {
      await mutate(() => api.setDelivery(bill.id, to), to === 'delivered' ? `Bill ${bill.billNo} marked delivered` : `Bill ${bill.billNo} marked pending`);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  const saveLines = (changes) => mutate(() => api.setLineDelivery(bill.id, changes.map((c) => ({ id: c.id, deliveredQty: c.qty }))), 'Delivery updated');
  const doReverse = async () => {
    const p = reversing;
    setReversing(null);
    try {
      await mutate(() => api.reversePayment(p.id, revReason),
        p.method === 'Advance' ? 'Payment reversed — the amount is back in the party’s advance' : 'Payment reversed');
      setRevReason('');
    } catch { /* toasted */ }
  };
  const open = bill.status !== 'voided';

  return (
    <>
      <PageHead title={`Bill ${bill.billNo}`} subtitle={`${party?.name || 'Unknown party'} · ${fmtDate(bill.date)}`}>
        <Button icon={ArrowLeft} onClick={() => navigate(-1)}>Back</Button>
        <Button icon={Printer} onClick={() => printBill(doc)}>Print</Button>
        <Button icon={FileDown} onClick={() => billPDF(doc)}>PDF</Button>
        {party?.phone && <a className="btn" href={whatsappUrl(party.phone, waText)} target="_blank" rel="noreferrer"><Send size={15} /> WhatsApp</a>}
        {open && (
          <>
            <Button icon={ListChecks} onClick={() => setDlvOpen(true)}>Delivery</Button>
            {progress.state !== 'delivered'
              ? <Button variant="primary" icon={Truck} loading={busy} onClick={() => setDelivery('delivered')}>Mark All Delivered</Button>
              : <Button icon={PackageOpen} loading={busy} onClick={() => setDelivery('pending')}>Mark Pending</Button>}
            <Button icon={RotateCcw} onClick={() => setRetOpen(true)}>Return</Button>
            <Button icon={Pencil} onClick={() => navigate(`/bill/${bill.id}/edit`)}>Edit</Button>
            <Button icon={Ban} onClick={() => setVoidOpen(true)}>Void</Button>
            {state.due > 0 && <Button variant="primary" icon={Plus} onClick={() => setPayOpen(true)}>Add Payment</Button>}
          </>
        )}
      </PageHead>

      {!open && (
        <div style={banner('var(--neutral-bg)', 'var(--border-strong)')}>
          <Ban size={17} className="muted" />
          <div>
            <div style={{ fontWeight: 700 }}>This bill is voided</div>
            <div className="small muted">{bill.voidReason || 'No reason recorded'} · {fmtDateTime(bill.voidedAt)} — kept in history, excluded from sales and dues.</div>
          </div>
        </div>
      )}
      {progress.state === 'partial' && (
        <div style={banner('var(--info-bg)', '#BFDBFE')}>
          <ListChecks size={17} color="#1D4ED8" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#1D4ED8' }}>Partly delivered</div>
            <div className="small" style={{ color: '#1D4ED8' }}>
              {lines.filter((l) => l.delivered >= l.qty - 0.0001).length} of {lines.length} items fully sent. Still to go:{' '}
              {lines.filter((l) => l.delivered < l.qty - 0.0001).map((l) => `${l.itemName} (${+(l.qty - l.delivered).toFixed(3)} ${l.unit})`).join(', ')}
            </div>
          </div>
          <Button size="sm" onClick={() => setDlvOpen(true)}>Update</Button>
        </div>
      )}
      {progress.state === 'pending' && (
        <div style={banner('var(--warning-bg)', '#FDE68A')}>
          <PackageOpen size={17} color="#B45309" />
          <div>
            <div style={{ fontWeight: 700, color: '#B45309' }}>Not delivered yet</div>
            <div className="small" style={{ color: '#B45309' }}>The goods on this bill have not gone out. It still counts as a sale and as money owed.</div>
          </div>
        </div>
      )}

      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Items" tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Rate</th><th className="r">Amount</th>
                    {open && <th className="r">Delivered</th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{l.itemName}</td>
                      <td className="r">{l.qty}</td>
                      <td>{l.unit}</td>
                      <td className="r"><Money value={l.price} /></td>
                      <td className="r strong"><Money value={l.qty * l.price} /></td>
                      {open && <td className="r nowrap"><ProgressCount done={l.delivered} qty={l.qty} /></td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>{lines.length} item{lines.length === 1 ? '' : 's'}</td>
                    <td className="r" colSpan={2} style={{ fontWeight: 700 }}>{qtySummary(lines)}</td>
                    <td colSpan={open ? 3 : 2} />
                  </tr>
                  <tr><td colSpan={5}>Subtotal</td><td className="r">{money(bill.subtotal)}</td>{open && <td />}</tr>
                  {Number(bill.roundOff) !== 0 && (
                    <tr><td colSpan={5} className="muted" style={{ fontWeight: 500 }}>Round off</td><td className="r">{money(bill.roundOff, { showSign: true })}</td>{open && <td />}</tr>
                  )}
                  {state.returned > 0 && (
                    <tr><td colSpan={5} style={{ color: 'var(--danger)' }}>Returns</td><td className="r" style={{ color: 'var(--danger)' }}>- {money(state.returned)}</td>{open && <td />}</tr>
                  )}
                  <tr><td colSpan={5} style={{ fontSize: 15 }}>Total</td><td className="r" style={{ fontSize: 15 }}>{money(state.net)}</td>{open && <td />}</tr>
                </tfoot>
              </table>
            </div>
          </Card>

          <Card title="Payments" subtitle="Reversed payments stay listed for traceability" tight>
            {payments.length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="r">Amount</th><th style={{ width: 110 }} /></tr></thead>
                  <tbody>
                    {payments.map((p) => {
                      const c = cheques.find((x) => x.paymentId === p.id);
                      return (
                        <tr key={p.id} style={p.reversed ? { opacity: 0.55 } : undefined}>
                          <td>{fmtDate(p.date)}</td>
                          <td>
                            {p.method}
                            {c && <div className="small muted">{c.chequeNo} · {c.bankName}{c.accountHolder ? ` · ${c.accountHolder}` : ''} <Pill status={c.status} /></div>}
                          </td>
                          <td className="small muted">{p.note || '—'}</td>
                          <td className="r strong"><span style={p.reversed ? { textDecoration: 'line-through' } : undefined}>{money(p.amount)}</span></td>
                          <td>
                            <div className="row-actions">
                              {p.reversed ? <Pill status="voided" label="Reversed" /> : (
                                <button className="btn btn-ghost btn-sm" title="Reverse this payment" onClick={() => setReversing(p)}><Undo2 size={14} /></button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No payments yet" message="Nothing has been paid against this bill." action={state.due > 0 ? <Button variant="primary" onClick={() => setPayOpen(true)}>Add payment</Button> : null} />
            )}
          </Card>

          {returns.length > 0 && (
            <Card title="Returns" tight>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Item</th><th className="r">Qty</th><th>Restocked</th><th>Note</th><th className="r">Value</th></tr></thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{data.items.find((i) => i.id === r.itemId)?.name || 'Item'}</td>
                        <td className="r">{r.qty}</td>
                        <td>{r.restock ? <Pill status="paid" label="Yes" /> : <Pill status="voided" label="No" />}</td>
                        <td className="small muted">{r.note || '—'}</td>
                        <td className="r strong"><Money value={r.valueAdjusted} /></td>
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
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span className="muted">Status</span><span className="spacer" /><Pill status={state.status} />
            </div>
            <SumRow label="Total" value={state.net} strong />
            <SumRow label="Paid" value={state.paid} />
            {state.returned > 0 && <SumRow label="Returned" value={state.returned} />}
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 6, borderTop: '2px solid var(--border-strong)' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Balance due</span>
              <span className="spacer" />
              <span className="money" style={{ fontSize: 19, color: state.due > 0 ? 'var(--danger)' : 'var(--success)' }}>{money(state.due)}</span>
            </div>
            {state.due > 0 && (
              <div className="mt-2" style={{
                padding: '10px 12px', borderRadius: 'var(--r-sm)', fontSize: 13,
                background: state.isOverdue ? 'var(--danger-bg)' : 'var(--warning-bg)',
                border: `1px solid ${state.isOverdue ? '#FECACA' : '#FDE68A'}`,
                color: state.isOverdue ? '#B91C1C' : '#B45309',
              }}
              >
                <strong>Due {fmtDate(bill.dueDate)}</strong>
                {state.isOverdue ? ` — ${state.overdueDays} day${state.overdueDays === 1 ? '' : 's'} overdue` : ' — not yet due'}
              </div>
            )}
          </Card>
          <Card title="Party">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{party?.name}</div>
            {party?.phone && <div className="small muted">{party.phone}</div>}
            {party?.address && <div className="small muted">{party.address}</div>}
            {party && <Button className="mt-2" block onClick={() => navigate(`/party/${party.id}`)}>Open full ledger</Button>}
          </Card>
          {bill.note && <Card title="Note"><p style={{ margin: 0, fontSize: 13.5 }}>{bill.note}</p></Card>}
        </div>
      </div>

      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} bill={bill} state={state} party={party} />
      <ReturnModal open={retOpen} onClose={() => setRetOpen(false)} bill={bill} party={party} />
      <LineProgressModal
        open={dlvOpen}
        onClose={() => setDlvOpen(false)}
        title={`Delivery — Bill ${bill.billNo}`}
        verb="Delivered"
        lines={lines.map((l) => ({ id: l.id, name: l.itemName, qty: Number(l.qty) || 0, unit: l.unit, done: l.delivered }))}
        onSave={saveLines}
      />
      <Modal
        open={voidOpen}
        title="Void this bill?"
        onClose={() => setVoidOpen(false)}
        footer={<><Button onClick={() => setVoidOpen(false)}>Cancel</Button><Button variant="danger" onClick={doVoid}>Void bill</Button></>}
      >
        <p style={{ marginTop: 0, fontSize: 14 }}>
          Bill {bill.billNo} will be marked Voided. It stays in your history with its bill number — nothing is deleted — but it stops counting towards sales and dues.
        </p>
        <Field label="Reason" hint="Recorded in the Activity Log">
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. Entered twice by mistake" autoFocus />
        </Field>
      </Modal>
      <Modal
        open={!!reversing}
        title="Reverse this payment?"
        onClose={() => setReversing(null)}
        footer={<><Button onClick={() => setReversing(null)}>Cancel</Button><Button variant="danger" onClick={doReverse}>Reverse payment</Button></>}
      >
        <p style={{ marginTop: 0, fontSize: 14 }}>
          The {money(reversing?.amount)} {reversing?.method} payment will be reversed. The original entry stays visible, marked reversed, so the ledger math remains traceable. This bill's balance will increase by {money(reversing?.amount)}.
        </p>
        <Field label="Reason" hint="Recorded in the Activity Log">
          <Input value={revReason} onChange={(e) => setRevReason(e.target.value)} placeholder="e.g. Entered against the wrong bill" autoFocus />
        </Field>
      </Modal>
    </>
  );
}
