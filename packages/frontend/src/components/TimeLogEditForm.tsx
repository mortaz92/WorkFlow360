import { useState } from 'react';
import { api } from '../lib/api';
import type { AssignableUser, Project, Task, TimeLogTipo } from '../lib/types';
import { TIPI_ORDER } from '../lib/format';

// Correzione di una registrazione ore da parte di admin/PM: cantiere, lavoro,
// dipendente, tipo, ore, data. Volutamente NON il form di OperaioPage — quello è
// fuso col flusso "registra"/"ripeti ultima" e ha regole diverse (l'operaio non può
// cambiare proprietario). Usato sia da RegistroCantiere sia dalla cronologia ore nel
// dettaglio dipendente: un solo editor condiviso tra i due punti di ingresso.
export default function TimeLogEditForm({
  timeLog,
  onSaved,
}: {
  timeLog: { id: string; taskId: string; userId: string; tipo: TimeLogTipo; hoursWorked: string; date: string };
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState(timeLog.taskId);
  const [userId, setUserId] = useState(timeLog.userId);
  const [tipo, setTipo] = useState(timeLog.tipo);
  const [hoursWorked, setHoursWorked] = useState(timeLog.hoursWorked);
  const [date, setDate] = useState(timeLog.date);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Carica le opzioni (cantieri/dipendenti/lavori del cantiere attuale) solo
  // all'apertura, non ad ogni render: sono liste che cambiano raramente e la
  // registrazione può essere corretta più volte nella stessa sessione della pagina.
  async function open() {
    setError(null);
    setTaskId(timeLog.taskId);
    setUserId(timeLog.userId);
    setTipo(timeLog.tipo);
    setHoursWorked(timeLog.hoursWorked);
    setDate(timeLog.date);
    setEditing(true);
    setLoadingOptions(true);
    try {
      const [projRes, usersRes, taskRes] = await Promise.all([
        api.listProjects(1, 100),
        api.listAssignableUsers(),
        api.getTaskById(timeLog.taskId),
      ]);
      setProjects(projRes.projects);
      setAssignableUsers(usersRes.users);
      setProjectId(taskRes.task.projectId);
      const tasksRes = await api.listTasks(taskRes.task.projectId);
      setTasks(tasksRes.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento delle opzioni');
    } finally {
      setLoadingOptions(false);
    }
  }

  async function onProjectChange(newProjectId: string) {
    setProjectId(newProjectId);
    setTaskId('');
    try {
      const tasksRes = await api.listTasks(newProjectId);
      setTasks(tasksRes.tasks);
      if (tasksRes.tasks[0]) setTaskId(tasksRes.tasks[0].id);
    } catch {
      setTasks([]);
    }
  }

  async function save() {
    setError(null);
    if (!taskId) return setError('Seleziona un lavoro');
    if (!/^\d+(\.\d{1,2})?$/.test(hoursWorked) || Number(hoursWorked) <= 0) {
      return setError('Inserisci un numero di ore valido (es. 3.5)');
    }
    setBusy(true);
    try {
      await api.updateTimeLog(timeLog.id, { taskId, userId, tipo, hoursWorked, date });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'aggiornamento della registrazione");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" className="btn-ghost px-2" onClick={open}>
        Modifica
      </button>
    );
  }

  return (
    <div className="inline-form w-full">
      <h3>Correggi registrazione</h3>
      {error && <div className="alert">{error}</div>}
      {loadingOptions ? (
        <p className="muted">Caricamento opzioni…</p>
      ) : (
        <>
          <label htmlFor={`tle-cantiere-${timeLog.id}`}>Cantiere</label>
          <select
            id={`tle-cantiere-${timeLog.id}`}
            className="field"
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label htmlFor={`tle-lavoro-${timeLog.id}`}>Lavoro</label>
          <select id={`tle-lavoro-${timeLog.id}`} className="field" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {tasks.length === 0 && <option value="">Nessun lavoro per questo cantiere</option>}
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <label htmlFor={`tle-dipendente-${timeLog.id}`}>Dipendente</label>
          <select id={`tle-dipendente-${timeLog.id}`} className="field" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {/* Il dipendente attuale potrebbe non essere più nella lista operai attivi
                (disattivato): lo mostriamo comunque come opzione corrente invece di
                farlo sparire in silenzio dalla tendina. */}
            {!assignableUsers.some((u) => u.id === userId) && <option value={userId}>(dipendente attuale)</option>}
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <label htmlFor={`tle-tipo-${timeLog.id}`}>Tipo</label>
          <select id={`tle-tipo-${timeLog.id}`} className="field" value={tipo} onChange={(e) => setTipo(e.target.value as TimeLogTipo)}>
            {TIPI_ORDER.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`tle-ore-${timeLog.id}`}>Ore</label>
              <input
                id={`tle-ore-${timeLog.id}`}
                className="field"
                type="number"
                step="0.25"
                min="0.25"
                value={hoursWorked}
                onChange={(e) => setHoursWorked(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={`tle-data-${timeLog.id}`}>Data</label>
              <input id={`tle-data-${timeLog.id}`} className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy} type="button" onClick={save}>
              {busy ? '…' : 'Salva'}
            </button>
            <button className="btn-ghost" disabled={busy} type="button" onClick={() => setEditing(false)}>
              Annulla
            </button>
          </div>
        </>
      )}
    </div>
  );
}
