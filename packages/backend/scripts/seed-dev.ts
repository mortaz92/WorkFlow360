// Seed di sviluppo: crea un'azienda demo + un admin con password nota + un cantiere + un task.
// USO: cd packages/backend && npx tsx scripts/seed-dev.ts
// NON usare in produzione — vedi la guardia in cima a main(), che blocca l'esecuzione da
// sola invece di fidarsi solo di questo commento.
import { db } from '../src/core/db';
import { companies, users, projects, tasks } from '../src/core/db/schema';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { BCRYPT_COST } from '../src/core/constants';

// Password nota pubblicamente (è scritta qui sotto) su un'azienda/admin demo: NON deve
// mai poter toccare un database vero. Il commento da solo non è una protezione — durante
// il deploy si passa DATABASE_URL di produzione nell'ambiente della shell (vedi
// GUIDA-DEPLOY.md, Passo 7) e quella variabile resta attiva per tutta la sessione del
// terminale: un lancio successivo e disattento di questo script scriverebbe sul database
// vero. Blocca su NODE_ENV=production E, indipendentemente da quello, su qualunque host
// del database diverso da locale — la seconda condizione protegge anche quando NODE_ENV
// non è stata impostata (caso comune quando si passano solo le env var necessarie).
function refuseIfNotLocal(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('[SEED-DEV] NODE_ENV=production: questo script crea un admin con password nota, mai su un ambiente di produzione. Interrotto.');
    process.exit(1);
  }
  const rawUrl = process.env.DATABASE_URL;
  const host = rawUrl ? new URL(rawUrl).hostname : '';
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error(`[SEED-DEV] DATABASE_URL punta a "${host || '(non impostata)'}", non a un database locale. Interrotto per sicurezza.`);
    console.error('[SEED-DEV] Questo script è solo per lo sviluppo locale. Per il primo admin in produzione usa: npm run bootstrap:admin');
    process.exit(1);
  }
}

async function main() {
  refuseIfNotLocal();

  const companyName = process.env.SEED_COMPANY ?? 'Neotekna SRL';
  // trim+lowercase: stessa normalizzazione di emailSchema (core/validation.ts), qui
  // fatta a mano perché questo script non passa da Zod — un'email demo scritta con un
  // case diverso da SEED_EMAIL creerebbe lo stesso bug "credenziali non valide al
  // login" già visto in produzione con bootstrap-admin.
  const adminEmail = (process.env.SEED_EMAIL ?? 'admin@neotekna.it').trim().toLowerCase();
  const adminPassword = process.env.SEED_PASSWORD ?? 'Admin123!';
  const adminName = process.env.SEED_NAME ?? 'Admin Neotekna';

  const [company] = await db
    .insert(companies)
    .values({ id: randomUUID(), name: companyName, vat: 'IT00000000', email: adminEmail })
    .onConflictDoNothing()
    .returning();

  const companyId = company?.id ?? (await db.select().from(companies).where(eq(companies.name, companyName)))[0].id;

  const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_COST);
  await db
    .insert(users)
    .values({ id: randomUUID(), email: adminEmail, name: adminName, role: 'admin', companyId, passwordHash })
    .onConflictDoNothing();

  const [project] = await db
    .insert(projects)
    .values({ id: randomUUID(), companyId, name: 'Cantiere Centro', tipoCommessa: 'consuntivo', clientName: 'Comune XY', status: 'in_progress' })
    .onConflictDoNothing()
    .returning();

  const projectId = project?.id ?? (await db.select().from(projects).where(eq(projects.name, 'Cantiere Centro')))[0].id;

  // Un task di esempio così l'operaio ha su cosa registrare le ore.
  await db
    .insert(tasks)
    .values({ id: randomUUID(), companyId, projectId, title: 'Installazione impianto', status: 'in_progress', priority: 'media' })
    .onConflictDoNothing();

  console.log('Seed completato:');
  console.log(`  Azienda: ${companyName}`);
  console.log(`  Admin:   ${adminEmail} (password: quella in SEED_PASSWORD, o il default nel sorgente di questo script)`);
  console.log(`  Cantiere: Cantiere Centro (${projectId}) + 1 task di esempio`);
  console.log('  Operaio demo: operaio@neotekna.it / Operaio123! (crealo da dashboard admin)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
