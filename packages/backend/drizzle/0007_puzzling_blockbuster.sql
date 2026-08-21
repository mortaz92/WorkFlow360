ALTER TABLE "projects" ADD COLUMN "code" varchar(50);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_code_unique" UNIQUE("company_id","code");