CREATE TABLE IF NOT EXISTS "time_log_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"time_log_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit" varchar(32) DEFAULT 'pz' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "time_logs" ADD COLUMN "work_description" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_log_materials" ADD CONSTRAINT "time_log_materials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_log_materials" ADD CONSTRAINT "time_log_materials_time_log_id_time_logs_id_fk" FOREIGN KEY ("time_log_id") REFERENCES "public"."time_logs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_log_materials_time_log_id_idx" ON "time_log_materials" USING btree ("time_log_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_log_materials_company_id_idx" ON "time_log_materials" USING btree ("company_id");