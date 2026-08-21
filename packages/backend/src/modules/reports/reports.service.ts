import { sql, eq, ne, and, or, desc, gte, lte, lt, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../core/db';
import { timeLogs, projects, users, tasks, timeLogMaterials } from '../../core/db/schema';
import { NotFoundError } from '../../core/errors';

// Archiviazione ore (decisa con l'utente, 10/08): un'ora registrata esce dal Report
// attivo e finisce nell'Archivio quando succede UNA delle due cose:
//  1) sono passati più di 15 giorni dalla fine del mese a cui appartiene la sua data
//     (finestra di correzione chiusa), oppure
//  2) il cantiere a cui appartiene è stato chiuso ("completed") — un cantiere finito
//     non deve più comparire tra le ore "in corso", indipendentemente da quando sono
//     state registrate.
// Nessun job schedulato: è una proprietà CALCOLATA a ogni lettura (data corrente vs
// data del log), non un flag salvato — non serve un cron che "chiuda" nulla di notte,
// e non c'è mai un disallineamento tra "quando è girato il job" e "cosa mostra la UI".
const ARCHIVE_GRACE_DAYS = 15;

// Il mese più vecchio ancora "aperto" è quello in cui cade (oggi - 15 giorni): la sua
// fine mese, per costruzione, non può essere trascorsa da più di 15 giorni. Tutto ciò
// che è STRETTAMENTE PRIMA del primo giorno di quel mese è quindi già archiviato.
// Esempio: oggi 20 settembre -> cutoff (oggi-15gg) = 5 settembre -> soglia = 1 settembre
// -> agosto (fine 31/8 + 15gg = 15/9, già passato) risulta archiviato, settembre no.
function computeArchiveCutoffISO(now: Date = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ARCHIVE_GRACE_DAYS);
  const y = cutoff.getFullYear();
  const m = cutoff.getMonth(); // 0-based
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// Subquery: id di tutti i task che appartengono a un cantiere chiuso di questa azienda.
// Usata per marcare come "archiviate" le ore di un cantiere completato, a prescindere
// dalla data — vive qui (non in tasks.service.ts) perché è specifica del calcolo report.
function completedTaskIdsSubquery(companyId: string) {
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(projects.companyId, companyId), eq(projects.status, 'completed')));
}

// Periodo opzionale (estremi inclusi, formato YYYY-MM-DD) applicato a tutte le query
// aggregate di questo modulo. Assente = tutto lo storico (comportamento invariato,
// nessuna rottura per i chiamanti esistenti che non lo passano).
export interface DateRange {
  from: string;
  to: string;
}

export interface HoursByProjectRow {
  projectId: string;
  projectNumber: number;
  code: string | null;
  tipoCommessa: string;
  projectName: string;
  totalHours: string; // numeric -> stringa
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

export interface HoursByUserRow {
  userId: string;
  userName: string;
  userEmail: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

// Tipizzato sql<string> (non l'`unknown` di prima): l'annotazione esplicita ": unknown"
// che questa funzione aveva cancellava il tipo più preciso che sql<string> produce già
// da solo, e quell'unknown si propagava a ogni .select({...}) che la usava — la causa
// esatta dell'errore "reports.service.ts, tipi unknown" già noto e documentato in
// session.md prima di questa sessione. Corretto qui perché questa stessa funzione
// viene ora riusata in una terza query (getProjectDetail).
function sumByTipo(tipo: string) {
  return sql<string>`coalesce(sum(case when ${timeLogs.tipo} = ${tipo} then ${timeLogs.hoursWorked}::numeric else 0 end), 0)::text`;
}

// Report 1: ore raggruppate per commessa (con breakdown per tipo).
// timeLogs -> tasks (sul taskId) -> projects (sul projectId). INNER JOIN: un cantiere
// senza ore nel periodo scelto semplicemente non compare (rumore in meno, a differenza
// di getHoursByUser sotto dove un dipendente a zero ore DEVE comparire lo stesso).
export async function getHoursByProject(companyId: string, range?: DateRange, opts?: { archived?: boolean }): Promise<HoursByProjectRow[]> {
  const archived = opts?.archived ?? false;
  const conditions = [eq(timeLogs.companyId, companyId)];
  if (range) {
    conditions.push(gte(timeLogs.date, range.from), lte(timeLogs.date, range.to));
  }
  // INNER JOIN già presente verso projects (sotto): qui la condizione può stare
  // direttamente in WHERE senza il problema del LEFT JOIN che affligge getHoursByUser.
  const cutoff = computeArchiveCutoffISO();
  conditions.push(
    archived
      ? or(eq(projects.status, 'completed'), lt(timeLogs.date, cutoff))!
      : and(ne(projects.status, 'completed'), gte(timeLogs.date, cutoff))!,
  );
  const rows = await db
    .select({
      projectId: projects.id,
      projectNumber: projects.projectNumber,
      code: projects.code,
      tipoCommessa: projects.tipoCommessa,
      projectName: projects.name,
      totalHours: sql<string>`coalesce(sum(${timeLogs.hoursWorked}::numeric), 0)::text`,
      ordinary: sumByTipo('ordinario'),
      straordinario: sumByTipo('straordinario'),
      notturno: sumByTipo('notturno'),
      festivo: sumByTipo('festivo'),
      permesso: sumByTipo('permesso'),
      ferie: sumByTipo('ferie'),
      logCount: sql<number>`count(${timeLogs.id})::int`,
    })
    .from(timeLogs)
    .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...conditions))
    .groupBy(projects.id, projects.projectNumber, projects.code, projects.tipoCommessa, projects.name)
    .orderBy(projects.name);
  return rows;
}

export interface ProjectMaterialSummaryRow {
  name: string;
  unit: string;
  totalQuantity: string; // numeric -> stringa
}

// Stessa forma di riga di HoursByUserRow (meno userEmail, non pertinente qui): permette
// al frontend di riusare lo stesso componente tabella (TabellaOre) senza mappature ad hoc.
export interface ProjectEmployeeRow {
  userId: string;
  userName: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

export interface ProjectDetail {
  id: string;
  projectNumber: number;
  code: string | null;
  name: string;
  status: string;
  tipoCommessa: string;
  createdAt: Date;
  // Derivato da employees.length: prima era una query count(distinct) separata, ora
  // è ridondante con l'array che il frontend riceve comunque — tenuto per non rompere
  // chi legge già questo campo (test esistenti inclusi), ma è sempre employees.length.
  employeeCount: number;
  employees: ProjectEmployeeRow[];
  totalHours: string;
  materials: ProjectMaterialSummaryRow[];
}

// Vista di dettaglio di UN cantiere: stato + ore per singolo dipendente coinvolto (non
// solo un conteggio) + materiale totale usato. Le query sono indipendenti (nessuna
// dipende dal risultato delle altre) quindi partono in parallelo.
export async function getProjectDetail(projectId: string, companyId: string, range?: DateRange): Promise<ProjectDetail> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) {
    throw new NotFoundError('Cantiere non trovato');
  }

  const employeeConditions = [eq(tasks.projectId, projectId), eq(timeLogs.companyId, companyId)];
  if (range) {
    employeeConditions.push(gte(timeLogs.date, range.from), lte(timeLogs.date, range.to));
  }

  const [employeeRows, materialRows] = await Promise.all([
    // INNER JOIN, non LEFT JOIN da users come in getHoursByUser: qui la domanda è "chi
    // ha lavorato in QUESTO cantiere", non "tutti i dipendenti dell'azienda" — un LEFT
    // JOIN da users elencherebbe l'intera azienda a zero su ogni singolo cantiere.
    db
      .select({
        userId: users.id,
        userName: users.name,
        totalHours: sql<string>`coalesce(sum(${timeLogs.hoursWorked}::numeric), 0)::text`,
        ordinary: sumByTipo('ordinario'),
        straordinario: sumByTipo('straordinario'),
        notturno: sumByTipo('notturno'),
        festivo: sumByTipo('festivo'),
        permesso: sumByTipo('permesso'),
        ferie: sumByTipo('ferie'),
        logCount: sql<number>`count(${timeLogs.id})::int`,
      })
      .from(timeLogs)
      .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
      .innerJoin(users, eq(timeLogs.userId, users.id))
      .where(and(...employeeConditions))
      .groupBy(users.id, users.name)
      .orderBy(users.name),
    db
      .select({
        name: timeLogMaterials.name,
        unit: timeLogMaterials.unit,
        totalQuantity: sql<string>`coalesce(sum(${timeLogMaterials.quantity}::numeric), 0)::text`,
      })
      .from(timeLogMaterials)
      .innerJoin(timeLogs, eq(timeLogMaterials.timeLogId, timeLogs.id))
      .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
      .where(and(eq(tasks.projectId, projectId), eq(timeLogMaterials.companyId, companyId)))
      .groupBy(timeLogMaterials.name, timeLogMaterials.unit)
      .orderBy(timeLogMaterials.name),
  ]);

  const totalHours = employeeRows
    .reduce((sum, r) => sum + Number(r.totalHours), 0)
    .toFixed(2);

  return {
    id: project.id,
    projectNumber: project.projectNumber,
    code: project.code,
    name: project.name,
    status: project.status,
    tipoCommessa: project.tipoCommessa,
    createdAt: project.createdAt,
    employeeCount: employeeRows.length,
    employees: employeeRows,
    totalHours,
    materials: materialRows,
  };
}

export interface UserTimeLogRow {
  id: string;
  date: string;
  tipo: string;
  hoursWorked: string;
  workDescription: string | null;
  projectId: string;
  projectNumber: number;
  code: string | null;
  tipoCommessa: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
}

export interface UserTimeLogDetail {
  userId: string;
  userName: string;
  userEmail: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
  timeLogs: UserTimeLogRow[];
}

// Vista di dettaglio di UN dipendente: tutte le sue righe timeLog con a quale
// cantiere/lavoro si riferiscono (join task->project), più recenti prima, più la
// scomposizione per tipo (ordinario/straordinario/notturno/festivo/permesso/ferie).
// La scomposizione si calcola in JS sulle righe già caricate (accumulando 6 contatori
// nello stesso ciclo che già sommava totalHours) invece di una seconda query SQL:
// costo zero in più, e garantisce che la scomposizione corrisponda esattamente alle
// righe mostrate nella stessa pagina.
export async function getUserTimeLogDetail(userId: string, companyId: string, range?: DateRange): Promise<UserTimeLogDetail> {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.companyId, companyId)))
    .limit(1);
  if (!user) {
    throw new NotFoundError('Dipendente non trovato');
  }

  const conditions = [eq(timeLogs.userId, userId), eq(timeLogs.companyId, companyId)];
  if (range) {
    conditions.push(gte(timeLogs.date, range.from), lte(timeLogs.date, range.to));
  }

  const rows = await db
    .select({
      id: timeLogs.id,
      date: timeLogs.date,
      tipo: timeLogs.tipo,
      hoursWorked: timeLogs.hoursWorked,
      workDescription: timeLogs.workDescription,
      projectId: projects.id,
      projectNumber: projects.projectNumber,
      code: projects.code,
      tipoCommessa: projects.tipoCommessa,
      projectName: projects.name,
      taskId: tasks.id,
      taskTitle: tasks.title,
    })
    .from(timeLogs)
    .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(timeLogs.date));

  const byTipo: Record<string, number> = {
    ordinario: 0,
    straordinario: 0,
    notturno: 0,
    festivo: 0,
    permesso: 0,
    ferie: 0,
  };
  let totalHours = 0;
  for (const r of rows) {
    const hours = Number(r.hoursWorked);
    totalHours += hours;
    byTipo[r.tipo] = (byTipo[r.tipo] ?? 0) + hours;
  }

  return {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    totalHours: totalHours.toFixed(2),
    ordinary: byTipo.ordinario.toFixed(2),
    straordinario: byTipo.straordinario.toFixed(2),
    notturno: byTipo.notturno.toFixed(2),
    festivo: byTipo.festivo.toFixed(2),
    permesso: byTipo.permesso.toFixed(2),
    ferie: byTipo.ferie.toFixed(2),
    logCount: rows.length,
    timeLogs: rows,
  };
}

// Report 2: ore raggruppate per utente (operaio).
// Parte da `users` (non da `timeLogs`) con LEFT JOIN: un INNER JOIN da timeLogs
// escluderebbe per costruzione ogni operaio senza ancora nessuna ora registrata (es.
// appena assunto), rendendolo invisibile sia in questo report sia nella pagina
// "Dipendenti" del frontend che lo consuma — un dipendente deve comparire da subito,
// con 0 ore, non sparire finché non registra la prima giornata. Il filtro companyId
// sul timeLogs va nella condizione di JOIN (non in WHERE): filtrarlo in WHERE
// annullerebbe l'effetto del LEFT JOIN, scartando le righe NULL degli operai senza ore.
//
// STESSA REGOLA per il periodo: il filtro data va nella condizione di JOIN, MAI in
// WHERE. Nella WHERE trasformerebbe il LEFT JOIN in un INNER JOIN di fatto — un
// dipendente con zero ore in quel mese sparirebbe dal report paghe invece di comparire
// con 0, il tipo di errore silenzioso più pericoloso per una busta paga.
export async function getHoursByUser(companyId: string, range?: DateRange, opts?: { archived?: boolean }): Promise<HoursByUserRow[]> {
  const archived = opts?.archived ?? false;
  const joinConditions = [eq(timeLogs.userId, users.id), eq(timeLogs.companyId, companyId)];
  if (range) {
    joinConditions.push(gte(timeLogs.date, range.from), lte(timeLogs.date, range.to));
  }
  // STESSA REGOLA del commento sopra su range/companyId: il filtro di archiviazione va
  // nella condizione di JOIN, MAI in WHERE — altrimenti il LEFT JOIN da users diventa
  // di fatto un INNER JOIN e un dipendente senza ore ATTIVE (magari ne ha solo di
  // archiviate) sparirebbe dal report invece di comparire con 0.
  const cutoff = computeArchiveCutoffISO();
  const completedTaskIds = completedTaskIdsSubquery(companyId);
  joinConditions.push(
    archived
      ? or(inArray(timeLogs.taskId, completedTaskIds), lt(timeLogs.date, cutoff))!
      : and(notInArray(timeLogs.taskId, completedTaskIds), gte(timeLogs.date, cutoff))!,
  );
  const rows = await db
    .select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      totalHours: sql<string>`coalesce(sum(${timeLogs.hoursWorked}::numeric), 0)::text`,
      ordinary: sumByTipo('ordinario'),
      straordinario: sumByTipo('straordinario'),
      notturno: sumByTipo('notturno'),
      festivo: sumByTipo('festivo'),
      permesso: sumByTipo('permesso'),
      ferie: sumByTipo('ferie'),
      logCount: sql<number>`count(${timeLogs.id})::int`,
    })
    .from(users)
    .leftJoin(timeLogs, and(...joinConditions))
    .where(and(eq(users.companyId, companyId), eq(users.role, 'operaio')))
    .groupBy(users.id, users.name, users.email)
    .orderBy(users.name);
  return rows;
}

const TIMELINE_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 100;

export interface ProjectTimelineEntry {
  id: string;
  date: string;
  tipo: string;
  hoursWorked: string;
  workDescription: string | null;
  notes: string | null;
  userId: string;
  userName: string;
  taskId: string;
  taskTitle: string;
  materials: { name: string; quantity: string; unit: string }[];
}

export interface ProjectTimeline {
  entries: ProjectTimelineEntry[];
  total: number;
  page: number;
  limit: number;
}

// Registro Archivio (7b): lettura NON aggregata, paginata, di ogni ora registrata su un
// cantiere — chi, quando, quanto, per quale lavoro, con quali materiali. Nessuna tabella
// nuova: gli stessi dati di time_logs/time_log_materials già letti altrove in forma di
// riepilogo, qui in forma di elenco cronologico.
export async function getProjectTimeline(
  projectId: string,
  companyId: string,
  opts: { page?: number; limit?: number; range?: DateRange } = {},
): Promise<ProjectTimeline> {
  // Stessa guardia di getProjectDetail: 404 cross-tenant invece di un 200 con lista
  // vuota, altrimenti l'esistenza di un cantiere di un'altra azienda sarebbe indovinabile.
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) {
    throw new NotFoundError('Cantiere non trovato');
  }

  const page = opts.page ?? 1;
  const limit = Math.min(opts.limit ?? TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT);
  const offset = (page - 1) * limit;

  const conditions = [eq(tasks.projectId, projectId), eq(timeLogs.companyId, companyId)];
  if (opts.range) {
    conditions.push(gte(timeLogs.date, opts.range.from), lte(timeLogs.date, opts.range.to));
  }

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: timeLogs.id,
        date: timeLogs.date,
        tipo: timeLogs.tipo,
        hoursWorked: timeLogs.hoursWorked,
        workDescription: timeLogs.workDescription,
        notes: timeLogs.notes,
        userId: users.id,
        userName: users.name,
        taskId: tasks.id,
        taskTitle: tasks.title,
      })
      .from(timeLogs)
      .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
      .innerJoin(users, eq(timeLogs.userId, users.id))
      .where(and(...conditions))
      // Tie-break su createdAt: lo split automatico ordinario/notturno/straordinario
      // scrive 2-3 righe con la STESSA data per un solo turno — senza un secondo
      // criterio di ordinamento il loro ordine relativo non è garantito da una query
      // all'altra (stesso tipo di bug già trovato una volta in OperaioPage.repeatLast).
      .orderBy(desc(timeLogs.date), desc(timeLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(timeLogs)
      .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
      .where(and(...conditions)),
  ]);

  // Materiali in batch, non 1+N per riga: una seconda query su tutti gli id della
  // pagina corrente, poi raggruppati in memoria.
  const ids = rows.map((r) => r.id);
  const materialRows = ids.length
    ? await db
        .select({
          timeLogId: timeLogMaterials.timeLogId,
          name: timeLogMaterials.name,
          quantity: timeLogMaterials.quantity,
          unit: timeLogMaterials.unit,
        })
        .from(timeLogMaterials)
        .where(inArray(timeLogMaterials.timeLogId, ids))
    : [];

  const materialsByLog = new Map<string, { name: string; quantity: string; unit: string }[]>();
  for (const m of materialRows) {
    const list = materialsByLog.get(m.timeLogId) ?? [];
    list.push({ name: m.name, quantity: m.quantity, unit: m.unit });
    materialsByLog.set(m.timeLogId, list);
  }

  const entries: ProjectTimelineEntry[] = rows.map((r) => ({
    ...r,
    materials: materialsByLog.get(r.id) ?? [],
  }));

  return { entries, total: count, page, limit };
}
