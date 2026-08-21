import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { MANAGER_ROLES } from '../../core/roles';
import {
  getHoursByProject,
  getHoursByUser,
  getProjectDetail,
  getUserTimeLogDetail,
  getProjectTimeline,
  type DateRange,
} from './reports.service';

const idParamSchema = z.string().uuid();

function parseId(id: string, label: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError(`${label} non valido`);
  }
  return parsed.data;
}

// Periodo opzionale, stessa forma su tutti e cinque i read di questo router: assente =
// tutto lo storico (comportamento invariato). Un range invertito (from > to) risponde
// con un errore esplicito invece di restituire silenziosamente zero ore — in un
// contesto di calcolo busta paga "0 ore" si legge come "non ha lavorato", non come
// "richiesta malformata".
const rangeQuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'Il periodo "from" deve essere precedente o uguale a "to"',
  });

function parseRange(query: unknown): DateRange | undefined {
  const parsed = rangeQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Periodo non valido');
  }
  const { from, to } = parsed.data;
  if (!from || !to) return undefined;
  return { from, to };
}

// ?archived=true seleziona le ore ARCHIVIATE (mese chiuso da 15+ giorni o cantiere
// completato) invece di quelle attive — stesso endpoint, stesso shape di risposta,
// così il frontend riusa lo stesso componente tabella per entrambe le viste.
function parseArchived(query: unknown): boolean {
  return (query as Record<string, unknown> | undefined)?.archived === 'true';
}

const reportsRouter = Router();

// Solo autenticati; i report sono sensibili: li vede chi gestisce (admin/project_manager).
// Un operaio NON deve vedere le ore dei colleghi -> 403.
reportsRouter.use('/', requireAuth);
reportsRouter.use('/', requireRole(...MANAGER_ROLES));

reportsRouter.get('/hours-by-project', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const range = parseRange(req.query);
    const rows = await getHoursByProject(req.user.companyId, range, { archived: parseArchived(req.query) });
    res.json({ reports: rows });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/hours-by-user', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const range = parseRange(req.query);
    const rows = await getHoursByUser(req.user.companyId, range, { archived: parseArchived(req.query) });
    res.json({ reports: rows });
  } catch (err) {
    next(err);
  }
});

// Dettaglio di un cantiere: stato, ore per singolo dipendente coinvolto, materiale
// totale usato.
reportsRouter.get('/projects/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id, 'ID cantiere');
    const range = parseRange(req.query);
    const detail = await getProjectDetail(id, req.user.companyId, range);
    res.json({ project: detail });
  } catch (err) {
    next(err);
  }
});

// Registro cronologico dettagliato di un cantiere (Archivio): ogni ora/materiale/
// dipendente nel tempo, paginato. Stesso periodo opzionale degli altri endpoint.
reportsRouter.get('/projects/:id/timeline', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id, 'ID cantiere');
    const range = parseRange(req.query);
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      throw new ValidationError('Parametro "page" non valido');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ValidationError('Parametro "limit" non valido');
    }
    const timeline = await getProjectTimeline(id, req.user.companyId, { page, limit, range });
    res.json(timeline);
  } catch (err) {
    next(err);
  }
});

// Dettaglio di un dipendente: tutte le sue ore con cantiere/lavoro associato, più
// scomposizione per tipo.
reportsRouter.get('/users/:id/time-logs', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id, 'ID dipendente');
    const range = parseRange(req.query);
    const detail = await getUserTimeLogDetail(id, req.user.companyId, range);
    res.json({ user: detail });
  } catch (err) {
    next(err);
  }
});

export { reportsRouter };
