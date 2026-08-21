import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Il messaggio mostrato è SEMPRE quello restituito dall'API, mai dedotto qui: il
// backend risponde identico esista o no l'email (anti-enumerazione, vedi
// requestPasswordReset in auth.service.ts) — interpretare la risposta lato client
// per mostrare qualcosa di diverso vanificherebbe quella protezione.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.forgotPassword(email.trim());
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore di rete. Verifica che il server sia attivo.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 p-4">
      <form className="card w-full max-w-[420px] flex flex-col gap-3" onSubmit={handleSubmit}>
        <h1 className="m-0 text-center text-3xl font-bold text-blue-600">WorkFlow360</h1>
        <p className="m-0 mb-2 text-center text-sm text-gray-500">Recupera la password</p>

        {message ? (
          <div className="alert-success">{message}</div>
        ) : (
          <>
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="username"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nome@azienda.com"
              required
            />
            {error && <div className="alert">{error}</div>}
            <button type="submit" disabled={loading} className="btn-primary mt-2">
              {loading ? 'Invio…' : 'Invia istruzioni'}
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
