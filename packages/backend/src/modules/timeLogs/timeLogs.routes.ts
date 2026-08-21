import { Router } from 'express';
import { z } from 'zod';
import { timeLogTypeEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { allowSelfOrManager, requireAuth, requireRole } from '../auth/auth.middleware';
import { MANAGER_ROLES } from '../../core/roles';
import { createTimeLog, deleteTimeLog, getTimeLogById, listTimeLogs, updateTimeLog } from './timeLogs.service';

const HOURS = z.string().regex(/^\d+(\.\d{1,2})?$/, 'deve essere un numero decimale');
const QTY = z.string().regex(/^\d+(\.\d{1,3})?$/, 'deve essere un numero decimale');
const tipoEnum = z.enum(timeLogTypeEnum.enumValues);
// HH:MM 24h, coerente col tipo "time" di Postgres senza i secondi. Usato sia per
// startTime che per endTime.
const TIME_HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'deve essere un orario HH:MM (es. 08:00)');

const materialSchema = z.object({
  name: z.string().min(1).max(255),
  quantity: QTY,
  unit: z.string().max(32).optional().default('pz'),
});

const createSchema = z.object({
  taskId: z.string().uuid(),
  // userId opzionale: l'operaio NON lo invia (il service forza il proprio id);
  // admin/PM possono registrarlo per conto di un altro utente.
  userId: z.string().uuid().optional(),
  hoursWorked: HOURS,
  date: z.string().date(),
  tipo: tipoEnum.optional(),
  // Facoltativa anche per tipo 'ordinario' (deciso con l'utente il 19/08): se assente,
  // né la fascia notturna né il tetto 8h/giorno vengono calcolati automaticamente — le
  // ore restano registrate integralmente sotto il tipo scelto (vedi createTimeLog).
  startTime: TIME_HHMM.optional(),
  // Sempre facoltativo, anche per tipo='ordinario' — a differenza di startTime non
  // alimenta alcun calcolo automatico, è solo un'informazione aggiuntiva (vedi
  // endTime in timeLogs.ts e createTimeLog in timeLogs.service.ts).
  endTime: TIME_HHMM.optional(),
  workDescription: z.string().max(4000).optional(),
  notes: z.string().max(2000).optional(),
  materials: z.array(materialSchema).max(100).optional(),
});

const updateSchema = z
  .object({
    // Bug corretto: mancava qui (Zod scartava il campo in silenzio), pur essendo già
    // inviato dal frontend — vedi UpdateTimeLogInput in timeLogs.types.ts.
    taskId: z.string().uuid().optional(),
    // Riassegnazione a un altro dipendente: il service la applica solo per admin/PM.
    userId: z.string().uuid().optional(),
    tipo: tipoEnum.optional(),
    hoursWorked: HOURS.optional(),
    date: z.string().date().optional(),
    startTime: TIME_HHMM.nullable().optional(),
    endTime: TIME_HHMM.nullable().optional(),
    workDescription: z.string().max(4000).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    materials: z.array(materialSchema).max(100).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Almeno un campo deve essere fornito per l\'aggiornamento',
  });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  taskId: z.string().uuid().optional(),
  // Mancava (errore tsc mai notato: parsed.data.userId sotto era sempre `undefined`
  // a runtime, il filtro per un manager che vuole vedere le ore di UN operaio
  // specifico non aveva mai effetto — restituiva sempre tutta l'azienda).
  userId: z.string().uuid().optional(),
});

const idParamSchema = z.string().uuid();

function parseId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID consuntivo non valido');
  }
  return parsed.data;
}

export const timeLogsRouter = Router();

// Lettura: autenticati (tutti i ruoli, incluso operaio).
timeLogsRouter.use('/', requireAuth);

timeLogsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }
    // Un operaio vede solo le proprie ore: passiamo il suo ruolo così il service
    // applica lo scoping. Gli altri ruoli vedono tutto (e possono filrare per userId).
    const result = await listTimeLogs(parsed.data.page, parsed.data.limit, req.user.companyId, {
      taskId: parsed.data.taskId,
      userId: parsed.data.userId,
      callerRole: req.user.role,
      callerId: req.user.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

timeLogsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id);
    // Il controllo self-o-manager vive nel service (getTimeLogById), coerente con
    // update/deleteTimeLog: prima era ripetuto qui e testava solo role==='operaio',
    // lasciando resource/qa/stakeholder leggere le ore di un collega per id diretto.
    const row = await getTimeLogById(id, req.user.companyId, req.user);
    res.json({ timeLog: row });
  } catch (err) {
    next(err);
  }
});

// Scrittura: admin/project_manager, OPPURE operaio (solo per sé stesso).
timeLogsRouter.use('/', allowSelfOrManager('operaio', ...MANAGER_ROLES));

timeLogsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati consuntivo non validi', parsed.error.flatten().fieldErrors);
    }
    // Sempre un array: una singola registrazione "ordinario" può diventare 2-3 righe
    // reali (ordinario/notturno/straordinario) per via dello split automatico — vedi
    // createTimeLog. Per gli altri tipi l'array ha semplicemente un solo elemento.
    const rows = await createTimeLog(parsed.data, req.user.companyId, req.user);
    res.status(201).json({ timeLogs: rows });
  } catch (err) {
    next(err);
  }
});

timeLogsRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di aggiornamento non validi', parsed.error.flatten().fieldErrors);
    }
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    const row = await updateTimeLog(id, parsed.data, req.user.companyId, req.user);
    res.json({ timeLog: row });
  } catch (err) {
    next(err);
  }
});

timeLogsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    await deleteTimeLog(id, req.user.companyId, req.user);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
