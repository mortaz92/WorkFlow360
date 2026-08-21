import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { HoursByProjectRow, HoursByUserRow } from '../lib/types';
import { PrinterIcon } from '../components/icons';
import TabellaOre from '../components/TabellaOre';
import { monthToRange } from '../lib/format';

// "YYYY-MM" -> "agosto 2026". Locale, mai new Date(stringaISO) diretto: costruire da
// anno/mese espliciti evita ambiguità di fuso (stesso principio di monthToRange).
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
}

export default function ReportPage() {
  const [byProject, setByProject] = useState<HoursByProjectRow[]>([]);
  const [byUser, setByUser] = useState<HoursByUserRow[]>([]);
  // '' = tutto lo storico (comportamento di default, invariato rispetto a prima).
  const [month, setMonth] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const range = month ? monthToRange(month) : undefined;
        const [p, u] = await Promise.all([api.getHoursByProject(range), api.getHoursByUser(range)]);
        setByProject(p.reports);
        setByUser(u.reports);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore caricamento report');
      } finally {
        setLoading(false);
      }
    })();
  }, [month]);

  const generatedOn = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-2xl font-semibold text-gray-900">Report</h1>
          {/* Il periodo va scritto qui, DENTRO l'area stampabile (non in un blocco
              no-print): un PDF consegnato a un dipendente deve dire quale mese copre,
              non solo quando è stato generato. */}
          <p className="mt-1 text-sm text-gray-500">
            Generato il {generatedOn} · Periodo: {month ? monthLabel(month) : 'tutto lo storico'}
          </p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <label htmlFor="report-month" className="mb-0">
            Mese
          </label>
          <input
            id="report-month"
            type="month"
            className="field w-auto"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          {month && (
            <button type="button" className="btn-ghost" onClick={() => setMonth('')}>
              Tutto lo storico
            </button>
          )}
          <button className="btn-secondary gap-2" onClick={() => window.print()}>
            <PrinterIcon className="h-4 w-4" /> Stampa / Scarica PDF
          </button>
        </div>
      </div>
      {error && <div className="alert no-print">{error}</div>}
      {loading && <p className="muted no-print">Caricamento…</p>}
      <TabellaOre title="Ore per commessa" rows={byProject} getName={(r) => r.projectName} />
      <TabellaOre title="Ore per operaio" rows={byUser} getName={(r) => r.userName} />
      <p className="muted no-print">
        I report mostrano le ore di TUTTA l'azienda (multi-tenant isolato). Gli operai non
        possono accedervi. Per consegnare il report a un dipendente o a un cliente, usa
        "Stampa / Scarica PDF": nella finestra di stampa del browser scegli "Salva come PDF"
        come destinazione per ottenere un file PDF vero e proprio.
      </p>
    </div>
  );
}
