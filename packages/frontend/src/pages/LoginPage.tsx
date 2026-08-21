import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login(email.trim(), password);
      setToken(res.accessToken);
      // Operaio -> dashboard operatore; gli altri ruoli -> dashboard azienda.
      const dest = res.user.role === 'operaio' ? '/operaio' : '/dashboard';
      navigate(dest, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Errore di rete. Verifica che il server sia attivo.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 p-4">
      <form className="card w-full max-w-[420px] flex flex-col gap-3" onSubmit={handleSubmit}>
        <h1 className="m-0 text-center text-3xl font-bold text-blue-600">WorkFlow360</h1>
        <p className="m-0 mb-2 text-center text-sm text-gray-500">Accedi con la tua email e password</p>

        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          className="field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="nome@azienda.com"
          required
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />

        {error && <div className="alert">{error}</div>}

        <button type="submit" disabled={loading} className="btn-primary mt-2">
          {loading ? 'Accesso…' : 'Accedi'}
        </button>
        <Link to="/forgot-password" className="list-link justify-center text-sm">
          Password dimenticata?
        </Link>
      </form>
    </div>
  );
}
