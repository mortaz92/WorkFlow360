// Codice SQLSTATE Postgres per violazione di vincolo UNIQUE: distingue un dato
// duplicato (errore del client, 400) da un errore di sistema (500). Era locale a
// users.service.ts finché quello restava l'unico punto a inserire righe con un
// vincolo UNIQUE applicativo; da quando projects.service.ts ne ha bisogno anche lui
// (campo `code`), è una costante del driver Postgres condivisa tra moduli — non
// un'astrazione di dominio, quindi non serve aspettare una terza occorrenza.
const POSTGRES_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Nome del vincolo che ha prodotto la violazione, quando Postgres lo comunica.
 *
 * Serve a chi ha PIÙ di un UNIQUE sulla stessa tabella: `isUniqueViolation` da solo dice
 * "un duplicato", non "quale duplicato", e un messaggio scelto sul solo codice 23505
 * finisce per spiegare all'utente un conflitto diverso da quello che è davvero successo
 * (rapportini ha sia l'UNIQUE su project+date+revision sia l'indice parziale
 * "uno solo in attesa di firma": confonderli manderebbe l'utente a cercare un rapportino
 * pendente che non esiste). Restituisce null se l'errore non è una violazione UNIQUE o
 * se il driver non ha riportato il nome del vincolo, così il chiamante può ripiegare su
 * un messaggio generico invece di indovinare.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  const constraint = (err as { constraint_name?: unknown; constraint?: unknown }).constraint_name ??
    (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' && constraint.length > 0 ? constraint : null;
}
