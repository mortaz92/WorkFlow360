import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { BCRYPT_COST } from '../constants';
import { db } from './index';
import { users } from './schema';

// Utility di solo sviluppo: crea un utente admin per poter testare il login
// prima che esista la CRUD utenti vera (Fase 7-9, "admin only" — qui non c'è
// ancora un admin da cui partire). Non è un endpoint API, va lanciata a mano.
const SEED_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@workflow360.local';
const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

async function seed(): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, SEED_EMAIL)).limit(1);

  if (existing.length > 0) {
    console.log(`[SEED] Utente admin già presente (${SEED_EMAIL}), nessuna azione.`);
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
  await db.insert(users).values({
    email: SEED_EMAIL,
    passwordHash,
    name: 'Admin',
    role: 'admin',
  });

  // Niente password in chiaro nei log: chi lancia il seed conosce già la variabile
  // d'ambiente (o il default) che l'ha impostata — stamparla rischia di finire in un
  // sistema di raccolta log condiviso.
  console.log(`[SEED] Utente admin creato: ${SEED_EMAIL}`);
  console.log('[SEED] Solo per sviluppo locale — la gestione utenti reale arriva in Fase 7-9.');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SEED] Errore:', err);
    process.exit(1);
  });
