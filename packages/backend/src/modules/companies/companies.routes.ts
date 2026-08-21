import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors';
import { requireAuth } from '../auth/auth.middleware';
import { createCompany, getCompanyById, listCompanies, updateCompany } from './companies.service';

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

// L'azienda è creata dal bootstrap iniziale (primo admin). Qui esponiamo solo
// lettura dell'elenco e dettaglio. La scrittura (creazione/modifica) è protetta
// da requireRole admin nel bootstrap; per ora bastano GET per il MVP.
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
