import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export default function ResetPasswordPage() {
  // Letto una sola volta al mount, poi ripulito dalla barra degli indirizzi: un
  // token in query string finisce altrimenti nella cronologia del browser e
  // nell'header Referer verso qualunque risorsa esterna caricata da questa pagina.
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  useEffect(() => {
    if (token) window.history.replaceState({}, '', window.location.pathname);
  }, [token]);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError('La password deve avere almeno 8 caratteri');
    if (password !== confirmPassword) return setError('Le due password non coincidono');
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      navigate('/login', { replace: true });
    } catch (err) {
      // Volutamente generico (coerente col backend, vedi resetPassword in
      // auth.service.ts): non distingue token inesistente/scaduto/già usato.
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
        <p className="m-0 mb-2 text-center text-sm text-gray-500">Scegli una nuova password</p>

        {!token ? (
          <div className="alert">Link non valido: manca il codice di recupero. Richiedine uno nuovo.</div>
        ) : (
          <>
            <label htmlFor="reset-password">Nuova password</label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Almeno 8 caratteri"
              required
            />
            <label htmlFor="reset-password-confirm">Conferma password</label>
            <input
              id="reset-password-confirm"
              type="password"
              autoComplete="new-password"
              className="field"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            {error && <div className="alert">{error}</div>}
            <button type="submit" disabled={loading} className="btn-primary mt-2">
              {loading ? 'Salvataggio…' : 'Reimposta password'}
            </button>
          </>
        )}

        <Link to="/login" className="list-link justify-center text-sm">
          Torna al login
        </Link>
      </form>
    </div>
  );
}
