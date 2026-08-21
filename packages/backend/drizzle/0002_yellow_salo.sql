DO $$ BEGIN
 CREATE TYPE "public"."time_log_type" AS ENUM('ordinario', 'straordinario', 'notturno', 'festivo', 'permesso', 'ferie');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Aggiunto in una sessione successiva (non nella generazione originale di drizzle-kit):
-- questa migrazione usa "tipo_commessa" alla riga sotto senza mai crearlo. Sul database
-- di sviluppo il tipo esisteva già (creato a mano, prima che il progetto avesse migrazioni
-- vere), quindi il difetto non si vedeva mai localmente — un database nuovo (es. il primo
-- deploy su Render) falliva con "type tipo_commessa does not exist". DO/EXCEPTION invece
-- di IF NOT EXISTS: Postgres non supporta IF NOT EXISTS su CREATE TYPE.
DO $$ BEGIN
 CREATE TYPE "public"."tipo_commessa" AS ENUM('contratto', 'consuntivo');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "user_role" ADD VALUE 'operaio';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"vat" varchar(64),
	"email" varchar(255),
	"phone" varchar(64),
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Step 1: aggiungiamo company_id come NULLABLE per non bloccare le righe esistenti
ALTER TABLE "users" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tipo_commessa" "tipo_commessa" DEFAULT 'consuntivo' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "time_logs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "time_logs" ADD COLUMN "tipo" "time_log_type" DEFAULT 'ordinario' NOT NULL;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "company_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_name_idx" ON "companies" USING btree ("name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_logs" ADD CONSTRAINT "time_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corrections" ADD CONSTRAINT "corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_company_id_idx" ON "projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_company_id_idx" ON "tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_logs_company_id_idx" ON "time_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_company_id_idx" ON "corrections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_company_id_idx" ON "audit_log" USING btree ("company_id");
