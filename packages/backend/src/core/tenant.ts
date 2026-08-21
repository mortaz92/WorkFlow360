import type { AuthenticatedUser } from '../modules/auth/auth.types';

/**
 * Helper centralizzato per il multi-tenant.
 *
 * Ogni query DOVREBBE passare da qui per ottenere il companyId dell'utente
 * loggato: in questo modo è impossibile (per errore o per bug) restituire dati
 * di un'azienda a un utente di un'altra. Neotekna SRL non vede mai Perluce SRL.
 */
export interface TenantContext {
  companyId: string;
  user: AuthenticatedUser;
}

export function tenantOf(user: AuthenticatedUser | undefined): TenantContext {
  if (!user) {
    // Non dovrebbe mai accadere: i router chiamano requireAuth prima di arrivare
    // qui. Se accade è un bug del wiring, non un errore utente.
    throw new Error('tenantOf chiamato senza utente autenticato');
  }
  return { companyId: user.companyId, user };
}
