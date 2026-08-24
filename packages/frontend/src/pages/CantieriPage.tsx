import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ProjectTipoCommessa, Project } from '../lib/types';
import { CalendarIcon, ArrowRightIcon, CraneIcon } from '../components/icons';
import { etichettaCantiere, formatDate, PROJECT_STATUS_LABELS } from '../lib/format';
import { Button, Card, EmptyState, Input } from '../components/ui';

const PAGE_SIZE = 20;

const TABS: { key: ProjectTipoCommessa; label: string }[] = [
  { key: 'consuntivo', label: 'Consuntivo' },
  { key: 'contratto', label: 'A contratto' },
];

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni punto in cui compaiono. Stesse stringhe già usate in DashboardPage: restano
// duplicate lì e qui finché non ci sarà un modulo condiviso per gli stili di pagina.
const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white transition-shadow hover:shadow-card-hover dark:border-surface-700 dark:bg-surface-800';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const FORM_INLINE = 'mt-4 flex flex-col gap-3 border-t border-surface-200 pt-4 dark:border-surface-700';

export default function CantieriPage() {
  const [tab, setTab] = useState<ProjectTipoCommessa>('consuntivo');
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  // Pagina propria per ogni tab: cambiare tab non deve far perdere il punto in cui si
  // era arrivati nell'altra lista (due paginatori indipendenti, non uno condiviso).
  const [pages, setPages] = useState<Record<ProjectTipoCommessa, number>>({ consuntivo: 1, contratto: 1 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const page = pages[tab];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function load(targetTab: ProjectTipoCommessa, targetPage: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProjects(targetPage, PAGE_SIZE, { tipoCommessa: targetTab });
      setProjects(res.projects);
      setTotal(res.total);
      setPages((prev) => ({ ...prev, [targetTab]: res.page }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(tab, pages[tab]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Cantieri</h1>
      </div>

      <div className="flex gap-1 rounded-lg bg-surface-100 p-1 dark:bg-surface-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`flex-1 cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-white text-surface-900 shadow-card dark:bg-surface-700 dark:text-surface-100'
                : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}

      <Card>
        <p className={`${TESTO_ATTENUATO} mb-3`}>
          {total} cantier{total === 1 ? 'e' : 'i'} {tab === 'consuntivo' ? 'a consuntivo' : 'a contratto'}
        </p>
        {loading && <p className={TESTO_ATTENUATO}>Caricamento…</p>}
        {projects.length === 0 && !loading && (
          <EmptyState
            title="Nessun cantiere in questa categoria"
            description="Creane uno con il modulo qui sotto."
            icon={<CraneIcon className="h-10 w-10" />}
          />
        )}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {projects.map((p) => (
            <li key={p.id} className={RIGA_ELENCO}>
              <Link
                to={`/cantieri/${p.id}`}
                className="flex items-center justify-between gap-4 rounded-lg p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-surface-500 dark:text-surface-400">
                      {etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)}
                    </span>
                    <strong className="truncate font-medium text-surface-900 dark:text-surface-100">{p.name}</strong>
                    <span className={`badge badge-${p.status}`}>{PROJECT_STATUS_LABELS[p.status]}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-sm text-surface-500 dark:text-surface-400">
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
          <div className="mt-4 flex items-center justify-between border-t border-surface-200 pt-4 dark:border-surface-700">
            <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => load(tab, page - 1)}>
              ← Precedente
            </Button>
            <span className={TESTO_ATTENUATO}>
              Pagina {page} di {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => load(tab, page + 1)}
            >
              Successiva →
            </Button>
          </div>
        )}

        {/* key={tab}: azzera volutamente il form (incluso il nome già digitato) quando
            si cambia tab — creare un cantiere mentre si è sulla tab sbagliata lo farebbe
            comparire nell'altra lista, sorprendendo l'utente; niente più tendina "Tipo"
            da scegliere a mano, il tipo è quello della tab attiva. */}
        <NewProjectForm key={tab} tipoCommessa={tab} onCreated={() => load(tab, page)} />
      </Card>
    </div>
  );
}

function NewProjectForm({ tipoCommessa, onCreated }: { tipoCommessa: ProjectTipoCommessa; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.createProject({ name, code: code.trim() || null, tipoCommessa });
      setName('');
      setCode('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore creazione cantiere');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={FORM_INLINE} onSubmit={submit}>
      <h3 className="m-0 text-sm font-semibold text-surface-900 dark:text-surface-100">
        Nuovo cantiere {tipoCommessa === 'consuntivo' ? 'a consuntivo' : 'a contratto'}
      </h3>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      <Input
        id="cantiere-nome"
        label="Nome cantiere"
        placeholder="Nome cantiere"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Input
        id="cantiere-codice"
        label="Codice cantiere (facoltativo)"
        placeholder="es. CANT-04 — se vuoto uso il formato automatico"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={50}
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        Crea cantiere
      </Button>
    </form>
  );
}
