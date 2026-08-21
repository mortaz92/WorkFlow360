import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { users } from '../../core/db/schema';
import { BCRYPT_COST } from '../../core/constants';
import { isUniqueViolation } from '../../core/db/isUniqueViolation';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { CreateUserInput, PaginatedUsers, PublicUser, UpdateUserInput } from './users.types';

// Limite di utenti "socio/admin" per azienda: ogni azienda può avere al massimo 3
// account di accesso (es. 3 soci). Gli operai sono aggiunti dopo e NON rientrano
// in questo tetto (il tetto riguarda chi gestisce l'azienda nel sistema).
export const MAX_USERS_PER_COMPANY = 3;

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

// Usata sia da PATCH /:id (con active:false esplicito) sia da DELETE /:id (soft-delete):
// è la stessa operazione con le stesse guardie, non due varianti — un solo punto dove
// vive la regola "resta sempre almeno un admin attivo" evita che diverga tra i due endpoint.
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

    // Disattivare se stessi è bloccato sempre, indipendentemente dal ruolo: previene
    // l'errore comune di un admin che clicca sul proprio utente pensando sia un altro.
    if (isDeactivating && actingUser.id === target.id) {
      throw new ForbiddenError('Non puoi disattivare il tuo stesso account');
    }

    // Invariante da proteggere: esiste sempre almeno un admin attivo PER AZIENDA —
    // azzerarli è un lock-out irreversibile via API (richiederebbe accesso diretto al DB).
    // Si applica sia alla disattivazione sia alla retrocessione di ruolo dell'ultimo admin.
    // Scoped a companyId: senza, il conteggio era globale su tutte le aziende — un admin
    // con colleghi attivi nella PROPRIA azienda poteva disattivare l'unico admin di
    // un'azienda diversa, perché il conteggio globale restava comunque > 1 (se stesso +
    // il bersaglio), mai realmente a guardia dell'azienda del bersaglio.
    if ((isDeactivating || isDemotingFromAdmin) && target.role === 'admin' && target.active) {
      const activeAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.active, true), eq(users.companyId, actingUser.companyId)))
        .for('update');

      if (activeAdmins.length <= 1) {
        throw new ForbiddenError("Non puoi rimuovere l'ultimo admin attivo dell'azienda");
      }
    }

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
