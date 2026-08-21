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
