import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { projects, companies, tasks, timeLogs } from '../../core/db/schema';
import { isUniqueViolation } from '../../core/db/isUniqueViolation';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors';
import type { AuthenticatedUser } from '../auth/auth.types';
import type {
  CreateProjectInput,
  PaginatedProjects,
  ProjectStatus,
  ProjectTipoCommessa,
  PublicProject,
  UpdateProjectInput,
} from './projects.types';

function toPublicProject(project: typeof projects.$inferSelect): PublicProject {
  const { ...publicProject } = project;
  return publicProject;
}

export interface ListProjectsFilters {
  tipoCommessa?: ProjectTipoCommessa;
  status?: ProjectStatus[];
}

// Filtri opzionali e additivi (punto 3: Cantieri a tab per tipo; punto 7a: Archivio =
// stessa lista con status diverso). Nessun filtro passato = comportamento identico a
// prima — non rompe OperaioPage, che chiama listProjects(1, 100) senza filtri.
export async function listProjects(
  page: number,
  limit: number,
  companyId: string,
  filters?: ListProjectsFilters,
): Promise<PaginatedProjects> {
  const offset = (page - 1) * limit;
  const conditions = [eq(projects.companyId, companyId)];
  if (filters?.tipoCommessa) conditions.push(eq(projects.tipoCommessa, filters.tipoCommessa));
  if (filters?.status?.length) conditions.push(inArray(projects.status, filters.status));

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(...conditions)),
  ]);

  return { projects: rows.map(toPublicProject), total: count, page, limit };
}

export interface ProjectsSummary {
  total: number;
  byTipo: Record<ProjectTipoCommessa, number>;
  byStatus: Record<ProjectStatus, number>;
}

// Conteggi per la dashboard (punto 2): una sola query group-by invece di due
// listProjects(limit=1) che scaricherebbero righe inutili solo per leggere `total`.
export async function getProjectsSummary(companyId: string): Promise<ProjectsSummary> {
  const rows = await db
    .select({
      tipoCommessa: projects.tipoCommessa,
      status: projects.status,
      count: sql<number>`count(*)::int`,
    })
    .from(projects)
    .where(eq(projects.companyId, companyId))
    .groupBy(projects.tipoCommessa, projects.status);

  const byTipo: Record<string, number> = { contratto: 0, consuntivo: 0 };
  const byStatus: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, blocked: 0 };
  let total = 0;
  for (const r of rows) {
    byTipo[r.tipoCommessa] = (byTipo[r.tipoCommessa] ?? 0) + r.count;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.count;
    total += r.count;
  }
  return { total, byTipo: byTipo as Record<ProjectTipoCommessa, number>, byStatus: byStatus as Record<ProjectStatus, number> };
}

export async function getProjectById(id: string, companyId: string): Promise<PublicProject> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) {
    throw new NotFoundError('Progetto non trovato');
  }
  return toPublicProject(project);
}

export async function createProject(input: CreateProjectInput, companyId: string): Promise<PublicProject> {
  if (!input.name || input.name.trim().length === 0) {
    throw new ValidationError('Il nome del progetto è obbligatorio');
  }

  return db.transaction(async (tx) => {
    // Blocca la riga dell'azienda per la durata della transazione: due creazioni
    // concorrenti nella stessa azienda vengono serializzate da Postgres invece di
    // leggere entrambe lo stesso MAX(project_number) e collidere sull'UNIQUE dello
    // schema — stesso idioma già usato nel progetto per lo stesso tipo di race
    // condition (users.service.ts updateUser, auth.service.ts rotateRefreshToken).
    // Un retry ottimistico era stato provato prima ma sotto concorrenza reale (3+
    // creazioni nello stesso istante) falliva quasi sempre almeno una richiesta su
    // tre: il lock la rende deterministicamente corretta per qualunque concorrenza.
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for('update')
      .limit(1);
    if (!company) {
      throw new NotFoundError('Azienda non trovata');
    }

    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${projects.projectNumber}), 0)::int` })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    const projectNumber = (max ?? 0) + 1;

    try {
      const [project] = await tx
        .insert(projects)
        .values({
          companyId,
          projectNumber,
          code: input.code ?? null,
          address: input.address ?? null,
          name: input.name.trim(),
          description: input.description ?? null,
          status: input.status ?? 'pending',
          tipoCommessa: input.tipoCommessa ?? 'consuntivo',
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          ownerId: input.ownerId ?? null,
        })
        .returning();
      return toPublicProject(project);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ValidationError('Codice cantiere già usato in un altro cantiere di questa azienda');
      }
      throw err;
    }
  });
}

export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  companyId: string,
): Promise<PublicProject> {
  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Progetto non trovato');
  }

  // Filtra solo i campi effettivamente forniti: un campo assente lascia il valore
  // attuale invariato (stesso criterio di users.updateUser), evitando di schiacciare
  // dati non voluti con undefined.
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.code !== undefined) patch.code = input.code;
  if (input.address !== undefined) patch.address = input.address;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.tipoCommessa !== undefined) patch.tipoCommessa = input.tipoCommessa;
  if (input.startDate !== undefined) patch.startDate = input.startDate;
  if (input.endDate !== undefined) patch.endDate = input.endDate;
  if (input.ownerId !== undefined) patch.ownerId = input.ownerId;

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Nessun campo fornito per l\'aggiornamento');
  }

  try {
    const [updated] = await db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .returning();
    return toPublicProject(updated);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ValidationError('Codice cantiere già usato in un altro cantiere di questa azienda');
    }
    throw err;
  }
}

export async function deleteProject(
  id: string,
  _actingUser: AuthenticatedUser,
  companyId: string,
): Promise<void> {
  // Soft-delete non applicabile: i task figli sono in CASCADE per design (un progetto
  // senza task non ha senso conservarlo come "disattivato"). Cancellazione fisica,
  // protetta dal requireRole('admin','manager') a livello di rotta + scoped per companyId.
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Progetto non trovato');
  }
  // Blocco esplicito, non solo il CASCADE dello schema: le ore registrate sono un dato
  // che si fattura (busta paga, report al cliente) — un DELETE che le cancella in
  // silenzio insieme al cantiere (verificato: 100mila ore reali sparite con una sola
  // chiamata in un test) è troppo pericoloso da lasciare a un CASCADE implicito, a
  // differenza dei task senza ore, che restano cancellabili insieme al progetto.
  const [{ count: linkedHours }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(timeLogs)
    .innerJoin(tasks, eq(timeLogs.taskId, tasks.id))
    .where(eq(tasks.projectId, id));
  if (linkedHours > 0) {
    throw new ConflictError(
      'Impossibile eliminare il cantiere: ha ore registrate collegate. ' +
        'Segnalo come completato invece di eliminarlo se il lavoro è finito.',
    );
  }
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.companyId, companyId)));
}
