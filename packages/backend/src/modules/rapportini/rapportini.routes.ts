import { Router } from 'express';
import { z } from 'zod';
import { rapportinoStatusEnum } from '../../core/db/schema';
import { ValidationError } from '../../core/errors';
import { emailSchema } from '../../core/validation';
import { MANAGER_ROLES } from '../../core/roles';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import {
  annullaRapportino,
  anteprimaRapportino,
  createRapportino,
  generaPdfRapportino,
  getRapportinoById,
  listRapportini,
  reinviaEmailRapportino,
  sbloccaRapportino,
  signRapportino,
} from './rapportini.service';

const idParamSchema = z.string().uuid();

function parseId(id: string): string {
  const parsed = idParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError('ID rapportino non valido');
  }
  return parsed.data;
}

const cantiereGiornoSchema = z.object({
  projectId: z.string().uuid(),
  date: z.string().date(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
  date: z.string().date().optional(),
  status: z.enum(rapportinoStatusEnum.enumValues).optional(),
});

const annullaSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const reinviaEmailSchema = z.object({
  email: emailSchema.optional(),
});

// Motivo OBBLIGATORIO, a differenza dell'annullamento: sbloccare toglie il vincolo a ore
// che un cliente ha già sottoscritto, ed è l'unica operazione di questo modulo che può
// far divergere le ore dal documento firmato. Deve restare scritto perché è stata fatta.
const sbloccaSchema = z.object({
  reason: z.string().min(1).max(2000),
});

const firmaSchema = z.object({
  // Il token viaggia nel CORPO, non nell'URL, esattamente come quello di
  // POST /auth/reset-password: requestLogger (core/middleware) scrive `req.originalUrl`
  // a ogni richiesta, quindi un token nel percorso finirebbe in chiaro nei log del
  // server a ogni tentativo — inclusi quelli falliti, dove il token è tipicamente ancora
  // valido e non consumato, e i log di Render sono leggibili da chiunque abbia accesso
  // alla dashboard. Un token opaco base64url: il tetto di lunghezza serve solo a
  // scartare subito payload assurdi prima di calcolarne l'hash.
  token: z.string().min(1).max(255),
  firmatarioNome: z.string().min(1).max(255),
  firmatarioEmail: emailSchema,
  // Nessun limite di lunghezza qui: la validazione vera (prefisso, byte magici PNG,
  // intestazione IHDR, dimensione massima) vive in validaFirmaPng nel service, che sa
  // dire con precisione cosa non va. Il tetto duro sulla dimensione lo mette già
  // express.json({limit:'1mb'}) montato su questa rotta in app.ts.
  firmaPng: z.string().min(1),
  // Facoltativo (client vecchi non lo mandano): quando presente deve combaciare con
  // l'id risolto dal token, verificato in signRapportino — vedi il commento lì per lo
  // scenario che questo chiude.
  rapportinoId: z.string().uuid().optional(),
});

export const rapportiniRouter = Router();

// --- Rotta PUBBLICA (l'unica di questo modulo) ---
// Registrata PRIMA di requireAuth: il cliente che firma non è un utente del sistema e
// non ha alcun token di accesso. Firma di persona sul dispositivo dell'operaio, con un
// link monouso a scadenza breve — stesso modello del reset password.
rapportiniRouter.post('/firma', async (req, res, next) => {
  try {
    const parsed = firmaSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati di firma non validi', parsed.error.flatten().fieldErrors);
    }
    const esito = await signRapportino(parsed.data.token, parsed.data, {
      // req.ip è affidabile perché app.ts imposta 'trust proxy' a 1 (un solo hop davanti):
      // senza, dietro il proxy di Render si registrerebbe l'IP del proxy per tutti.
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    });
    res.json(esito);
  } catch (err) {
    next(err);
  }
});

// --- Da qui in poi: solo utenti autenticati ---
rapportiniRouter.use('/', requireAuth);

// Registrata PRIMA di '/:id': altrimenti Express instraderebbe "anteprima" lì dentro
// trattandola come un id non valido — stessa trappola già nota in questo progetto
// (projects.routes.ts '/summary', tasks.routes.ts '/assignable-users').
rapportiniRouter.get('/anteprima', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = cantiereGiornoSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri non validi', parsed.error.flatten().fieldErrors);
    }
    const snapshot = await anteprimaRapportino(
      parsed.data.projectId,
      parsed.data.date,
      req.user.companyId,
      req.user,
    );
    res.json({ anteprima: snapshot });
  } catch (err) {
    next(err);
  }
});

// Elenco: solo admin/PM. Un operaio arriva ai propri rapportini per id (GET /:id), non
// scorrendo quelli dell'intera azienda — stesso principio già applicato ai report.
rapportiniRouter.get('/', requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Parametri di ricerca non validi', parsed.error.flatten().fieldErrors);
    }
    const result = await listRapportini(parsed.data.page, parsed.data.limit, req.user.companyId, {
      projectId: parsed.data.projectId,
      date: parsed.data.date,
      status: parsed.data.status,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

rapportiniRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = cantiereGiornoSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Dati rapportino non validi', parsed.error.flatten().fieldErrors);
    }
    const created = await createRapportino(parsed.data.projectId, parsed.data.date, req.user.companyId, req.user);
    // signingToken compare SOLO in questa risposta: in database ne resta il solo hash e
    // nessun altro endpoint può restituirlo.
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

rapportiniRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const rapportino = await getRapportinoById(parseId(req.params.id), req.user.companyId, req.user);
    res.json({ rapportino });
  } catch (err) {
    next(err);
  }
});

rapportiniRouter.get('/:id/pdf', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const pdf = await generaPdfRapportino(parseId(req.params.id), req.user.companyId, req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    res.send(pdf.contenuto);
  } catch (err) {
    next(err);
  }
});

rapportiniRouter.post('/:id/annulla', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = annullaSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Dati non validi', parsed.error.flatten().fieldErrors);
    }
    const rapportino = await annullaRapportino(
      parseId(req.params.id),
      parsed.data.reason ?? null,
      req.user.companyId,
      req.user,
    );
    res.json({ rapportino });
  } catch (err) {
    next(err);
  }
});

rapportiniRouter.post('/:id/reinvia-email', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = reinviaEmailSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Dati non validi', parsed.error.flatten().fieldErrors);
    }
    const esito = await reinviaEmailRapportino(
      parseId(req.params.id),
      parsed.data.email,
      req.user.companyId,
      req.user,
    );
    res.json(esito);
  } catch (err) {
    next(err);
  }
});

// Solo admin: sbloccare ore firmate dal cliente non è gestione ordinaria del cantiere
// (che spetterebbe anche al project_manager), è un intervento amministrativo su un
// documento sottoscritto — per questo lascia una voce di audit.
rapportiniRouter.post('/:id/sblocca', requireRole('admin'), async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const parsed = sbloccaSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Serve un motivo per sbloccare un rapportino firmato', parsed.error.flatten().fieldErrors);
    }
    const rapportino = await sbloccaRapportino(
      parseId(req.params.id),
      parsed.data.reason,
      req.user.companyId,
      req.user,
    );
    res.json({ rapportino });
  } catch (err) {
    next(err);
  }
});
