import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getCurrentUser } from '../lib/api';
import type { Company, HoursByProjectRow, Project, ProjectsSummary, UserSummary, UserRole } from '../lib/types';
import { CalendarIcon, ChevronRightIcon, CraneIcon, SearchIcon, UsersIcon } from '../components/icons';
import { etichettaCantiere, formatHours, formatDate, PROJECT_STATUS_LABELS, USER_ROLE_LABELS } from '../lib/format';

const RECENT_PROJECTS_LIMIT = 5;
const TOP_PROJECTS_LIMIT = 5;

// Ordinario+straordinario+notturno+festivo, ESCLUSE ferie/permesso: coerente con la
// stessa distinzione già fatta in OperaioPage e nella decisione sull'Archivio Cantieri
// (l'utente ha confermato "solo ore lavorate" come numero di riferimento). Una
// classifica "cantieri per ore consumate" che include le assenze del personale
// gonfierebbe cantieri dove si è solo stati in ferie, non lavorato.
function workedHours(row: HoursByProjectRow): number {
  return Number(row.ordinary) + Number(row.straordinario) + Number(row.notturno) + Number(row.festivo);
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export default function DashboardPage() {
  // GET /companies restituisce il catalogo GLOBALE (tutte le aziende, non solo la
  // propria — così è pensato lato backend, vedi companies.routes.ts), quindi qui va
  // filtrato per il companyId del token: prendere semplicemente companies[0] mostrava
  // il nome di un'azienda a caso (in pratica capitava di mostrare debris di test).
  const currentUser = getCurrentUser();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [projectsSummary, setProjectsSummary] = useState<ProjectsSummary | null>(null);
  const [topProjects, setTopProjects] = useState<HoursByProjectRow[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [usr, comp, proj, summary, hoursByProject] = await Promise.all([
        api.listUsers(),
        api.listCompanies(),
        // Solo i più recenti: la lista completa vive nella sua pagina dedicata (paginata).
        api.listProjects(1, RECENT_PROJECTS_LIMIT),
        api.getProjectsSummary(),
        api.getHoursByProject(),
      ]);
      setUsers(usr.users);
      setCompany(comp.companies.find((c) => c.id === currentUser?.companyId) ?? null);
      setRecentProjects(proj.projects);
      setProjectsSummary(summary);
      setTopProjects(
        [...hoursByProject.reports]
          .filter((r) => workedHours(r) > 0)
          .sort((a, b) => workedHours(b) - workedHours(a))
          .slice(0, TOP_PROJECTS_LIMIT),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const me = users.find((u) => u.id === currentUser?.id);
  const displayName = me?.name ?? currentUser?.email ?? '';

  // Filtro lato client sui soli 5 cantieri già caricati: davvero funzionante (non un
  // campo decorativo), niente chiamata aggiuntiva al server per un elenco così piccolo.
  const filteredRecent = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recentProjects;
    return recentProjects.filter((p) => p.name.toLowerCase().includes(q) || String(p.projectNumber).includes(q));
  }, [recentProjects, search]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 text-2xl font-semibold text-gray-900">Dashboard</h1>
          {company && <p className="mt-1 text-sm text-gray-500">{company.name}</p>}
        </div>
        {displayName && (
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
              {initials(displayName)}
            </span>
            <span className="text-sm font-medium text-gray-900">{displayName}</span>
          </div>
        )}
      </div>

      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted">Caricamento…</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Link to="/cantieri" className="stat-tile transition-shadow hover:shadow-md">
          <span className="stat-icon">
            <CraneIcon className="h-5 w-5" />
          </span>
          <span className="stat-value">{projectsSummary?.byTipo.consuntivo ?? '…'}</span>
          <span className="stat-label">Cantieri consuntivo</span>
        </Link>
        <Link to="/cantieri" className="stat-tile transition-shadow hover:shadow-md">
          <span className="stat-icon">
            <CraneIcon className="h-5 w-5" />
          </span>
          <span className="stat-value">{projectsSummary?.byTipo.contratto ?? '…'}</span>
          <span className="stat-label">Cantieri a contratto</span>
        </Link>
        <Link to="/dipendenti" className="stat-tile transition-shadow hover:shadow-md">
          <span className="stat-icon">
            <UsersIcon className="h-5 w-5" />
          </span>
          <span className="stat-value">{users.filter((u) => u.role === 'operaio').length}</span>
          {/* Solo il ruolo "operaio" lavora davvero in cantiere: il conteggio totale
              utenti (admin/PM/resource/qa/stakeholder inclusi) vive già sotto in
              "Utenti" — qui deve corrispondere a chi si vede aprendo /dipendenti. */}
          <span className="stat-label">Dipendenti (operai)</span>
        </Link>
      </div>

      {topProjects.length > 0 && (
        <section className="card">
          <h2>Cantieri per ore lavorate</h2>
          <ul className="list">
            {topProjects.map((p, i) => {
              const max = workedHours(topProjects[0]) || 1;
              const pct = Math.max(4, Math.round((workedHours(p) / max) * 100));
              return (
                <li key={p.projectId} className="list-item flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-gray-900">
                      {i + 1}. {p.projectName}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-sm font-semibold text-gray-700">{formatHours(workedHours(p))}h</span>
                      <Link to={`/cantieri/${p.projectId}`} className="list-link">
                        Dettagli <ChevronRightIcon />
                      </Link>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-blue-600" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0">Cantieri recenti</h2>
          <div className="flex items-center gap-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                className="field w-48 py-2 pl-9 text-sm"
                placeholder="Cerca cantieri…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Link to="/cantieri" className="list-link shrink-0">
              Vedi tutti
            </Link>
          </div>
        </div>

        {filteredRecent.length === 0 && !loading && <p className="muted">Nessun cantiere trovato.</p>}

        {filteredRecent.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left">
                  <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">N. Cantiere</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Nome cantiere</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Stato</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Data di creazione</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filteredRecent.map((p) => (
                  <tr key={p.id} className="border-b border-gray-200 last:border-none hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono font-semibold text-gray-900">{etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className={`badge badge-${p.status} ml-0`}>{PROJECT_STATUS_LABELS[p.status]}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      <span className="flex items-center gap-1.5">
                        <CalendarIcon className="h-4 w-4" />
                        {formatDate(p.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/cantieri/${p.id}`} className="list-link justify-end">
                        Dettagli <ChevronRightIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Utenti ({users.length}/3 admin max)</h2>
        {users.length === 0 && !loading && <p className="muted">Nessun utente oltre a te.</p>}
        <ul className="list">
          {users.map((u) => (
            <li key={u.id} className="list-item flex items-center justify-between">
              <div>
                <strong className="font-medium text-gray-900">{u.name}</strong>{' '}
                <span className="muted">{u.email}</span>
              </div>
              <span className="badge badge-role">{USER_ROLE_LABELS[u.role]}</span>
            </li>
          ))}
        </ul>
        <NewUserForm onCreated={loadAll} />
      </section>
    </div>
  );
}

const ROLES: UserRole[] = ['admin', 'project_manager', 'operaio'];

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('operaio');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.createUser({ email, name, role, password });
      setEmail('');
      setName('');
      setPassword('');
      setRole('operaio');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore creazione utente');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>Nuovo utente</h3>
      {error && <div className="alert">{error}</div>}
      {/* autoComplete="off": senza, Chrome suggeriva l'email dell'admin già loggato in
          questo campo (l'ha creato lui, è l'ultima email "vista" dal browser in un input
          type="email") — un suggerimento del browser, mai un valore scritto dall'app, ma
          visivamente sembrava che il modulo "riusasse" l'email sbagliata. Email SEMPRE
          richiesta, anche per i dipendenti: hanno un indirizzo aziendale come chiunque
          altro, non è un campo riservato agli admin. */}
      <label htmlFor="nuovo-utente-email">Email</label>
      <input
        id="nuovo-utente-email"
        className="field"
        type="email"
        autoComplete="off"
        placeholder="nome@azienda.it"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <label htmlFor="nuovo-utente-nome">Nome</label>
      <input id="nuovo-utente-nome" className="field" autoComplete="off" placeholder="Nome e cognome" value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="nuovo-utente-ruolo">Ruolo</label>
      <select id="nuovo-utente-ruolo" className="field" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {USER_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <label htmlFor="nuovo-utente-password">Password iniziale</label>
      <input
        id="nuovo-utente-password"
        className="field"
        type="password"
        autoComplete="new-password"
        placeholder="Password iniziale"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button className="btn-primary" disabled={busy} type="submit">
        {busy ? '…' : 'Crea utente'}
      </button>
    </form>
  );
}
