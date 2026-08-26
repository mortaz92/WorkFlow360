import crypto from 'node:crypto';

// Un unico posto che sa come si fabbrica e come si confronta un token opaco. Non è
// un'astrazione preventiva: i flussi che ne hanno bisogno sono tre e sono tutti reali
// (refresh token e token di reset password in auth.service.ts, token di firma del
// rapportino in rapportini.service.ts). Con tre copie private della stessa coppia di
// funzioni, un domani basterebbe cambiare l'algoritmo in due punti su tre perché il
// terzo resti indietro senza che nessun test se ne accorga.
//
// Si salva SEMPRE e SOLO l'hash, mai il valore in chiaro: un dump del database non
// deve permettere di impersonare un utente né di firmare un rapportino al posto del
// cliente. SHA-256 e non bcrypt: il valore ha centinaia di bit di entropia casuale
// (non è una password scelta da un umano), quindi un attacco a forza bruta è
// impossibile a prescindere dalla lentezza dell'hash — un hash lento rallenterebbe
// solo le verifiche legittime, senza aggiungere sicurezza reale.

export function generateOpaqueToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashOpaqueToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
