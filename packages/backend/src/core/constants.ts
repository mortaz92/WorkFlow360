// Costo bcrypt per l'hashing delle password: più alto rallenta un brute-force offline
// ma anche ogni login/creazione legittima. 12 è il valore raccomandato attuale per
// bcrypt in produzione. Un solo valore condiviso da ogni punto che crea/verifica un
// hash, per non poter divergere per errore (l'elenco di "chi lo usa" invecchia più in
// fretta di questa riga — cercalo con un grep su BCRYPT_COST se serve saperlo).
export const BCRYPT_COST = 12;

// Un valore che viene da un file di esempio o da una guida (.env.example,
// GUIDA-DEPLOY.md) non è mai un segreto vero, anche quando è abbastanza lungo da
// superare un controllo di sola lunghezza — un copia-incolla distratto lo renderebbe
// un segreto valido ma noto a chiunque legga il repository. Usata sia per i JWT secret
// (core/config) sia per la password del primo admin (scripts/bootstrap-admin.ts): un
// solo punto, perché un domani un placeholder con un'altra parola (es. "CHANGEME")
// va aggiunto qui una volta sola, non in ogni file che valida un segreto.
export function looksLikePlaceholder(value: string): boolean {
  return /replace_me|incolla_qui/i.test(value);
}
