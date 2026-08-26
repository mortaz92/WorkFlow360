-- Al massimo UN rapportino "in_firma" per volta su uno stesso cantiere/giorno: senza
-- questo vincolo, due operai (o due tocchi sullo stesso pulsante) creerebbero due link
-- di firma validi in contemporanea per la stessa giornata, e il cliente finirebbe per
-- firmarne uno mentre l'altro resta aperto sulle stesse ore.
--
-- È un indice UNIQUE PARZIALE, non un UNIQUE normale: il vincolo vale SOLO finché il
-- rapportino è in attesa di firma. Una volta 'firmato', 'annullato' o 'scaduto' quel
-- giorno deve tornare disponibile per una nuova revisione — un UNIQUE pieno su
-- (project_id, date) lo bloccherebbe per sempre dopo il primo tentativo.
-- Il progressivo delle revisioni resta protetto a parte dall'UNIQUE
-- (project_id, date, revision) generato dalla migrazione 0011.
--
-- Scritta a mano perché drizzle-kit non genera indici parziali (stesso motivo per cui
-- 0009_restrict_user_role.sql è scritta a mano: lì era la rimozione di valori da un
-- enum). Di conseguenza questo indice NON è dichiarato in src/core/db/schema/rapportini.ts:
-- drizzle-kit confronta lo schema col proprio snapshot in drizzle/meta, non col database
-- reale, quindi non conoscendolo non potrà mai proporne il DROP in una migrazione futura.
CREATE UNIQUE INDEX IF NOT EXISTS "rapportini_project_id_date_in_firma_unique"
  ON "rapportini" ("project_id", "date")
  WHERE "status" = 'in_firma';
