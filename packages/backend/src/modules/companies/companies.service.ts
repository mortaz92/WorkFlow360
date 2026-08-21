import { desc, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { companies } from '../../core/db/schema';
import { NotFoundError, ValidationError } from '../../core/errors';
import type { CreateCompanyInput, PublicCompany, UpdateCompanyInput } from './companies.types';

function toPublicCompany(c: typeof companies.$inferSelect): PublicCompany {
  const { ...pub } = c;
  return pub;
}

// Scoped alla SOLA azienda del chiamante: prima restituiva l'intero catalogo (ogni
// azienda cliente del SaaS, con P.IVA/email/telefono), e il frontend si limitava a
// filtrare lato client la propria — i dati di tutte le altre restavano comunque nella
// risposta HTTP, leggibili da chiunque autenticato, operaio incluso.
export async function listCompanies(companyId: string): Promise<PublicCompany[]> {
  const rows = await db.select().from(companies).where(eq(companies.id, companyId)).orderBy(desc(companies.createdAt));
  return rows.map(toPublicCompany);
}

export async function getCompanyById(id: string, companyId: string): Promise<PublicCompany> {
  // Un'azienda può leggere SOLO se stessa: id richiesto e azienda del chiamante devono
  // coincidere. Stesso principio di isolamento già applicato ad audit log/users/ecc.
  // in questa sessione, qui però non c'era proprio nessun candidato "companyId" nella
  // query da confrontare — la tabella companies non ha un genitore, è essa stessa il
  // confine del tenant.
  if (id !== companyId) {
    throw new NotFoundError('Azienda non trovata');
  }
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!c) {
    throw new NotFoundError('Azienda non trovata');
  }
  return toPublicCompany(c);
}

export async function createCompany(input: CreateCompanyInput): Promise<PublicCompany> {
  if (!input.name || input.name.trim().length === 0) {
    throw new ValidationError('Il nome dell\'azienda è obbligatorio');
  }
  const [c] = await db
    .insert(companies)
    .values({
      name: input.name.trim(),
      vat: input.vat ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
    })
    .returning();
  return toPublicCompany(c);
}

// Scoped come getCompanyById: un admin può modificare SOLO la propria azienda, mai
// un'altra per id (companies.routes.ts passa sempre req.user.companyId come terzo
// argomento — senza questo controllo qui, un id arbitrario nell'URL basterebbe).
export async function updateCompany(id: string, input: UpdateCompanyInput, companyId: string): Promise<PublicCompany> {
  if (id !== companyId) {
    throw new NotFoundError('Azienda non trovata');
  }
  const [existing] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!existing) {
    throw new NotFoundError('Azienda non trovata');
  }
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.vat !== undefined) patch.vat = input.vat;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.address !== undefined) patch.address = input.address;

  const [updated] = await db.update(companies).set(patch).where(eq(companies.id, companyId)).returning();
  return toPublicCompany(updated);
}
