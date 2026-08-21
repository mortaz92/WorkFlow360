import { pgTable, uuid, varchar, jsonb, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { companies } from './companies';

export const auditActionEnum = pgEnum('audit_action', ['CREATE', 'UPDATE', 'DELETE', 'EXPORT']);
// Tipo TS derivato dall'enum: auditLog.types.ts lo importa come `AuditAction` da
// questo modulo (via schema/index.ts) — l'enum Drizzle da solo è un valore per le
// query, non un tipo. Mancava (errore preesistente noto, "AuditAction non esportato
// da schema"): corretto qui perché questa sessione è la prima a chiamare davvero
// recordAudit() da codice di produzione (modifica delle ore da parte di un manager).
export type AuditAction = (typeof auditActionEnum.enumValues)[number];

// Tabella pensata come append-only: nessun modulo applicativo deve esporre
// un'operazione di UPDATE o DELETE su questa tabella (garanzia di immutabilità, Fase 25-27).
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: ogni voce di audit riguarda UNA azienda.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // set null: il log di audit deve sopravvivere anche se l'utente che ha compiuto
    // l'azione viene cancellato — si perde solo il collegamento, non la riga storica.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: auditActionEnum('action').notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: varchar('entity_id', { length: 255 }).notNull(),
    changesJson: jsonb('changes_json'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('audit_log_user_id_idx').on(table.userId),
    timestampIdx: index('audit_log_timestamp_idx').on(table.timestamp),
    entityIdx: index('audit_log_entity_idx').on(table.entityType, table.entityId),
    companyIdIdx: index('audit_log_company_id_idx').on(table.companyId),
  }),
);
