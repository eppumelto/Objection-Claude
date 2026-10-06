import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api.ts';
import { useAuth, type User } from '../auth.tsx';

function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isReg = mode === 'register';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isReg && password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    try {
      const r = await api<{ user: User }>('POST', `/api/auth/${mode}`, { email, password });
      setUser(r.user);
      navigate('/cases', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="logo" aria-hidden="true">OBJECTION!</p>
        <p className="tagline">AI Courtroom Simulator: you are the defense.</p>
        <h1>{isReg ? 'Create an account' : 'Log in'}</h1>
        <form onSubmit={submit} noValidate>
          <label htmlFor={`${mode}-email`}>Email</label>
          <input
            id={`${mode}-email`} type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} data-testid={`${mode}-email`}
          />
          <label htmlFor={`${mode}-password`}>
            Password{isReg && <span className="hint"> (at least 8 characters)</span>}
          </label>
          <input
            id={`${mode}-password`} type="password" autoComplete={isReg ? 'new-password' : 'current-password'} required
            value={password} onChange={(e) => setPassword(e.target.value)} data-testid={`${mode}-password`}
          />
          {error && <p className="error" role="alert" data-testid="auth-error">{error}</p>}
          <button type="submit" className="btn primary block" disabled={busy} data-testid={`${mode}-submit`}>
            {isReg ? 'Register' : 'Log in'}
          </button>
        </form>
        <p className="switch">
          {isReg
            ? <>Already have an account? <Link to="/login">Log in</Link></>
            : <>New here? <Link to="/register">Create an account</Link></>}
        </p>
      </div>
    </main>
  );
}

export const LoginPage = () => <AuthForm mode="login" />;
export const RegisterPage = () => <AuthForm mode="register" />;
