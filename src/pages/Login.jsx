import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { CONFIG } from '../lib/config.js';
import { LOGO } from '../components/Layout.jsx';
import { Button, Field, Input, Toasts } from '../components/ui.jsx';

export default function Login() {
  const { login, toast, toasts } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      await login(username, password);
      toast('Welcome back', 'success');
    } catch (ex) {
      setErr(ex.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <img className="login-logo" src={LOGO} alt={CONFIG.defaultShopName} />
          <p className="muted small" style={{ margin: '4px 0 0' }}>Wholesale &amp; Warehouse Business Dashboard</p>
        </div>
        <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus /></Field>
        <Field label="Password" error={err}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Enter your password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" block icon={LogIn} loading={busy}>Sign in</Button>
      </form>
      <Toasts toasts={toasts} />
    </div>
  );
}
