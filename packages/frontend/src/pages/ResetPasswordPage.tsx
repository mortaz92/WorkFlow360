import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/Card';
import { BuildingIcon } from '../components/icons';

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
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="flex min-h-screen items-center justify-center bg-surface-50 dark:bg-surface-950 p-4">
      <Card variant="elevated" className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-600 text-white">
            <BuildingIcon className="h-7 w-7" />
          </div>
          <CardTitle className="text-2xl font-bold text-surface-900 dark:text-white">WorkFlow360</CardTitle>
          <CardDescription className="mt-1 text-surface-600 dark:text-surface-400">
            Scegli una nuova password
          </CardDescription>
        </CardHeader>

        <CardContent className="pb-2">
          {!token ? (
            <div className="space-y-4 text-center">
              <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm font-medium text-danger-600 dark:bg-danger-900/30 dark:border-danger-800 dark:text-danger-400" role="alert">
                Link non valido: manca il codice di recupero. Richiedine uno nuovo.
              </div>
              <Link
                to="/forgot-password"
                className="block text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                Richiedi nuovo link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                id="reset-password"
                label="Nuova password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Almeno 8 caratteri"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                error={error || undefined}
                size="lg"
                leftIcon={<svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M6 15v-5h8v5"/></svg>}
                rightIcon={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="pointer-events-auto text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                    aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                  >
                    {showPassword ? (
                      <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.5 9.5a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="18" y2="18" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 10s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7Z" />
                        <circle cx="10" cy="10" r="3" />
                      </svg>
                    )}
                  </button>
                }
              />

              <Input
                id="reset-password-confirm"
                label="Conferma password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Conferma la password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                size="lg"
                leftIcon={<svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M6 15v-5h8v5"/></svg>}
              />

              {error && (
                <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm font-medium text-danger-600 dark:bg-danger-900/30 dark:border-danger-800 dark:text-danger-400" role="alert">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={loading}
              >
                Reimposta password
              </Button>
            </form>
          )}

          <Link
            to="/login"
            className="block text-center text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 mt-4"
          >
            Torna al login
          </Link>
        </CardContent>

        <CardFooter className="pt-4 border-t border-surface-200 dark:border-surface-700">
          <p className="text-center text-sm text-surface-500 dark:text-surface-400">
            © 2026 WorkFlow360. Tutti i diritti riservati.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}