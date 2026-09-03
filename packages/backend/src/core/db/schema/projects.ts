import { pgTable, uuid, varchar, text, date, integer, timestamp, pgEnum, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';
import { companies } from './companies';

export const projectStatusEnum = pgEnum('project_status', [
  'pending',
  'in_progress',
  'completed',
  'blocked',
]);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: commessa visibile solo all'azienda proprietaria.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    // Identificativo leggibile mostrato all'utente (es. "Cantiere #12"), progressivo
    // PER AZIENDA (non globale): ogni azienda vede il proprio primo cantiere come #1,
    // indipendentemente da quanti cantieri esistono su altre aziende. Assegnato in
    // projects.service.ts (MAX+1 scoped su companyId), con l'UNIQUE sotto come rete
    // di sicurezza contro una race condition tra due creazioni concorrenti.
    projectNumber: integer('project_number').notNull(),
    // Codice scritto a mano dall'admin alla creazione (es. "CANT-04"), facoltativo,
    // SI AFFIANCA a projectNumber invece di sostituirlo — projectNumber resta
    // l'identità stabile assegnata dal server sotto lock (vedi projects.service.ts
    // createProject). NULL per i cantieri creati prima di questo campo o senza codice
    // scritto: NULLS DISTINCT (default Postgres) fa sì che più righe NULL convivano
    // sotto lo stesso UNIQUE senza collidere tra loro.
    code: varchar('code', { length: 50 }),
    // Committente del cantiere. Esisteva da tempo in CLAUDE.md e in scripts/seed-dev.ts
    // ma NON nello schema: Drizzle scartava il campo in silenzio a ogni insert (vedi il
    // commento su Project in packages/frontend/src/lib/types.ts, che segnalava proprio
    // questo buco). Serve per davvero da quando il cliente firma il rapportino: sul
    // documento deve comparire il nome di chi lo sottoscrive, non solo quello del cantiere.
    clientName: varchar('client_name', { length: 255 }),
    // Indirizzo del cantiere ("Destinazione" sul rapportino cartaceo): dove si è lavorato,
    // che non coincide con la sede del committente. Facoltativo: i cantieri creati prima
    // di questo campo restano a NULL e il documento semplicemente stampa un trattino.
    // `text` come companies.address: senza limite in colonna il SOLO limite è quello Zod,
    // così una stringa troppo lunga diventa un 400 con messaggio e mai un errore del
    // driver (22001) travestito da 500.
    address: text('address'),
    description: text('description'),
    status: projectStatusEnum('status').notNull().default('pending'),
    // Solo etichetta: contratto (prezzo fisso) vs consuntivo (ore fatte).
    // NESSUN prezzo/importo nel DB — l'operaio vede su che cantiere lavora.
    tipoCommessa: pgEnum('tipo_commessa', ['contratto', 'consuntivo'])('tipo_commessa')
      .notNull()
      .default('consuntivo'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    // set null: se il proprietario viene rimosso, il progetto resta e va riassegnato,
    // non ha senso farlo sparire insieme al suo owner.
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdIdx: index('projects_owner_id_idx').on(table.ownerId),
    companyIdIdx: index('projects_company_id_idx').on(table.companyId),
    companyProjectNumberUnique: unique('projects_company_id_project_number_unique').on(
      table.companyId,
      table.projectNumber,
    ),
    companyCodeUnique: unique('projects_company_id_code_unique').on(table.companyId, table.code),
  }),
);
