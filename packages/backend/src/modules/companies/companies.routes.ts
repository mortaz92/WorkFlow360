import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import { createCompany, getCompanyById, listCompanies, updateCompany } from './companies.service';
import { COMPANY_MANAGER_ROLES } from './companies.types';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  vat: z.string().max(64).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(64).optional(),
  address: z.string().max(2000).optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    vat: z.string().max(64).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(64).optional(),
    address: z.string().max(2000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Nessun campo fornito' });

const idSchema = z.string().uuid();

function parseId(id: string): string {
  const p = idSchema.safeParse(id);
  if (!p.success) throw new ValidationError('ID azienda non valido');
  return p.data;
}

export const companiesRouter = Router();

// L'azienda è creata dal bootstrap iniziale (primo admin) — non esiste (e non è
// previsto) un endpoint per creare una SECONDA azienda in questo SaaS single-tenant-
// per-deploy. La modifica (PATCH sotto) invece è voluta: senza, il nome scelto al
// bootstrap (es. per una demo) resterebbe permanente, senza modo di correggerlo prima
// di un uso reale con un cliente vero.
companiesRouter.use('/', requireAuth);

companiesRouter.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const rows = await listCompanies(req.user.companyId);
    res.json({ companies: rows });
  } catch (err) {
    next(err);
  }
});

companiesRouter.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id);
    const c = await getCompanyById(id, req.user.companyId);
    res.json({ company: c });
  } catch (err) {
    next(err);
  }
});

// Solo admin, non i project_manager (COMPANY_MANAGER_ROLES = ['admin']): l'anagrafica
// azienda è un'impostazione a livello dell'intero tenant, non di un singolo cantiere.
companiesRouter.patch('/:id', requireRole(...COMPANY_MANAGER_ROLES), async (req, res, next) => {
  try {
    if (!req.user) throw new Error('req.user non popolato');
    const id = parseId(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0]?.message ?? 'Dati non validi');
    }
    const c = await updateCompany(id, parsed.data, req.user.companyId);
    res.json({ company: c });
  } catch (err) {
    next(err);
  }
});
