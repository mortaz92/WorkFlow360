// Costo bcrypt per l'hashing delle password: più alto rallenta un brute-force offline
// ma anche ogni login/creazione legittima. 12 è il valore raccomandato attuale per
// bcrypt in produzione. Condiviso tra auth (hash fittizio anti-timing), users
// (creazione utenti) e il seed di sviluppo, per non poter divergere per errore.
export const BCRYPT_COST = 12;
