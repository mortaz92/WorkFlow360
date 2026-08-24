import { useState } from 'react';
import { api } from '../lib/api';
import type { AssignableUser, Project, Task, TimeLogTipo } from '../lib/types';
import { TIPI_ORDER } from '../lib/format';
import { Button, Input, Select, type SelectOption } from './ui';

// Stessa classe di riquadro-errore usata nelle pagine già migrate al design system:
// ricopiata e non estratta in un modulo condiviso finché la migrazione delle altre
// pagine è in corso in parallelo (va consolidata in un unico passaggio, alla fine).
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

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
      <Button type="button" variant="ghost" size="sm" onClick={open}>
        Modifica
      </Button>
    );
  }

  const opzioniCantieri: SelectOption[] = projects.map((p) => ({ value: p.id, label: p.name }));

  // Cantiere senza lavori: unica voce della tendina (com'era prima), non un'opzione
  // aggiuntiva davanti a una lista piena.
  const opzioniLavori: SelectOption[] =
    tasks.length === 0
      ? [{ value: '', label: 'Nessun lavoro per questo cantiere' }]
      : tasks.map((t) => ({ value: t.id, label: t.title }));

  // Il dipendente attuale potrebbe non essere più nella lista operai attivi
  // (disattivato): lo mostriamo comunque come opzione corrente invece di farlo
  // sparire in silenzio dalla tendina.
  const opzioniDipendenti: SelectOption[] = [
    ...(assignableUsers.some((u) => u.id === userId) ? [] : [{ value: userId, label: '(dipendente attuale)' }]),
    ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
  ];

  const opzioniTipo: SelectOption[] = TIPI_ORDER.map((t) => ({ value: t, label: t }));

  return (
    <div className="mt-4 flex w-full flex-col gap-3 border-t border-surface-200 pt-4 dark:border-surface-700">
      <h3 className="m-0 text-sm font-semibold text-surface-900 dark:text-surface-100">Correggi registrazione</h3>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      {loadingOptions ? (
        <p className="text-sm text-surface-500 dark:text-surface-400">Caricamento opzioni…</p>
      ) : (
        <>
          <Select
            id={`tle-cantiere-${timeLog.id}`}
            label="Cantiere"
            options={opzioniCantieri}
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
          />
          <Select
            id={`tle-lavoro-${timeLog.id}`}
            label="Lavoro"
            options={opzioniLavori}
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
          />
          <Select
            id={`tle-dipendente-${timeLog.id}`}
            label="Dipendente"
            options={opzioniDipendenti}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <Select
            id={`tle-tipo-${timeLog.id}`}
            label="Tipo"
            options={opzioniTipo}
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TimeLogTipo)}
          />
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                id={`tle-ore-${timeLog.id}`}
                label="Ore"
                type="number"
                step="0.25"
                min="0.25"
                value={hoursWorked}
                onChange={(e) => setHoursWorked(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <Input
                id={`tle-data-${timeLog.id}`}
                label="Data"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="primary" loading={busy} onClick={save}>
              Salva
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Annulla
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
