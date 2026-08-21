// Raggruppamento delle registrazioni ore per la Cronologia ore (dettaglio dipendente):
// stessa data + stesso lavoro (taskId determina già il cantiere, non serve una chiave
// composta più larga) diventano UN gruppo visivo con i tipi affiancati invece di righe
// separate una sotto l'altra — richiesto esplicitamente dall'utente il 19/08.
import type { ProjectTimelineEntry, ProjectTipoCommessa, TimeLogTipo, UserTimeLogRow } from './types';

export interface TimeLogGroup {
  date: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectNumber: number;
  code: string | null;
  tipoCommessa: ProjectTipoCommessa;
  projectName: string;
  // Le registrazioni originali che compongono il gruppo: mai perse, servono al
  // pulsante "Modifica" per singola riga (un gruppo non ha "la" registrazione da
  // correggere, solo le righe che lo compongono).
  entries: UserTimeLogRow[];
  hoursByTipo: Partial<Record<TimeLogTipo, string>>;
  totalHours: string;
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// Un gruppo NON è "una riga per tipo": nello stesso giorno, sullo stesso lavoro,
// possono esistere due righe con lo STESSO tipo (es. 4h ordinario la mattina + 4h
// ordinario il pomeriggio, registrate separatamente) — le ore si SOMMANO.
// Preserva l'ordine di arrivo (il backend restituisce già date desc, senza tie-break):
// una Map itera nell'ordine di prima comparsa della coppia data+lavoro, quindi i
// gruppi restano ordinati come le righe originali senza bisogno di riordinarli qui.
export function groupTimeLogsByDayAndTask(rows: UserTimeLogRow[]): TimeLogGroup[] {
  const groups = new Map<string, TimeLogGroup>();
  for (const row of rows) {
    const key = `${row.date}|${row.taskId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        date: row.date,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        projectId: row.projectId,
        projectNumber: row.projectNumber,
        code: row.code,
        tipoCommessa: row.tipoCommessa,
        projectName: row.projectName,
        entries: [],
        hoursByTipo: {},
        totalHours: '0.00',
      };
      groups.set(key, group);
    }
    group.entries.push(row);
    const prevTipoHours = Number(group.hoursByTipo[row.tipo] ?? '0');
    group.hoursByTipo[row.tipo] = round2(prevTipoHours + Number(row.hoursWorked));
  }
  for (const group of groups.values()) {
    const total = group.entries.reduce((sum, e) => sum + Number(e.hoursWorked), 0);
    group.totalHours = round2(total);
  }
  return Array.from(groups.values());
}

export interface TimelineGroup {
  date: string;
  userId: string;
  userName: string;
  taskId: string;
  taskTitle: string;
  entries: ProjectTimelineEntry[];
  hoursByTipo: Partial<Record<TimeLogTipo, string>>;
  totalHours: string;
  materials: { name: string; quantity: string; unit: string }[];
}

// Stessa logica di groupTimeLogsByDayAndTask sopra, ma per il Registro cronologico di UN
// cantiere (RegistroCantiere): lì, a differenza della Cronologia ore di un dipendente,
// possono comparire PIÙ dipendenti sullo stesso lavoro — la chiave di raggruppamento
// include quindi anche userId, non solo data+lavoro (altrimenti le ore di due operai
// diversi nello stesso giorno sullo stesso lavoro finirebbero mescolate in un unico
// gruppo, perdendo di vista chi ha fatto cosa). Funzione separata (non generica sulle
// due forme di riga) perché UserTimeLogRow e ProjectTimelineEntry hanno campi diversi
// (materiali qui, dati di progetto là) e i punti reali di riuso sono ancora solo 2 — sotto
// la soglia di 3 casi che il progetto richiede prima di forzare un'astrazione comune.
export function groupTimelineByDayUserTask(rows: ProjectTimelineEntry[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const row of rows) {
    const key = `${row.date}|${row.userId}|${row.taskId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        date: row.date,
        userId: row.userId,
        userName: row.userName,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        entries: [],
        hoursByTipo: {},
        totalHours: '0.00',
        materials: [],
      };
      groups.set(key, group);
    }
    group.entries.push(row);
    const prevTipoHours = Number(group.hoursByTipo[row.tipo] ?? '0');
    group.hoursByTipo[row.tipo] = round2(prevTipoHours + Number(row.hoursWorked));
    if (row.materials.length > 0) group.materials.push(...row.materials);
  }
  for (const group of groups.values()) {
    const total = group.entries.reduce((sum, e) => sum + Number(e.hoursWorked), 0);
    group.totalHours = round2(total);
  }
  return Array.from(groups.values());
}
