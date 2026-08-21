import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { AssignableUser, Project, ProjectDetail, ProjectStatus, ProjectTipoCommessa, Task } from '../lib/types';
import { ArrowLeftIcon, CalendarIcon, ClockIcon, PackageIcon, PrinterIcon, UsersIcon } from '../components/icons';
import { etichettaCantiere, formatDate, formatHours, PROJECT_STATUS_LABELS } from '../lib/format';
import TabellaOre from '../components/TabellaOre';
import RegistroCantiere from '../components/RegistroCantiere';

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
        <Link to="/cantieri" className="list-link w-fit">
          <ArrowLeftIcon /> Cantieri
        </Link>
        <button type="button" className="btn-secondary gap-2" onClick={() => window.print()}>
          <PrinterIcon className="h-4 w-4" /> Stampa / Scarica PDF
        </button>
      </div>

      {error && <div className="alert no-print">{error}</div>}
      {loading && <p className="muted no-print">Caricamento…</p>}

      {project && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg text-gray-400">{etichettaCantiere(project.code, project.projectNumber, project.tipoCommessa)}</span>
              <h1 className="m-0 text-2xl font-semibold text-gray-900">{project.name}</h1>
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
            <div className="mt-1 flex items-center gap-1 text-sm text-gray-500">
              <CalendarIcon className="h-4 w-4" />
              Creato il {formatDate(project.createdAt)}
            </div>
          </div>

          {detail && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="stat-tile">
                <span className="stat-label">
                  <UsersIcon className="h-4 w-4" /> Dipendenti coinvolti
                </span>
                <span className="stat-value">{detail.employeeCount}</span>
              </div>
              <div className="stat-tile">
                <span className="stat-label">
                  <ClockIcon className="h-4 w-4" /> Ore totali registrate
                </span>
                <span className="stat-value">{formatHours(detail.totalHours)}</span>
              </div>
              <div className="stat-tile">
                <span className="stat-label">
                  <PackageIcon className="h-4 w-4" /> Materiali diversi usati
                </span>
                <span className="stat-value">{detail.materials.length}</span>
              </div>
            </div>
          )}

          {kpiForbidden && (
            <p className="muted">Le statistiche del cantiere (dipendenti, ore, materiale) sono visibili solo ad amministratori e project manager.</p>
          )}

          {detail && detail.employees.length > 0 && (
            <TabellaOre title="Ore per dipendente" rows={detail.employees} getName={(r) => r.userName} />
          )}

          {detail && detail.materials.length > 0 && (
            <section className="card">
              <h2>Materiale utilizzato</h2>
              <ul className="list">
                {detail.materials.map((m) => (
                  <li key={`${m.name}-${m.unit}`} className="list-item flex items-center justify-between">
                    <span className="font-medium text-gray-900">{m.name}</span>
                    <span className="muted">
                      {formatHours(m.totalQuantity)} {m.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h2>Lavori</h2>
            {tasks.length === 0 && <p className="muted">Nessun lavoro ancora.</p>}
            <ul className="list">
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} assignableUsers={assignableUsers} canEdit={!kpiForbidden} onChanged={load} />
              ))}
            </ul>
            {project.status === 'completed' ? (
              <p className="muted no-print mt-2">Cantiere chiuso: riaprilo per poter aggiungere nuovi lavori.</p>
            ) : (
              <NewTaskForm projectId={project.id} assignableUsers={assignableUsers} onCreated={load} />
            )}
          </section>

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
      <button type="button" className={isClosed ? 'btn-secondary' : 'btn-danger'} disabled={busy} onClick={toggle}>
        {busy ? '…' : isClosed ? 'Riapri cantiere' : 'Chiudi cantiere'}
      </button>
      {error && <div className="alert">{error}</div>}
    </>
  );
}

const STATUS_OPTIONS = Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[];

// Modifica di nome/tipo/stato del cantiere. Il backend (PATCH /projects/:id) accetta già
// tutti e tre — non serve nulla di nuovo lato server, mancava solo questa UI. Cambiare
// lo stato a "completed" è anche il modo in cui un cantiere finisce nell'Archivio: non
// serve un bottone "archivia" separato, è lo stesso campo che c'era già.
function ProjectEditForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code ?? '');
  const [tipoCommessa, setTipoCommessa] = useState(project.tipoCommessa);
  const [status, setStatus] = useState(project.status);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Stessa lezione già imparata in questo file con TaskRow.syncAndToggle: la bozza deve
  // ripartire dal valore vero e attuale del cantiere ogni volta che si apre o si annulla
  // la modifica, mai da uno stato congelato al primo mount — altrimenti "Annulla" non
  // annulla davvero e un salvataggio può sovrascrivere in silenzio una modifica fatta
  // nel frattempo da un collega.
  function syncAndToggle(next: boolean) {
    setName(project.name);
    setCode(project.code ?? '');
    setTipoCommessa(project.tipoCommessa);
    setStatus(project.status);
    setError(null);
    setEditing(next);
  }

  // Poter correggere il codice anche da qui (non solo alla creazione) non è
  // estetico: un codice sbagliato è altrimenti irreparabile, perché deleteProject
  // rifiuta di cancellare un cantiere con ore registrate collegate.
  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.updateProject(project.id, { name, code: code.trim() || null, tipoCommessa, status });
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
      <button type="button" className="btn-ghost" onClick={() => syncAndToggle(true)}>
        Modifica
      </button>
    );
  }

  return (
    <div className="inline-form w-full basis-full">
      <h3>Modifica cantiere</h3>
      {error && <div className="alert">{error}</div>}
      <label htmlFor="cantiere-edit-nome">Nome</label>
      <input id="cantiere-edit-nome" className="field" value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="cantiere-edit-codice">Codice cantiere (facoltativo)</label>
      <input
        id="cantiere-edit-codice"
        className="field"
        placeholder="es. CANT-04 — se vuoto uso il formato automatico"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={50}
      />
      <label htmlFor="cantiere-edit-tipo">Tipo</label>
      <select
        id="cantiere-edit-tipo"
        className="field"
        value={tipoCommessa}
        onChange={(e) => setTipoCommessa(e.target.value as ProjectTipoCommessa)}
      >
        <option value="consuntivo">Consuntivo</option>
        <option value="contratto">A contratto</option>
      </select>
      <label htmlFor="cantiere-edit-status">Stato</label>
      <select id="cantiere-edit-status" className="field" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {PROJECT_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy} type="button" onClick={save}>
          {busy ? '…' : 'Salva'}
        </button>
        <button className="btn-ghost" disabled={busy} type="button" onClick={() => syncAndToggle(false)}>
          Annulla
        </button>
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
      <li className="list-item flex items-center justify-between gap-2">
        <span>{task.title}</span>
        <span className="flex items-center gap-2">
          {/* Risolto dal server (task.assignedToName): mai incrociato con
              assignableUsers, che può essere vuoto o non includere un operaio
              disattivato pur essendo il task ancora assegnato a lui. */}
          <span className="muted text-sm">{task.assignedToName ?? 'Non assegnato'}</span>
          {canEdit && (
            <button type="button" className="btn-ghost" onClick={() => syncAndToggle(true)}>
              Modifica
            </button>
          )}
        </span>
      </li>
    );
  }

  return (
    <li className="list-item">
      <div className="inline-form">
        <label htmlFor={`task-title-${task.id}`}>Nome lavoro</label>
        <input
          id={`task-title-${task.id}`}
          className="field"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        {error && <div className="alert">{error}</div>}
        {canAssign && (
          <>
            <label htmlFor={`task-assign-${task.id}`}>Assegnato a</label>
            <select id={`task-assign-${task.id}`} className="field" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Non assegnato</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button className="btn-primary" disabled={busy} type="button" onClick={save}>
          {busy ? '…' : 'Salva'}
        </button>
        <button className="btn-ghost" disabled={busy} type="button" onClick={() => syncAndToggle(false)}>
          Annulla
        </button>
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
    <form className="inline-form" onSubmit={submit}>
      {error && <div className="alert">{error}</div>}
      <input
        className="field"
        placeholder="Nome lavoro (es. Installazione impianto)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      {assignableUsers.length > 0 && (
        <select className="field" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
          <option value="">Assegna a… (facoltativo)</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      <button className="btn-primary" disabled={busy} type="submit">
        {busy ? '…' : '+ Aggiungi lavoro'}
      </button>
    </form>
  );
}
