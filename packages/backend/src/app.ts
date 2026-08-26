import express, { type Express, type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { sql } from 'drizzle-orm';
import { CONFIG } from './core/config';
import { db } from './core/db';
import { requestLogger } from './core/middleware/requestLogger';
import { notFoundHandler } from './core/middleware/notFoundHandler';
import { errorHandler } from './core/middleware/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { projectsRouter } from './modules/projects/projects.routes';
import { tasksRouter } from './modules/tasks/tasks.routes';
import { timeLogsRouter } from './modules/timeLogs/timeLogs.routes';
import { correctionsRouter } from './modules/corrections/corrections.routes';
import { auditLogRouter } from './modules/auditLog/auditLog.routes';
import { companiesRouter } from './modules/companies/companies.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { rapportiniRouter } from './modules/rapportini/rapportini.routes';

// Il middleware cors() qui sotto chiude già ogni richiesta OPTIONS con 204 prima che
// raggiunga express.json()/i router (vedi sorgente di `cors`, che risponde e non chiama
// next() per il preflight) — quindi un OPTIONS non arriva mai davvero a questi limiter.
// Lo skip resta come difesa in profondità: se un domani cors() venisse configurato con
// `preflightContinue: true` o riordinato, un vero preflight tornerebbe a consumare budget.
const skipPreflight = (req: Request): boolean => req.method === 'OPTIONS';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Un solo posto che sa come si forma un limiter: i cinque di sotto differiscono solo per
// il limite numerico e il messaggio, e prima di questa funzione ripetevano cinque volte
// anche il formato standard dell'errore — con il rischio concreto che una modifica futura
// a quel formato ne aggiornasse quattro su cinque per distrazione.
function createRateLimiter(limit: number, message: string) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipPreflight,
    message: { error: { code: 'RATE_LIMIT_EXCEEDED', message, details: {} } },
  });
}

// Limite generico anti-flood su tutta l'API. L'health check (GET /api/v1/health,
// interrogato ogni pochi minuti da un monitor esterno tipo UptimeRobot, vedi
// GUIDA-DEPLOY.md) è registrato PRIMA di questo limiter più sotto, quindi non lo
// attraversa affatto — niente skip da tenere sincronizzato con la rotta.
const apiRateLimiter = createRateLimiter(300, 'Troppe richieste. Riprova più tardi.');

// Limite molto più stretto sul login: rallenta il credential stuffing / brute
// force senza dipendere dal limite generico, pensato per traffico normale.
const loginRateLimiter = createRateLimiter(10, 'Troppi tentativi di accesso. Riprova più tardi.');

// Molto stretto: senza, l'endpoint diventerebbe un modo economico per bombardare di
// email una casella nota (o, con un provider a pagamento, per far spendere credito
// all'azienda). Il limite basso è accettabile perché nell'uso reale nessuno chiede
// "password dimenticata" più di poche volte in un quarto d'ora.
const forgotPasswordRateLimiter = createRateLimiter(5, 'Troppe richieste di recupero password. Riprova più tardi.');

// Più permissivo del forgot-password perché qui serve già possedere un token valido
// (arrivato via email): il limite protegge dal brute-force sul token, non dallo spam.
const resetPasswordRateLimiter = createRateLimiter(10, 'Troppi tentativi. Riprova più tardi.');

// Firma pubblica del rapportino: stessa natura del reset-password (chi chiama possiede
// già un token valido, il limite protegge dal brute-force sul token, non dallo spam) ma
// più permissivo, 20 invece di 10. In cantiere l'intera squadra è dietro un solo IP —
// hotspot del capocantiere o NAT del cliente — e un limite stretto bloccherebbe le firme
// legittime dei colleghi invece di un attaccante.
const firmaRapportinoRateLimiter = createRateLimiter(20, 'Troppi tentativi di firma. Riprova più tardi.');

// Il PNG di una firma tracciata su un tablet può superare i 100KB che express.json()
// accetta di default, e un corpo rifiutato per dimensione arriverebbe come 413 proprio
// mentre il cliente sta firmando. Il limite più alto vale SOLO per questa rotta.
const FIRMA_BODY_LIMIT = '1mb';

// Più stretto del limite generico: la gestione utenti è riservata agli admin e non
// dovrebbe generare traffico paragonabile al resto dell'API — un limite più basso
// rende più costosa un'enumerazione degli utenti (via GET /:id) da un admin
// compromesso, senza intralciare l'uso amministrativo normale.
const usersRateLimiter = createRateLimiter(100, 'Troppe richieste sulla gestione utenti. Riprova più tardi.');

export function createApp(): Express {
  const app = express();

  // Dietro il proxy di Render l'IP del client sta in X-Forwarded-For: senza questo,
  // express-rate-limit vedrebbe l'IP del proxy per tutti e limiterebbe il mondo intero
  // come se fosse un unico utente. Il valore è 1 (un solo hop di proxy davanti) e NON
  // `true`: con `true` ci si fiderebbe di qualunque X-Forwarded-For inoltrato, che è un
  // modo banale per falsificare il proprio IP e azzerare il rate limiting a ogni richiesta.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Nessun header Origin (curl, health check, richieste server-to-server): consentito.
        if (!origin || CONFIG.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // `callback(null, false)`, MAI un Error: con un Error, cors() chiama next(err) e
        // salta dritto all'error handler, bypassando i rate limiter (montati dopo, righe
        // sotto) — un origin non consentita diventerebbe un modo gratis per aggirare il
        // rate limiting, oltre a scrivere uno stack trace nei log ad ogni tentativo. Con
        // `false` la richiesta prosegue senza header CORS (il browser la blocca comunque
        // lato client) ma passa regolarmente dai limiter come qualunque altra richiesta.
        console.warn(`[CORS] Origin non consentita: ${origin}`);
        callback(null, false);
      },
      credentials: true,
      // Il browser mette in cache l'esito del preflight per un giorno invece di rifarlo
      // prima di ogni POST/PATCH/DELETE: in produzione (frontend e backend su domini
      // diversi) dimezza il numero di richieste e il tempo di attesa dell'utente.
      maxAge: 86400,
    }),
  );
  // PRIMA di express.json() globale, e non è indifferente: body-parser marca la
  // richiesta con req._body appena l'ha letta, e ogni parser successivo la salta senza
  // rileggerla. Se il parser globale (limite 100KB) girasse per primo, una firma da
  // 300KB verrebbe rifiutata con 413 prima ancora di arrivare al parser da 1MB, che non
  // avrebbe mai occasione di parlare. L'ordine QUI è il meccanismo, non uno stile.
  app.use('/api/v1/rapportini/firma', express.json({ limit: FIRMA_BODY_LIMIT }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestLogger);

  // Registrata PRIMA di apiRateLimiter (non dopo, con uno skip da tenere sincronizzato
  // con la rotta): un monitor esterno come UptimeRobot la interroga ogni pochi minuti, e
  // un 429 qui farebbe considerare il servizio "giù" con un riavvio inutile.
  app.get('/api/v1/health', async (_req, res, next) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok', env: CONFIG.NODE_ENV, db: 'connected' });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/', apiRateLimiter);
  app.use('/api/v1/auth/login', loginRateLimiter);
  app.use('/api/v1/auth/forgot-password', forgotPasswordRateLimiter);
  app.use('/api/v1/auth/reset-password', resetPasswordRateLimiter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRateLimiter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/projects', projectsRouter);
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/time-logs', timeLogsRouter);
  app.use('/api/v1/corrections', correctionsRouter);
  app.use('/api/v1/audit-logs', auditLogRouter);
  app.use('/api/v1/companies', companiesRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/rapportini/firma', firmaRapportinoRateLimiter);
  app.use('/api/v1/rapportini', rapportiniRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
