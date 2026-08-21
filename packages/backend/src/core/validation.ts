import { z } from 'zod';

// Un solo punto che decide come si normalizza un'email in ingresso: trim per gli
// spazi accidentali (già fatto anche dal frontend, ma un secondo client API non lo
// farebbe), poi minuscolo PRIMA del controllo di formato — senza, due utenti con la
// stessa email ma un carattere diverso di maiuscola/minuscola sarebbero considerati
// "diversi" da Postgres (confronto case-sensitive di default), mentre per un umano
// sono lo stesso indirizzo: un login con l'email scritta in un case diverso da quello
// salvato in fase di creazione falliva con "credenziali non valide" — bug reale,
// riprodotto con il primo utente creato in produzione (20/08).
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Indirizzo email non valido');
