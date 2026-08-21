import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken } from '../lib/api';
import type { Project, Task, TimeLog, TimeLogTipo, CreateTimeLogInput, UpdateTimeLogInput } from '../lib/types';
import { badgeClassForTipo, formatHours, PROJECT_STATUS_LABELS } from '../lib/format';
import { CalendarIcon, DocumentIcon, PackageIcon } from '../components/icons';

const TIPI: TimeLogTipo[] = ['ordinario', 'straordinario', 'notturno', 'festivo', 'permesso', 'ferie'];
const ABSENCE_TIPI: TimeLogTipo[] = ['ferie', 'permesso'];
// Storico più profondo del default (20) del backend: serve a coprire per intero il
// riepilogo "ultimi 7 giorni" qui sotto, non solo le ultimissime righe salvate.
const HISTORY_FETCH_LIMIT = 100;
// Max consentito dallo schema di validazione backend (projects.routes.ts): l'operaio
// vede TUTTI i cantieri della sua azienda, non solo i primi 20 (default), altrimenti
// oltre il ventesimo cantiere sparisce dalla tendina di selezione.
const PROJECTS_FETCH_LIMIT = 100;
const RECENT_DAYS = 7;

interface MaterialDraft {
  name: string;
  quantity: string;
  unit: string;
}

// Data in fuso LOCALE, non UTC: toISOString() userebbe UTC, e tra mezzanotte e le
// 1-2 di notte (ora italiana) restituirebbe il giorno PRECEDENTE — rilevante perché
// questa app modella turni notturni fino alle 6 come regola di dominio di prima classe.
function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function lastNDays(n: number): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(isoDate(d));
  }
  return days;
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function isWeekendDay(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00`).getDay();
  return dow === 0 || dow === 6;
}

// Riassume la risposta di POST /time-logs: una singola registrazione "ordinario" può
// diventare 2-3 righe reali per lo split automatico ordinario/notturno/straordinario
// lato server — senza questo messaggio l'operaio vede comparire righe che non ha
// scelto lui e sembra un bug dell'app, non una regola di calcolo.
function summarizeSaved(logs: TimeLog[]): string {
  if (logs.length === 1) {
    return `Salvate ${formatHours(logs[0].hoursWorked)}h (${logs[0].tipo}).`;
  }
  const total = logs.reduce((sum, l) => sum + Number(l.hoursWorked), 0);
  const parts = logs.map((l) => `${formatHours(l.hoursWorked)}h ${l.tipo}`).join(' + ');
  return `Salvate ${formatHours(total)}h → divise automaticamente in ${parts}.`;
}

export default function OperaioPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [myLogs, setMyLogs] = useState<TimeLog[]>([]);
  const [myLogsTotal, setMyLogsTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'registra' | 'storico'>('registra');

  // Form
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tipo, setTipo] = useState<TimeLogTipo>('ordinario');
  const [hours, setHours] = useState('');
  const [startTime, setStartTime] = useState('');
  // Sempre facoltativa, anche con tipo 'ordinario' — solo informativa, non entra nel
  // calcolo delle ore (a differenza di startTime, vedi handleSubmit).
  const [endTime, setEndTime] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const [work, setWork] = useState('');
  const [notes, setNotes] = useState('');
  const [materials, setMaterials] = useState<MaterialDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [repeating, setRepeating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveConfirmation, setSaveConfirmation] = useState<TimeLog[] | null>(null);

  // Stato modifica
  const [editingId, setEditingId] = useState<string | null>(null);

  const navigate = useNavigate();

  // selectDefaultProject: solo al primo caricamento si sceglie un cantiere/lavoro di
  // default. Richiamata anche dopo salvataggio/cancellazione per aggiornare le liste,
  // ma lì NON deve toccare la selezione corrente — prima lo faceva sempre, e dopo ogni
  // salvataggio su un cantiere diverso dal primo la selezione tornava al primo cantiere
  // mentre taskId restava quello vecchio: un mismatch invisibile che faceva sembrare
  // il form rotto al salvataggio successivo (trovato in revisione, mai riprodotto nei
  // miei test perché avevano un solo cantiere).
  async function loadAll(selectDefaultProject = false) {
    setLoading(true);
    setError(null);
    try {
      const [proj, logs] = await Promise.all([
        // Un cantiere chiuso ("completed") non compare qui: il backend rifiuta comunque
        // nuove ore con 409 (timeLogs.service.ts), ma è inutile far scegliere all'operaio
        // un cantiere su cui sa già in partenza che l'inserimento fallirà.
        api.listProjects(1, PROJECTS_FETCH_LIMIT, { status: ['pending', 'in_progress', 'blocked'] }),
        api.listTimeLogs(HISTORY_FETCH_LIMIT),
      ]);
      setProjects(proj.projects);
      setMyLogs(logs.timeLogs);
      setMyLogsTotal(logs.total);
      if (selectDefaultProject) {
        const firstProject = proj.projects[0];
        if (firstProject) {
          setSelectedProjectId(firstProject.id);
          const loadedTasks = await loadTasks(firstProject.id);
          setTaskId(loadedTasks[0]?.id ?? '');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore caricamento');
    } finally {
      setLoading(false);
    }
  }

  async function loadTasks(projectId: string): Promise<Task[]> {
    if (!projectId) {
      setTasks([]);
      return [];
    }
    try {
      const res = await api.listTasks(projectId);
      setTasks(res.tasks);
      return res.tasks;
    } catch {
      setTasks([]);
      return [];
    }
  }

  async function onProjectChange(projectId: string) {
    setSelectedProjectId(projectId);
    setTaskId('');
    const loadedTasks = await loadTasks(projectId);
    if (loadedTasks[0]) setTaskId(loadedTasks[0].id);
  }

  useEffect(() => {
    loadAll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    clearToken();
    navigate('/login', { replace: true });
  }

  // Non tocca cantiere/lavoro selezionati: dopo un salvataggio l'operaio lavora quasi
  // sempre ancora sullo stesso lavoro, e comunque la selezione corrente resta sempre
  // valida (tasks non viene ricaricata da qui, solo da onProjectChange/repeatLast).
  function resetForm() {
    setTipo('ordinario');
    setHours('');
    setStartTime('');
    setEndTime('');
    setDate(isoDate(new Date()));
    setWork('');
    setNotes('');
    setMaterials([]);
    setEditingId(null);
    setFormError(null);
  }

  function startEdit(log: TimeLog) {
    setActiveTab('registra');
    setSaveConfirmation(null);
    setEditingId(log.id);
    setTaskId(log.taskId);
    setTipo(log.tipo);
    setHours(log.hoursWorked);
    setStartTime(log.startTime ? log.startTime.slice(0, 5) : '');
    setEndTime(log.endTime ? log.endTime.slice(0, 5) : '');
    setDate(log.date);
    setWork(log.workDescription ?? '');
    setNotes(log.notes ?? '');
    setMaterials(log.materials.map((m) => ({ name: m.name, quantity: m.quantity, unit: m.unit })));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Ripropone cantiere/lavoro/ora di inizio dell'ultima registrazione (myLogs[0]): in
  // cantiere si lavora spesso giorni di fila sullo stesso lavoro, rifare le stesse
  // scelte ogni volta costa tempo col telefono in mano. Ore/data/lavoro
  // svolto/materiali non vengono toccati (restano quello che l'operaio aveva già
  // scritto, se qualcosa): sono gli unici dati che cambiano ogni giorno. NON ripropone
  // il tipo: myLogs non ha un ordinamento secondario stabile tra righe della stessa
  // data, quindi la riga più recente potrebbe essere una porzione "notturno"/
  // "straordinario" generata dallo split automatico, mai scelta dall'operaio — copiarla
  // spegnerebbe lo split alla registrazione successiva. GET /tasks/:id (accessibile
  // all'operaio, scoped per azienda) dà il projectId direttamente: risolve in una sola
  // chiamata invece di cercare tra i task di ogni cantiere.
  async function repeatLast() {
    const last = myLogs[0];
    if (!last) return;
    setFormError(null);
    setSaveConfirmation(null);
    setRepeating(true);
    try {
      const { task } = await api.getTaskById(last.taskId);
      setSelectedProjectId(task.projectId);
      await loadTasks(task.projectId);
      setTaskId(last.taskId);
      if (last.startTime) setStartTime(last.startTime.slice(0, 5));
      if (last.endTime) setEndTime(last.endTime.slice(0, 5));
      setActiveTab('registra');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Errore nel recupero dell'ultima registrazione");
    } finally {
      setRepeating(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!taskId) return setFormError('Seleziona un cantiere');
    if (!/^\d+(\.\d{1,2})?$/.test(hours) || Number(hours) <= 0)
      return setFormError('Inserisci un numero di ore valido (es. 3.5)');

    const filteredMaterials = materials
      .filter((m) => m.name.trim() && Number(m.quantity) > 0)
      .map((m) => ({ name: m.name.trim(), quantity: m.quantity, unit: m.unit || 'pz' }));

    setSaving(true);
    try {
      if (editingId) {
        // A differenza della creazione, qui `|| null` e non `|| undefined`: questo
        // form rimanda sempre il valore corrente di OGNI campo, quindi un campo
        // svuotato dall'operaio deve dire esplicitamente "cancellalo", non "non l'ho
        // toccato" (che il backend ignorerebbe, lasciando il valore vecchio per
        // sempre — bug trovato in FASE 5: "Ora di fine" non si poteva più svuotare).
        const patch: UpdateTimeLogInput = {
          taskId,
          hoursWorked: hours,
          date,
          tipo,
          startTime: startTime || null,
          endTime: endTime || null,
          workDescription: work || null,
          notes: notes || null,
          materials: filteredMaterials,
        };
        await api.updateTimeLog(editingId, patch);
        setSaveConfirmation(null);
      } else {
        const payload: CreateTimeLogInput = {
          taskId,
          hoursWorked: hours,
          date,
          tipo,
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          workDescription: work || undefined,
          notes: notes || undefined,
          materials: filteredMaterials,
        };
        const res = await api.createTimeLog(payload);
        setSaveConfirmation(res.timeLogs);
      }
      resetForm();
      await loadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Errore salvataggio');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Eliminare questa registrazione?')) return;
    try {
      await api.deleteTimeLog(id);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore eliminazione');
    }
  }

  function addMaterial() {
    setMaterials((m) => [...m, { name: '', quantity: '', unit: 'pz' }]);
  }
  function updateMaterial(i: number, field: keyof MaterialDraft, value: string) {
    setMaterials((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  }
  function removeMaterial(i: number) {
    setMaterials((prev) => prev.filter((_, idx) => idx !== i));
  }

  const selectedTask = tasks.find((t) => t.id === taskId);

  const todayIso = isoDate(new Date());
  // 7 elementi: memoizzare "una volta sola" (deps []) congelava la finestra al mount,
  // disallineandola da todayIso dopo mezzanotte su una PWA tenuta aperta a lungo.
  const last7Days = useMemo(() => lastNDays(RECENT_DAYS), [todayIso]);
  // Ore lavorate separate dalle assenze (ferie/permesso): un giorno di ferie non è un
  // "buco" da segnalare in rosso, ed è coerente con come le stesse ore vengono escluse
  // dal totale "ore lavorate" nell'Archivio Cantieri.
  const { workedByDay, absenceByDay } = useMemo(() => {
    const worked = new Map<string, number>();
    const absence = new Map<string, number>();
    for (const log of myLogs) {
      const target = ABSENCE_TIPI.includes(log.tipo) ? absence : worked;
      target.set(log.date, (target.get(log.date) ?? 0) + Number(log.hoursWorked));
    }
    return { workedByDay: worked, absenceByDay: absence };
  }, [myLogs]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Niente sidebar qui: l'operaio ha un'unica vista, in cantiere da smartphone.
          Una sidebar desktop-style ruberebbe spazio prezioso al form. */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <div>
          <strong className="text-lg font-semibold text-blue-600">WorkFlow360</strong>
          <span className="muted"> · Operaio</span>
        </div>
        <button className="btn-ghost" onClick={logout}>
          Esci
        </button>
      </header>

      <main className="mx-auto max-w-xl p-4 flex flex-col gap-4">
        {error && <div className="alert">{error}</div>}
        {loading && <p className="muted">Caricamento…</p>}

        <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
              activeTab === 'registra' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('registra')}
          >
            Registra ore
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
              activeTab === 'storico' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('storico')}
          >
            Storico ({myLogsTotal})
          </button>
        </div>

        {activeTab === 'registra' && (
          <>
            {saveConfirmation && (
              <div className="alert-success flex items-start justify-between gap-3">
                <span>{summarizeSaved(saveConfirmation)}</span>
                <button type="button" className="btn-ghost px-2" onClick={() => setSaveConfirmation(null)}>
                  ✕
                </button>
              </div>
            )}

            <section className="card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="m-0">{editingId ? 'Modifica registrazione' : 'Registra le tue ore'}</h2>
                {!editingId && myLogs.length > 0 && (
                  <button type="button" className="btn-ghost" disabled={repeating} onClick={repeatLast}>
                    {repeating ? '…' : 'Ripeti ultima registrazione'}
                  </button>
                )}
              </div>
              {formError && <div className="alert">{formError}</div>}
              <form className="inline-form" onSubmit={handleSubmit}>
                <label htmlFor="op-cantiere">Cantiere</label>
                <select id="op-cantiere" className="field" value={selectedProjectId} onChange={(e) => onProjectChange(e.target.value)} required>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <label htmlFor="op-lavoro">Lavoro (task)</label>
                <select id="op-lavoro" className="field" value={taskId} onChange={(e) => setTaskId(e.target.value)} required>
                  {tasks.length === 0 && <option value="">Nessun lavoro per questo cantiere</option>}
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} · {PROJECT_STATUS_LABELS[t.status]}
                    </option>
                  ))}
                </select>
                {selectedTask && (
                  <div className="flex items-start justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                    <span className="text-gray-600">{selectedTask.description ?? 'Nessuna descrizione per questo lavoro.'}</span>
                    <span className={`badge badge-${selectedTask.status} shrink-0`}>{PROJECT_STATUS_LABELS[selectedTask.status]}</span>
                  </div>
                )}

                <label htmlFor="op-tipo">Tipo</label>
                <select id="op-tipo" className="field" value={tipo} onChange={(e) => setTipo(e.target.value as TimeLogTipo)}>
                  {TIPI.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <div className="flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="op-ore">Ore</label>
                    <input
                      id="op-ore"
                      className="field"
                      type="number"
                      step="0.25"
                      min="0.25"
                      placeholder="3.5"
                      value={hours}
                      onChange={(e) => setHours(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex-1">
                    <label htmlFor="op-data">Data</label>
                    <input id="op-data" className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                  </div>
                </div>

                {/* Visibili per qualunque tipo (il backend li accetta sempre, vedi
                    createSchema/updateSchema): prima erano nascosti fuori da
                    'ordinario', ma lo stato React non si svuotava con loro — un
                    orario inserito su 'ordinario' e poi "nascosto" cambiando tipo
                    veniva comunque inviato, e ricompariva come orario fantasma su
                    una riga ferie/permesso nello storico (trovato in FASE 5).
                    Renderli sempre visibili è la correzione: quello che l'operaio
                    vede è sempre quello che verrà salvato, niente più stato invisibile. */}
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="op-ora-inizio">Ora di inizio (opz.)</label>
                    <input
                      id="op-ora-inizio"
                      className="field"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </div>
                  <div className="flex-1">
                    <label htmlFor="op-ora-fine">Ora di fine (opz.)</label>
                    <input
                      id="op-ora-fine"
                      className="field"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                    />
                  </div>
                </div>
                {tipo === 'ordinario' ? (
                  startTime ? (
                    <p className="muted">
                      Le ore tra le 22:00 e le 6:00 diventano automaticamente "notturno"; oltre le 8 ore
                      ordinario nello stesso giorno, il resto diventa automaticamente "straordinario".
                      "Ora di fine" è solo un'informazione in più: il totale ore resta quello scritto sopra.
                    </p>
                  ) : (
                    <p className="muted">
                      Senza ora di inizio le ore notturne e lo straordinario NON vengono riconosciuti
                      automaticamente: tutte le ore restano registrate come "ordinario".
                    </p>
                  )
                ) : (
                  <p className="muted">"Ora di inizio/fine" sono facoltative, solo un'informazione in più sul turno.</p>
                )}

                <label htmlFor="op-lavoro-svolto">Lavoro svolto</label>
                <textarea
                  id="op-lavoro-svolto"
                  className="field"
                  placeholder="Es. Montaggio tubazione rame, saldatura giunti"
                  value={work}
                  onChange={(e) => setWork(e.target.value)}
                  rows={2}
                />

                <label>Materiali usati</label>
                {materials.map((m, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      className="field flex-[2]"
                      placeholder="Nome (es. Tubo rame)"
                      value={m.name}
                      onChange={(e) => updateMaterial(i, 'name', e.target.value)}
                    />
                    <input
                      className="field w-16 flex-1"
                      placeholder="Qtà"
                      type="number"
                      step="0.1"
                      value={m.quantity}
                      onChange={(e) => updateMaterial(i, 'quantity', e.target.value)}
                    />
                    <input
                      className="field w-[70px] flex-1"
                      placeholder="unità"
                      value={m.unit}
                      onChange={(e) => updateMaterial(i, 'unit', e.target.value)}
                    />
                    <button type="button" className="btn-ghost px-2" onClick={() => removeMaterial(i)}>
                      ✕
                    </button>
                  </div>
                ))}
                <button type="button" className="btn-ghost" onClick={addMaterial}>
                  + Aggiungi materiale
                </button>

                <label htmlFor="op-note">Note (opz.)</label>
                <input id="op-note" className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />

                <button className="btn-primary" type="submit" disabled={saving}>
                  {saving ? '…' : editingId ? 'Salva modifica' : 'Salva ore'}
                </button>
                {editingId && (
                  <button type="button" className="btn-ghost" onClick={resetForm}>
                    Annulla
                  </button>
                )}
              </form>
            </section>
          </>
        )}

        {activeTab === 'storico' && (
          <>
            <section className="card">
              <h2>Ultimi {RECENT_DAYS} giorni</h2>
              <ul className="list">
                {last7Days.map((day) => {
                  const worked = workedByDay.get(day) ?? 0;
                  const absence = absenceByDay.get(day) ?? 0;
                  const isToday = day === todayIso;
                  const isWeekend = isWeekendDay(day);
                  // "Buco" solo se non c'è nessuna ora (né lavorata né di assenza), non
                  // è oggi (la giornata non è ancora finita) e non è un weekend (un rosso
                  // che si accende ogni sabato e domenica smette di essere un allarme).
                  const isGap = worked === 0 && absence === 0 && !isToday && !isWeekend;
                  return (
                    <li
                      key={day}
                      className={`list-item flex items-center justify-between ${isGap ? 'border-red-200 bg-red-50' : ''}`}
                    >
                      <span className="flex items-center gap-2 font-medium text-gray-900 capitalize">
                        <CalendarIcon className="h-4 w-4 text-gray-400" />
                        {dayLabel(day)}
                      </span>
                      {worked > 0 && (
                        <span className="text-sm font-semibold text-gray-700">
                          {formatHours(worked)}h{absence > 0 ? ' + ferie/permesso' : ''}
                        </span>
                      )}
                      {worked === 0 && absence > 0 && <span className="text-sm font-medium text-blue-600">Ferie/permesso</span>}
                      {worked === 0 && absence === 0 && isToday && <span className="muted text-sm">Non ancora registrato</span>}
                      {worked === 0 && absence === 0 && !isToday && isWeekend && <span className="muted text-sm">—</span>}
                      {isGap && <span className="text-sm font-medium text-red-600">Nessuna ora registrata</span>}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="card">
              <h2>
                Le mie registrazioni ({myLogs.length}
                {myLogsTotal > myLogs.length ? ` di ${myLogsTotal}` : ''})
              </h2>
              {myLogs.length === 0 && !loading && <p className="muted">Nessuna ora registrata.</p>}
              <ul className="list">
                {myLogs.map((log) => (
                  <li key={log.id} className="list-item flex flex-col items-stretch gap-1.5">
                    <div className="flex justify-between">
                      <strong className="font-medium text-gray-900">
                        {log.date} · {log.hoursWorked}h
                        {log.startTime
                          ? ` (da ${log.startTime.slice(0, 5)}${log.endTime ? ` a ${log.endTime.slice(0, 5)}` : ''})`
                          : ''}
                      </strong>
                      <span className={badgeClassForTipo(log.tipo)}>{log.tipo}</span>
                    </div>
                    {log.workDescription && (
                      <span className="flex items-center gap-1.5 muted">
                        <DocumentIcon className="h-4 w-4" /> {log.workDescription}
                      </span>
                    )}
                    {log.materials.length > 0 && (
                      <span className="flex items-center gap-1.5 muted">
                        <PackageIcon className="h-4 w-4" />{' '}
                        {log.materials.map((m) => `${m.name} ${m.quantity}${m.unit}`).join(', ')}
                      </span>
                    )}
                    <div className="mt-1 flex gap-2">
                      <button className="btn-ghost" onClick={() => startEdit(log)}>
                        Modifica
                      </button>
                      <button className="btn-danger" onClick={() => handleDelete(log.id)}>
                        Elimina
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
