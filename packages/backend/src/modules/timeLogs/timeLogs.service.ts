import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { projects, tasks, timeLogs, timeLogMaterials, users } from '../../core/db/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { isManager } from '../../core/roles';
import { recordAudit } from '../auditLog/auditLog.service';
import { assertOreNonBloccateDaRapportino } from '../rapportini/rapportini.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type {
  CreateMaterialInput,
  CreateTimeLogInput,
  PaginatedTimeLogs,
  PublicTimeLog,
  UpdateTimeLogInput,
} from './timeLogs.types';

// Sottoinsieme dei metodi di query usati da questo modulo, comune sia a `db` sia a un
// client di transazione `tx` (db.transaction(async (tx) => ...)): permette a
// loadMaterials di essere chiamata sia fuori sia dentro una transazione, così una
// lettura non finisce per usare una connessione/snapshot diverso da quello delle
// scritture della stessa operazione (rilevante da quando updateTimeLog gira in
// transazione, vedi sotto).
type Queryable = Pick<typeof db, 'select'>;

const HOURS_REGEX = /^\d+(\.\d{1,2})?$/;
const QTY_REGEX = /^\d+(\.\d{1,3})?$/;

// --- Regole automatiche sulle ore "ordinario" (decise con l'utente) ---
// 1) Fascia notturna 22:00-06:00: le ore di un turno che ci ricadono diventano
//    'notturno' automaticamente, indipendentemente dal tetto delle 8h (contenitore
//    separato — non concorrono al calcolo dello straordinario).
// 2) Tetto di 8 ore "ordinario" AL GIORNO per dipendente: sommando le ore diurne di
//    QUESTA registrazione a quelle "ordinario" già registrate nello stesso giorno,
//    l'eccedenza oltre le 8h diventa automaticamente 'straordinario'.
// La regola scatta SOLO quando tipo è 'ordinario' (o omesso, che equivale a
// 'ordinario'): gli altri tipi sono una scelta esplicita dell'operaio, mai toccata.
const NIGHT_START_MINUTES = 22 * 60; // 22:00
const NIGHT_END_MINUTES = 6 * 60; // 06:00 (il giorno dopo, la fascia attraversa la mezzanotte)
const DAILY_ORDINARY_CAP_HOURS = 8;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Quante ore di un turno [startTime, startTime+durationHours) cadono nella fascia
// notturna 22:00-06:00. Attraversa la mezzanotte camminando a segmenti (giorno/notte)
// finché non si esaurisce la durata — corretto anche per turni molto lunghi o che
// attraversano più volte il confine (raro ma non impossibile con un errore di battitura).
function nightHoursInShift(startTime: string, durationHours: number): number {
  const durationMinutes = Math.round(durationHours * 60);
  let cursor = parseTimeToMinutes(startTime);
  let remaining = durationMinutes;
  let nightMinutes = 0;
  while (remaining > 0) {
    const timeOfDay = ((cursor % 1440) + 1440) % 1440;
    const isNight = timeOfDay >= NIGHT_START_MINUTES || timeOfDay < NIGHT_END_MINUTES;
    const minutesToBoundary = isNight
      ? timeOfDay < NIGHT_END_MINUTES
        ? NIGHT_END_MINUTES - timeOfDay
        : 1440 - timeOfDay + NIGHT_END_MINUTES
      : NIGHT_START_MINUTES - timeOfDay;
    const step = Math.min(remaining, minutesToBoundary);
    if (isNight) nightMinutes += step;
    cursor += step;
    remaining -= step;
  }
  return nightMinutes / 60;
}

// Helper: carica i materiali di un time_log e li allega alla riga pubblica. Accetta
// `db` o un client di transazione (vedi tipo Queryable sopra).
async function loadMaterials(queryable: Queryable, timeLogId: string): Promise<PublicTimeLog['materials']> {
  const rows = await queryable
    .select()
    .from(timeLogMaterials)
    .where(eq(timeLogMaterials.timeLogId, timeLogId));
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    quantity: m.quantity, // numeric -> stringa
    unit: m.unit,
  }));
}

function toPublicTimeLog(row: typeof timeLogs.$inferSelect, materials: PublicTimeLog['materials']): PublicTimeLog {
  const { ...publicRow } = row;
  return { ...publicRow, materials };
}

export async function listTimeLogs(
  page: number,
  limit: number,
  companyId: string,
  opts?: { taskId?: string; userId?: string; callerRole?: string; callerId?: string },
): Promise<PaginatedTimeLogs> {
  const offset = (page - 1) * limit;
  // Un operaio vede SOLO le proprie ore; gli altri ruoli (admin/PM) vedono tutto
  // della loro azienda (e possono filtrare per userId esplicito se fornito).
  // Se chi chiama è un operaio, il filtro userId viene FORZATO al suo id (non può
  // spiare le ore dei colleghi, anche se passasse userId nel query string).
  const scopedUserId = isManager(opts?.callerRole ?? '')
    ? opts?.userId
    : opts?.callerId;
  const conditions = [
    eq(timeLogs.companyId, companyId),
    ...(opts?.taskId ? [eq(timeLogs.taskId, opts.taskId)] : []),
    ...(scopedUserId ? [eq(timeLogs.userId, scopedUserId)] : []),
  ];

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(timeLogs)
      .where(and(...conditions))
      .orderBy(desc(timeLogs.date))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(timeLogs)
      .where(and(...conditions)),
  ]);

  const withMaterials = await Promise.all(rows.map(async (r) => toPublicTimeLog(r, await loadMaterials(db, r.id))));
  return { timeLogs: withMaterials, total: count, page, limit };
}

export async function getTimeLogById(id: string, companyId: string, actingUser: AuthenticatedUser): Promise<PublicTimeLog> {
  const [row] = await db
    .select()
    .from(timeLogs)
    .where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Consuntivo non trovato');
  }
  // Stesso controllo di updateTimeLog/deleteTimeLog sotto: un non-manager vede SOLO le
  // proprie ore. Prima il controllo viveva nella route e testava solo role==='operaio',
  // lasciando resource/qa/stakeholder leggere le ore di un collega per id diretto anche
  // se la lista (GET senza id) già li limitava alle proprie — stessa risorsa, due regole.
  if (!isManager(actingUser.role) && row.userId !== actingUser.id) {
    throw new ForbiddenError('Puoi vedere solo le tue ore');
  }
  return toPublicTimeLog(row, await loadMaterials(db, row.id));
}

function validateMaterials(materials: CreateMaterialInput[] | undefined): void {
  if (!materials) return;
  for (const m of materials) {
    if (!m.name || m.name.trim().length === 0) {
      throw new ValidationError('Ogni materiale deve avere un nome');
    }
    if (!QTY_REGEX.test(String(m.quantity)) || Number(m.quantity) <= 0) {
      throw new ValidationError('La quantità del materiale deve essere un numero decimale positivo');
    }
  }
}

// Inserisce una riga time_log + (facoltativamente) i suoi materiali, in un unico punto
// così createTimeLog può chiamarlo più volte quando l'ora "ordinario" viene divisa.
async function insertTimeLogRow(
  companyId: string,
  taskId: string,
  targetUserId: string,
  tipo: string,
  hoursWorked: number,
  date: string,
  startTime: string | null,
  endTime: string | null,
  workDescription: string | null,
  notes: string | null,
  materialsInput: CreateMaterialInput[] | undefined,
): Promise<PublicTimeLog> {
  const [row] = await db
    .insert(timeLogs)
    .values({
      companyId,
      taskId,
      userId: targetUserId,
      tipo: tipo as (typeof timeLogs.$inferInsert)['tipo'],
      hoursWorked: hoursWorked.toFixed(2),
      date,
      startTime,
      endTime,
      workDescription,
      notes,
    })
    .returning();

  let materials: PublicTimeLog['materials'] = [];
  if (materialsInput && materialsInput.length > 0) {
    const inserted = await db
      .insert(timeLogMaterials)
      .values(
        materialsInput.map((m) => ({
          companyId,
          timeLogId: row.id,
          name: m.name.trim(),
          quantity: m.quantity,
          unit: m.unit ?? 'pz',
        })),
      )
      .returning();
    materials = inserted.map((m) => ({ id: m.id, name: m.name, quantity: m.quantity, unit: m.unit }));
  }

  return toPublicTimeLog(row, materials);
}

export async function createTimeLog(
  input: CreateTimeLogInput,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PublicTimeLog[]> {
  if (!HOURS_REGEX.test(input.hoursWorked)) {
    throw new ValidationError('hoursWorked deve essere un numero decimale (es. "2.5")');
  }
  if (Number(input.hoursWorked) <= 0) {
    throw new ValidationError('hoursWorked deve essere maggiore di zero');
  }
  validateMaterials(input.materials);

  const tipo = input.tipo ?? 'ordinario';

  // Un operaio può registrare SOLO le proprie ore: il userId viene forzato a chi
  // effettua la chiamata, ignorando qualsiasi valore nel body (anti-tampering).
  // Admin/PM possono registrare ore per conto di un altro utente della stessa azienda,
  // ma se non lo specificano (es. dalla pagina Operaio, che non lo invia mai mancando
  // di una guardia di ruolo) registrano per sé stessi — mai lasciare targetUserId
  // undefined: finirebbe in un confronto eq(users.id, undefined) più sotto, che il
  // driver Postgres rifiuta con un errore non gestito (500 invece di un 400/comportamento
  // sensato), riprodotto dal vivo in FASE 5 con l'esatto payload di OperaioPage.
  const targetUserId = isManager(actingUser.role) ? (input.userId ?? actingUser.id) : actingUser.id;

  // Il task padre deve esistere E appartenere alla stessa azienda (no cross-tenant).
  // Join con projects per conoscere lo stato del cantiere: serve al controllo subito
  // sotto, stessa regola già applicata in tasks.service.ts.createTask.
  const [task] = await db
    .select({ id: tasks.id, projectStatus: projects.status })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!task) {
    throw new NotFoundError('Task padre non trovato');
  }
  // Cantiere chiuso ("completed"): non si registrano più ore. "blocked" escluso di
  // proposito, stessa decisione di createTask — un cantiere bloccato può ripartire.
  if (task.projectStatus === 'completed') {
    throw new ConflictError('Il cantiere è chiuso: non si possono registrare nuove ore. Riaprilo prima di continuare.');
  }
  // L'utente destinatario deve esistere (e non essere cancellabile se ha consuntivi: restrict FK).
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.companyId, companyId)))
    .limit(1);
  if (!user) {
    throw new NotFoundError('Utente non trovato');
  }

  const startTime = input.startTime ?? null;
  const endTime = input.endTime ?? null;
  const workDescription = input.workDescription ?? null;
  const notes = input.notes ?? null;

  if (tipo !== 'ordinario') {
    // Tipo scelto esplicitamente dall'operaio (straordinario/notturno/festivo/
    // permesso/ferie): nessun automatismo, si registra esattamente come richiesto.
    const row = await insertTimeLogRow(
      companyId, input.taskId, targetUserId, tipo, Number(input.hoursWorked), input.date,
      startTime, endTime, workDescription, notes, input.materials,
    );
    return [row];
  }

  // --- tipo === 'ordinario': split automatico notturno + tetto giornaliero 8h ---
  const totalHours = Number(input.hoursWorked);

  // Senza ora di inizio nessun automatismo è possibile (deciso con l'utente il
  // 19/08): né la fascia notturna (serve sapere QUANDO comincia il turno) né il
  // tetto 8h/giorno (stessa decisione, per coerenza — vedi updateTimeLog più sotto,
  // che applica la stessa condizione). Le ore restano integralmente 'ordinario' su
  // UNA sola riga, anche oltre le 8h.
  if (!startTime) {
    const row = await insertTimeLogRow(
      companyId, input.taskId, targetUserId, 'ordinario', totalHours, input.date,
      null, endTime, workDescription, notes, input.materials,
    );
    return [row];
  }

  const nightHours = round2(nightHoursInShift(startTime, totalHours));
  const dayHours = round2(totalHours - nightHours);

  // Ore "ordinario" già registrate da questo utente in questa data (solo tipo
  // ordinario: il notturno è un contenitore separato, non concorre al tetto).
  // Lettura non lockata: due submit concorrenti dello STESSO operaio per lo STESSO
  // giorno potrebbero in teoria leggere lo stesso totale e sforare lievemente il
  // tetto — scenario molto improbabile (un solo operaio registra le proprie ore) e
  // comunque non distruttivo (nessun vincolo DB violato, solo un arrotondamento del
  // conteggio), quindi non giustifica la complessità di una transazione con lock qui.
  const [existingRow] = await db
    .select({ sum: sql<string>`coalesce(sum(${timeLogs.hoursWorked}::numeric), 0)::text` })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.userId, targetUserId),
        eq(timeLogs.companyId, companyId),
        eq(timeLogs.date, input.date),
        eq(timeLogs.tipo, 'ordinario'),
      ),
    );
  const existingOrdinario = Number(existingRow?.sum ?? '0');

  let ordinarioPortion = dayHours;
  let straordinarioPortion = 0;
  if (dayHours > 0 && existingOrdinario + dayHours > DAILY_ORDINARY_CAP_HOURS) {
    ordinarioPortion = round2(Math.max(0, DAILY_ORDINARY_CAP_HOURS - existingOrdinario));
    straordinarioPortion = round2(dayHours - ordinarioPortion);
  }

  const portions: { tipo: string; hours: number }[] = [];
  if (ordinarioPortion > 0) portions.push({ tipo: 'ordinario', hours: ordinarioPortion });
  if (nightHours > 0) portions.push({ tipo: 'notturno', hours: nightHours });
  if (straordinarioPortion > 0) portions.push({ tipo: 'straordinario', hours: straordinarioPortion });
  // Nel caso limite in cui, per arrotondamento, nessuna porzione risulti positiva
  // (non dovrebbe succedere con hoursWorked > 0 validato sopra), non si perdono ore:
  // si registra tutto come ordinario, comportamento pre-esistente prima di questa regola.
  if (portions.length === 0) portions.push({ tipo: 'ordinario', hours: totalHours });

  // I materiali e la descrizione del lavoro appartengono alla registrazione nel suo
  // insieme, non a una singola porzione: vanno SOLO sulla prima riga creata, altrimenti
  // finirebbero duplicati nei totali materiale del cantiere (getProjectDetail somma
  // per time_log, non per registrazione "logica").
  //
  // endTime segue una regola diversa da startTime, e non per svista: startTime è vero
  // per ogni porzione (il turno È iniziato a quell'ora, chiunque lo guardi). endTime
  // duplicato identico su ogni porzione è invece un dato oggettivamente falso — una
  // porzione da 2h che dichiara la stessa finestra di una porzione da 8h (misurato in
  // FASE 5: 30h di lavoro producevano 3 righe che dichiaravano TUTTE "08:00→17:00").
  // Con più di una porzione non si conosce il confine reale tra l'una e l'altra (lo
  // split è per tipo/soglia oraria, non per fascia oraria effettiva), quindi endTime
  // resta null su ogni riga generata invece di mentire su tutte. Su una registrazione
  // che NON si divide (portions.length === 1) resta l'informazione vera che l'operaio
  // ha scritto.
  const isSplit = portions.length > 1;
  const rows: PublicTimeLog[] = [];
  for (let i = 0; i < portions.length; i++) {
    const portion = portions[i];
    const row = await insertTimeLogRow(
      companyId, input.taskId, targetUserId, portion.tipo, portion.hours, input.date,
      startTime, isSplit ? null : endTime, workDescription, notes, i === 0 ? input.materials : undefined,
    );
    rows.push(row);
  }
  return rows;
}

export async function updateTimeLog(
  id: string,
  input: UpdateTimeLogInput,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PublicTimeLog> {
  // Transazione + FOR UPDATE: due modifiche concorrenti sulla stessa riga (es. un
  // admin che corregge mentre l'operaio la modifica a sua volta) vengono serializzate
  // da Postgres, stesso idioma già in uso in questo progetto (users.service.ts,
  // projects.service.ts) — prima updateTimeLog non ne aveva bisogno perché toccava
  // solo la riga stessa; ora aggiorna anche timeLogMaterials e (per un manager che
  // modifica ore non sue) audit_log nella stessa operazione logica: o tutto o niente.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(timeLogs)
      .where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)))
      .for('update')
      .limit(1);
    if (!existing) {
      throw new NotFoundError('Consuntivo non trovato');
    }

    // Un operaio può modificare SOLO le proprie ore.
    if (!isManager(actingUser.role) && existing.userId !== actingUser.id) {
      throw new ForbiddenError('Puoi modificare solo le tue ore');
    }

    // Ore già allegate a un rapportino in firma o firmato: non si toccano. Lo snapshot
    // congelato conserva ciò che il cliente ha visto, ma senza questo blocco le ore vere
    // potrebbero cambiare sotto quel documento e il firmato risulterebbe smentito dal
    // database. Dentro la transazione e DOPO il FOR UPDATE qui sopra: leggerlo prima
    // lascerebbe aperta la finestra in cui un rapportino viene creato tra il controllo e
    // la scrittura. Vale anche per un admin — per lui esiste POST /rapportini/:id/sblocca.
    await assertOreNonBloccateDaRapportino(tx, existing.rapportinoId, companyId);

    const patch: Record<string, unknown> = {};
    if (input.tipo !== undefined) patch.tipo = input.tipo;
    if (input.hoursWorked !== undefined) {
      if (!HOURS_REGEX.test(input.hoursWorked) || Number(input.hoursWorked) <= 0) {
        throw new ValidationError('hoursWorked deve essere un numero decimale positivo');
      }
      patch.hoursWorked = input.hoursWorked;
    }
    if (input.date !== undefined) patch.date = input.date;
    // Aggiornamento diretto del campo, senza ripetere lo split automatico notturno/
    // straordinario: quello scatta solo alla creazione (vedi createTimeLog). Modificare
    // un orario già registrato non deve silenziosamente far comparire nuove righe.
    if (input.startTime !== undefined) patch.startTime = input.startTime;
    if (input.endTime !== undefined) patch.endTime = input.endTime;
    if (input.workDescription !== undefined) patch.workDescription = input.workDescription;
    if (input.notes !== undefined) patch.notes = input.notes;

    // Cantiere/lavoro di destinazione: il task deve esistere ed essere della stessa
    // azienda (stesso controllo già fatto in createTimeLog). "Sposta questa
    // registrazione sul cantiere giusto" è il caso d'uso principale per cui questo
    // campo esiste — prima non aveva alcun effetto (vedi commento sul bug in
    // timeLogs.types.ts).
    if (input.taskId !== undefined) {
      const [task] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, companyId)))
        .limit(1);
      if (!task) {
        throw new NotFoundError('Task padre non trovato');
      }
      patch.taskId = input.taskId;
    }

    // Riassegnazione a un altro dipendente: SOLO admin/PM. Per un operaio il valore
    // viene ignorato (non rifiutato con un errore) — sta comunque modificando solo
    // righe sue, coerente con l'anti-tampering già applicato a CreateTimeLogInput.userId
    // in createTimeLog.
    let effectiveUserId = existing.userId;
    if (input.userId !== undefined && isManager(actingUser.role)) {
      const [targetUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.companyId, companyId)))
        .limit(1);
      if (!targetUser) {
        throw new NotFoundError('Utente non trovato');
      }
      patch.userId = input.userId;
      effectiveUserId = input.userId;
    }

    if (Object.keys(patch).length === 0 && input.materials === undefined) {
      throw new ValidationError('Nessun campo fornito per l\'aggiornamento');
    }

    // Il tetto 8h/giorno "ordinario" scattava solo alla CREAZIONE (lo split sopra
    // deliberatamente non si ripete, vedi commento su startTime/endTime): un operaio
    // poteva creare 9h (split 8+1) e poi con un PATCH portare la riga "ordinario" a
    // 20h, che restava 20h senza rispezzare — la regola di business si aggirava in due
    // passaggi. Non rispezza in più righe (cambierebbe il contratto della risposta,
    // oggi una singola riga): blocca l'aggiornamento se il risultato sfora il tetto.
    //
    // Calcolato sull'utente e sulla data EFFETTIVI (dopo un'eventuale riassegnazione),
    // non su quelli originali della riga: altrimenti spostare una registrazione su un
    // dipendente che ha già 8h quel giorno scavalcherebbe il suo tetto invece di farlo
    // scattare.
    const effectiveTipo = input.tipo ?? existing.tipo;
    // Stessa condizione di createTimeLog: senza un'ora di inizio nota per questa
    // registrazione, il tetto 8h/giorno non scatta (deciso con l'utente il 19/08) —
    // altrimenti una riga creata senza automatismo (perché mancava l'ora di inizio)
    // diventerebbe correggibile solo entro il tetto, un vincolo mai applicato alla
    // sua creazione. `input.startTime` può essere `null` esplicito (l'operaio lo
    // svuota in questo stesso PATCH): in quel caso vale il nuovo valore, non quello
    // vecchio della riga.
    const effectiveStartTime = input.startTime !== undefined ? input.startTime : existing.startTime;
    if (effectiveTipo === 'ordinario' && effectiveStartTime) {
      const effectiveDate = input.date ?? existing.date;
      const effectiveHours = Number(input.hoursWorked ?? existing.hoursWorked);
      const [otherOrdinaryRow] = await tx
        .select({ sum: sql<string>`coalesce(sum(${timeLogs.hoursWorked}::numeric), 0)::text` })
        .from(timeLogs)
        .where(
          and(
            eq(timeLogs.userId, effectiveUserId),
            eq(timeLogs.companyId, companyId),
            eq(timeLogs.date, effectiveDate),
            eq(timeLogs.tipo, 'ordinario'),
            ne(timeLogs.id, id),
          ),
        );
      const otherOrdinaryHours = Number(otherOrdinaryRow?.sum ?? '0');
      if (otherOrdinaryHours + effectiveHours > DAILY_ORDINARY_CAP_HOURS) {
        throw new ValidationError(
          `Superato il tetto di ${DAILY_ORDINARY_CAP_HOURS}h ordinario/giorno ` +
            `(già registrate ${round2(otherOrdinaryHours)}h su altre righe di questo giorno). ` +
            'La quota eccedente va registrata come "straordinario", non aggiunta qui.',
        );
      }
    }

    if (Object.keys(patch).length > 0) {
      await tx
        .update(timeLogs)
        .set(patch)
        .where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)));
    }

    // I materiali in update sono un REPLACE dell'intera lista: semplice e prevedibile
    // per chi corregge un errore. Niente merge complicato.
    let materials: PublicTimeLog['materials'] = [];
    if (input.materials !== undefined) {
      validateMaterials(input.materials);
      await tx.delete(timeLogMaterials).where(eq(timeLogMaterials.timeLogId, id));
      if (input.materials.length > 0) {
        const inserted = await tx
          .insert(timeLogMaterials)
          .values(
            input.materials.map((m) => ({
              companyId,
              timeLogId: id,
              name: m.name.trim(),
              quantity: m.quantity,
              unit: m.unit ?? 'pz',
            })),
          )
          .returning();
        materials = inserted.map((m) => ({ id: m.id, name: m.name, quantity: m.quantity, unit: m.unit }));
      }
    } else {
      materials = await loadMaterials(tx, id);
    }

    const [updated] = await tx
      .select()
      .from(timeLogs)
      .where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)))
      .limit(1);

    // Traccia di audit SOLO quando chi modifica non è il proprietario originale della
    // riga — oggi significa sempre "un admin/PM ha corretto le ore di un operaio" (un
    // operaio non può toccare righe altrui, il controllo di ruolo sopra lo impedisce).
    // Un admin che riscrive le ore di un collega senza lasciare traccia è il genere di
    // cosa che si mette il primo giorno, non si aggiunge dopo un contenzioso.
    if (actingUser.id !== existing.userId) {
      await recordAudit({
        companyId,
        userId: actingUser.id,
        action: 'UPDATE',
        entityType: 'time_log',
        entityId: id,
        changes: { before: existing, after: updated },
      });
    }

    return toPublicTimeLog(updated, materials);
  });
}

export async function deleteTimeLog(id: string, companyId: string, actingUser: AuthenticatedUser): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(timeLogs)
      .where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)))
      .for('update')
      .limit(1);
    if (!existing) {
      throw new NotFoundError('Consuntivo non trovato');
    }
    // Un operaio può cancellare SOLO le proprie ore; admin/PM cancellano tutto.
    if (!isManager(actingUser.role) && existing.userId !== actingUser.id) {
      throw new ForbiddenError('Puoi eliminare solo le tue ore');
    }
    // Stesso lucchetto di updateTimeLog, e a maggior ragione: cancellare una riga
    // allegata a un rapportino firmato farebbe sparire dal database un'ora che il
    // cliente ha sottoscritto (vedi assertOreNonBloccateDaRapportino).
    await assertOreNonBloccateDaRapportino(tx, existing.rapportinoId, companyId);
    // CASCADE rimuove anche i time_log_materials figli.
    await tx.delete(timeLogs).where(and(eq(timeLogs.id, id), eq(timeLogs.companyId, companyId)));

    // Stessa traccia di audit di updateTimeLog: solo quando chi cancella non è il
    // proprietario originale della riga (sempre un admin/PM che tocca ore non sue).
    if (actingUser.id !== existing.userId) {
      await recordAudit({
        companyId,
        userId: actingUser.id,
        action: 'DELETE',
        entityType: 'time_log',
        entityId: id,
        changes: { before: existing },
      });
    }
  });
}
