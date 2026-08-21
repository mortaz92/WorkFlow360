import { pgTable, uuid, varchar, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { companies } from './companies';

// Ridotto da 6 a 3 valori il 20/08 (deciso con l'utente: resource/qa/stakeholder
// avevano pochissime funzioni reali collegate, tolti per semplificare il prodotto).
// Nessun utente reale aveva questi ruoli al momento della rimozione (verificato con
// una query diretta sul DB prima di procedere). Vedi drizzle/0009_restrict_user_role.sql
// per la migrazione — drizzle-kit non genera automaticamente la rimozione di valori da
// un enum Postgres, quella migrazione è scritta a mano.
export const userRoleEnum = pgEnum('user_role', [
  'admin',
  'project_manager',
  'operaio',
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Multi-tenant: ogni utente appartiene a UNA sola azienda. Nessuna query deve
  // mai restituire utenti di aziende diverse da quella del chiamante.
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull(),
  department: varchar('department', { length: 255 }),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
