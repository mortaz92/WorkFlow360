// Seed di sviluppo: crea un'azienda demo + un admin con password nota + un cantiere + un task.
// USO: cd packages/backend && npx tsx scripts/seed-dev.ts
// NON usare in produzione.
import { db } from '../src/core/db';
import { companies, users, projects, tasks } from '../src/core/db/schema';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

async function main() {
  const companyName = process.env.SEED_COMPANY ?? 'Neotekna SRL';
  const adminEmail = process.env.SEED_EMAIL ?? 'admin@neotekna.it';
  const adminPassword = process.env.SEED_PASSWORD ?? 'Admin123!';
  const adminName = process.env.SEED_NAME ?? 'Admin Neotekna';

  const [company] = await db
    .insert(companies)
    .values({ id: randomUUID(), name: companyName, vat: 'IT00000000', email: adminEmail })
    .onConflictDoNothing()
    .returning();

  const companyId = company?.id ?? (await db.select().from(companies).where(eq(companies.name, companyName)))[0].id;

  const passwordHash = await bcrypt.hash(adminPassword, 10);
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
  console.log(`  Admin:   ${adminEmail} / ${'*'.repeat(adminPassword.length)}`);
  console.log(`  Cantiere: Cantiere Centro (${projectId}) + 1 task di esempio`);
  console.log('  Operaio demo: operaio@neotekna.it / Operaio123! (crealo da dashboard admin)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
