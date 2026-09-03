import { pgTable, uuid, varchar, numeric, text, timestamp, index } from 'drizzle-orm/pg-core';
import { timeLogs } from './timeLogs';
import { companies } from './companies';

// Tabella figlia di time_logs: ogni riga è un materiale usato in cantiere durante
// quella registrazione ore. Strutturata (nome + quantità + unità) per consentire
// report "materiale consumato per cantiere/commessa" lato azienda.
// Eredità il companyId dal time_log padre per coerenza di scoping multi-tenant.
export const timeLogMaterials = pgTable(
  'time_log_materials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: eredita l'azienda dal time_log padre.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // cascade: se si cancella la registrazione ore, spariscono anche i suoi materiali.
    timeLogId: uuid('time_log_id')
      .notNull()
      .references(() => timeLogs.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    // Codice articolo scritto dall'operaio (colonna CODICE del blocco cartaceo),
    // facoltativo. varchar(50) come projects.code: lo schema Zod usa lo stesso limite,
    // così una stringa più lunga diventa un 400 e non un errore del driver travestito
    // da 500. Nessun indice: nessuna query filtra per codice.
    code: varchar('code', { length: 50 }),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    unit: varchar('unit', { length: 32 }).notNull().default('pz'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    timeLogIdIdx: index('time_log_materials_time_log_id_idx').on(table.timeLogId),
    companyIdIdx: index('time_log_materials_company_id_idx').on(table.companyId),
  }),
);
