import { useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useStore } from '../store';

export function SignIn() {
  const devLogin = useStore((s) => s.devLogin);
  const checkAuth = useStore((s) => s.checkAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [showDev, setShowDev] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (new URLSearchParams(location.search).get('login') === 'failed' ? 'Sign-in didn’t finish. Try again.' : null));

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password'); return; }
    setBusy(true); setError(null);
    try {
      await api.login(username.trim(), password);
      await checkAuth();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg === 'admin_login_not_configured' ? 'Admin login is not set up yet. Generate a hash with bin/set-admin-password.mjs and set TREE_ADMIN_USER / TREE_ADMIN_PASSWORD_HASH.' : 'Wrong username or password');
      setBusy(false);
    }
  };

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    setBusy(true); setError(null);
    try { await api.devLogin(email.trim(), name.trim() || undefined); await checkAuth(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="blob" color="black" size={84} />
        </div>
        <h1 className="signin__title">Tree</h1>
        <p className="signin__sub">Your own AI teammates. Hand them a task and they get it done.</p>
        <form className="signin__dev" onSubmit={login}>
          <div className="signin__divider"><span>Sign in</span></div>
          <input className="text-input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Username" autoComplete="username" />
          <input className="text-input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" />
          <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {devLogin && !showDev && (
          <p className="signin__foot"><button type="button" className="btn btn--ghost" onClick={() => setShowDev(true)}>Use dev email sign-in instead</button></p>
        )}
        {devLogin && showDev && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in with email (local testing only)</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
          </form>
        )}
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">Tree — your personal agent team. Not affiliated with xAI or Grok.</p>
      </div>
    </div>
  );
}
