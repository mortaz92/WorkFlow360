import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/Card';
import { BuildingIcon } from '../components/icons';
import loginBackground from '../assets/login-construction-bg.jpg';
import loginBackgroundVideo from '../assets/login-construction-bg.mp4';

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-50 dark:bg-surface-950 p-4">
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={loginBackgroundVideo}
        poster={loginBackground}
        autoPlay
        loop
        muted
        playsInline
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-surface-50/70 via-surface-50/10 to-transparent dark:from-surface-950/85 dark:via-surface-950/40 dark:to-surface-950/10" />
      <Card variant="elevated" className="relative z-10 w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-600 text-white">
            <BuildingIcon className="h-7 w-7" />
          </div>
          <CardTitle className="text-2xl font-bold text-surface-900 dark:text-white">WorkFlow360</CardTitle>
          <CardDescription className="mt-1 text-surface-600 dark:text-surface-400">
            Accedi con la tua email e password
          </CardDescription>
        </CardHeader>

        <CardContent className="pb-2">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              id="login-email"
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="nome@azienda.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              error={error || undefined}
              size="lg"
              leftIcon={<svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M3 5.5l7 5.5 7-5.5"/></svg>}
            />

            <div className="relative">
              <Input
                id="login-password"
                label="Password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
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
            </div>

            {error && (
              <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm font-medium text-danger-600 dark:bg-danger-900/30 dark:border-danger-800 dark:text-danger-400" role="alert">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-surface-600 dark:text-surface-400">Ricordami</span>
              </label>
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                Password dimenticata?
              </Link>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={loading}
            >
              Accedi
            </Button>
          </form>
        </CardContent>

        <CardFooter className="pt-4 border-t border-surface-200 dark:border-surface-700 flex-col gap-2">
          <p className="text-center text-sm text-surface-500 dark:text-surface-400">
            © 2026 WorkFlow360. Tutti i diritti riservati.
          </p>
          <p className="text-center text-xs text-surface-400 dark:text-surface-500">
            <Link to="/privacy" className="hover:text-primary-600 dark:hover:text-primary-400">Privacy</Link>
            {' · '}
            <Link to="/termini" className="hover:text-primary-600 dark:hover:text-primary-400">Termini di servizio</Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}