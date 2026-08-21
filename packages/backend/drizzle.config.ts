import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

// Stessa logica di caricamento di src/core/config/index.ts: drizzle-kit esegue
// questo file con cwd = packages/backend, quindi il .env di root va risolto da lì.
const envPath = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

if (!process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL non impostata (atteso in ${envPath} o nell'ambiente)`);
}

export default {
  schema: './src/core/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
} satisfies Config;
