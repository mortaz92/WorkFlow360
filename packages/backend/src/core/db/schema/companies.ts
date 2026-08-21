import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';

// Tabella radice del multi-tenant: ogni azienda cliente ha il suo company_id.
// Tutti i dati (users, projects, timeLogs, ...) riportano company_id e vengono
// sempre filtrati per esso: Neotekna SRL NON vede mai i dati di Perluce SRL.
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    // Partita IVA / codice fiscale: identificativo legale, utile in fattura/report.
    vat: varchar('vat', { length: 64 }),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 64 }),
    address: text('address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index('companies_name_idx').on(table.name),
  }),
);
