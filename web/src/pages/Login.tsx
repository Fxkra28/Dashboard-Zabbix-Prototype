import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api';
import { resetAuthProbe } from '../hooks/useAuth';

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Checked here, not only by `required`, so a whitespace-only username is
    // refused without a round trip to the BFF.
    if (!username.trim() || !password) {
      setError('Enter a username and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
      // Drop the cached /api/auth/me result: otherwise signing in as a
      // different user keeps the previous role until a full page reload,
      // and the sidebar shows the wrong menu.
      resetAuthProbe();
      nav('/');
    } catch (err) {
      // login() distinguishes wrong credentials from a rate limit or a BFF
      // that is down; every failure used to read "Invalid username or password".
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit} noValidate>
        <div
          className="logo"
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: 'var(--primary)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
          }}
        >
          HC
        </div>
        <h1>HCML Monitoring Portal</h1>
        <p>Sign in to continue</p>

        <div className="field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
