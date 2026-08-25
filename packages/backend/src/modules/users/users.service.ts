import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { refreshTokens, users } from '../../core/db/schema';
import { BCRYPT_COST } from '../../core/constants';
import { isUniqueViolation } from '../../core/db/isUniqueViolation';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { recordAudit } from '../auditLog/auditLog.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { CreateUserInput, PaginatedUsers, PublicUser, UpdateUserInput } from './users.types';

// Limite di utenti "socio/admin" per azienda: ogni azienda può avere al massimo 3
// account di accesso (es. 3 soci). Gli operai sono aggiunti dopo e NON rientrano
// in questo tetto (il tetto riguarda chi gestisce l'azienda nel sistema).
export const MAX_USERS_PER_COMPANY = 3;

// Suffisso dell'email sintetica assegnata a un utente anonimizzato. Ha due compiti:
// soddisfare il vincolo UNIQUE su users.email senza occupare un indirizzo che qualcuno
// potrebbe voler usare davvero, ed essere il MODO in cui riconosciamo un utente già
// anonimizzato (nessuna colonna in più nello schema). Il dominio finisce in `.local`,
// che per RFC 6762 non è instradabile: nessuna email potrà mai partire verso un
// indirizzo di questa forma nemmeno per errore.
const ANONYMIZED_EMAIL_SUFFIX = '@anonimizzato.workflow360.local';

// Testo che sostituisce il nome reale: è lo stesso che il frontend annuncia nella
// conferma di rimozione (packages/frontend/src/pages/DipendenteDetailPage.tsx,
// "l'account diventerà «Utente rimosso»"), non un segnaposto scelto qui.
const ANONYMIZED_NAME = 'Utente rimosso';

// Byte di casualità per la password "morta" di un utente anonimizzato: non deve essere
// indovinabile né riutilizzabile, non deve mai autenticare nessuno.
const DEAD_PASSWORD_BYTES = 32;

function isAnonymized(email: string): boolean {
  return email.toLowerCase().endsWith(ANONYMIZED_EMAIL_SUFFIX);
}

function toPublicUser(user: typeof users.$inferSelect): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export async function listUsers(page: number, limit: number, companyId: string): Promise<PaginatedUsers> {
  const offset = (page - 1) * limit;

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(users).where(eq(users.companyId, companyId)).orderBy(users.createdAt).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(eq(users.companyId, companyId)),
  ]);

  return { users: rows.map(toPublicUser), total: count, page, limit };
}

export async function getUserById(id: string, companyId: string): Promise<PublicUser> {
  const [user] = await db.select().from(users).where(and(eq(users.id, id), eq(users.companyId, companyId))).limit(1);
  if (!user) {
    throw new NotFoundError('Utente non trovato');
  }
  return toPublicUser(user);
}

// Nessuna guardia anti-lockout qui: creare un utente è un'operazione additiva, non può
// mai far scendere il numero di admin attivi (a differenza di updateUser sotto).
export async function createUser(input: CreateUserInput, companyId: string): Promise<PublicUser> {
  // Tetto massimo 3 utenti "socio/admin" per azienda: ogni azienda può avere al
  // massimo 3 account con ruolo admin (es. 3 soci che gestiscono). Gli altri ruoli
  // (operai, resource, qa, project_manager) non rientrano in questo tetto e sono
  // illimitati, perché il limite riguarda chi amministra l'azienda nel sistema —
  // per questo il controllo si applica SOLO quando si sta creando un nuovo admin.
  if (input.role === 'admin') {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.role, 'admin')));
    if (count >= MAX_USERS_PER_COMPANY) {
      throw new ConflictError(
        `Limite massimo di ${MAX_USERS_PER_COMPANY} utenti amministratori per azienda raggiunto. ` +
          `Per aggiungere un nuovo amministratore, rimuovi un account esistente.`,
      );
    }
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  try {
    const [user] = await db
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        department: input.department,
        companyId,
        passwordHash,
      })
      .returning();
    return toPublicUser(user);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ValidationError('Email già registrata');
    }
    throw err;
  }
}

// Sottoinsieme del client Drizzle usato dalle guardie qui sotto (sole letture): permette
// di passare indifferentemente `db` o il client di transazione `tx`, senza dover nominare
// il tipo interno di db.transaction. Stesso espediente di `Queryable` in timeLogs.service.ts.
type Queryable = Pick<typeof db, 'select'>;

// Cosa sta facendo il chiamante: NON è deducibile dal solo target, perché le due guardie
// qui sotto non si applicano negli stessi casi — l'auto-blocco vale per la disattivazione
// ma NON per la retrocessione di ruolo su se stessi, che arriva fino al conteggio degli
// admin attivi (differenza da cui dipende il test di isolamento multi-tenant in
// users.test.ts, vedi il suo commento). Solo chi chiama sa quale operazione sta
// compiendo, quindi lo dichiara esplicitamente.
interface RemoveAdminAccessIntent {
  isDeactivating: boolean;
  isDemotingFromAdmin: boolean;
  // Verbo usato nel messaggio d'errore: chi preme "Elimina" non deve leggere "non puoi
  // disattivare", e viceversa. Cambia solo il testo, mai la regola applicata.
  azione: 'disattivare' | 'anonimizzare';
}

// Guardie anti-lockout condivise da OGNI operazione che può togliere a un admin l'accesso
// al sistema: la disattivazione/retrocessione (updateUser) e l'anonimizzazione GDPR
// (anonymizeUser). Stanno in un punto solo perché l'invariante "resta sempre almeno un
// admin attivo per azienda" non deve poter divergere tra i percorsi che la devono
// rispettare — è esattamente il tipo di regola che si dimentica di replicare quando se ne
// aggiunge uno nuovo, e il prezzo dell'errore è un lock-out irreversibile via API.
async function assertCanRemoveAdminAccess(
  tx: Queryable,
  target: typeof users.$inferSelect,
  actingUser: AuthenticatedUser,
  intent: RemoveAdminAccessIntent,
): Promise<void> {
  // Agire su se stessi è bloccato sempre, indipendentemente dal ruolo: previene
  // l'errore comune di un admin che clicca sul proprio utente pensando sia un altro.
  if (intent.isDeactivating && actingUser.id === target.id) {
    throw new ForbiddenError(`Non puoi ${intent.azione} il tuo stesso account`);
  }

  // Invariante da proteggere: esiste sempre almeno un admin attivo PER AZIENDA —
  // azzerarli è un lock-out irreversibile via API (richiederebbe accesso diretto al DB).
  // Si applica sia alla disattivazione sia alla retrocessione di ruolo dell'ultimo admin.
  // Scoped a companyId: senza, il conteggio era globale su tutte le aziende — un admin
  // con colleghi attivi nella PROPRIA azienda poteva disattivare l'unico admin di
  // un'azienda diversa, perché il conteggio globale restava comunque > 1 (se stesso +
  // il bersaglio), mai realmente a guardia dell'azienda del bersaglio.
  if ((intent.isDeactivating || intent.isDemotingFromAdmin) && target.role === 'admin' && target.active) {
    const activeAdmins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true), eq(users.companyId, actingUser.companyId)))
      .for('update');

    if (activeAdmins.length <= 1) {
      throw new ForbiddenError("Non puoi rimuovere l'ultimo admin attivo dell'azienda");
    }
  }
}

// Usata da PATCH /:id, incluso il caso `active:false` (sospensione reversibile, es. un
// dipendente in aspettativa che si vuole riattivare dopo mantenendo nome ed email).
// La cancellazione vera dei dati personali è un'altra operazione: vedi anonymizeUser.
export async function updateUser(id: string, input: UpdateUserInput, actingUser: AuthenticatedUser): Promise<PublicUser> {
  return db.transaction(async (tx) => {
    // FOR UPDATE blocca la riga target per la durata della transazione: due richieste
    // concorrenti che toccano lo stesso utente vengono serializzate da Postgres, non
    // corrono entrambe sulla stessa lettura "ancora admin attivo". companyId nella
    // WHERE (non solo un controllo dopo la lettura): senza, un admin di un'azienda
    // poteva leggere/modificare l'utente di un'altra azienda conoscendone solo l'id —
    // stesso pattern già corretto in auditLog.service.ts nella stessa sessione.
    const [target] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, actingUser.companyId)))
      .for('update')
      .limit(1);
    if (!target) {
      throw new NotFoundError('Utente non trovato');
    }

    const isDeactivating = input.active === false && target.active;
    const isDemotingFromAdmin = input.role !== undefined && input.role !== 'admin' && target.role === 'admin';
    const isPromotingToAdmin = input.role === 'admin' && target.role !== 'admin';

    await assertCanRemoveAdminAccess(tx, target, actingUser, {
      isDeactivating,
      isDemotingFromAdmin,
      azione: 'disattivare',
    });

    // Stesso tetto di createUser (MAX_USERS_PER_COMPANY), qui applicato alla PROMOZIONE:
    // createUser lo controllava solo alla creazione, quindi si aggirava creando un
    // utente con un altro ruolo e promuovendolo subito dopo via PATCH — verificato che
    // funzionava (portata un'azienda di test da 2 a 5 admin). Stesso conteggio (tutti
    // gli admin, non solo quelli attivi: un admin disattivato occupa comunque un posto).
    if (isPromotingToAdmin) {
      // Niente .for('update') qui: Postgres non lo permette su una query con count(*)
      // (errore 0A000, "FOR UPDATE is not allowed with aggregate functions") — stesso
      // motivo per cui createUser(), che fa lo stesso conteggio, non lo usa. Il FOR
      // UPDATE sopra (riga target) basta comunque a serializzare due PATCH concorrenti
      // sullo stesso utente; una race tra due PROMOZIONI DIVERSE nello stesso istante
      // resta teoricamente possibile ma non distruttiva (stesso margine già accettato
      // in createUser per la creazione).
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.companyId, actingUser.companyId), eq(users.role, 'admin')));
      if (count >= MAX_USERS_PER_COMPANY) {
        throw new ConflictError(
          `Limite massimo di ${MAX_USERS_PER_COMPANY} utenti amministratori per azienda raggiunto. ` +
            `Per promuovere questo utente, rimuovi prima un amministratore esistente.`,
        );
      }
    }

    // Stessa cattura di createUser: senza, un'email già in uso da un altro utente
    // risponderebbe con un 500 generico invece di un errore chiaro (l'unico punto che
    // scriveva email prima d'ora era createUser, che questa cattura ce l'ha già).
    try {
      const [updated] = await tx
        .update(users)
        .set(input)
        .where(and(eq(users.id, id), eq(users.companyId, actingUser.companyId)))
        .returning();
      return toPublicUser(updated);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ValidationError('Email già registrata');
      }
      throw err;
    }
  });
}

/**
 * Cancellazione dei dati personali di un dipendente (DELETE /:id), cioè il diritto alla
 * cancellazione GDPR applicato a questo dominio.
 *
 * Non è un DELETE di riga: la riga utente resta, perché le ore lavorate sono collegate a
 * `userId` e vanno conservate per gli obblighi contabili. Restano quindi i dati NON
 * identificativi (id, azienda, ruolo, date) e spariscono quelli identificativi (nome,
 * email, reparto). Il ruolo NON si tocca, deliberatamente: serve alle statistiche
 * aggregate e da solo non identifica nessuno.
 *
 * Distinta dalla disattivazione semplice (PATCH /:id con `active:false`), che è
 * reversibile e mantiene nome ed email — es. un dipendente in aspettativa. Questa non è
 * reversibile: dopo, il nome e l'email originali non esistono più da nessuna parte, audit
 * log compreso (vedi `changes` più sotto).
 */
export async function anonymizeUser(id: string, actingUser: AuthenticatedUser): Promise<PublicUser> {
  const anonymized = await db.transaction(async (tx) => {
    // Stesso pattern di updateUser: FOR UPDATE per serializzare le richieste concorrenti
    // sulla stessa riga, companyId dentro la WHERE per non poter mai toccare l'utente di
    // un'altra azienda conoscendone solo l'id.
    const [target] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.companyId, actingUser.companyId)))
      .for('update')
      .limit(1);
    if (!target) {
      throw new NotFoundError('Utente non trovato');
    }

    // isDeactivating è SEMPRE vero: l'anonimizzazione implica la disattivazione, non
    // esiste una versione "anonimizza ma lascialo entrare". isDemotingFromAdmin resta
    // falso perché il ruolo non viene toccato.
    await assertCanRemoveAdminAccess(tx, target, actingUser, {
      isDeactivating: true,
      isDemotingFromAdmin: false,
      azione: 'anonimizzare',
    });

    // Rianonimizzare non è idempotente — riscriverebbe l'email sintetica (che dipende
    // dall'id, quindi resterebbe identica) ma soprattutto genererebbe un nuovo hash e una
    // nuova voce di audit per dati che non ci sono più: rumore su un'operazione che, per
    // definizione, si può fare una volta sola. Meglio un errore esplicito.
    if (isAnonymized(target.email)) {
      throw new ConflictError('Utente già anonimizzato');
    }

    // Password "morta": un hash di un valore casuale che nessuno conosce e che non viene
    // mai restituito. Non serve a farci entrare qualcuno, serve a garantire che la vecchia
    // password non resti valida in nessuna forma — un hash bcrypt è un dato personale
    // quanto basta (permette di verificare una password indovinata).
    const passwordHash = await bcrypt.hash(crypto.randomBytes(DEAD_PASSWORD_BYTES).toString('hex'), BCRYPT_COST);

    let updatedUser: typeof users.$inferSelect;
    try {
      // Email derivata dall'id (non casuale, non progressiva): l'id è già unico per
      // costruzione, quindi il vincolo UNIQUE è soddisfatto senza dover riprovare in caso
      // di collisione, e ripetere il calcolo dà sempre lo stesso valore.
      const [updated] = await tx
        .update(users)
        .set({
          name: ANONYMIZED_NAME,
          email: `deleted-${id}${ANONYMIZED_EMAIL_SUFFIX}`,
          department: null,
          active: false,
          passwordHash,
        })
        .where(and(eq(users.id, id), eq(users.companyId, actingUser.companyId)))
        .returning();
      updatedUser = updated;
    } catch (err) {
      // In teoria irraggiungibile (l'email sintetica dipende da un id univoco), ma un 500
      // generico su un'operazione irreversibile è il peggior modo per scoprire che la
      // teoria era sbagliata — stessa cattura già usata da createUser/updateUser.
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          "Anonimizzazione non riuscita: l'email sintetica di questo utente risulta già assegnata a un altro account.",
        );
      }
      throw err;
    }

    // Nella STESSA transazione dell'anonimizzazione: un utente i cui dati sono stati
    // cancellati non deve poter rinnovare una sessione ancora aperta. Stesso pattern di
    // resetPassword in auth.service.ts. L'access token già emesso scade da sé entro
    // JWT_ACCESS_EXPIRES_IN e nel frattempo non passa comunque (auth.middleware rilegge
    // `active` dal DB), ma il refresh token vivrebbe giorni.
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));

    return toPublicUser(updatedUser);
  });

  // Dopo il commit, non dentro la transazione: recordAudit scrive con `db` e non con il
  // client `tx` (vale anche dove è chiamata da timeLogs.service.ts, dove si trova dentro
  // il blocco ma su un'altra connessione), quindi la voce di audit non fa comunque parte
  // della transazione — meglio che questo sia visibile dalla struttura del codice.
  // La cancellazione dei dati è la parte critica: un errore qui non deve annullarla né
  // far fallire la richiesta, la voce di audit è accessoria.
  try {
    await recordAudit({
      companyId: actingUser.companyId,
      userId: actingUser.id,
      action: 'DELETE',
      entityType: 'users',
      entityId: id,
      // Solo il fatto, MAI i valori precedenti: un audit log che conserva il vecchio nome
      // o la vecchia email vanificherebbe l'anonimizzazione (i dati personali sarebbero
      // ancora nel database, solo in un'altra tabella). Chi ha agito e quando restano
      // tracciati; su chi, solo l'id — che non identifica una persona da solo.
      changes: { anonymized: true },
    });
  } catch (err) {
    console.error(`[USERS] Utente ${id} anonimizzato, ma la voce di audit non è stata registrata:`, err);
  }

  return anonymized;
}
