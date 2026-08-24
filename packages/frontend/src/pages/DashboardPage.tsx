import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, getCurrentUser } from '../lib/api';
import type { Company, HoursByProjectRow, Project, ProjectsSummary, UserSummary, UserRole } from '../lib/types';
import { CalendarIcon, ChevronRightIcon, CraneIcon, SearchIcon, UsersIcon } from '../components/icons';
import { etichettaCantiere, formatHours, formatDate, PROJECT_STATUS_LABELS, USER_ROLE_LABELS } from '../lib/format';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  Table,
  type Column,
  type SelectOption,
} from '../components/ui';

const RECENT_PROJECTS_LIMIT = 5;
const TOP_PROJECTS_LIMIT = 5;

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni punto in cui compaiono (link "Dettagli", righe di elenco, riquadri di errore).
const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 transition-shadow hover:shadow-card dark:border-surface-700 dark:bg-surface-800';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

// Input/Select del design system impostano solo il COLORE del bordo: il preflight di
// Tailwind v4 azzera border-width su ogni elemento, quindi senza questa classe il campo
// resterebbe senza contorno visibile. Aggiunta qui via className del componente, per non
// toccare i componenti condivisi (usati anche dalle pagine di login).
const BORDO_CAMPO = 'border';

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

// KPI tile: numero grande + etichetta dentro una Card cliccabile. Stessa struttura per
// tutte e tre le tessere, quindi una sola volta qui invece di tre blocchi identici.
function StatTile({ to, icon, value, label }: { to: string; icon: ReactNode; value: ReactNode; label: string }) {
  return (
    <Link
      to={to}
      className="rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-950"
    >
      <Card variant="interactive" padding="sm" className="flex h-full flex-col gap-1">
        <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary-600 text-white">
          {icon}
        </span>
        <span className="text-3xl font-bold text-surface-900 dark:text-surface-100">{value}</span>
        <span className="text-sm font-medium text-surface-500 dark:text-surface-400">{label}</span>
      </Card>
    </Link>
  );
}

const COLONNE_CANTIERI: Column<Project>[] = [
  {
    key: 'numero',
    header: 'N. Cantiere',
    className: 'font-mono font-semibold',
    render: (p) => etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa),
  },
  {
    key: 'nome',
    header: 'Nome cantiere',
    className: 'font-medium',
    render: (p) => p.name,
  },
  {
    key: 'stato',
    header: 'Stato',
    render: (p) => <span className={`badge badge-${p.status} ml-0`}>{PROJECT_STATUS_LABELS[p.status]}</span>,
  },
  {
    key: 'creato',
    header: 'Data di creazione',
    // Colore attenuato messo sullo <span> interno e non sulla cella: la <td> del
    // componente Table porta già un text-* proprio, due utility dello stesso tipo sullo
    // stesso elemento si contendono la precedenza in base all'ordine del CSS generato.
    render: (p) => (
      <span className="flex items-center gap-1.5 text-surface-500 dark:text-surface-400">
        <CalendarIcon className="h-4 w-4" />
        {formatDate(p.createdAt)}
      </span>
    ),
  },
  {
    key: 'azioni',
    header: '',
    className: 'text-right',
    render: (p) => (
      <Link to={`/cantieri/${p.id}`} className={`${LINK_DETTAGLIO} justify-end`}>
        Dettagli <ChevronRightIcon />
      </Link>
    ),
  },
];

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
          <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">Dashboard</h1>
          {company && <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">{company.name}</p>}
        </div>
        {displayName && (
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-600 text-sm font-semibold text-white">
              {initials(displayName)}
            </span>
            <span className="text-sm font-medium text-surface-900 dark:text-surface-100">{displayName}</span>
          </div>
        )}
      </div>

      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      {loading && <p className="text-sm text-surface-500 dark:text-surface-400">Caricamento…</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile
          to="/cantieri"
          icon={<CraneIcon className="h-5 w-5" />}
          value={projectsSummary?.byTipo.consuntivo ?? '…'}
          label="Cantieri consuntivo"
        />
        <StatTile
          to="/cantieri"
          icon={<CraneIcon className="h-5 w-5" />}
          value={projectsSummary?.byTipo.contratto ?? '…'}
          label="Cantieri a contratto"
        />
        {/* Solo il ruolo "operaio" lavora davvero in cantiere: il conteggio totale
            utenti (admin/PM/resource/qa/stakeholder inclusi) vive già sotto in
            "Utenti" — qui deve corrispondere a chi si vede aprendo /dipendenti. */}
        <StatTile
          to="/dipendenti"
          icon={<UsersIcon className="h-5 w-5" />}
          value={users.filter((u) => u.role === 'operaio').length}
          label="Dipendenti (operai)"
        />
      </div>

      {topProjects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Cantieri per ore lavorate</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {topProjects.map((p, i) => {
                const max = workedHours(topProjects[0]) || 1;
                const pct = Math.max(4, Math.round((workedHours(p) / max) * 100));
                return (
                  <li key={p.projectId} className={`${RIGA_ELENCO} flex flex-col gap-2`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-surface-900 dark:text-surface-100">
                        {i + 1}. {p.projectName}
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                          {formatHours(workedHours(p))}h
                        </span>
                        <Link to={`/cantieri/${p.projectId}`} className={LINK_DETTAGLIO}>
                          Dettagli <ChevronRightIcon />
                        </Link>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-200 dark:bg-surface-700">
                      <div className="h-full rounded-full bg-primary-600 dark:bg-primary-500" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Cantieri recenti</CardTitle>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <div className="w-full sm:w-56">
              <Input
                id="dashboard-cerca-cantieri"
                aria-label="Cerca cantieri"
                placeholder="Cerca cantieri…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                leftIcon={<SearchIcon className="h-4 w-4" />}
                className={BORDO_CAMPO}
              />
            </div>
            <Link to="/cantieri" className={`${LINK_DETTAGLIO} shrink-0`}>
              Vedi tutti
            </Link>
          </div>
        </CardHeader>

        <CardContent>
          {filteredRecent.length === 0 && !loading && (
            <EmptyState title="Nessun cantiere trovato" icon={<SearchIcon className="h-10 w-10" />} />
          )}

          {filteredRecent.length > 0 && (
            <Table
              columns={COLONNE_CANTIERI}
              data={filteredRecent}
              keyExtractor={(p) => p.id}
              caption="Cantieri recenti"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Utenti ({users.length}/3 admin max)</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 && !loading && (
            <EmptyState title="Nessun utente oltre a te" icon={<UsersIcon className="h-10 w-10" />} />
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {users.map((u) => (
              <li key={u.id} className={`${RIGA_ELENCO} flex items-center justify-between`}>
                <div>
                  <strong className="font-medium text-surface-900 dark:text-surface-100">{u.name}</strong>{' '}
                  <span className="text-sm text-surface-500 dark:text-surface-400">{u.email}</span>
                </div>
                <span className="badge badge-role">{USER_ROLE_LABELS[u.role]}</span>
              </li>
            ))}
          </ul>
          <NewUserForm onCreated={loadAll} />
        </CardContent>
      </Card>
    </div>
  );
}

const ROLES: UserRole[] = ['admin', 'project_manager', 'operaio'];

const ROLE_OPTIONS: SelectOption[] = ROLES.map((r) => ({ value: r, label: USER_ROLE_LABELS[r] }));

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
    <form
      className="mt-4 flex flex-col gap-3 border-t border-surface-200 pt-4 dark:border-surface-700"
      onSubmit={submit}
    >
      <h3 className="m-0 text-sm font-semibold text-surface-900 dark:text-surface-100">Nuovo utente</h3>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      {/* autoComplete="off": senza, Chrome suggeriva l'email dell'admin già loggato in
          questo campo (l'ha creato lui, è l'ultima email "vista" dal browser in un input
          type="email") — un suggerimento del browser, mai un valore scritto dall'app, ma
          visivamente sembrava che il modulo "riusasse" l'email sbagliata. Email SEMPRE
          richiesta, anche per i dipendenti: hanno un indirizzo aziendale come chiunque
          altro, non è un campo riservato agli admin. */}
      <Input
        id="nuovo-utente-email"
        label="Email"
        type="email"
        autoComplete="off"
        placeholder="nome@azienda.it"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        className={BORDO_CAMPO}
      />
      <Input
        id="nuovo-utente-nome"
        label="Nome"
        autoComplete="off"
        placeholder="Nome e cognome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        className={BORDO_CAMPO}
      />
      <Select
        id="nuovo-utente-ruolo"
        label="Ruolo"
        options={ROLE_OPTIONS}
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
        className={BORDO_CAMPO}
      />
      <Input
        id="nuovo-utente-password"
        label="Password iniziale"
        type="password"
        autoComplete="new-password"
        placeholder="Password iniziale"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        className={BORDO_CAMPO}
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        Crea utente
      </Button>
    </form>
  );
}
