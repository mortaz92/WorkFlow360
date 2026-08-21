import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
        <div className="relative">
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            className="field pr-10"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-400 hover:text-gray-600"
            aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
            title={showPassword ? 'Nascondi password' : 'Mostra password'}
          >
            {showPassword ? (
              // Occhio barrato: la password è visibile in chiaro, cliccando la nascondi.
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            ) : (
              // Occhio aperto: la password è nascosta, cliccando la mostri in chiaro.
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>

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
