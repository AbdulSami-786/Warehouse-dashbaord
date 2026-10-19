import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ChevronRight, Download, Pencil, Plus, Save, UserCog,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { money, r2, today, fmtDate, norm } from '../lib/format.js';
import { salaryStatus } from '../lib/calc.js';
import { exportCSV } from '../lib/exporters.js';
import {
  Button, Card, Empty, Field, Input, Modal, Money, PageHead, Pill, SearchBox, Select, Stat,
} from '../components/ui.jsx';
import ImportButton from '../components/ImportButton.jsx';

export function EmployeeForm({ employee = null, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    name: String(employee?.name ?? ''), phone: String(employee?.phone ?? ''), role: String(employee?.role ?? ''),
    monthlySalary: employee?.monthlySalary ?? '', joinDate: employee?.joinDate ?? today(),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!f.name.trim()) return setErr('Employee name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveEmployee({
        id: employee?.id, name: f.name.trim(), phone: f.phone.trim(), role: f.role.trim(),
        monthlySalary: Number(f.monthlySalary) || 0, joinDate: f.joinDate,
      }), employee ? 'Employee updated' : 'Employee added');
      onSaved?.(saved);
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Full name" className="full" error={err}><Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Kashif Ali" /></Field>
        <Field label="Role"><Input value={f.role} onChange={set('role')} placeholder="e.g. Shop Assistant" /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" /></Field>
        <Field label="Monthly salary"><Input type="number" min="0" step="any" value={f.monthlySalary} onChange={set('monthlySalary')} placeholder="0" /></Field>
        <Field label="Join date"><Input type="date" value={f.joinDate} onChange={set('joinDate')} /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>{employee ? 'Update Employee' : 'Add Employee'}</Button>
      </div>
    </form>
  );
}

export default function Employees() {
  const { data, settings, toast } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const rows = useMemo(() => {
    const s = norm(q);
    return data.employees.filter((e) => e.status !== 'archived')
      .filter((e) => !s || norm(e.name).includes(s) || norm(e.role).includes(s))
      .map((e) => ({ ...e, ...salaryStatus(e, data.employeeTx) }))
      .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }, [data, q]);
  const totals = useMemo(() => ({
    payroll: r2(rows.reduce((s, e) => s + (Number(e.monthlySalary) || 0), 0)),
    paid: r2(rows.reduce((s, e) => s + e.paid, 0)),
    remaining: r2(rows.reduce((s, e) => s + e.remaining, 0)),
  }), [rows]);
  const toExcel = () => {
    exportCSV('Employees', ['Name', 'Role', 'Phone', 'Join Date', 'Monthly Salary', 'Paid This Month', 'Remaining'],
      rows.map((e) => [e.name, e.role, e.phone, fmtDate(e.joinDate), Number(e.monthlySalary).toFixed(2), e.paid.toFixed(2), e.remaining.toFixed(2)]),
      [`${settings.shopName} — Employees`, `Monthly payroll: ${money(totals.payroll)}`]);
    toast('Employees exported');
  };
  return (
    <>
      <PageHead title="Employees" subtitle={`${rows.length} staff · ${money(totals.payroll)} monthly payroll`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search name or role…" />
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <ImportButton kind="employees" />
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Employee</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Monthly Payroll" value={money(totals.payroll)} icon={UserCog} tone="#1F2937" />
        <Stat label="Paid This Month" value={money(totals.paid)} icon={UserCog} tone="#16A34A" />
        <Stat label="Remaining To Pay" value={money(totals.remaining)} icon={UserCog} tone="#DC2626" />
      </div>
      <Card tight>
        {rows.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Joined</th><th className="r">Monthly salary</th><th className="r">Paid this month</th><th className="r">Remaining</th><th style={{ width: 90 }} /></tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/employee/${e.id}`)}>
                      <td style={{ fontWeight: 600 }}>{e.name}</td>
                      <td>{e.role || <span className="muted">—</span>}</td>
                      <td className="small">{e.phone || <span className="muted">—</span>}</td>
                      <td className="small nowrap">{fmtDate(e.joinDate)}</td>
                      <td className="r"><Money value={e.monthlySalary} /></td>
                      <td className="r"><Money value={e.paid} /></td>
                      <td className="r strong">{e.remaining > 0 ? <span className="money neg">{money(e.remaining)}</span> : <Pill status="paid" label="Settled" />}</td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(e)}><Pencil size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title="Open ledger" onClick={() => navigate(`/employee/${e.id}`)}><ChevronRight size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{rows.length} employees</td>
                    <td className="r">{money(totals.payroll)}</td>
                    <td className="r">{money(totals.paid)}</td>
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.remaining)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((e) => (
                <div key={e.id} className="mcard" onClick={() => navigate(`/employee/${e.id}`)}>
                  <div className="top">
                    <span className="name">{e.name}</span>
                    <span className="amt" style={{ color: e.remaining > 0 ? 'var(--danger)' : 'var(--success)' }}>{e.remaining > 0 ? money(e.remaining) : 'Settled'}</span>
                  </div>
                  <div className="meta">{e.role && <span>{e.role}</span>}<span>Salary {money(e.monthlySalary)}</span><span>Paid {money(e.paid)}</span></div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            icon={UserCog}
            title={q ? 'No matching employees' : 'No employees yet'}
            message={q ? `Nothing matches "${q}".` : 'Add your staff to track salaries, advances and bonuses.'}
            action={q ? null : <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first employee</Button>}
          />
        )}
      </Card>
      <Modal open={adding} title="Add Employee" onClose={() => setAdding(false)}>
        <EmployeeForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal open={!!editing} title={`Edit ${editing?.name || 'Employee'}`} onClose={() => setEditing(null)}>
        {editing && <EmployeeForm employee={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

const TX_TYPES = [{ value: 'salary', label: 'Salary payment' }, { value: 'advance', label: 'Advance' }, { value: 'bonus', label: 'Bonus' }];
const blankTx = () => ({ type: 'salary', amount: '', date: today(), method: 'Cash', note: '' });

function EntryModal({ open, onClose, employee, month }) {
  const { methods, mutate } = useApp();
  const [f, setF] = useState(blankTx);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (busy || !(Number(f.amount) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.addEmployeeTx({ employeeId: employee.id, type: f.type, amount: Number(f.amount), date: f.date, method: f.method, note: f.note }), 'Entry recorded');
      setF(blankTx());
      onClose();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={`Add Entry — ${employee.name}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} onClick={save} loading={busy} disabled={!(Number(f.amount) > 0)}>Record Entry</Button></>}
    >
      <div className="form-grid">
        <Field label="Type"><Select value={f.type} onChange={set('type')} options={TX_TYPES} /></Field>
        <Field label="Amount" hint={f.type === 'salary' ? `${money(month.remaining)} remaining this month` : undefined}>
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} autoFocus placeholder="0" />
        </Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Paid from"><Select value={f.method} onChange={set('method')} options={methods.filter((m) => m !== 'Cheque')} /></Field>
        <Field label="Note" className="full"><Input value={f.note} onChange={set('note')} placeholder="Optional" /></Field>
      </div>
      {f.type === 'salary' && Number(f.amount) > month.remaining && month.remaining > 0 && (
        <div style={{ padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309' }}>
          This is more than the {money(month.remaining)} still owed for this month.
        </div>
      )}
    </Modal>
  );
}

export function EmployeeLedger() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, settings, toast } = useApp();
  const [adding, setAdding] = useState(false);
  const emp = data.employees.find((e) => e.id === id);
  const txs = useMemo(() => data.employeeTx.filter((t) => t.employeeId === id).sort((a, b) => new Date(b.date) - new Date(a.date)), [data.employeeTx, id]);
  const month = useMemo(() => (emp ? salaryStatus(emp, data.employeeTx) : null), [emp, data.employeeTx]);
  const sums = useMemo(() => {
    const of = (type) => r2(txs.filter((t) => t.type === type).reduce((s, t) => s + (Number(t.amount) || 0), 0));
    return { salary: of('salary'), advance: of('advance'), bonus: of('bonus'), total: r2(txs.reduce((s, t) => s + (Number(t.amount) || 0), 0)) };
  }, [txs]);
  if (!emp) return <Empty icon={UserCog} title="Employee not found" action={<Button onClick={() => navigate('/employees')}>Back to Employees</Button>} />;
  const toExcel = () => {
    exportCSV(`Employee_${emp.name}`, ['Date', 'Type', 'Amount', 'Method', 'Note'],
      txs.map((t) => [fmtDate(t.date), t.type, Number(t.amount).toFixed(2), t.method || '', t.note || '']),
      [`${settings.shopName} — ${emp.name} Ledger`, emp.role || '', `Monthly salary: ${money(emp.monthlySalary)}`, `Remaining this month: ${money(month.remaining)}`]);
    toast('Ledger exported');
  };
  const typeLabel = (t) => (t.type === 'salary' ? 'Salary' : t.type === 'bonus' ? 'Bonus' : 'Advance');
  return (
    <>
      <PageHead title={emp.name} subtitle={[emp.role, emp.phone, `Joined ${fmtDate(emp.joinDate)}`].filter(Boolean).join(' · ')}>
        <Button icon={ArrowLeft} onClick={() => navigate('/employees')}>Back</Button>
        <Button icon={Download} onClick={toExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Entry</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Monthly Salary" value={money(emp.monthlySalary)} icon={UserCog} tone="#1F2937" />
        <Stat label="Paid This Month" value={money(month.paid)} icon={UserCog} tone="#16A34A" />
        <Stat label="Remaining This Month" value={money(month.remaining)} icon={UserCog} tone="#DC2626" />
        <Stat label="Paid All Time" value={money(sums.total)} icon={UserCog} tone="#6B7280" />
      </div>
      <Card title="Transaction History" tight subtitle={`${txs.length} entries · Salary ${money(sums.salary)} · Advances ${money(sums.advance)} · Bonuses ${money(sums.bonus)}`}>
        {txs.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Type</th><th>Method</th><th>Note</th><th className="r">Amount</th></tr></thead>
                <tbody>
                  {txs.map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap">{fmtDate(t.date)}</td>
                      <td><Pill status={t.type === 'salary' ? 'paid' : t.type === 'bonus' ? 'cleared' : 'partial'} label={typeLabel(t)} /></td>
                      <td>{t.method || 'Cash'}</td>
                      <td className="small muted">{t.note || '—'}</td>
                      <td className="r strong"><Money value={t.amount} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={4}>Total paid all time</td><td className="r">{money(sums.total)}</td></tr></tfoot>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {txs.map((t) => (
                <div key={t.id} className="mcard">
                  <div className="top"><span className="name">{typeLabel(t)}</span><span className="amt">{money(t.amount)}</span></div>
                  <div className="meta"><span>{fmtDate(t.date)}</span><span>{t.method || 'Cash'}</span>{t.note && <span>{t.note}</span>}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty icon={UserCog} title="No entries yet" message={`Record ${emp.name}'s first salary payment, advance or bonus.`} action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add entry</Button>} />
        )}
      </Card>
      <EntryModal open={adding} onClose={() => setAdding(false)} employee={emp} month={month} />
    </>
  );
}
