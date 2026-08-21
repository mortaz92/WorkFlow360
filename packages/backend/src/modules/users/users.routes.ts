import { Router } from 'express';
import { z } from 'zod';
import { userRoleEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { createUser, getUserById, listUsers, updateUser } from './users.service';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum(userRoleEnum.enumValues),
  department: z.string().max(255).optional(),
  password: z.string().min(8),
});

const updateUserSchema = z
  .object({
    // Facoltativa, a differenza della creazione: l'utente esiste già e cambia solo se
    // qualcuno la fornisce esplicitamente. L'email è anche l'identità di accesso —
    // updateUser() ora cattura la violazione UNIQUE (vedi users.service.ts) per
    // rispondere 400 invece di un 500 generico se la nuova email è già in uso.
    email: z.string().email().optional(),
    name: z.string().min(1).max(255).optional(),
    role: z.enum(userRoleEnum.enumValues).optional(),
    // nullable distinto da optional: null rimuove esplicitamente il department,
    // il campo assente lascia il valore attuale invariato.
    department: z.string().max(255).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Almeno un campo deve essere fornito per l'aggiornamento",
  });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.string().uuid();

// Un :id che non è un UUID (es. "not-a-valid-uuid") arriverebbe intatto a Drizzle,
// che lo passa a Postgres così com'è: Postgres lo rifiuta con un errore di sistema
// (codice 22P02), che senza questo controllo diventa un 500 invece di un 400 —
// un errore del client mascherato da errore del server.
function parseUserId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID utente non valido');
  }
  return parsed.data;
}

export const usersRouter = Router();

// Ogni rotta di questo modulo è riservata agli admin: nessuna eccezione, il CRUD
// utenti non ha un caso d'uso legittimo per ruoli diversi in questa fase.
usersRouter.use(requireAuth, requireRole('admin'));

usersRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di paginazione non validi', parsed.error.flatten().fieldErrors);
    }

    const result = await listUsers(parsed.data.page, parsed.data.limit, req.user.companyId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

usersRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseUserId(req.params.id);
    const user = await getUserById(id, req.user.companyId);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

usersRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati utente non validi', parsed.error.flatten().fieldErrors);
    }

    const user = await createUser(parsed.data, req.user.companyId);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/:id', async (req, res, next) => {
  try {
    const id = parseUserId(req.params.id);
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di aggiornamento non validi', parsed.error.flatten().fieldErrors);
    }

    // req.user non può mancare qui: requireAuth+requireRole (usersRouter.use sopra)
    // lo popolano o interrompono la richiesta prima di questo handler — ma niente
    // "!" per dirlo, un controllo esplicito non si affida all'ordine dei middleware.
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }

    const user = await updateUser(id, parsed.data, req.user);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = parseUserId(req.params.id);
    if (!req.user) {
      throw new Error('req.user non popolato: middleware di autenticazione non applicato');
    }

    const user = await updateUser(id, { active: false }, req.user);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});
