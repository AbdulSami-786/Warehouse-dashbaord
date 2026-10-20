import { useEffect, useMemo, useState } from 'react';
import {
  CreditCard, Database, Download, Lock, Plus, Printer, Save, ShieldCheck, Trash2, TriangleAlert,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { CONFIG, PAYMENT_METHODS } from '../lib/config.js';
import { money, applyRounding, ROUNDING_OPTIONS } from '../lib/format.js';
import { exportBackup, printWidthTest, receiptWidth, RECEIPT_WIDTHS } from '../lib/exporters.js';
import { SYSTEM_METHODS } from '../lib/calc.js';
import { wipeLocal } from '../lib/localAdapter.js';
import {
  Button, Card, Confirm, Field, Input, PageHead, Pill, Select, Textarea,
} from '../components/ui.jsx';

const onSheets = CONFIG.backend === 'sheets';

export default function Settings() {
  const { data, settings, mutate, toast, logout, adoptSession, access } = useApp();
  const shopSettings = access.can('settings');
  const [f, setF] = useState(settings);
  const [pw, setPw] = useState({ old: '', next: '', confirm: '' });
  const [newMethod, setNewMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState('');
  const [wiping, setWiping] = useState(false);
  useEffect(() => { setF(settings); }, [settings]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (patch, msg) => {
    setBusy(true);
    try { await mutate(() => api.saveSettings(patch), msg); } catch { /* toasted */ } finally { setBusy(false); }
  };
  const changePassword = async () => {
    setPwErr('');
    if (pw.next.length < 6) return setPwErr('New password must be at least 6 characters');
    if (pw.next !== pw.confirm) return setPwErr('New passwords do not match');
    setPwBusy(true);
    try {
      const res = await api.changePassword(pw.old, pw.next);
      // The server ends every session on a password change and hands this
      // device a new one, so it stays signed in.
      if (res?.token) adoptSession({ token: res.token, username: res.username, role: res.role, expiresAt: res.expiresAt });
      setPw({ old: '', next: '', confirm: '' });
      toast('Password changed — other devices must sign in again', 'success');
    } catch (err) {
      setPwErr(err.message || 'Could not change password');
    } finally {
      setPwBusy(false);
    }
    return undefined;
  };
  const addMethod = async () => {
    const m = newMethod.trim();
    if (!m) return;
    if ([...PAYMENT_METHODS, ...(settings.customMethods || [])].some((x) => x.toLowerCase() === m.toLowerCase())) {
      toast('That payment method already exists', 'error');
      return;
    }
    if (SYSTEM_METHODS.some((x) => x.toLowerCase() === m.toLowerCase())) {
      toast(`"${m}" is used by the system for advances and set-offs. Pick another name.`, 'error');
      return;
    }
    await mutate(() => api.saveSettings({ customMethods: [...(settings.customMethods || []), m] }), `"${m}" added`);
    setNewMethod('');
  };
  const removeMethod = (m) => {
    // A method's balance is worked out from the records that name it. Removing
    // one still in use would drop that money out of every account total.
    const used = [data.payments, data.expenses, data.employeeTx, data.supplierPayments, data.whExpenses, data.purchases, data.whPartyPayments]
      .some((rows) => (rows || []).some((r) => r.method === m));
    if (used) {
      toast(`"${m}" has money recorded against it, so it cannot be removed.`, 'error');
      return undefined;
    }
    return mutate(() => api.saveSettings({ customMethods: (settings.customMethods || []).filter((x) => x !== m) }), `"${m}" removed`);
  };
  const wipe = () => {
    setWiping(false);
    wipeLocal();
    toast('Local data cleared', 'info');
    setTimeout(() => {
      logout();
      window.location.reload();
    }, 600);
  };
  const sample = useMemo(() => {
    const rounded = applyRounding(1247.63, f.roundingRule);
    return { sample: 1247.63, rounded, diff: rounded - 1247.63 };
  }, [f.roundingRule]);

  return (
    <>
      <PageHead title="Settings" subtitle="Shop details, billing rules, and account security" />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col">
          {shopSettings && (<>
          <Card title="Shop Details" subtitle="Appears on printed bills and shared ledgers">
            <div className="form-grid">
              <Field label="Shop name" className="full"><Input value={f.shopName || ''} onChange={set('shopName')} /></Field>
              <Field label="Phone"><Input value={f.phone || ''} onChange={set('phone')} placeholder="03xx-xxxxxxx" /></Field>
              <Field label="Email"><Input type="email" value={f.email || ''} onChange={set('email')} /></Field>
              <Field label="Address" className="full"><Textarea value={f.address || ''} onChange={set('address')} rows={2} /></Field>
            </div>
            <Button variant="primary" icon={Save} loading={busy} onClick={() => save({ shopName: f.shopName, phone: f.phone, address: f.address, email: f.email, logoUrl: f.logoUrl }, 'Shop details saved')}>Save Shop Details</Button>
          </Card>
          <Card title="Billing Rules">
            <Field label="Rounding rule" hint={`${money(sample.sample, { decimals: 2 })} becomes ${money(sample.rounded)} (round off ${money(sample.diff, { showSign: true })})`}>
              <Select value={f.roundingRule || 'nearest1'} onChange={set('roundingRule')} options={ROUNDING_OPTIONS} />
            </Field>
            <div className="form-grid">
              <Field label="Default credit days" hint="Used when a bill has a credit remainder"><Input type="number" min="0" value={f.defaultCreditDays ?? 7} onChange={set('defaultCreditDays')} /></Field>
              <Field label="Price change alert (%)" hint="Warn if a price differs from the last one by more than this"><Input type="number" min="0" max="100" value={f.priceAlertThreshold ?? 15} onChange={set('priceAlertThreshold')} /></Field>
            </div>
            <Button
              variant="primary"
              icon={Save}
              loading={busy}
              onClick={() => save({ roundingRule: f.roundingRule, defaultCreditDays: Number(f.defaultCreditDays) || 7, priceAlertThreshold: Number(f.priceAlertThreshold) || 15 }, 'Preferences saved')}
            >
              Save Billing Rules
            </Button>
          </Card>
          <Card title="Receipt Printer" subtitle="Width of the slip your thermal printer prints">
            <Field label="Paper / print width" hint="If the right side of the bill is cut off, print the test slip and pick the last width you can fully see.">
              <Select value={String(receiptWidth(f))} onChange={(e) => setF((x) => ({ ...x, receiptWidthMm: Number(e.target.value) }))} options={RECEIPT_WIDTHS.map((w) => ({ value: String(w.value), label: w.label }))} />
            </Field>
            <div className="row" style={{ gap: 9, flexWrap: 'wrap' }}>
              <Button icon={Printer} onClick={() => printWidthTest(f)}>Print Test Slip</Button>
              <Button variant="primary" icon={Save} loading={busy} onClick={() => save({ receiptWidthMm: receiptWidth(f) }, 'Receipt printer saved')}>Save Printer Width</Button>
            </div>
          </Card>
          <Card title="Payment Methods" subtitle="Built-in methods plus any you add">
            <div className="chips mb-2">{PAYMENT_METHODS.map((m) => <span key={m} className="chip" style={{ cursor: 'default' }}>{m}</span>)}</div>
            {(settings.customMethods || []).length > 0 && (
              <>
                <div className="small muted mb-1">Your custom methods</div>
                <div className="col mb-2" style={{ gap: 7 }}>
                  {settings.customMethods.map((m) => (
                    <div key={m} className="row" style={{ padding: '8px 11px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', gap: 8 }}>
                      <CreditCard size={15} className="muted" />
                      <span style={{ fontWeight: 500 }}>{m}</span>
                      <span className="spacer" />
                      <button className="btn btn-ghost btn-sm" onClick={() => removeMethod(m)} title="Remove method"><Trash2 size={14} color="var(--danger)" /></button>
                    </div>
                  ))}
                </div>
              </>
            )}
            <Field label="Add a payment method">
              <div className="input-group">
                <Input value={newMethod} onChange={(e) => setNewMethod(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMethod(); } }} placeholder="e.g. Meezan Bank" />
                <Button icon={Plus} onClick={addMethod}>Add</Button>
              </div>
            </Field>
          </Card>
          </>)}
        </div>
        <div className="col">
          <Card title="Change Password" subtitle="Stored as an irreversible hash, never plain text">
            <Field label="Current password" error={pwErr}><Input type="password" value={pw.old} autoComplete="current-password" onChange={(e) => setPw((x) => ({ ...x, old: e.target.value }))} /></Field>
            <Field label="New password" hint="At least 6 characters"><Input type="password" value={pw.next} autoComplete="new-password" onChange={(e) => setPw((x) => ({ ...x, next: e.target.value }))} /></Field>
            <Field label="Confirm new password"><Input type="password" value={pw.confirm} autoComplete="new-password" onChange={(e) => setPw((x) => ({ ...x, confirm: e.target.value }))} /></Field>
            <Button variant="primary" icon={Lock} onClick={changePassword} loading={pwBusy} disabled={!pw.old || !pw.next}>Change Password</Button>
          </Card>
          {access.isAdmin && (
          <Card title="Backup" subtitle="Download your entire dataset">
            <p className="small muted" style={{ marginTop: 0 }}>Exports every record — shop and warehouses — as a single file. Keep it somewhere safe; it is your restore point if anything goes wrong.</p>
            <Button icon={Download} block onClick={() => { exportBackup(data, settings.shopName); toast('Backup downloaded'); }}>Download Full Backup</Button>
          </Card>
          )}
          {onSheets ? (
            <Card title="Data Storage">
              <div className="row" style={{ gap: 9 }}>
                <Database size={17} className="muted" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>Google Sheets</div>
                  <div className="small muted">Every save goes straight to your Google Sheet, so every device signed in sees the same data</div>
                </div>
                <Pill status="paid" label="Online" />
              </div>
            </Card>
          ) : (
            <Card title="Data Storage">
              <div className="row mb-2" style={{ gap: 9 }}>
                <Database size={17} className="muted" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>Local storage in this browser</div>
                  <div className="small muted">Everything is saved on this computer only — nothing is sent to any server</div>
                </div>
                <Pill status="partial" label="Local" />
              </div>
              <div style={{ padding: '11px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309', display: 'flex', gap: 8 }}>
                <TriangleAlert size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>Data lives only in this browser on this computer. Clearing browsing data, or opening the dashboard in another browser or on another device, will not show it. Download a backup regularly.</span>
              </div>
            </Card>
          )}
          <Card title="Keeping Your Data Safe">
            <div className="col small" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <ShieldCheck size={15} color="var(--success)" style={{ flex: 'none', marginTop: 1 }} />
                <span>Bills are voided, payments reversed, parties archived, warehouse movements cancelled — kept in history and logged.</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <ShieldCheck size={15} color="var(--success)" style={{ flex: 'none', marginTop: 1 }} />
                <span>Passwords are stored as one-way hashes. Even someone reading the raw data cannot recover them.</span>
              </div>
            </div>
          </Card>
          {/* Wiping this browser's copy does nothing to the Google Sheet. */}
          {!onSheets && access.isSuper && (
            <Card title="Danger Zone">
              <p className="small muted" style={{ marginTop: 0 }}>Clears all data stored on this device and starts fresh. Download a backup first if you want to keep anything.</p>
              <Button variant="danger" icon={Trash2} block onClick={() => setWiping(true)}>Reset Local Data</Button>
            </Card>
          )}
        </div>
      </div>
      <Confirm
        open={wiping}
        title="Reset all local data?"
        message="Every party, item, bill, payment, warehouse record and log stored on this device will be erased. This cannot be undone. Download a backup first if you need this data."
        confirmLabel="Erase everything"
        danger
        onConfirm={wipe}
        onCancel={() => setWiping(false)}
      />
    </>
  );
}
