import { pgTable, uuid, numeric, date, time, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tasks } from './tasks';
import { users } from './users';
import { companies } from './companies';
import { rapportini } from './rapportini';

export const timeLogTypeEnum = pgEnum('time_log_type', [
  'ordinario',
  'straordinario',
  'notturno',
  'festivo',
  'permesso',
  'ferie',
]);

export const timeLogs = pgTable(
  'time_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Multi-tenant: l'ora eredita l'azienda dall'utente che la registra.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // cascade: l'ora registrata non ha significato se il task a cui si riferisce sparisce.
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // restrict: le ore lavorate sono dati storici/consuntivi — non si può cancellare
    // un utente che ha ore registrate senza prima riassegnarle o archiviarle esplicitamente.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // UNICA colonna tipo per tutte le registrazioni: l'operaio sceglie cosa inserire.
    tipo: timeLogTypeEnum('tipo').notNull().default('ordinario'),
    hoursWorked: numeric('hours_worked', { precision: 10, scale: 2 }).notNull(),
    date: date('date').notNull(),
    // Orario di inizio turno (facoltativo — le righe storiche non ce l'hanno).
    // Serve a calcolare automaticamente quante ore rientrano nella fascia notturna
    // 22:00-06:00 quando tipo='ordinario' (vedi createTimeLog in timeLogs.service.ts):
    // senza un orario di inizio non è possibile stabilire se un'ora lavorata cada di
    // notte o di giorno, un totale di ore da solo non basta.
    startTime: time('start_time'),
    // Orario di fine turno. Sempre facoltativo, anche per tipo='ordinario' — a
    // differenza di startTime NON entra nel calcolo automatico notturno/straordinario
    // in createTimeLog: è solo un'informazione aggiuntiva che l'operaio può registrare,
    // hoursWorked resta l'unica fonte per il totale ore.
    endTime: time('end_time'),
    // Descrizione libera del LAVORO SVOLTO (cosa ha fatto l'operaio in cantiere).
    // Indipendente da contratto/consuntivo: l'operaio la compila sempre.
    workDescription: text('work_description'),
    notes: text('notes'),
    // Rapportino a cui questa riga è stata allegata (NULL = ora libera, il caso normale).
    // Vale come LUCCHETTO: finché il rapportino è 'in_firma' o 'firmato', updateTimeLog
    // e deleteTimeLog rifiutano la modifica (409) — le ore non devono poter divergere in
    // silenzio da quelle che il cliente ha visto e sottoscritto. Lo snapshot congelato
    // sul rapportino non basta da solo: senza il lucchetto, snapshot e realtà si
    // separerebbero e il documento firmato risulterebbe smentito dal database.
    // set null (non cascade/restrict): se un rapportino venisse mai eliminato, le ore
    // restano e tornano semplicemente libere.
    rapportinoId: uuid('rapportino_id').references(() => rapportini.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdIdx: index('time_logs_task_id_idx').on(table.taskId),
    userIdIdx: index('time_logs_user_id_idx').on(table.userId),
    companyIdIdx: index('time_logs_company_id_idx').on(table.companyId),
    // Ogni annullamento/sblocco di un rapportino azzera questa colonna su tutte le sue
    // righe: senza indice sarebbe una scansione completa di time_logs ogni volta.
    rapportinoIdIdx: index('time_logs_rapportino_id_idx').on(table.rapportinoId),
  }),
);
