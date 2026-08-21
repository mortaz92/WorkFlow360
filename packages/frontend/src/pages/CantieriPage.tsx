import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ProjectTipoCommessa, Project } from '../lib/types';
import { CalendarIcon, ArrowRightIcon } from '../components/icons';
import { etichettaCantiere, formatDate, PROJECT_STATUS_LABELS } from '../lib/format';

const PAGE_SIZE = 20;

const TABS: { key: ProjectTipoCommessa; label: string }[] = [
  { key: 'consuntivo', label: 'Consuntivo' },
  { key: 'contratto', label: 'A contratto' },
];

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
        <h1 className="m-0 text-2xl font-semibold text-gray-900">Cantieri</h1>
      </div>

      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`flex-1 cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <section className="card">
        <p className="muted mb-3">
          {total} cantier{total === 1 ? 'e' : 'i'} {tab === 'consuntivo' ? 'a consuntivo' : 'a contratto'}
        </p>
        {loading && <p className="muted">Caricamento…</p>}
        {projects.length === 0 && !loading && <p className="muted">Nessun cantiere in questa categoria. Creane uno.</p>}
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id} className="list-item">
              <Link to={`/cantieri/${p.id}`} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-gray-400">{etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)}</span>
                    <strong className="truncate font-medium text-gray-900">{p.name}</strong>
                    <span className={`badge badge-${p.status}`}>{PROJECT_STATUS_LABELS[p.status]}</span>
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
            <button className="btn-secondary" disabled={page <= 1 || loading} onClick={() => load(tab, page - 1)}>
              ← Precedente
            </button>
            <span className="muted">
              Pagina {page} di {totalPages}
            </span>
            <button className="btn-secondary" disabled={page >= totalPages || loading} onClick={() => load(tab, page + 1)}>
              Successiva →
            </button>
          </div>
        )}

        {/* key={tab}: azzera volutamente il form (incluso il nome già digitato) quando
            si cambia tab — creare un cantiere mentre si è sulla tab sbagliata lo farebbe
            comparire nell'altra lista, sorprendendo l'utente; niente più tendina "Tipo"
            da scegliere a mano, il tipo è quello della tab attiva. */}
        <NewProjectForm key={tab} tipoCommessa={tab} onCreated={() => load(tab, page)} />
      </section>
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
    <form className="inline-form" onSubmit={submit}>
      <h3>Nuovo cantiere {tipoCommessa === 'consuntivo' ? 'a consuntivo' : 'a contratto'}</h3>
      {error && <div className="alert">{error}</div>}
      <label htmlFor="cantiere-nome">Nome cantiere</label>
      <input
        id="cantiere-nome"
        className="field"
        placeholder="Nome cantiere"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <label htmlFor="cantiere-codice">Codice cantiere (facoltativo)</label>
      <input
        id="cantiere-codice"
        className="field"
        placeholder="es. CANT-04 — se vuoto uso il formato automatico"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={50}
      />
      <button className="btn-primary" disabled={busy} type="submit">
        {busy ? '…' : 'Crea cantiere'}
      </button>
    </form>
  );
}
