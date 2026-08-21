import { pgTable, uuid, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tasks } from './tasks';
import { users } from './users';
import { companies } from './companies';

export const correctionStatusEnum = pgEnum('correction_status', [
  'open',
  'in_review',
  'approved',
  'rejected',
  'applied',
]);
export const correctionSeverityEnum = pgEnum('correction_severity', ['low', 'medium', 'high', 'critical']);

export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: la correzione eredita l'azienda dal task padre.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // cascade: la correzione è legata al task, non ha senso tenerla se il task sparisce.
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // restrict: mantiene la tracciabilità di chi ha segnalato cosa (accountability del QA).
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    status: correctionStatusEnum('status').notNull().default('open'),
    severity: correctionSeverityEnum('severity').notNull().default('medium'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdIdx: index('corrections_task_id_idx').on(table.taskId),
    reportedByIdx: index('corrections_reported_by_idx').on(table.reportedBy),
    companyIdIdx: index('corrections_company_id_idx').on(table.companyId),
  }),
);
