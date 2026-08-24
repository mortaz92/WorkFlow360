import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { HoursByProjectRow, HoursByUserRow, Project } from '../lib/types';
import { ArchiveIcon, ArrowLeftIcon, ArrowRightIcon, CalendarIcon, PrinterIcon } from '../components/icons';
import { etichettaCantiere, formatDate } from '../lib/format';
import TabellaOre from '../components/TabellaOre';
import { Button, Card, EmptyState } from '../components/ui';

const PAGE_SIZE = 20;

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni punto in cui compaiono (testo attenuato, righe di elenco, link "Dettagli",
// riquadro di errore).
const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 transition-shadow hover:shadow-card dark:border-surface-700 dark:bg-surface-800';

const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

// Cantieri con stato "completed", tenuti separati dalla lista attiva in Cantieri.
// "blocked" resta apposta tra gli attivi (decisione utente 18/08): un cantiere bloccato
// non è finito, può ripartire. Il dettaglio (incluso il registro cronologico) è lo
// stesso di un cantiere attivo — /cantieri/:id, nessuna pagina di dettaglio duplicata.
export default function ArchivioPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Ore archiviate: mese chiuso da 15+ giorni o cantiere completato (vedi
  // reports.service.ts, computeArchiveCutoffISO) — stesso endpoint del Report attivo,
  // solo con ?archived=true, stesso componente tabella (TabellaOre).
  const [byProjectArchived, setByProjectArchived] = useState<HoursByProjectRow[]>([]);
  const [byUserArchived, setByUserArchived] = useState<HoursByUserRow[]>([]);
  const [oreLoading, setOreLoading] = useState(true);
  const [oreError, setOreError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function load(targetPage: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProjects(targetPage, PAGE_SIZE, { status: ['completed'] });
      setProjects(res.projects);
      setTotal(res.total);
      setPage(res.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento');
    } finally {
      setLoading(false);
    }
  }

  async function loadOreArchiviate() {
    setOreLoading(true);
    setOreError(null);
    try {
      const [p, u] = await Promise.all([
        api.getHoursByProject(undefined, true),
        api.getHoursByUser(undefined, true),
      ]);
      setByProjectArchived(p.reports);
      setByUserArchived(u.reports);
    } catch (err) {
      setOreError(err instanceof Error ? err.message : 'Errore nel caricamento delle ore archiviate');
    } finally {
      setOreLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    loadOreArchiviate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Archivio</h1>
          <p className={`mt-1 ${TESTO_ATTENUATO}`}>
            {total} cantier{total === 1 ? 'e' : 'i'} completat{total === 1 ? 'o' : 'i'} · più sotto le ore dei mesi chiusi (15+ giorni) e dei cantieri chiusi
          </p>
        </div>
        <Button
          variant="secondary"
          fullWidth
          className="no-print"
          leftIcon={<PrinterIcon className="h-4 w-4" />}
          onClick={() => window.print()}
        >
          Stampa / Scarica PDF
        </Button>
      </div>

      {error && (
        <div className={`${ALERT_ERRORE} no-print`} role="alert">
          {error}
        </div>
      )}

      {/* break-inside-avoid: conserva in stampa il comportamento che la vecchia classe
          .card otteneva con la sua regola @media print (nessuno spezzamento a metà
          pagina) — questa pagina si stampa davvero. */}
      <Card className="break-inside-avoid">
        {loading && <p className={TESTO_ATTENUATO}>Caricamento…</p>}
        {projects.length === 0 && !loading && (
          <EmptyState title="Nessun cantiere completato ancora." icon={<ArchiveIcon className="h-10 w-10" />} />
        )}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {projects.map((p) => (
            <li key={p.id} className={RIGA_ELENCO}>
              <Link to={`/cantieri/${p.id}`} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`font-mono ${TESTO_ATTENUATO}`}>
                      {etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)}
                    </span>
                    <strong className="truncate font-medium text-surface-900 dark:text-surface-100">{p.name}</strong>
                  </div>
                  <div className={`mt-1 flex items-center gap-1 ${TESTO_ATTENUATO}`}>
                    <CalendarIcon className="h-4 w-4" />
                    Creato il {formatDate(p.createdAt)}
                  </div>
                </div>
                <span className={`${LINK_DETTAGLIO} shrink-0`}>
                  Dettagli <ArrowRightIcon />
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-surface-200 pt-4 dark:border-surface-700">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<ArrowLeftIcon />}
              disabled={page <= 1 || loading}
              onClick={() => load(page - 1)}
            >
              Precedente
            </Button>
            <span className={TESTO_ATTENUATO}>
              Pagina {page} di {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              rightIcon={<ArrowRightIcon />}
              disabled={page >= totalPages || loading}
              onClick={() => load(page + 1)}
            >
              Successiva
            </Button>
          </div>
        )}
      </Card>

      <div>
        <h2 className="m-0 text-xl font-semibold text-surface-900 dark:text-surface-100">Ore archiviate</h2>
        <p className={`mt-1 ${TESTO_ATTENUATO}`}>
          Ore di mesi chiusi da oltre 15 giorni o di cantieri chiusi — non più modificabili dal Report attivo.
        </p>
      </div>
      {oreError && (
        <div className={`${ALERT_ERRORE} no-print`} role="alert">
          {oreError}
        </div>
      )}
      {oreLoading && <p className={`${TESTO_ATTENUATO} no-print`}>Caricamento ore archiviate…</p>}
      <TabellaOre title="Ore archiviate per commessa" rows={byProjectArchived} getName={(r) => r.projectName} />
      <TabellaOre title="Ore archiviate per operaio" rows={byUserArchived} getName={(r) => r.userName} />
    </div>
  );
}
