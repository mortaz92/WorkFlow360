import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { getAuditLogById, listAuditLogs } from './auditLog.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  entityType: z.string().max(100).optional(),
  userId: z.string().uuid().optional(),
});

const idParamSchema = z.string().uuid();

function parseId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID audit non valido');
  }
  return parsed.data;
}

export const auditLogRouter = Router();

// L'audit log è append-only: l'API espone SOLO lettura. La scrittura avviene
// internamente via recordAudit() (Fase 25-27), mai esposta a un endpoint mutante.
// Solo admin/project_manager (coerente con CLAUDE.md, che lo documenta così): prima
// era aperto a chiunque autenticato, in contraddizione con la documentazione — il
// changesJson di una voce di audit può contenere qualunque payload prima/dopo.
auditLogRouter.use('/', requireAuth, requireRole('admin', 'project_manager'));

auditLogRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }
    const { page, limit, entityType, userId } = parsed.data;
    const result = await listAuditLogs(page, limit, req.user.companyId, {
      ...(entityType ? { entityType } : {}),
      ...(userId ? { userId } : {}),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

auditLogRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id);
    const row = await getAuditLogById(id, req.user.companyId);
    res.json({ auditLog: row });
  } catch (err) {
    next(err);
  }
});
