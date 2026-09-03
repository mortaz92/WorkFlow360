ALTER TABLE "projects" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "time_log_materials" ADD COLUMN "code" varchar(50);--> statement-breakpoint

-- N° progressivo per azienda. Aggiunta in TRE passi invece che con un solo
-- "ADD COLUMN ... NOT NULL" (che è quanto drizzle-kit aveva generato qui): in
-- produzione la tabella potrebbe non essere vuota, e ADD COLUMN NOT NULL senza
-- default fallisce su qualunque riga esistente — con una migrazione che gira
-- all'AVVIO (render.yaml), un fallimento qui significa servizio giù.
-- Non serve un LOCK TABLE esplicito: ALTER TABLE ... ADD COLUMN prende già ACCESS
-- EXCLUSIVE su "rapportini" e lo tiene fino al COMMIT dell'intera migrazione (il
-- migrator drizzle avvolge tutti gli statement in UNA transazione), quindi nessuna
-- INSERT concorrente può infilarsi tra il backfill e il SET NOT NULL.
ALTER TABLE "rapportini" ADD COLUMN "numero" integer;--> statement-breakpoint

-- Backfill: numerazione per azienda in ordine di creazione. `id` come secondo criterio
-- perché created_at ha default now() e due righe possono condividerlo: senza, l'ordine
-- sarebbe arbitrario e la numerazione non riproducibile. Non dà per scontato che la
-- tabella sia vuota ed è corretto anche se lo è.
WITH numerati AS (
  SELECT "id", (row_number() OVER (PARTITION BY "company_id" ORDER BY "created_at", "id"))::int AS n
  FROM "rapportini"
)
UPDATE "rapportini" AS r SET "numero" = numerati.n
FROM numerati WHERE r."id" = numerati."id";--> statement-breakpoint

ALTER TABLE "rapportini" ALTER COLUMN "numero" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rapportini" ADD CONSTRAINT "rapportini_company_id_numero_unique" UNIQUE("company_id","numero");
