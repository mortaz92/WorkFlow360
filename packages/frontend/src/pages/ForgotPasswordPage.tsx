import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/Card';
import { BuildingIcon } from '../components/icons';

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
    <div className="flex min-h-screen items-center justify-center bg-surface-50 dark:bg-surface-950 p-4">
      <Card variant="elevated" className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-600 text-white">
            <BuildingIcon className="h-7 w-7" />
          </div>
          <CardTitle className="text-2xl font-bold text-surface-900 dark:text-white">WorkFlow360</CardTitle>
          <CardDescription className="mt-1 text-surface-600 dark:text-surface-400">
            Recupera la password
          </CardDescription>
        </CardHeader>

        <CardContent className="pb-2">
          {message ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-success-50 border border-success-200 px-3 py-2.5 text-sm font-medium text-success-600 dark:bg-success-900/30 dark:border-success-800 dark:text-success-400" role="status">
                {message}
              </div>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                Torna al login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                id="forgot-email"
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
                Invia istruzioni
              </Button>
            </form>
          )}
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