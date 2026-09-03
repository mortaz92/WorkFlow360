import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, clearToken } from '../lib/api';
import type {
  Project,
  Task,
  TimeLog,
  TimeLogTipo,
  CreateTimeLogInput,
  UpdateTimeLogInput,
} from '../lib/types';
import { badgeClassForTipo, formatHours, formatQuantita, PROJECT_STATUS_LABELS } from '../lib/format';
import {
  CalendarIcon,
  CheckCircleIcon,
  ClockIcon,
  DocumentIcon,
  GearIcon,
  LogoutIcon,
  PackageIcon,
  XIcon,
} from '../components/icons';
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
  Textarea,
  type SelectOption,
} from '../components/ui';

const TIPI: TimeLogTipo[] = ['ordinario', 'straordinario', 'notturno', 'festivo', 'permesso', 'ferie'];
// Un rapportino esiste solo per cantieri "a consuntivo" (il backend rifiuta comunque la
// creazione per gli altri, rapportini.service.ts): la tendina di questa scheda mostra
// solo quelli, coerente con la stessa distinzione già fatta altrove nell'app
// (etichettaCantiere/formatProjectId trattano i due tipi diversamente).
const TIPO_COMMESSA_RAPPORTINO = 'consuntivo';
const ABSENCE_TIPI: TimeLogTipo[] = ['ferie', 'permesso'];
// Storico più profondo del default (20) del backend: serve a coprire per intero il
// riepilogo "ultimi 7 giorni" qui sotto, non solo le ultimissime righe salvate.
const HISTORY_FETCH_LIMIT = 100;
// Max consentito dallo schema di validazione backend (projects.routes.ts): l'operaio
// vede TUTTI i cantieri della sua azienda, non solo i primi 20 (default), altrimenti
// oltre il ventesimo cantiere sparisce dalla tendina di selezione.
const PROJECTS_FETCH_LIMIT = 100;
const RECENT_DAYS = 7;

// Le stesse opzioni di TIPI, nella forma richiesta dal <Select> del design system:
// costruite una volta sola a livello di modulo perché l'elenco è fisso e non dipende
// dallo stato (a differenza di cantieri e lavori, che arrivano dal server).
const TIPO_OPTIONS: SelectOption[] = TIPI.map((t) => ({ value: t, label: t }));

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni riquadro. Stessi valori usati in DashboardPage: le due pagine devono restare
// visivamente coerenti anche se le apre lo stesso utente su schermi diversi.
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const ALERT_SUCCESSO =
  'rounded-lg border border-success-200 bg-success-50 px-3 py-2.5 text-sm font-medium text-success-700 dark:border-success-800 dark:bg-success-900/30 dark:text-success-300';

const ELENCO = 'm-0 flex list-none flex-col gap-2 p-0';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 transition-shadow hover:shadow-card dark:border-surface-700 dark:bg-surface-800';

// Variante della riga per un giorno senza ore: NON si aggiunge sopra RIGA_ELENCO, si
// sostituisce. Sovrapporre bg-danger-50 a bg-white lascerebbe decidere il colore
// all'ordine con cui Tailwind genera le due utility, non all'ordine in cui le scrivo.
const RIGA_ELENCO_BUCO =
  'rounded-lg border border-danger-200 bg-danger-50 p-3 dark:border-danger-800 dark:bg-danger-900/20';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

// Stessa etichetta che Input/Select/Textarea disegnano al loro interno: serve per i
// gruppi di campi che non hanno un singolo input a cui agganciarsi (i materiali).
const ETICHETTA_CAMPO = 'block text-sm font-medium text-surface-700 dark:text-surface-300';

interface MaterialDraft {
  name: string;
  quantity: string;
  unit: string;
  // Codice articolo, facoltativo. Stringa vuota e non `null` finché sta nel form: è il
  // valore che un <input> restituisce davvero quando è vuoto — la conversione a null
  // avviene una volta sola, al momento dell'invio (vedi filteredMaterials).
  code: string;
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
  const [activeTab, setActiveTab] = useState<'registra' | 'storico' | 'rapportino'>('registra');

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
  const location = useLocation();
  // Messaggio "di ritorno" da FirmaPage dopo "Il cliente non firma" (navigate con
  // state, mai persistito): letto una sola volta all'apertura, non riappare se la
  // pagina viene ricaricata (location.state non sopravvive a un refresh).
  const [infoMessage, setInfoMessage] = useState<string | null>(
    (location.state as { rapportinoAnnullato?: boolean } | null)?.rapportinoAnnullato
      ? 'Rapportino annullato: il cliente non ha firmato.'
      : null,
  );

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
    setMaterials(
      log.materials.map((m) => ({ name: m.name, quantity: m.quantity, unit: m.unit, code: m.code ?? '' })),
    );
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

    // `code: ... || null` e non `|| undefined`: un codice cancellato dall'operaio deve
    // dire "toglilo", e in modifica i materiali sono un replace dell'intera lista — un
    // undefined lascerebbe la riga senza codice comunque, ma passare null lo dichiara
    // invece di lasciarlo dedurre.
    const filteredMaterials = materials
      .filter((m) => m.name.trim() && Number(m.quantity) > 0)
      .map((m) => ({ name: m.name.trim(), quantity: m.quantity, unit: m.unit || 'pz', code: m.code.trim() || null }));

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
    setMaterials((m) => [...m, { name: '', quantity: '', unit: 'pz', code: '' }]);
  }
  function updateMaterial(i: number, field: keyof MaterialDraft, value: string) {
    setMaterials((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  }
  function removeMaterial(i: number) {
    setMaterials((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Cantieri "a consuntivo": unico tipo per cui esiste un rapportino, passati così com'è
  // al componente condiviso PreparaRapportino (che qui mostra una tendina di scelta —
  // in CantiereDetailPage il cantiere è già noto, niente tendina).
  const consuntivoProjects = useMemo(
    () => projects.filter((p) => p.tipoCommessa === TIPO_COMMESSA_RAPPORTINO),
    [projects],
  );

  const selectedTask = tasks.find((t) => t.id === taskId);

  // Le liste delle tendine nella forma attesa dal <Select> del design system: stessi
  // valori e stesse etichette di prima, solo passati come dato invece che come <option>.
  const projectOptions: SelectOption[] = projects.map((p) => ({ value: p.id, label: p.name }));
  const taskOptions: SelectOption[] =
    tasks.length === 0
      ? [{ value: '', label: 'Nessun lavoro per questo cantiere' }]
      : tasks.map((t) => ({ value: t.id, label: `${t.title} · ${PROJECT_STATUS_LABELS[t.status]}` }));

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
    <div className="min-h-screen bg-surface-50 dark:bg-surface-950">
      {/* Niente sidebar qui: l'operaio ha un'unica vista, in cantiere da smartphone.
          Una sidebar desktop-style ruberebbe spazio prezioso al form. */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-surface-200 bg-white px-4 py-3 dark:border-surface-700 dark:bg-surface-900">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-white">
            <GearIcon className="h-5 w-5" />
          </span>
          <strong className="truncate text-lg font-semibold text-surface-900 dark:text-white">WorkFlow360</strong>
          <span className={`${TESTO_ATTENUATO} shrink-0`}>· Operaio</span>
        </div>
        <Button variant="ghost" onClick={logout} leftIcon={<LogoutIcon className="h-4 w-4" />}>
          Esci
        </Button>
      </header>

      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
        {infoMessage && (
          <div className={`${ALERT_SUCCESSO} flex items-start justify-between gap-3`} role="status">
            <span>{infoMessage}</span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => setInfoMessage(null)}
              aria-label="Chiudi il messaggio"
            >
              <XIcon />
            </Button>
          </div>
        )}
        {error && (
          <div className={ALERT_ERRORE} role="alert">
            {error}
          </div>
        )}
        {loading && <p className={TESTO_ATTENUATO}>Caricamento…</p>}

        <div className="flex gap-1 rounded-xl bg-surface-100 p-1 dark:bg-surface-800">
          <button
            type="button"
            className={`flex-1 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'registra'
                ? 'bg-white text-surface-900 shadow-card dark:bg-surface-700 dark:text-white'
                : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
            }`}
            onClick={() => setActiveTab('registra')}
          >
            Registra ore
          </button>
          <button
            type="button"
            className={`flex-1 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'storico'
                ? 'bg-white text-surface-900 shadow-card dark:bg-surface-700 dark:text-white'
                : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
            }`}
            onClick={() => setActiveTab('storico')}
          >
            Storico ({myLogsTotal})
          </button>
          <button
            type="button"
            className={`flex-1 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'rapportino'
                ? 'bg-white text-surface-900 shadow-card dark:bg-surface-700 dark:text-white'
                : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
            }`}
            onClick={() => setActiveTab('rapportino')}
          >
            Rapportino cliente
          </button>
        </div>

        {activeTab === 'registra' && (
          <>
            {saveConfirmation && (
              <div className={`${ALERT_SUCCESSO} flex items-start justify-between gap-3`} role="status">
                <span className="flex items-start gap-2">
                  <CheckCircleIcon className="h-5 w-5 shrink-0" />
                  {summarizeSaved(saveConfirmation)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setSaveConfirmation(null)}
                  aria-label="Chiudi la conferma di salvataggio"
                >
                  <XIcon />
                </Button>
              </div>
            )}

            <Card>
              <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{editingId ? 'Modifica registrazione' : 'Registra le tue ore'}</CardTitle>
                {!editingId && myLogs.length > 0 && (
                  <Button variant="ghost" size="sm" loading={repeating} onClick={repeatLast}>
                    Ripeti ultima registrazione
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {formError && (
                  <div className={`${ALERT_ERRORE} mb-4`} role="alert">
                    {formError}
                  </div>
                )}
                <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                  <Select
                    id="op-cantiere"
                    label="Cantiere"
                    size="lg"
                    options={projectOptions}
                    value={selectedProjectId}
                    onChange={(e) => onProjectChange(e.target.value)}
                    required
                  />

                  {/* Tendina e descrizione del lavoro selezionato stanno in un gruppo
                      con spaziatura più stretta del resto del form: sono la stessa
                      informazione, il riquadro descrive la voce appena scelta sopra. */}
                  <div className="flex flex-col gap-2">
                    <Select
                      id="op-lavoro"
                      label="Lavoro (task)"
                      size="lg"
                      options={taskOptions}
                      value={taskId}
                      onChange={(e) => setTaskId(e.target.value)}
                      required
                    />
                    {selectedTask && (
                      <div className="flex items-start justify-between gap-2 rounded-lg border border-surface-200 bg-surface-50 p-3 text-sm dark:border-surface-700 dark:bg-surface-900/50">
                        <span className="text-surface-600 dark:text-surface-400">
                          {selectedTask.description ?? 'Nessuna descrizione per questo lavoro.'}
                        </span>
                        <span className={`badge badge-${selectedTask.status} shrink-0`}>{PROJECT_STATUS_LABELS[selectedTask.status]}</span>
                      </div>
                    )}
                  </div>

                  <Select
                    id="op-tipo"
                    label="Tipo"
                    size="lg"
                    options={TIPO_OPTIONS}
                    value={tipo}
                    onChange={(e) => setTipo(e.target.value as TimeLogTipo)}
                  />

                  <div className="flex gap-3">
                    <div className="flex-1">
                      <Input
                        id="op-ore"
                        label="Ore"
                        size="lg"
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
                      {/* dark:[color-scheme:dark]: senza, l'icona del calendario/orologio
                          disegnata dal browser resta nera su fondo scuro, quasi invisibile.
                          Vale per tutti e tre i campi date/time di questo form. */}
                      <Input
                        id="op-data"
                        label="Data"
                        size="lg"
                        type="date"
                        className="dark:[color-scheme:dark]"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        required
                      />
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
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <Input
                          id="op-ora-inizio"
                          label="Ora di inizio (opz.)"
                          size="lg"
                          type="time"
                          className="dark:[color-scheme:dark]"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                        />
                      </div>
                      <div className="flex-1">
                        <Input
                          id="op-ora-fine"
                          label="Ora di fine (opz.)"
                          size="lg"
                          type="time"
                          className="dark:[color-scheme:dark]"
                          value={endTime}
                          onChange={(e) => setEndTime(e.target.value)}
                        />
                      </div>
                    </div>
                    {tipo === 'ordinario' ? (
                      startTime ? (
                        <p className={TESTO_ATTENUATO}>
                          Le ore tra le 22:00 e le 6:00 diventano automaticamente "notturno"; oltre le 8 ore
                          ordinario nello stesso giorno, il resto diventa automaticamente "straordinario".
                          "Ora di fine" è solo un'informazione in più: il totale ore resta quello scritto sopra.
                        </p>
                      ) : (
                        <p className={TESTO_ATTENUATO}>
                          Senza ora di inizio le ore notturne e lo straordinario NON vengono riconosciuti
                          automaticamente: tutte le ore restano registrate come "ordinario".
                        </p>
                      )
                    ) : (
                      <p className={TESTO_ATTENUATO}>
                        "Ora di inizio/fine" sono facoltative, solo un'informazione in più sul turno.
                      </p>
                    )}
                  </div>

                  <Textarea
                    id="op-lavoro-svolto"
                    label="Lavoro svolto"
                    size="lg"
                    placeholder="Es. Montaggio tubazione rame, saldatura giunti"
                    value={work}
                    onChange={(e) => setWork(e.target.value)}
                    rows={2}
                  />

                  <div className="flex flex-col gap-2">
                    {/* Etichetta del gruppo, non di un singolo campo: ogni materiale è
                        una riga da tre campi, e ciascuno ha la propria aria-label. Un
                        <label> senza campo a cui agganciarsi non descriverebbe niente. */}
                    <span className={ETICHETTA_CAMPO}>Materiali usati</span>
                    {/* DUE righe sul telefono, una sola da tablet in su. Il codice è il
                        quarto campo del materiale: infilarlo nella riga da tre di prima
                        avrebbe lasciato quattro campi da ~70px su uno schermo da 360, cioè
                        quattro caselle in cui non si legge quello che si scrive. Il riquadro
                        chiaro attorno a ogni materiale serve solo sul telefono: con due
                        righe per materiale, senza, non si capisce dove finisce uno e comincia
                        il successivo. */}
                    {materials.map((m, i) => (
                      <div
                        key={i}
                        className="flex flex-col gap-1.5 rounded-lg border border-surface-200 p-2 dark:border-surface-700 sm:flex-row sm:items-center sm:border-0 sm:p-0"
                      >
                        <div className="flex items-center gap-1.5 sm:flex-[3]">
                          <div className="flex-1">
                            <Input
                              aria-label={`Nome del materiale ${i + 1}`}
                              size="lg"
                              placeholder="Nome (es. Tubo rame)"
                              value={m.name}
                              onChange={(e) => updateMaterial(i, 'name', e.target.value)}
                            />
                          </div>
                          {/* maxLength allineato al tetto dello schema Zod del backend
                              (materialSchema.code, 50). */}
                          <div className="w-28 shrink-0">
                            <Input
                              aria-label={`Codice del materiale ${i + 1}`}
                              size="lg"
                              placeholder="Codice"
                              maxLength={50}
                              value={m.code}
                              onChange={(e) => updateMaterial(i, 'code', e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 sm:flex-[2]">
                          <div className="flex-1">
                            <Input
                              aria-label={`Quantità del materiale ${i + 1}`}
                              size="lg"
                              placeholder="Qtà"
                              type="number"
                              step="0.1"
                              value={m.quantity}
                              onChange={(e) => updateMaterial(i, 'quantity', e.target.value)}
                            />
                          </div>
                          <div className="flex-1">
                            <Input
                              aria-label={`Unità di misura del materiale ${i + 1}`}
                              size="lg"
                              placeholder="unità"
                              value={m.unit}
                              onChange={(e) => updateMaterial(i, 'unit', e.target.value)}
                            />
                          </div>
                          <Button
                            variant="ghost"
                            className="shrink-0"
                            onClick={() => removeMaterial(i)}
                            aria-label={`Rimuovi il materiale ${i + 1}`}
                          >
                            <XIcon className="h-5 w-5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button variant="ghost" onClick={addMaterial}>
                      + Aggiungi materiale
                    </Button>
                  </div>

                  <Input
                    id="op-note"
                    label="Note (opz.)"
                    size="lg"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />

                  {/* Bottoni impilati sul telefono e affiancati da tablet in su: in
                      cantiere si usa una mano sola, il bersaglio deve essere largo
                      quanto lo schermo. */}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="submit" variant="primary" size="lg" fullWidth loading={saving}>
                      {editingId ? 'Salva modifica' : 'Salva ore'}
                    </Button>
                    {editingId && (
                      <Button type="button" variant="ghost" size="lg" fullWidth onClick={resetForm}>
                        Annulla
                      </Button>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>
          </>
        )}

        {activeTab === 'storico' && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Ultimi {RECENT_DAYS} giorni</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className={ELENCO}>
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
                        className={`${isGap ? RIGA_ELENCO_BUCO : RIGA_ELENCO} flex items-center justify-between gap-2`}
                      >
                        <span className="flex items-center gap-2 font-medium capitalize text-surface-900 dark:text-surface-100">
                          <CalendarIcon className="h-4 w-4 text-surface-400 dark:text-surface-500" />
                          {dayLabel(day)}
                        </span>
                        {worked > 0 && (
                          <span className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                            {formatHours(worked)}h{absence > 0 ? ' + ferie/permesso' : ''}
                          </span>
                        )}
                        {worked === 0 && absence > 0 && (
                          <span className="text-sm font-medium text-primary-600 dark:text-primary-400">Ferie/permesso</span>
                        )}
                        {worked === 0 && absence === 0 && isToday && (
                          <span className={TESTO_ATTENUATO}>Non ancora registrato</span>
                        )}
                        {worked === 0 && absence === 0 && !isToday && isWeekend && (
                          <span className={TESTO_ATTENUATO}>—</span>
                        )}
                        {isGap && (
                          <span className="text-sm font-medium text-danger-600 dark:text-danger-400">
                            Nessuna ora registrata
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  Le mie registrazioni ({myLogs.length}
                  {myLogsTotal > myLogs.length ? ` di ${myLogsTotal}` : ''})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {myLogs.length === 0 && !loading && (
                  <EmptyState title="Nessuna ora registrata" icon={<ClockIcon className="h-10 w-10" />} />
                )}
                <ul className={ELENCO}>
                  {myLogs.map((log) => (
                    <li key={log.id} className={`${RIGA_ELENCO} flex flex-col items-stretch gap-1.5`}>
                      <div className="flex justify-between gap-2">
                        <strong className="font-medium text-surface-900 dark:text-surface-100">
                          {log.date} · {log.hoursWorked}h
                          {log.startTime
                            ? ` (da ${log.startTime.slice(0, 5)}${log.endTime ? ` a ${log.endTime.slice(0, 5)}` : ''})`
                            : ''}
                        </strong>
                        <span className={badgeClassForTipo(log.tipo)}>{log.tipo}</span>
                      </div>
                      {log.workDescription && (
                        <span className={`flex items-center gap-1.5 ${TESTO_ATTENUATO}`}>
                          <DocumentIcon className="h-4 w-4" /> {log.workDescription}
                        </span>
                      )}
                      {log.materials.length > 0 && (
                        <span className={`flex items-center gap-1.5 ${TESTO_ATTENUATO}`}>
                          <PackageIcon className="h-4 w-4" />{' '}
                          {/* Il codice compare fra parentesi solo dove c'è: è l'unico punto
                              in cui l'operaio può rileggere quello che ha scritto senza
                              riaprire la registrazione in modifica. */}
                          {/* formatQuantita: `quantity` arriva grezza dall'API, cioè
                              "12.000" per dodici metri — che in italiano si legge
                              "dodicimila". Qui è dove l'operaio rilegge quello che ha
                              appena scritto, quindi è anche dove se ne accorgerebbe. */}
                          {log.materials
                            .map((m) => `${m.name}${m.code ? ` (${m.code})` : ''} ${formatQuantita(m.quantity)}${m.unit}`)
                            .join(', ')}
                        </span>
                      )}
                      <div className="mt-1 flex gap-2">
                        <Button variant="ghost" onClick={() => startEdit(log)}>
                          Modifica
                        </Button>
                        <Button variant="danger" onClick={() => handleDelete(log.id)}>
                          Elimina
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </>
        )}

        {activeTab === 'rapportino' && <PreparaRapportino projects={consuntivoProjects} returnTo="/operaio" />}
      </main>
    </div>
  );
}
