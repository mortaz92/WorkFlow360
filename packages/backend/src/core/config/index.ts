import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

// Il monorepo ha un unico .env alla radice (accanto a docker-compose.yml).
// npm workspaces esegue "dev"/"start" con cwd = packages/backend, quindi saliamo
// da lì (non da __dirname, che dipende dalla profondità del file e si rompe al primo refactor).
// In produzione (Render, Docker, CI) le variabili arrivano spesso iniettate nell'ambiente
// senza un file .env: in quel caso non è un errore, si procede e la validazione Zod sotto
// segnalerà comunque, con un messaggio chiaro, quali variabili mancano davvero.
const envPath = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn(`[CONFIG] File .env non trovato in ${envPath}: leggo le variabili già presenti nell'ambiente.`);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL è obbligatoria'),
  // HS256 è sicuro solo con un segreto ad alta entropia: 32 caratteri è il minimo
  // per avvicinarsi ai 256 bit raccomandati (genera con: openssl rand -base64 32).
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET deve avere almeno 32 caratteri (openssl rand -base64 32)'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET deve avere almeno 32 caratteri (openssl rand -base64 32)'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Origini ammesse per CORS, separate da virgola. In sviluppo punta al dev server Vite (Fase 10+);
  // in produzione va impostata esplicitamente sul dominio reale del frontend, mai lasciata permissiva.
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  // Recupero password (19/08) — MAI obbligatoria: un backend che si rifiuta di avviarsi
  // (incluso nei test) perché manca una funzione accessoria come l'invio email sarebbe
  // peggio del problema che risolve. Senza chiave, requestPasswordReset logga e non invia,
  // ma risponde comunque 200 (anti-enumerazione invariata).
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('WorkFlow360 <onboarding@resend.dev>'),
  // Base per costruire il link nell'email di reset — MAI ricavata dall'header
  // Host/Origin della richiesta (controllato dal client, diventerebbe un modo per far
  // arrivare all'utente un link verso un dominio altrui con dentro un token valido).
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  PASSWORD_RESET_EXPIRES_IN: z.string().default('1h'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("[CONFIG] Variabili d'ambiente mancanti o non valide:\n");
  const fieldErrors = parsedEnv.error.flatten().fieldErrors;
  for (const [field, messages] of Object.entries(fieldErrors)) {
    console.error(`  - ${field}: ${(messages ?? []).join(', ')}`);
  }
  console.error('\n[CONFIG] Correggi le variabili in .env (vedi .env.example) e riavvia.');
  process.exit(1);
}

export const CONFIG = Object.freeze({
  ...parsedEnv.data,
  corsOrigins: parsedEnv.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
});
