import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound, Lock, Pencil, Plus, Save, ShieldCheck, Trash2, UserCog, UserPlus, Users as UsersIcon,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import { fmtDate } from '../lib/format.js';
import { PAGES, PRESETS, ROLES } from '../lib/permissions.js';
import {
  Button, Card, Confirm, Empty, Field, Input, Modal, PageHead, Pill, Select, Stat,
} from '../components/ui.jsx';

const GROUPS = [
  { key: 'shop', label: 'Wholesale shop' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'both', label: 'Both' },
];

const blankUser = () => ({
  id: '', name: '', username: '', password: '', role: 'staff', status: 'active', pages: [],
});

/** Add or edit one user: who they are, their role, and which pages they open. */
function UserModal({ open, user, onClose, onSaved }) {
  const { toast, me } = useApp();
  const [f, setF] = useState(blankUser);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(user ? { ...blankUser(), ...user, password: '', pages: user.pages || PAGES.map((p) => p.key) } : blankUser());
  }, [open, user]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const staff = f.role === 'staff';
  const allPages = f.role === 'superadmin';
  const selectable = (p) => !(staff && p.cost);
  const has = (key) => f.pages.includes(key);
  const toggle = (key) => setF((x) => ({ ...x, pages: has(key) ? x.pages.filter((k) => k !== key) : [...x.pages, key] }));
  const setGroup = (group, on) => setF((x) => {
    const keys = PAGES.filter((p) => p.system === group && selectable(p)).map((p) => p.key);
    const rest = x.pages.filter((k) => !keys.includes(k));
    return { ...x, pages: on ? [...rest, ...keys] : rest };
  });
  const self = user && user.username === me?.username;
  const save = async () => {
    if (busy) return;
    setErr('');
    if (!f.username.trim()) return setErr('Enter a username');
    if (!user && f.password.length < 6) return setErr('Set a password of at least 6 characters');
    if (staff && !f.pages.filter((k) => selectable(PAGES.find((p) => p.key === k) || {})).length) return setErr('Tick at least one page');
    setBusy(true);
    try {
      const saved = await api.saveUser({
        id: user?.id, name: f.name.trim(), username: f.username.trim(), role: f.role, status: f.status,
        password: f.password || undefined, pages: allPages ? null : f.pages,
      });
      toast(user ? `${saved.name} updated` : `${saved.name} added — they can sign in now`);
      onSaved();
      onClose();
    } catch (ex) {
      setErr(ex.message || 'Could not save');
    } finally {
      setBusy(false);
    }
    return undefined;
  };
  return (
    <Modal
      open={open}
      wide
      title={user ? `Edit ${user.name}` : 'Add User'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} loading={busy} onClick={save}>{user ? 'Save changes' : 'Add user'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Full name"><Input value={f.name} onChange={set('name')} placeholder="e.g. Kashif Ali" autoFocus /></Field>
        <Field label="Username" hint="Used to sign in. Letters and numbers, no spaces.">
          <Input value={f.username} onChange={set('username')} autoComplete="off" placeholder="e.g. kashif" />
        </Field>
        <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave empty to keep the current password' : 'At least 6 characters'}>
          <Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={set('status')} disabled={self} options={[{ value: 'active', label: 'Active — can sign in' }, { value: 'disabled', label: 'Switched off — cannot sign in' }]} />
        </Field>
      </div>
      <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 6 }}>Role</label>
      <div className="role-pick">
        {ROLES.map((r) => (
          <button
            type="button"
            key={r.value}
            className={`role-opt ${f.role === r.value ? 'on' : ''}`}
            disabled={self && r.value !== 'superadmin'}
            onClick={() => setF((x) => ({ ...x, role: r.value }))}
          >
            <span className="role-opt-t">{r.label}</span>
            <span className="role-opt-d">{r.desc}</span>
          </button>
        ))}
      </div>
      {allPages ? (
        <div className="note" style={{ marginTop: 12 }}><ShieldCheck size={14} /><span>A super admin opens every page, sees cost prices, manages users and imports files.</span></div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 6, margin: '14px 0 8px', alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, marginRight: 4 }}>Pages this user can open</span>
            <span className="spacer" />
            {PRESETS.map((pr) => (
              <Button key={pr.label} size="sm" onClick={() => setF((x) => ({ ...x, pages: pr.pages.filter((k) => selectable(PAGES.find((p) => p.key === k))) }))}>{pr.label}</Button>
            ))}
          </div>
          {GROUPS.map((g) => {
            const list = PAGES.filter((p) => p.system === g.key);
            const usable = list.filter(selectable);
            const allOn = usable.length > 0 && usable.every((p) => has(p.key));
            return (
              <div key={g.key} className="perm-group">
                <div className="perm-head">
                  <span>{g.label}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setGroup(g.key, !allOn)}>{allOn ? 'Clear all' : 'Select all'}</button>
                </div>
                <div className="perm-grid">
                  {list.map((p) => {
                    const locked = !selectable(p);
                    return (
                      <label key={p.key} className={`perm-item ${locked ? 'locked' : ''} ${has(p.key) && !locked ? 'on' : ''}`} title={locked ? 'Shows cost prices — staff never see these' : ''}>
                        <input type="checkbox" checked={has(p.key) && !locked} disabled={locked} onChange={() => toggle(p.key)} />
                        <span>{p.label}</span>
                        {p.cost && <Lock size={12} className="muted" style={{ marginLeft: 'auto', flex: 'none' }} />}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="small muted" style={{ marginTop: 8 }}>
            <Lock size={11} style={{ verticalAlign: -1 }} /> Pages with a lock show cost prices. {staff ? 'Staff never get them, and never see cost prices anywhere else either.' : 'Admins see cost prices on every page they open.'}
          </div>
        </>
      )}
      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}

export default function Users() {
  const { me, toast } = useApp();
  const [users, setUsers] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const load = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (ex) {
      toast(ex.message || 'Could not load users', 'error');
      setUsers([]);
    }
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  const counts = useMemo(() => {
    const list = users || [];
    return {
      total: list.length,
      active: list.filter((u) => u.status !== 'disabled').length,
      staff: list.filter((u) => u.role === 'staff').length,
    };
  }, [users]);
  const roleLabel = (r) => ROLES.find((x) => x.value === r)?.label || r;
  const pageCount = (u) => (u.role === 'superadmin' || u.pages == null ? 'All pages' : `${u.pages.length} page${u.pages.length === 1 ? '' : 's'}`);
  const remove = async () => {
    const u = deleting;
    setDeleting(null);
    try {
      await api.deleteUser(u.id);
      toast(`${u.name} deleted`);
      load();
    } catch (ex) {
      toast(ex.message || 'Could not delete', 'error');
    }
  };
  return (
    <>
      <PageHead title="Users" subtitle="Who can sign in, and which pages each person can open">
        <Button variant="primary" icon={UserPlus} onClick={() => setAdding(true)}>Add User</Button>
      </PageHead>
      <div className="stat-grid">
        <Stat label="Users" value={counts.total} icon={UsersIcon} tone="#1F2937" />
        <Stat label="Active" value={counts.active} icon={ShieldCheck} tone="#16A34A" />
        <Stat label="Staff (no cost prices)" value={counts.staff} icon={UserCog} tone="#B7791F" />
      </div>
      <Card tight>
        {users === null ? <div className="card-body muted">Loading…</div> : users.length ? (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Access</th><th>Status</th><th>Added</th><th style={{ width: 110 }} /></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 600 }}>{u.name}{u.username === me?.username && <span className="muted small"> (you)</span>}</td>
                      <td className="mono">{u.username}</td>
                      <td><Pill status={u.role === 'superadmin' ? 'paid' : u.role === 'admin' ? 'cleared' : 'partial'} label={roleLabel(u.role)} /></td>
                      <td className="small">{pageCount(u)}</td>
                      <td>{u.status === 'disabled' ? <Pill status="voided" label="Switched off" /> : <Pill status="active" label="Active" />}</td>
                      <td className="small muted nowrap">{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(u)}><Pencil size={14} /></button>
                          {u.username !== me?.username && <button className="btn btn-ghost btn-sm" title="Delete" onClick={() => setDeleting(u)}><Trash2 size={14} color="var(--danger)" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mcards" style={{ padding: 12 }}>
              {users.map((u) => (
                <div key={u.id} className="mcard" onClick={() => setEditing(u)}>
                  <div className="top"><span className="name">{u.name}</span><Pill status={u.role === 'superadmin' ? 'paid' : u.role === 'admin' ? 'cleared' : 'partial'} label={roleLabel(u.role)} /></div>
                  <div className="meta">
                    <span><KeyRound size={12} style={{ verticalAlign: -2 }} /> {u.username}</span>
                    <span>{pageCount(u)}</span>
                    {u.status === 'disabled' && <Pill status="voided" label="Switched off" />}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon={UsersIcon} title="No users" message="Add the people who work with you." action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add User</Button>} />}
      </Card>
      <UserModal open={adding} onClose={() => setAdding(false)} onSaved={load} />
      <UserModal open={!!editing} user={editing} onClose={() => setEditing(null)} onSaved={load} />
      <Confirm
        open={!!deleting}
        danger
        title="Delete this user?"
        confirmLabel="Delete user"
        message={deleting ? `${deleting.name} (${deleting.username}) will no longer be able to sign in, and is signed out everywhere now. Their past entries stay in the records. To stop someone only for a while, switch them off instead.` : ''}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
