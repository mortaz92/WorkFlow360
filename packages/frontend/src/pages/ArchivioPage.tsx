import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { HoursByProjectRow, HoursByUserRow, Project } from '../lib/types';
import { CalendarIcon, ArrowRightIcon, PrinterIcon } from '../components/icons';
import { etichettaCantiere, formatDate } from '../lib/format';
import TabellaOre from '../components/TabellaOre';

const PAGE_SIZE = 20;

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
          <h1 className="m-0 text-2xl font-semibold text-gray-900">Archivio</h1>
          <p className="mt-1 text-sm text-gray-500">
            {total} cantier{total === 1 ? 'e' : 'i'} completat{total === 1 ? 'o' : 'i'} · più sotto le ore dei mesi chiusi (15+ giorni) e dei cantieri chiusi
          </p>
        </div>
        <button type="button" className="btn-secondary gap-2 no-print" onClick={() => window.print()}>
          <PrinterIcon className="h-4 w-4" /> Stampa / Scarica PDF
        </button>
      </div>

      {error && <div className="alert no-print">{error}</div>}

      <section className="card">
        {loading && <p className="muted">Caricamento…</p>}
        {projects.length === 0 && !loading && <p className="muted">Nessun cantiere completato ancora.</p>}
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id} className="list-item">
              <Link to={`/cantieri/${p.id}`} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-gray-400">{etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)}</span>
                    <strong className="truncate font-medium text-gray-900">{p.name}</strong>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-sm text-gray-500">
                    <CalendarIcon className="h-4 w-4" />
                    Creato il {formatDate(p.createdAt)}
                  </div>
                </div>
                <span className="list-link shrink-0">
                  Dettagli <ArrowRightIcon />
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
            <button className="btn-secondary" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
              ← Precedente
            </button>
            <span className="muted">
              Pagina {page} di {totalPages}
            </span>
            <button className="btn-secondary" disabled={page >= totalPages || loading} onClick={() => load(page + 1)}>
              Successiva →
            </button>
          </div>
        )}
      </section>

      <div>
        <h2 className="m-0 text-xl font-semibold text-gray-900">Ore archiviate</h2>
        <p className="mt-1 text-sm text-gray-500">
          Ore di mesi chiusi da oltre 15 giorni o di cantieri chiusi — non più modificabili dal Report attivo.
        </p>
      </div>
      {oreError && <div className="alert no-print">{oreError}</div>}
      {oreLoading && <p className="muted no-print">Caricamento ore archiviate…</p>}
      <TabellaOre title="Ore archiviate per commessa" rows={byProjectArchived} getName={(r) => r.projectName} />
      <TabellaOre title="Ore archiviate per operaio" rows={byUserArchived} getName={(r) => r.userName} />
    </div>
  );
}
