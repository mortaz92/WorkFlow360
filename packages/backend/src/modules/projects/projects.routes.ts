import { Router } from 'express';
import { z } from 'zod';
import { projectStatusEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { MANAGER_ROLES } from '../../core/roles';
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectsSummary,
  listProjects,
  updateProject,
} from './projects.service';

const statusEnum = z.enum(projectStatusEnum.enumValues);
const tipoCommessaEnum = z.enum(['contratto', 'consuntivo']);

// Scritto a mano dall'admin, facoltativo: una stringa vuota (campo lasciato bianco nel
// form) equivale a "nessun codice", non a un codice letterale "" — senza questa
// normalizzazione il primo cantiere senza codice passerebbe e il secondo violerebbe
// l'UNIQUE su (company_id, code) con un errore che sembra un bug del programma.
const codeSchema = z
  .string()
  .max(50)
  .nullable()
  .optional()
  .transform((val) => {
    if (val == null) return val;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

// Stessa normalizzazione di codeSchema, per la stessa ragione: un campo lasciato bianco
// nel form arriva come "" e deve valere "nessun indirizzo", non un indirizzo vuoto — sul
// rapportino la differenza è fra stampare il trattino e stampare una riga vuota.
// Il tetto di lunghezza vive QUI e non in colonna (la colonna è `text`): così una stringa
// troppo lunga diventa un 400 con messaggio, non un 22001 del driver travestito da 500.
const addressSchema = z
  .string()
  .max(500)
  .nullable()
  .optional()
  .transform((val) => {
    if (val == null) return val;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  code: codeSchema,
  address: addressSchema,
  description: z.string().max(2000).optional(),
  status: statusEnum.optional(),
  tipoCommessa: tipoCommessaEnum.optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
});

const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    code: codeSchema,
    address: addressSchema,
    description: z.string().max(2000).nullable().optional(),
    status: statusEnum.optional(),
    tipoCommessa: tipoCommessaEnum.optional(),
    startDate: z.string().date().nullable().optional(),
    endDate: z.string().date().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Almeno un campo deve essere fornito per l\'aggiornamento',
  });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tipoCommessa: tipoCommessaEnum.optional(),
  // Stringa separata da virgole ("completed,blocked") invece di status[]=...: coerente
  // con come i browser/client compongono già gli altri query param di questo progetto
  // (un solo parametro, non un array ripetuto).
  status: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(statusEnum))
    .optional(),
});

const idParamSchema = z.string().uuid();

function parseProjectId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID progetto non valido');
  }
  return parsed.data;
}

export const projectsRouter = Router();

// Lettura: qualsiasi utente autenticato può vedere i progetti (pattern di trasparenza
// del team: il consuntivo è visibile, la scrittura è riservata). Scrittura: solo
// admin/manager (MANAGER_ROLES).
projectsRouter.use('/', requireAuth);

projectsRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }
    const result = await listProjects(parsed.data.page, parsed.data.limit, req.user.companyId, {
      tipoCommessa: parsed.data.tipoCommessa,
      status: parsed.data.status,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Registrata PRIMA di '/:id': altrimenti Express instraderebbe "summary" lì dentro,
// trattandolo come un id non valido — stessa trappola già nota in questo progetto
// (tasks.routes.ts, '/assignable-users'). Lettura aperta a chiunque sia autenticato,
// stesso livello di fiducia di GET '/' e GET '/:id' qui sopra (il dato che riassume è
// già leggibile riga per riga da chiunque).
projectsRouter.get('/summary', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const summary = await getProjectsSummary(req.user.companyId);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

projectsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseProjectId(req.params.id);
    const project = await getProjectById(id, req.user.companyId);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

// Da qui in poi: solo admin/manager.
projectsRouter.use('/', requireRole(...MANAGER_ROLES));

projectsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati progetto non validi', parsed.error.flatten().fieldErrors);
    }
    const project = await createProject(parsed.data, req.user.companyId);
    res.status(201).json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = parseProjectId(req.params.id);
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di aggiornamento non validi', parsed.error.flatten().fieldErrors);
    }
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    const project = await updateProject(id, parsed.data, req.user.companyId);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = parseProjectId(req.params.id);
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }
    await deleteProject(id, req.user, req.user.companyId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
