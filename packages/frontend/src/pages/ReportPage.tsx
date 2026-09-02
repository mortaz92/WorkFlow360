import { useEffect, useState } from 'react';
import { api, getCurrentUser } from '../lib/api';
import type { HoursByProjectRow, HoursByUserRow } from '../lib/types';
import { PrinterIcon } from '../components/icons';
import TabellaOre from '../components/TabellaOre';
import RapportiniCantiere from '../components/RapportiniCantiere';
import { monthToRange } from '../lib/format';
import { Button, Input } from '../components/ui';

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni punto in cui compaiono (testo attenuato, riquadro di errore).
const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

// Input del design system imposta solo il COLORE del bordo: il preflight di Tailwind v4
// azzera border-width su ogni elemento, quindi senza `border` il campo resterebbe senza
// contorno visibile. `dark:[color-scheme:dark]` riguarda il widget nativo del selettore
// mese: senza, l'icona del calendario resta scura sopra lo sfondo scuro del campo.
const CAMPO_MESE = 'border dark:[color-scheme:dark]';

// "YYYY-MM" -> "agosto 2026". Locale, mai new Date(stringaISO) diretto: costruire da
// anno/mese espliciti evita ambiguità di fuso (stesso principio di monthToRange).
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
}

export default function ReportPage() {
  // Come in CantiereDetailPage: governa solo il bottone "Sblocca" dentro RapportiniCantiere
  // (un project_manager arriva comunque a questa pagina — vedi il gate di ruolo in
  // AppLayout — ma sbloccare un rapportino firmato resta un intervento riservato ad admin).
  const isAdmin = getCurrentUser()?.role === 'admin';
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
          <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Report</h1>
          {/* Il periodo va scritto qui, DENTRO l'area stampabile (non in un blocco
              no-print): un PDF consegnato a un dipendente deve dire quale mese copre,
              non solo quando è stato generato. */}
          <p className={`mt-1 ${TESTO_ATTENUATO}`}>
            Generato il {generatedOn} · Periodo: {month ? monthLabel(month) : 'tutto lo storico'}
          </p>
        </div>
        {/* items-end: l'etichetta "Mese" sta sopra al campo, quindi i pulsanti si
            allineano al bordo inferiore del campo e non al centro del gruppo. */}
        <div className="no-print flex w-full flex-wrap items-end gap-2 sm:w-auto">
          <div className="w-full sm:w-44">
            <Input
              id="report-month"
              label="Mese"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className={CAMPO_MESE}
            />
          </div>
          {month && (
            <Button variant="ghost" onClick={() => setMonth('')}>
              Tutto lo storico
            </Button>
          )}
          <Button
            variant="secondary"
            fullWidth
            leftIcon={<PrinterIcon className="h-4 w-4" />}
            onClick={() => window.print()}
          >
            Stampa / Scarica PDF
          </Button>
        </div>
      </div>
      {error && (
        <div className={`${ALERT_ERRORE} no-print`} role="alert">
          {error}
        </div>
      )}
      {loading && <p className={`${TESTO_ATTENUATO} no-print`}>Caricamento…</p>}
      <TabellaOre title="Ore per commessa" rows={byProject} getName={(r) => r.projectName} />
      <TabellaOre title="Ore per operaio" rows={byUser} getName={(r) => r.userName} />
      {/* Stesso componente usato dentro un singolo cantiere (CantiereDetailPage), qui senza
          projectId: mostra i rapportini di TUTTA l'azienda invece di uno solo — il backend
          filtra già per companyId del token, quindi niente da cambiare lì. */}
      <RapportiniCantiere isAdmin={isAdmin} />
      <p className={`${TESTO_ATTENUATO} no-print`}>
        I report mostrano le ore di TUTTA l'azienda (multi-tenant isolato). Gli operai non
        possono accedervi. Per consegnare il report a un dipendente o a un cliente, usa
        "Stampa / Scarica PDF": nella finestra di stampa del browser scegli "Salva come PDF"
        come destinazione per ottenere un file PDF vero e proprio.
      </p>
    </div>
  );
}
