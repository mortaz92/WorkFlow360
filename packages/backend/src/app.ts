import express, { type Express } from 'express';
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

// Limite generico anti-flood su tutta l'API.
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Troppe richieste. Riprova più tardi.',
      details: {},
    },
  },
});

// Limite molto più stretto sul login: rallenta il credential stuffing / brute
// force senza dipendere dal limite generico, pensato per traffico normale.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Troppi tentativi di accesso. Riprova più tardi.',
      details: {},
    },
  },
});

// Molto stretto: senza, l'endpoint diventerebbe un modo economico per bombardare di
// email una casella nota (o, con un provider a pagamento, per far spendere credito
// all'azienda). Il limite basso è accettabile perché nell'uso reale nessuno chiede
// "password dimenticata" più di poche volte in un quarto d'ora.
const forgotPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Troppe richieste di recupero password. Riprova più tardi.',
      details: {},
    },
  },
});

// Più permissivo del forgot-password perché qui serve già possedere un token valido
// (arrivato via email): il limite protegge dal brute-force sul token, non dallo spam.
const resetPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Troppi tentativi. Riprova più tardi.',
      details: {},
    },
  },
});

// Più stretto del limite generico: la gestione utenti è riservata agli admin e non
// dovrebbe generare traffico paragonabile al resto dell'API — un limite più basso
// rende più costosa un'enumerazione degli utenti (via GET /:id) da un admin
// compromesso, senza intralciare l'uso amministrativo normale.
const usersRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Troppe richieste sulla gestione utenti. Riprova più tardi.',
      details: {},
    },
  },
});

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Nessun header Origin (curl, health check, richieste server-to-server): consentito.
        if (!origin || CONFIG.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin non consentita: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestLogger);
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

  app.get('/api/v1/health', async (_req, res, next) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok', env: CONFIG.NODE_ENV, db: 'connected' });
    } catch (err) {
      next(err);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
