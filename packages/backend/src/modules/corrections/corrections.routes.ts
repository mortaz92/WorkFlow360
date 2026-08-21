import { Router } from 'express';
import { z } from 'zod';
import { correctionSeverityEnum, correctionStatusEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { MANAGER_ROLES } from '../../core/roles';
import { createCorrection, deleteCorrection, getCorrectionById, listCorrections, updateCorrection } from './corrections.service';

const statusEnum = z.enum(correctionStatusEnum.enumValues);
const severityEnum = z.enum(correctionSeverityEnum.enumValues);

const createSchema = z.object({
  taskId: z.string().uuid(),
  reportedBy: z.string().uuid(),
  description: z.string().min(1).max(2000),
  status: statusEnum.optional(),
  severity: severityEnum.optional(),
});

const updateSchema = z
  .object({
    description: z.string().min(1).max(2000).optional(),
    status: statusEnum.optional(),
    severity: severityEnum.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Almeno un campo deve essere fornito per l\'aggiornamento',
  });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  taskId: z.string().uuid().optional(),
});

const idParamSchema = z.string().uuid();

function parseId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID correzione non valido');
  }
  return parsed.data;
}

export const correctionsRouter = Router();

// Lettura E scrittura: admin/project_manager (MANAGER_ROLES). Il ruolo 'qa'
// era incluso prima del 20/08 (creava le correzioni) — rimosso insieme a resource/
// stakeholder, decisione dell'utente di semplificare i ruoli del prodotto.
correctionsRouter.use('/', requireAuth, requireRole(...MANAGER_ROLES));

correctionsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }
    const result = await listCorrections(parsed.data.page, parsed.data.limit, req.user.companyId, parsed.data.taskId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

correctionsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id);
    const row = await getCorrectionById(id, req.user.companyId);
    res.json({ correction: row });
  } catch (err) {
    next(err);
  }
});

correctionsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati correzione non validi', parsed.error.flatten().fieldErrors);
    }
    const row = await createCorrection(parsed.data, req.user.companyId);
    res.status(201).json({ correction: row });
  } catch (err) {
    next(err);
  }
});

correctionsRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di aggiornamento non validi', parsed.error.flatten().fieldErrors);
    }
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    const row = await updateCorrection(id, parsed.data, req.user.companyId);
    res.json({ correction: row });
  } catch (err) {
    next(err);
  }
});

correctionsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    await deleteCorrection(id, req.user.companyId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
