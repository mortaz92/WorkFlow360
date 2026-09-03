import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, getCurrentUser } from '../lib/api';
import type { AssignableUser, Project, ProjectDetail, ProjectStatus, ProjectTipoCommessa, Task } from '../lib/types';
import {
  ArrowLeftIcon,
  BuildingIcon,
  CalendarIcon,
  ClipboardIcon,
  ClockIcon,
  PackageIcon,
  PrinterIcon,
  UsersIcon,
} from '../components/icons';
import { etichettaCantiere, formatDate, formatHours, PROJECT_STATUS_LABELS } from '../lib/format';
import TabellaOre from '../components/TabellaOre';
import RegistroCantiere from '../components/RegistroCantiere';
import RapportiniCantiere from '../components/RapportiniCantiere';
import PreparaRapportino from '../components/PreparaRapportino';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  type SelectOption,
} from '../components/ui';

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni punto in cui compaiono. Stesse stringhe già usate in DashboardPage: restano
// duplicate lì e qui finché non ci sarà un modulo condiviso per gli stili di pagina.
const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 transition-shadow hover:shadow-card dark:border-surface-700 dark:bg-surface-800';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const FORM_INLINE = 'mt-4 flex flex-col gap-3 border-t border-surface-200 pt-4 dark:border-surface-700';

// La vecchia classe .card portava con sé una regola di stampa (break-inside: avoid) che
// il componente Card non ha: senza questa utility una scheda potrebbe spezzarsi a metà
// tra due pagine nel "Stampa / Scarica PDF" di questa pagina.
const CARD_STAMPABILE = 'break-inside-avoid';

// KPI tile: etichetta + numero grande dentro una Card. Stessa struttura per tutte e tre
// le tessere del cantiere, quindi una sola volta qui invece di tre blocchi identici.
function KpiTile({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <Card padding="sm" className={`flex flex-col gap-1 ${CARD_STAMPABILE}`}>
      <span className="flex items-center gap-1.5 text-sm font-medium text-surface-500 dark:text-surface-400">
        {icon} {label}
      </span>
      <span className="text-3xl font-bold text-surface-900 dark:text-surface-100">{value}</span>
    </Card>
  );
}

export default function CantiereDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  // Distinto da "detail === null": la sezione KPI vive sotto /reports, riservata ad
  // admin/project_manager (stessa regola di Report/Dipendenti) — un ruolo diverso deve
  // comunque poter vedere nome/stato/lavori del cantiere (lettura aperta a tutti su
  // /projects), solo senza le statistiche aggregate. Prima di questo fix la pagina si
  // bloccava del tutto per quei ruoli, perdendo anche i lavori che potevano già vedere.
  const [kpiForbidden, setKpiForbidden] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Come detail/kpiForbidden sopra: /tasks/assignable-users è riservato a
  // admin/project_manager. Un ruolo diverso NON può (ri)assegnare — niente errore di
  // pagina per questo, la lista resta vuota e la dropdown di assegnazione sparisce —
  // ma VEDE comunque chi è assegnato: il nome (assignedToName) arriva già risolto dal
  // server dentro Task, non va MAI incrociato con questa lista (che è filtrata a
  // operai attivi e sarebbe comunque vuota per questi ruoli — un bug reale di questa
  // sessione, corretto: prima il nome spariva per tutti tranne admin/PM).
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Sblocco di un rapportino firmato è riservato ad admin (vedi RapportiniCantiere):
  // stessa lettura del token già usata in DipendenteDetailPage/UserEditForm.
  const currentRole = getCurrentUser()?.role;
  const isAdmin = currentRole === 'admin';
  // Preparare un rapportino (e avviarne la firma) vale per admin E project_manager,
  // stesso criterio di assertPuoPrepararlo/isManager nel backend (core/roles.ts) — non
  // solo isAdmin sopra, che qui gate solo lo sblocco di un rapportino già firmato.
  const isManager = currentRole === 'admin' || currentRole === 'project_manager';

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    setKpiForbidden(false);
    try {
      const [projectRes, tasksRes] = await Promise.all([api.getProjectById(id), api.listTasks(id)]);
      setProject(projectRes.project);
      setTasks(tasksRes.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento');
      setLoading(false);
      return;
    }
    try {
      const detailRes = await api.getProjectDetail(id);
      setDetail(detailRes.project);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setKpiForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : 'Errore nel caricamento delle statistiche');
      }
    }
    try {
      const assignableRes = await api.listAssignableUsers();
      setAssignableUsers(assignableRes.users);
    } catch (err) {
      // Solo il 403 per ruoli non-manager è atteso e silenzioso (la pagina resta
      // utilizzabile, solo senza poter assegnare). Un altro errore (rete, 500) non va
      // confuso con "non ho i permessi": stesso principio già applicato a kpiForbidden
      // sopra, che questo blocco non seguiva.
      setAssignableUsers([]);
      if (!(err instanceof ApiError && err.status === 403)) {
        setError(err instanceof Error ? err.message : "Errore nel caricamento dell'elenco dipendenti assegnabili");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3 no-print">
        <Link to="/cantieri" className={`${LINK_DETTAGLIO} w-fit`}>
          <ArrowLeftIcon /> Cantieri
        </Link>
        <Button variant="secondary" leftIcon={<PrinterIcon className="h-4 w-4" />} onClick={() => window.print()}>
          Stampa / Scarica PDF
        </Button>
      </div>

      {error && (
        <div className={`${ALERT_ERRORE} no-print`} role="alert">
          {error}
        </div>
      )}
      {loading && <p className={`${TESTO_ATTENUATO} no-print`}>Caricamento…</p>}

      {project && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg text-surface-500 dark:text-surface-400">
                {etichettaCantiere(project.code, project.projectNumber, project.tipoCommessa)}
              </span>
              <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">{project.name}</h1>
              <span className={`badge badge-${project.tipoCommessa}`}>{project.tipoCommessa}</span>
              <span className={`badge badge-${project.status}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
              {/* Stesso gate di scrittura di /reports (PROJECT_MANAGER_ROLES): kpiForbidden
                  è già la stessa verifica di ruolo, riusata invece di duplicarla. */}
              {!kpiForbidden && (
                <span className="flex flex-wrap items-center gap-2 no-print">
                  <CloseReopenButton project={project} onSaved={load} />
                  <ProjectEditForm project={project} onSaved={load} />
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-surface-500 dark:text-surface-400">
              <span className="flex items-center gap-1">
                <CalendarIcon className="h-4 w-4" />
                Creato il {formatDate(project.createdAt)}
              </span>
              {/* Mostrato solo se c'è: una riga "Indirizzo: —" occuperebbe spazio per dire
                  che non si sa nulla. È la "Destinazione" stampata sui rapportini, ed è qui
                  che si controlla che sia quella giusta prima di farne firmare uno. */}
              {project.address && (
                <span className="flex items-center gap-1">
                  <BuildingIcon className="h-4 w-4" />
                  {project.address}
                </span>
              )}
            </div>
          </div>

          {detail && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <KpiTile
                icon={<UsersIcon className="h-4 w-4" />}
                label="Dipendenti coinvolti"
                value={detail.employeeCount}
              />
              <KpiTile
                icon={<ClockIcon className="h-4 w-4" />}
                label="Ore totali registrate"
                value={formatHours(detail.totalHours)}
              />
              <KpiTile
                icon={<PackageIcon className="h-4 w-4" />}
                label="Materiali diversi usati"
                value={detail.materials.length}
              />
            </div>
          )}

          {kpiForbidden && (
            <p className={TESTO_ATTENUATO}>
              Le statistiche del cantiere (dipendenti, ore, materiale) sono visibili solo ad amministratori e project
              manager.
            </p>
          )}

          {detail && detail.employees.length > 0 && (
            <TabellaOre title="Ore per dipendente" rows={detail.employees} getName={(r) => r.userName} />
          )}

          {detail && detail.materials.length > 0 && (
            <Card className={CARD_STAMPABILE}>
              <CardHeader>
                <CardTitle>Materiale utilizzato</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {detail.materials.map((m) => (
                    <li key={`${m.name}-${m.unit}`} className={`${RIGA_ELENCO} flex items-center justify-between`}>
                      <span className="font-medium text-surface-900 dark:text-surface-100">{m.name}</span>
                      <span className={TESTO_ATTENUATO}>
                        {formatHours(m.totalQuantity)} {m.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card className={CARD_STAMPABILE}>
            <CardHeader>
              <CardTitle>Lavori</CardTitle>
            </CardHeader>
            <CardContent>
              {tasks.length === 0 && (
                <EmptyState title="Nessun lavoro ancora" icon={<ClipboardIcon className="h-10 w-10" />} />
              )}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} assignableUsers={assignableUsers} canEdit={!kpiForbidden} onChanged={load} />
                ))}
              </ul>
              {project.status === 'completed' ? (
                <p className={`${TESTO_ATTENUATO} no-print mt-2`}>
                  Cantiere chiuso: riaprilo per poter aggiungere nuovi lavori.
                </p>
              ) : (
                <NewTaskForm projectId={project.id} assignableUsers={assignableUsers} onCreated={load} />
              )}
            </CardContent>
          </Card>

          {/* I rapportini esistono solo per cantieri "a consuntivo" (il backend rifiuta
              comunque la creazione per gli altri): niente sezione vuota e fuorviante per
              un cantiere a contratto fisso, dove questa feature non si applica mai. */}
          {project.tipoCommessa === 'consuntivo' && (
            <>
              {isManager && (
                <PreparaRapportino projectId={project.id} returnTo={`/cantieri/${project.id}`} />
              )}
              {!kpiForbidden && <RapportiniCantiere projectId={project.id} isAdmin={isAdmin} />}
            </>
          )}

          {!kpiForbidden && <RegistroCantiere projectId={project.id} />}
        </>
      )}
    </div>
  );
}

// Azione dedicata e ben visibile per chiudere/riaprire un cantiere — prima l'unico modo
// era il generico "Modifica" -> tendina Stato, facile da non notare. Il backend applica
// già l'effetto reale (POST /tasks e /time-logs rifiutano con 409 su un cantiere
// "completed", vedi tasks.service.ts/timeLogs.service.ts): questo bottone è solo la via
// più diretta per arrivarci, non introduce comportamento nuovo lato server.
function CloseReopenButton({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClosed = project.status === 'completed';

  async function toggle() {
    const confirmed = confirm(
      isClosed
        ? 'Riaprire questo cantiere? Sarà di nuovo possibile aggiungere lavori e registrare ore.'
        : 'Chiudere questo cantiere? Da questo momento non sarà più possibile aggiungere nuovi lavori né registrare nuove ore qui — il cantiere passa nell\'Archivio.',
    );
    if (!confirmed) return;
    setError(null);
    setBusy(true);
    try {
      await api.updateProject(project.id, { status: isClosed ? 'in_progress' : 'completed' });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'aggiornamento dello stato del cantiere");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant={isClosed ? 'secondary' : 'danger'} size="sm" loading={busy} onClick={toggle}>
        {isClosed ? 'Riapri cantiere' : 'Chiudi cantiere'}
      </Button>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
    </>
  );
}

const STATUS_OPTIONS: SelectOption[] = (Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => ({
  value: s,
  label: PROJECT_STATUS_LABELS[s],
}));

const TIPO_OPTIONS: SelectOption[] = [
  { value: 'consuntivo', label: 'Consuntivo' },
  { value: 'contratto', label: 'A contratto' },
];

// Modifica di nome/tipo/stato del cantiere. Il backend (PATCH /projects/:id) accetta già
// tutti e tre — non serve nulla di nuovo lato server, mancava solo questa UI. Cambiare
// lo stato a "completed" è anche il modo in cui un cantiere finisce nell'Archivio: non
// serve un bottone "archivia" separato, è lo stesso campo che c'era già.
function ProjectEditForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code ?? '');
  const [address, setAddress] = useState(project.address ?? '');
  const [tipoCommessa, setTipoCommessa] = useState(project.tipoCommessa);
  const [status, setStatus] = useState(project.status);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Stessa lezione già imparata in questo file con TaskRow.syncAndToggle: la bozza deve
  // ripartire dal valore vero e attuale del cantiere ogni volta che si apre o si annulla
  // la modifica, mai da uno stato congelato al primo mount — altrimenti "Annulla" non
  // annulla davvero e un salvataggio può sovrascrivere in silenzio una modifica fatta
  // nel frattempo da un collega.
  // OGNI campo nuovo del form va aggiunto anche QUI: i due bug sopra sono esattamente
  // quello che succede a un campo dimenticato in questa funzione.
  function syncAndToggle(next: boolean) {
    setName(project.name);
    setCode(project.code ?? '');
    setAddress(project.address ?? '');
    setTipoCommessa(project.tipoCommessa);
    setStatus(project.status);
    setError(null);
    setEditing(next);
  }

  // Poter correggere il codice anche da qui (non solo alla creazione) non è
  // estetico: un codice sbagliato è altrimenti irreparabile, perché deleteProject
  // rifiuta di cancellare un cantiere con ore registrate collegate. Vale identico per
  // l'indirizzo, che per giunta finisce stampato sui rapportini.
  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.updateProject(project.id, {
        name,
        code: code.trim() || null,
        address: address.trim() || null,
        tipoCommessa,
        status,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'aggiornamento del cantiere");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => syncAndToggle(true)}>
        Modifica
      </Button>
    );
  }

  return (
    <div className={`${FORM_INLINE} w-full basis-full`}>
      <h3 className="m-0 text-sm font-semibold text-surface-900 dark:text-surface-100">Modifica cantiere</h3>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      <Input
        id="cantiere-edit-nome"
        label="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Input
        id="cantiere-edit-codice"
        label="Codice cantiere (facoltativo)"
        placeholder="es. CANT-04 — se vuoto uso il formato automatico"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={50}
      />
      {/* maxLength allineato al tetto dello schema Zod del backend (addressSchema, 500). */}
      <Input
        id="cantiere-edit-indirizzo"
        label="Indirizzo del cantiere (facoltativo)"
        placeholder="es. Via Roma 12, Milano — la Destinazione sul rapportino"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        maxLength={500}
      />
      <Select
        id="cantiere-edit-tipo"
        label="Tipo"
        options={TIPO_OPTIONS}
        value={tipoCommessa}
        onChange={(e) => setTipoCommessa(e.target.value as ProjectTipoCommessa)}
      />
      <Select
        id="cantiere-edit-status"
        label="Stato"
        options={STATUS_OPTIONS}
        value={status}
        onChange={(e) => setStatus(e.target.value as ProjectStatus)}
      />
      <div className="flex gap-2">
        <Button type="button" variant="primary" loading={busy} onClick={save}>
          Salva
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => syncAndToggle(false)}>
          Annulla
        </Button>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  assignableUsers,
  canEdit,
  onChanged,
}: {
  task: Task;
  assignableUsers: AssignableUser[];
  // Stesso gate di ProjectEditForm (kpiForbidden): un ruolo non-manager può vedere i
  // lavori ma non toccarli. Non va confuso con canAssign sotto — quello riguarda solo
  // la dropdown "assegnato a", non il permesso di rinominare il lavoro.
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [assignedTo, setAssignedTo] = useState(task.assignedTo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Nessuna dropdown da mostrare se il ruolo di chi guarda non può leggere l'elenco
  // operai (vedi commento su assignableUsers in load()): il titolo resta comunque
  // modificabile (governato da canEdit), solo senza poter scegliere un assegnatario.
  const canAssign = assignableUsers.length > 0;

  // `task` cambia ad ogni load() (refetch dopo qualunque salvataggio, anche di un
  // ALTRO lavoro), ma questo componente resta montato (stessa key={t.id}): senza
  // risincronizzare qui, "Annulla" non annullava davvero (title/assignedTo restava la
  // scelta scartata) e una modifica di un altro utente nel frattempo poteva essere
  // sovrascritta in silenzio da un "Salva" basato su un valore di partenza vecchio —
  // due bug reali trovati in FASE 5. Chiamare questa funzione SIA per aprire la
  // modifica SIA per annullarla risolve entrambi: la bozza riparte sempre dal valore
  // vero e attuale del task, mai da uno stato congelato al primo mount.
  function syncAndToggle(next: boolean) {
    setTitle(task.title);
    setAssignedTo(task.assignedTo ?? '');
    setError(null);
    setEditing(next);
  }

  async function save() {
    setError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return setError('Il nome del lavoro non può essere vuoto');
    setBusy(true);
    try {
      await api.updateTask(task.id, { title: trimmedTitle, assignedTo: assignedTo || null });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'aggiornamento del lavoro");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <li className={`${RIGA_ELENCO} flex items-center justify-between gap-2`}>
        <span className="text-surface-900 dark:text-surface-100">{task.title}</span>
        <span className="flex items-center gap-2">
          {/* Risolto dal server (task.assignedToName): mai incrociato con
              assignableUsers, che può essere vuoto o non includere un operaio
              disattivato pur essendo il task ancora assegnato a lui. */}
          <span className={TESTO_ATTENUATO}>{task.assignedToName ?? 'Non assegnato'}</span>
          {canEdit && (
            <Button type="button" variant="ghost" size="sm" onClick={() => syncAndToggle(true)}>
              Modifica
            </Button>
          )}
        </span>
      </li>
    );
  }

  return (
    <li className={RIGA_ELENCO}>
      <div className="flex flex-col gap-3">
        <Input
          id={`task-title-${task.id}`}
          label="Nome lavoro"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        {error && (
          <div className={ALERT_ERRORE} role="alert">
            {error}
          </div>
        )}
        {canAssign && (
          <Select
            id={`task-assign-${task.id}`}
            label="Assegnato a"
            options={[
              // Prima opzione dentro `options` e non nella prop `placeholder` del
              // componente: quella renderizza un <option disabled>, che impedirebbe di
              // TOGLIERE un'assegnazione già fatta.
              { value: '', label: 'Non assegnato' },
              ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
            ]}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="primary" loading={busy} onClick={save}>
            Salva
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => syncAndToggle(false)}>
            Annulla
          </Button>
        </div>
      </div>
    </li>
  );
}

function NewTaskForm({
  projectId,
  assignableUsers,
  onCreated,
}: {
  projectId: string;
  assignableUsers: AssignableUser[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.createTask({ projectId, title, status: 'in_progress', assignedTo: assignedTo || null });
      setTitle('');
      setAssignedTo('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore creazione lavoro');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={FORM_INLINE} onSubmit={submit}>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      <Input
        aria-label="Nome lavoro"
        placeholder="Nome lavoro (es. Installazione impianto)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      {assignableUsers.length > 0 && (
        <Select
          aria-label="Assegna il lavoro a un dipendente"
          options={[
            // Come in TaskRow: la voce "nessuna assegnazione" è una option normale, non
            // la prop `placeholder` (che sarebbe disabilitata e non riselezionabile).
            { value: '', label: 'Assegna a… (facoltativo)' },
            ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
          ]}
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
        />
      )}
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        + Aggiungi lavoro
      </Button>
    </form>
  );
}
