import { Router } from 'express';
import { z } from 'zod';
import { projectStatusEnum, taskPriorityEnum, taskStatusEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { MANAGER_ROLES } from '../../core/roles';
import { createTask, deleteTask, getTaskById, listAssignableUsers, listTasks, updateTask } from './tasks.service';

const statusEnum = z.enum(taskStatusEnum.enumValues);
const priorityEnum = z.enum(taskPriorityEnum.enumValues);

const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  dueDate: z.string().date().nullable().optional(),
  hoursEstimated: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
});

const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    status: statusEnum.optional(),
    priority: priorityEnum.optional(),
    dueDate: z.string().date().nullable().optional(),
    hoursEstimated: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Almeno un campo deve essere fornito per l\'aggiornamento',
  });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
});

const idParamSchema = z.string().uuid();

function parseTaskId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID task non valido');
  }
  return parsed.data;
}

export const tasksRouter = Router();

// Lettura: qualsiasi utente autenticato. Scrittura: admin/project_manager.
tasksRouter.use('/', requireAuth);

tasksRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }
    const result = await listTasks(parsed.data.page, parsed.data.limit, req.user.companyId, parsed.data.projectId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Registrata PRIMA di GET /:id: essendo una stringa fissa e non un UUID, Express
// la instraderebbe altrimenti verso /:id (che la tratterebbe come un id non valido).
// Ristretta a MANAGER_ROLES con middleware diretto sulla rotta, non con lo
// use('/', requireRole(...)) più sotto — quello scatta dopo GET /:id ed è pensato
// per scrittura, mentre qui è comunque una lettura ma più mirata di GET /:id.
tasksRouter.get('/assignable-users', requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const assignableUsers = await listAssignableUsers(req.user.companyId);
    res.json({ users: assignableUsers });
  } catch (err) {
    next(err);
  }
});

tasksRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseTaskId(req.params.id);
    const task = await getTaskById(id, req.user.companyId);
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.use('/', requireRole(...MANAGER_ROLES));

tasksRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati task non validi', parsed.error.flatten().fieldErrors);
    }
    const task = await createTask(parsed.data, req.user.companyId);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di aggiornamento non validi', parsed.error.flatten().fieldErrors);
    }
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    const task = await updateTask(id, parsed.data, req.user.companyId);
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    await deleteTask(id, req.user.companyId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
