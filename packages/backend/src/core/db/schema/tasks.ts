import { pgTable, uuid, varchar, text, date, numeric, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';
import { companies } from './companies';

export const taskStatusEnum = pgEnum('task_status', ['pending', 'in_progress', 'completed', 'blocked']);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: il task eredita l'azienda dal progetto padre (DEVE coincidere).
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // cascade: il task è parte intrinseca del progetto, non ha senso isolato.
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    // set null: se l'assegnatario viene rimosso, il task torna non assegnato invece di sparire.
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    status: taskStatusEnum('status').notNull().default('pending'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    dueDate: date('due_date'),
    hoursEstimated: numeric('hours_estimated', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index('tasks_project_id_idx').on(table.projectId),
    assignedToIdx: index('tasks_assigned_to_idx').on(table.assignedTo),
    statusIdx: index('tasks_status_idx').on(table.status),
    companyIdIdx: index('tasks_company_id_idx').on(table.companyId),
  }),
);
