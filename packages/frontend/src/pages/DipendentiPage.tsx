import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { HoursByUserRow } from '../lib/types';
import { ArrowRightIcon, ClockIcon } from '../components/icons';
import { formatHours } from '../lib/format';

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
        <h1 className="m-0 text-2xl font-semibold text-gray-900">Dipendenti</h1>
        <p className="mt-1 text-sm text-gray-500">{rows.length} dipendent{rows.length === 1 ? 'e' : 'i'} con ore registrate</p>
      </div>

      {error && <div className="alert">{error}</div>}

      <section className="card">
        {loading && <p className="muted">Caricamento…</p>}
        {rows.length === 0 && !loading && <p className="muted">Nessun dipendente ha ancora registrato ore.</p>}
        <ul className="list">
          {rows.map((r) => (
            <li key={r.userId} className="list-item">
              <Link to={`/dipendenti/${r.userId}`} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <strong className="truncate font-medium text-gray-900">{r.userName}</strong>{' '}
                  <span className="muted">{r.userEmail}</span>
                  <div className="mt-1 flex items-center gap-1 text-sm text-gray-500">
                    <ClockIcon className="h-4 w-4" />
                    {formatHours(r.totalHours)} ore · {r.logCount} registrazioni
                  </div>
                </div>
                <span className="list-link shrink-0">
                  Dettagli <ArrowRightIcon />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
