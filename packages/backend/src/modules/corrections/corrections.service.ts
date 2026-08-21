import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { tasks, corrections, users } from '../../core/db/schema';
import { NotFoundError, ValidationError } from '../../core/errors';
import type { CreateCorrectionInput, PaginatedCorrections, PublicCorrection, UpdateCorrectionInput } from './corrections.types';

function toPublicCorrection(row: typeof corrections.$inferSelect): PublicCorrection {
  const { ...publicRow } = row;
  return publicRow;
}

export async function listCorrections(
  page: number,
  limit: number,
  companyId: string,
  taskId?: string,
): Promise<PaginatedCorrections> {
  const offset = (page - 1) * limit;
  const conditions = [
    eq(corrections.companyId, companyId),
    ...(taskId ? [eq(corrections.taskId, taskId)] : []),
  ];

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(corrections)
      .where(and(...conditions))
      .orderBy(desc(corrections.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(corrections)
      .where(and(...conditions)),
  ]);

  return { corrections: rows.map(toPublicCorrection), total: count, page, limit };
}

export async function getCorrectionById(id: string, companyId: string): Promise<PublicCorrection> {
  const [row] = await db
    .select()
    .from(corrections)
    .where(and(eq(corrections.id, id), eq(corrections.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Correzione non trovata');
  }
  return toPublicCorrection(row);
}

export async function createCorrection(
  input: CreateCorrectionInput,
  companyId: string,
): Promise<PublicCorrection> {
  if (!input.description || input.description.trim().length === 0) {
    throw new ValidationError('La descrizione della correzione è obbligatoria');
  }

  // Il task padre deve esistere E appartenere alla stessa azienda (no cross-tenant).
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!task) {
    throw new NotFoundError('Task padre non trovato');
  }
  // Chi segnala deve esistere (FK restrict: non si può cancellare un utente con correzioni).
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.reportedBy), eq(users.companyId, companyId)))
    .limit(1);
  if (!user) {
    throw new NotFoundError('Utente segnalatore non trovato');
  }

  const [row] = await db
    .insert(corrections)
    .values({
      companyId,
      taskId: input.taskId,
      reportedBy: input.reportedBy,
      description: input.description.trim(),
      status: input.status ?? 'open',
      severity: input.severity ?? 'medium',
    })
    .returning();
  return toPublicCorrection(row);
}

export async function updateCorrection(
  id: string,
  input: UpdateCorrectionInput,
  companyId: string,
): Promise<PublicCorrection> {
  const [existing] = await db
    .select()
    .from(corrections)
    .where(and(eq(corrections.id, id), eq(corrections.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Correzione non trovata');
  }

  const patch: Record<string, unknown> = {};
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.status !== undefined) patch.status = input.status;
  if (input.severity !== undefined) patch.severity = input.severity;

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Nessun campo fornito per l\'aggiornamento');
  }

  const [updated] = await db
    .update(corrections)
    .set(patch)
    .where(and(eq(corrections.id, id), eq(corrections.companyId, companyId)))
    .returning();
  return toPublicCorrection(updated);
}

export async function deleteCorrection(id: string, companyId: string): Promise<void> {
  const [existing] = await db
    .select({ id: corrections.id })
    .from(corrections)
    .where(and(eq(corrections.id, id), eq(corrections.companyId, companyId)))
    .limit(1);
  if (!existing) {
    throw new NotFoundError('Correzione non trovata');
  }
  await db.delete(corrections).where(and(eq(corrections.id, id), eq(corrections.companyId, companyId)));
}
