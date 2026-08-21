import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { auditLog } from '../../core/db/schema';
import { NotFoundError } from '../../core/errors';
import type { PaginatedAuditLogs, PublicAuditLog, RecordAuditInput } from './auditLog.types';

function toPublicAuditLog(row: typeof auditLog.$inferSelect): PublicAuditLog {
  const { ...publicRow } = row;
  return publicRow;
}

export async function listAuditLogs(
  page: number,
  limit: number,
  companyId: string,
  filters?: { entityType?: string; userId?: string },
): Promise<PaginatedAuditLogs> {
  const offset = (page - 1) * limit;
  // companyId è sempre presente (non opzionale, a differenza di entityType/userId):
  // l'audit log è per definizione scoped a un'azienda, mai una scelta del chiamante.
  const conditions = [
    eq(auditLog.companyId, companyId),
    filters?.entityType ? eq(auditLog.entityType, filters.entityType) : undefined,
    filters?.userId ? eq(auditLog.userId, filters.userId) : undefined,
  ].filter(Boolean);

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(and(...(conditions as ReturnType<typeof eq>[])))
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(...(conditions as ReturnType<typeof eq>[]))),
  ]);

  return { auditLogs: rows.map(toPublicAuditLog), total: count, page, limit };
}

export function recordAudit(input: RecordAuditInput): Promise<PublicAuditLog> {
  return db
    .insert(auditLog)
    .values({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changesJson: input.changes ?? null,
    })
    .returning()
    .then(([row]) => toPublicAuditLog(row));
}

export async function getAuditLogById(id: string, companyId: string): Promise<PublicAuditLog> {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.id, id), eq(auditLog.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Voce di audit non trovata');
  }
  return toPublicAuditLog(row);
}
