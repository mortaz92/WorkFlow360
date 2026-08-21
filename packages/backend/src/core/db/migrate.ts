import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { CONFIG } from '../config';

async function runMigrations(): Promise<void> {
  const migrationClient = postgres(CONFIG.DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  console.log('[DB] Applico le migrazioni...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[DB] Migrazioni applicate con successo.');

  await migrationClient.end();
}

runMigrations().catch((err) => {
  console.error('[DB] Errore durante la migrazione:', err);
  process.exit(1);
});
