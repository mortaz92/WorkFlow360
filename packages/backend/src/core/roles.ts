import type { UserRole } from '../modules/auth/auth.types';

// Ruoli con permessi di gestione (creare/modificare/eliminare cantieri, lavori, ore,
// correzioni). Dopo la riduzione dei ruoli utente da 6 a 3 (20/08), questa lista
// coincide esattamente con "chi non è operaio" — prima di allora projects/tasks/
// timeLogs/corrections avevano ciascuno la propria costante identica, duplicata per
// puro caso storico. COMPANY_MANAGER_ROLES in companies.types.ts resta separato
// apposta: lì la gestione utenti/azienda è riservata al solo admin, non ai PM.
export const MANAGER_ROLES: UserRole[] = ['admin', 'project_manager'];

export function isManager(role: UserRole | string): boolean {
  return (MANAGER_ROLES as readonly string[]).includes(role);
}
