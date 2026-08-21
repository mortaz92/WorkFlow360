-- Rimuove resource/qa/stakeholder dall'enum user_role (restano admin/project_manager/
-- operaio): deciso con l'utente il 20/08, questi 3 ruoli avevano pochissime funzioni
-- reali collegate. Postgres non supporta un ALTER TYPE ... DROP VALUE diretto quando si
-- vuole RESTRINGERE i valori ammessi — va ricreato il tipo (drizzle-kit generate non
-- rileva da solo questa rimozione, questa migrazione è scritta a mano).
--
-- Verificato prima di scrivere questo file: zero utenti reali avevano uno di questi 3
-- ruoli. Il cast USING sotto resta comunque la vera protezione anche in astratto — se
-- una riga avesse contenuto un valore rimosso, il cast fallisce con "invalid input
-- value for enum" e l'intera migrazione va in rollback (nessun troncamento silenzioso).
ALTER TYPE "public"."user_role" RENAME TO "user_role_old";
--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'project_manager', 'operaio');
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::text::"public"."user_role";
--> statement-breakpoint
DROP TYPE "public"."user_role_old";
