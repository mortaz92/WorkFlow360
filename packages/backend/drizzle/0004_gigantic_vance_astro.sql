-- Numero cantiere leggibile, progressivo PER AZIENDA (non globale).
-- Aggiunta in 3 passi per non rompere righe già esistenti:
-- 1) colonna nullable, 2) backfill via ROW_NUMBER() partizionato per company_id
--    (ordinato per data di creazione, così i cantieri più vecchi ricevono i numeri
--    più bassi), 3) NOT NULL + UNIQUE(company_id, project_number) come rete di
--    sicurezza contro collisioni future tra creazioni concorrenti.
ALTER TABLE "projects" ADD COLUMN "project_number" integer;--> statement-breakpoint
UPDATE "projects" p
SET "project_number" = sub.n
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS n
  FROM "projects"
) sub
WHERE p.id = sub.id;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "project_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_project_number_unique" UNIQUE("company_id","project_number");
