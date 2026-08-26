DO $$ BEGIN
 CREATE TYPE "public"."rapportino_status" AS ENUM('in_firma', 'firmato', 'annullato', 'scaduto');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rapportini" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"date" date NOT NULL,
	"revision" integer NOT NULL,
	"status" "rapportino_status" DEFAULT 'in_firma' NOT NULL,
	"created_by" uuid NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"total_hours" numeric(10, 2) NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signer_name" varchar(255),
	"signer_email" varchar(255),
	"signature_png" text,
	"signed_at" timestamp with time zone,
	"signed_ip" varchar(45),
	"signed_user_agent" varchar(500),
	"email_sent_at" timestamp with time zone,
	"email_last_error" text,
	"cancel_reason" text,
	"unlocked_at" timestamp with time zone,
	"unlocked_by" uuid,
	"unlock_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rapportini_project_id_date_revision_unique" UNIQUE("project_id","date","revision")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "client_name" varchar(255);--> statement-breakpoint
ALTER TABLE "time_logs" ADD COLUMN "rapportino_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rapportini" ADD CONSTRAINT "rapportini_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rapportini" ADD CONSTRAINT "rapportini_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rapportini" ADD CONSTRAINT "rapportini_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rapportini" ADD CONSTRAINT "rapportini_unlocked_by_users_id_fk" FOREIGN KEY ("unlocked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rapportini_company_id_idx" ON "rapportini" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rapportini_project_id_date_idx" ON "rapportini" USING btree ("project_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rapportini_token_hash_idx" ON "rapportini" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rapportini_status_idx" ON "rapportini" USING btree ("status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_logs" ADD CONSTRAINT "time_logs_rapportino_id_rapportini_id_fk" FOREIGN KEY ("rapportino_id") REFERENCES "public"."rapportini"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_logs_rapportino_id_idx" ON "time_logs" USING btree ("rapportino_id");