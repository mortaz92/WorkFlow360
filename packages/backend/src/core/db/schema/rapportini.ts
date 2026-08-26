import {
  pgTable,
  uuid,
  varchar,
  text,
  date,
  integer,
  numeric,
  jsonb,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { projects } from './projects';
import { users } from './users';

export const rapportinoStatusEnum = pgEnum('rapportino_status', [
  'in_firma',
  'firmato',
  'annullato',
  'scaduto',
]);

// Tipo TS derivato dall'enum (stesso idioma di AuditAction in auditLog.ts): l'enum
// Drizzle da solo è un valore per le query, non un tipo utilizzabile nei service.
export type RapportinoStatus = (typeof rapportinoStatusEnum.enumValues)[number];

// Rapportino giornaliero firmato dal cliente su commessa a consuntivo. Il cliente NON
// è un utente del sistema: firma di persona sul dispositivo già autenticato
// dell'operaio, tramite un token monouso a scadenza breve (stesso modello del reset
// password, vedi passwordResetTokens.ts).
export const rapportini = pgTable(
  'rapportini',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: il rapportino eredita l'azienda dal cantiere.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // restrict, NON cascade come tasks/time_logs: un rapportino firmato è una prova
    // documentale di quanto il cliente ha riconosciuto: cancellare il cantiere non
    // deve poterla far sparire in silenzio insieme a lui.
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    date: date('date').notNull(),
    // Progressivo per (cantiere, giorno): se un rapportino viene annullato o scade, il
    // successivo per lo stesso giorno è la revisione 2, non un secondo "numero 1".
    // Assegnato in rapportini.service.ts (MAX+1 sotto lock della riga del cantiere),
    // con l'UNIQUE più sotto come rete di sicurezza contro due creazioni concorrenti —
    // stesso idioma già usato per projects.projectNumber.
    revision: integer('revision').notNull(),
    status: rapportinoStatusEnum('status').notNull().default('in_firma'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Copia CONGELATA alla creazione di tutto ciò che il cliente vede e firma: nomi,
    // email, ore, materiali. Deliberatamente ridondante rispetto alle tabelle di
    // origine — DELETE /users/:id anonimizza l'utente in modo irreversibile, e un
    // documento firmato non deve mai mostrare retroattivamente "Utente rimosso".
    snapshotJson: jsonb('snapshot_json').notNull(),
    // sha256 del JSON canonico (chiavi ordinate) dello snapshot: permette di dimostrare
    // che il contenuto non è cambiato dopo la firma.
    snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
    totalHours: numeric('total_hours', { precision: 10, scale: 2 }).notNull(),
    // Solo l'hash del token di firma, mai il valore in chiaro (vedi core/tokens.ts).
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    signerName: varchar('signer_name', { length: 255 }),
    signerEmail: varchar('signer_email', { length: 255 }),
    // PNG in base64 SENZA il prefisso "data:image/png;base64," (rimosso in fase di
    // validazione): il prefisso è un dettaglio del formato usato dal browser, non
    // parte dell'immagine, e conservarlo renderebbe ambiguo cosa contiene la colonna.
    signaturePng: text('signature_png'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    // 45 caratteri: lunghezza massima di un IPv6 in forma testuale con suffisso IPv4.
    signedIp: varchar('signed_ip', { length: 45 }),
    signedUserAgent: varchar('signed_user_agent', { length: 500 }),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    // La firma acquisita non va MAI persa perché l'email non è partita: l'errore si
    // registra qui e il rapportino resta firmato (vedi signRapportino).
    emailLastError: text('email_last_error'),
    cancelReason: text('cancel_reason'),
    // Sblocco amministrativo: libera le ore per una correzione, ma NON tocca né lo
    // stato né lo snapshot — il documento firmato resta quello che il cliente ha visto.
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
    unlockedBy: uuid('unlocked_by').references(() => users.id, { onDelete: 'set null' }),
    unlockReason: text('unlock_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index('rapportini_company_id_idx').on(table.companyId),
    projectDateIdx: index('rapportini_project_id_date_idx').on(table.projectId, table.date),
    // UNIQUE e non un indice semplice: il token di firma è la chiave con cui la rotta
    // pubblica trova LA riga da firmare (`where tokenHash = ...` + `.limit(1)`). Senza
    // unicità garantita dal database, due righe con lo stesso hash renderebbero quel
    // `limit(1)` una scelta arbitraria di Postgres — si firmerebbe un rapportino a caso
    // tra i due. La probabilità di collisione su 32 byte casuali è nulla, ma il costo di
    // dichiararlo è zero e il vincolo intercetta anche un bug di riuso del token.
    tokenHashIdx: uniqueIndex('rapportini_token_hash_idx').on(table.tokenHash),
    statusIdx: index('rapportini_status_idx').on(table.status),
    projectDateRevisionUnique: unique('rapportini_project_id_date_revision_unique').on(
      table.projectId,
      table.date,
      table.revision,
    ),
    // NOTA: manca qui, di proposito, l'UNIQUE PARZIALE su (project_id, date) WHERE
    // status = 'in_firma' — quello che impedisce due rapportini contemporaneamente in
    // attesa di firma per lo stesso cantiere/giorno. Drizzle-kit non genera indici
    // parziali, quindi vive in una migrazione scritta a mano
    // (drizzle/0012_rapportino_partial_unique.sql), come già fatto per
    // drizzle/0009_restrict_user_role.sql. Non dichiararlo qui è voluto: drizzle-kit
    // confronta lo schema col PROPRIO snapshot in drizzle/meta, non col database reale,
    // quindi un indice che non conosce non verrà mai proposto in DROP per errore.
  }),
);
