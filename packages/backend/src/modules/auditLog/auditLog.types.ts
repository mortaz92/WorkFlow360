import type { AuditAction } from '../../core/db/schema';

export interface PublicAuditLog {
  id: string;
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  changesJson: unknown;
  timestamp: Date;
}

export interface PaginatedAuditLogs {
  auditLogs: PublicAuditLog[];
  total: number;
  page: number;
  limit: number;
}

// Input usato solo internamente (recordAudit): l'API non espone mai scritture,
// l'audit log è append-only per design.
export interface RecordAuditInput {
  companyId: string;
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  changes?: unknown;
}
