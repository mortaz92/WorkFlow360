import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, getCurrentUser } from '../lib/api';
import type { Project } from '../lib/types';
import { XIcon } from '../components/icons';
import PreparaRapportino from '../components/PreparaRapportino';
import RapportiniCantiere from '../components/RapportiniCantiere';
import { Button } from '../components/ui';

// Classi ricorrenti del design system, identiche a ReportPage/OperaioPage: restano
// duplicate qui finché non ci sarà un modulo condiviso per gli stili di pagina.
const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const ALERT_SUCCESSO =
  'rounded-lg border border-success-200 bg-success-50 px-3 py-2.5 text-sm font-medium text-success-700 dark:border-success-800 dark:bg-success-900/30 dark:text-success-300';

// Max consentito dallo schema di validazione backend (projects.routes.ts), stesso valore
// di OperaioPage: col default (20) l'azienda con più di venti cantieri a consuntivo ne
// vedrebbe sparire alcuni dalla tendina senza nessun avviso.
const PROJECTS_FETCH_LIMIT = 100;

// Pagina dedicata ai rapportini (voce "Rapportini clienti" del menu, admin/PM). Nata
// perché la funzione era raggiungibile solo dentro il dettaglio di un singolo cantiere e
// in fondo alla pagina Report: l'utente non la trovava. Qui sta in un posto solo, col suo
// nome, e fa entrambe le cose — prepararne uno nuovo (stesso componente dell'operaio, con
// la tendina dei cantieri) e gestire quelli esistenti di tutta l'azienda.
export default function RapportiniPage() {
  // Governa solo il bottone "Sblocca" in RapportiniCantiere: un project_manager arriva
  // comunque a questa pagina (gate di ruolo in AppLayout), ma sbloccare un rapportino
  // firmato resta un intervento riservato ad admin — stesso criterio di CantiereDetailPage.
  const isAdmin = getCurrentUser()?.role === 'admin';
  const location = useLocation();
  // Messaggio "di ritorno" da FirmaPage dopo "Il cliente non firma" (navigate con state,
  // mai persistito): letto una sola volta all'apertura, sparisce con un ricaricamento —
  // identico a OperaioPage, che riceve lo stesso state dallo stesso punto.
  const [infoMessage, setInfoMessage] = useState<string | null>(
    (location.state as { rapportinoAnnullato?: boolean } | null)?.rapportinoAnnullato
      ? 'Rapportino annullato: il cliente non ha firmato.'
      : null,
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Solo cantieri a consuntivo (l'unico tipo per cui esiste un rapportino — il
        // backend rifiuta comunque gli altri) e non chiusi: filtrati dal server, così
        // la tendina non offre mai un cantiere su cui la creazione fallirebbe.
        const res = await api.listProjects(1, PROJECTS_FETCH_LIMIT, {
          tipoCommessa: 'consuntivo',
          status: ['pending', 'in_progress', 'blocked'],
        });
        setProjects(res.projects);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore nel caricamento dei cantieri');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Rapportini clienti</h1>
        <p className={`mt-1 ${TESTO_ATTENUATO}`}>
          Le ore di una giornata su un cantiere a consuntivo, firmate dal cliente sul posto. Prepara il rapportino
          qui e fai firmare il cliente su questo dispositivo: la copia firmata gli arriva via email, l'originale
          resta qui sotto.
        </p>
      </div>

      {infoMessage && (
        <div className={`${ALERT_SUCCESSO} flex items-start justify-between gap-3`} role="status">
          <span>{infoMessage}</span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setInfoMessage(null)}
            aria-label="Chiudi il messaggio"
          >
            <XIcon />
          </Button>
        </div>
      )}

      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}

      {/* Solo dopo il caricamento: PreparaRapportino con lista vuota mostra "Nessun
          cantiere a consuntivo", che comparirebbe per un istante anche quando i cantieri
          ci sono e stanno solo arrivando. */}
      {loading ? (
        <p className={TESTO_ATTENUATO}>Caricamento…</p>
      ) : (
        <PreparaRapportino projects={projects} returnTo="/rapportini" />
      )}

      {/* Senza projectId: tutti i rapportini dell'azienda (il backend filtra sempre per
          companyId del token, con o senza cantiere — listRapportini in rapportini.service.ts). */}
      <RapportiniCantiere isAdmin={isAdmin} />
    </div>
  );
}
