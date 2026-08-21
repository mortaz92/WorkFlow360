-- Normalizza le email già salvate a minuscolo (trim + lower), per allinearle a come
-- vengono lette/scritte dal codice dopo il fix di core/validation.ts (21/08): prima
-- di quel fix, un'email creata con un case diverso da quello poi digitato al login
-- falliva con "credenziali non valide" (Postgres confronta le stringhe esattamente).
-- Riprodotto dal vivo col primo admin di produzione, creato con una maiuscola nel
-- dominio della sua email. Nessun cambio di schema: solo dati, nessun CREATE/ALTER TYPE.
UPDATE "users" SET "email" = LOWER(TRIM("email")) WHERE "email" != LOWER(TRIM("email"));
--> statement-breakpoint
UPDATE "companies" SET "email" = LOWER(TRIM("email")) WHERE "email" IS NOT NULL AND "email" != LOWER(TRIM("email"));
