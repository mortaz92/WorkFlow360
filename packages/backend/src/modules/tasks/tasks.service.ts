import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { projects, tasks, timeLogs, users } from '../../core/db/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors';
import type { AssignableUser, CreateTaskInput, PaginatedTasks, PublicTask, UpdateTaskInput } from './tasks.types';

// Colonne di tasks + il nome (non l'utente intero) di chi è assegnato, risolto lato
// server con un leftJoin invece di lasciare che il frontend lo incroci con una lista
// di operai potenzialmente vuota (403 per ruoli non-manager) o incompleta (operai
// disattivati, esclusi da listAssignableUsers): un task RESTA assegnato anche se
// l'assegnatario non è più nella lista di chi può essere scelto di nuovo — mostrare
// comunque il nome storico è più corretto che far sembrare il task "Non assegnato".
// leftJoin (non join): assignedTo è nullable, un task senza assegnatario deve restare
// nel risultato con assignedToName null, non sparire.
const TASK_WITH_ASSIGNEE_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  description: tasks.description,
  assignedTo: tasks.assignedTo,
  assignedToName: users.name,
  status: tasks.status,
  priority: tasks.priority,
  dueDate: tasks.dueDate,
  hoursEstimated: tasks.hoursEstimated,
  createdAt: tasks.createdAt,
};

export async function listTasks(
  page: number,
  limit: number,
  companyId: string,
  projectId?: string,
): Promise<PaginatedTasks> {
  const offset = (page - 1) * limit;

  const conditions = [
    eq(tasks.companyId, companyId),
    ...(projectId ? [eq(tasks.projectId, projectId)] : []),
  ];
  const [rows, [{ count }]] = await Promise.all([
    db
      .select(TASK_WITH_ASSIGNEE_COLUMNS)
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(...conditions)),
  ]);

  return { tasks: rows.map((r) => ({ ...r, assignedToName: r.assignedToName ?? null })), total: count, page, limit };
}

export async function getTaskById(id: string, companyId: string): Promise<PublicTask> {
  const [task] = await db
    .select(TASK_WITH_ASSIGNEE_COLUMNS)
    .from(tasks)
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!task) {
    throw new NotFoundError('Task non trovato');
  }
  return { ...task, assignedToName: task.assignedToName ?? null };
}

// assignedTo è una FK verso users.id senza scoping per azienda a livello di schema
// (la FK garantisce solo che l'utente esista DA QUALCHE PARTE) — senza questo
// controllo un admin dell'azienda A potrebbe assegnare un task a un utente
// dell'azienda B conoscendone/indovinandone l'id, una violazione dell'isolamento
// multi-tenant che è una regola di prima classe in questo progetto (vedi
// companies.test.ts). Ristretto a operai attivi, coerente con listAssignableUsers:
// la UI offre solo quelle scelte, il server non si fida che il client la rispetti.
async function assertAssignableUser(userId: string, companyId: string): Promise<void> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.companyId, companyId), eq(users.role, 'operaio'), eq(users.active, true)))
    .limit(1);
  if (!user) {
    throw new NotFoundError('Dipendente da assegnare non trovato (deve essere un operaio attivo della stessa azienda)');
  }
}

export async function createTask(input: CreateTaskInput, companyId: string): Promise<PublicTask> {
  if (!input.projectId || !input.title || input.title.trim().length === 0) {
    throw new ValidationError('projectId e title sono obbligatori');
  }

  // Il progetto padre deve esistere E appartenere alla stessa azienda (no cross-tenant).
  const [project] = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) {
    throw new NotFoundError('Progetto padre non trovato');
  }
  // "completed" è la chiusura vera e propria del cantiere (vedi ArchivioPage): da quel
  // momento non si aprono più nuovi lavori. "blocked" resta escluso di proposito — un
  // cantiere bloccato non è finito, può ripartire (stessa decisione già presa per
  // l'Archivio, 18/08).
  if (project.status === 'completed') {
    throw new ConflictError('Il cantiere è chiuso: non si possono aggiungere nuovi lavori. Riaprilo prima di continuare.');
  }

  if (input.assignedTo) {
    await assertAssignableUser(input.assignedTo, companyId);
  }

  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      projectId: input.projectId,
      title: input.title.trim(),
      description: input.description ?? null,
      assignedTo: input.assignedTo ?? null,
      status: input.status ?? 'pending',
      priority: input.priority ?? 'medium',
      dueDate: input.dueDate ?? null,
      hoursEstimated: input.hoursEstimated ?? null,
    })
    .returning();
  // Ri-letto con getTaskById invece di restituire .returning() direttamente: serve
  // assignedToName, che richiede il leftJoin su users — .returning() da un insert
  // non può includerlo.
  return getTaskById(task.id, companyId);
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  companyId: string,
): Promise<PublicTask> {
  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Task non trovato');
  }

  if (input.assignedTo) {
    await assertAssignableUser(input.assignedTo, companyId);
  }

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;
  if (input.status !== undefined) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.hoursEstimated !== undefined) patch.hoursEstimated = input.hoursEstimated;

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Nessun campo fornito per l\'aggiornamento');
  }

  await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)));
  // Come in createTask: ri-letto con getTaskById per includere assignedToName
  // (leftJoin), che .returning() da un update non può dare.
  return getTaskById(id, companyId);
}

// Elenco minimale (solo id+nome) di chi può essere assegnato a un Lavoro: operai
// attivi dell'azienda. Endpoint dedicato invece di allargare GET /users (riservato
// ad admin) — chi gestisce i task (admin+project_manager, vedi MANAGER_ROLES)
// deve poter popolare questa dropdown senza ereditare i permessi più ampi di
// quell'endpoint (che espone email/department/active di ogni utente, non solo operai).
export async function listAssignableUsers(companyId: string): Promise<AssignableUser[]> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.role, 'operaio'), eq(users.active, true)))
    .orderBy(users.name);
}

export async function deleteTask(id: string, companyId: string): Promise<void> {
  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Task non trovato');
  }
  // Stesso blocco di deleteProject (projects.service.ts): le ore registrate sono un
  // dato che si fattura, non va perso in un CASCADE implicito.
  const [{ count: linkedHours }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(timeLogs)
    .where(eq(timeLogs.taskId, id));
  if (linkedHours > 0) {
    throw new ConflictError('Impossibile eliminare il lavoro: ha ore registrate collegate.');
  }
  await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)));
}
