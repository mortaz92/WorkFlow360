import type { UserRole } from '../auth/auth.types';

export interface PublicCompany {
  id: string;
  name: string;
  vat: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  createdAt: Date;
}

export interface CreateCompanyInput {
  name: string;
  vat?: string;
  email?: string;
  phone?: string;
  address?: string;
}

// A differenza della creazione, in un PATCH ogni campo (incluso il nome) è per
// definizione facoltativo: il chiamante manda solo ciò che vuole cambiare.
export interface UpdateCompanyInput {
  name?: string;
  vat?: string;
  email?: string;
  phone?: string;
  address?: string;
}

// Ruoli che possono gestire (creare/modificare) l'azienda stessa.
export const COMPANY_MANAGER_ROLES: UserRole[] = ['admin'];
