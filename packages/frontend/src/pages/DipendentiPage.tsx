import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { HoursByUserRow } from '../lib/types';
import { ArrowRightIcon, ClockIcon, UsersIcon } from '../components/icons';
import { formatHours } from '../lib/format';
import { Card, CardContent, EmptyState } from '../components/ui';

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle a ogni
// occorrenza (link "Dettagli", riquadro di errore). Volutamente ricopiate da DashboardPage
// e NON estratte in un modulo condiviso: la migrazione grafica delle altre pagine è in
// corso in parallelo, un file comune va introdotto in un unico passaggio di consolidamento
// quando tutte saranno migrate, non da più lati contemporaneamente.
const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

export default function DipendentiPage() {
  const [rows, setRows] = useState<HoursByUserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getHoursByUser();
        setRows(res.reports);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore nel caricamento');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Dipendenti</h1>
        <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
          {rows.length} dipendent{rows.length === 1 ? 'e' : 'i'} con ore registrate
        </p>
      </div>

      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}

      <Card>
        <CardContent>
          {loading && <p className="text-sm text-surface-500 dark:text-surface-400">Caricamento…</p>}
          {rows.length === 0 && !loading && (
            <EmptyState
              title="Nessun dipendente"
              description="Nessun dipendente ha ancora registrato ore."
              icon={<UsersIcon className="h-10 w-10" />}
            />
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((r) => (
              <li key={r.userId}>
                {/* Card "interactive" dentro il Link: l'intera riga resta cliccabile come
                    prima e l'anello di focus si vede anche navigando da tastiera. */}
                <Link
                  to={`/dipendenti/${r.userId}`}
                  className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-950"
                >
                  <Card variant="interactive" padding="sm" className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <strong className="truncate font-medium text-surface-900 dark:text-surface-100">
                        {r.userName}
                      </strong>{' '}
                      <span className="text-sm text-surface-500 dark:text-surface-400">{r.userEmail}</span>
                      <div className="mt-1 flex items-center gap-1 text-sm text-surface-500 dark:text-surface-400">
                        <ClockIcon className="h-4 w-4" />
                        {formatHours(r.totalHours)} ore · {r.logCount} registrazioni
                      </div>
                    </div>
                    <span className={`${LINK_DETTAGLIO} shrink-0`}>
                      Dettagli <ArrowRightIcon />
                    </span>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
