ALTER TABLE "issue_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "retain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_state_chk" CHECK ("state" IN ('active', 'void'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
DO $$
DECLARE fk text;
BEGIN
	SELECT conname INTO fk FROM pg_constraint
	WHERE conrelid = 'issue_create_idempotency_keys'::regclass AND contype = 'f'
	  AND pg_get_constraintdef(oid) LIKE '%REFERENCES issues(id)%';
	IF fk IS NOT NULL THEN
		EXECUTE format('ALTER TABLE "issue_create_idempotency_keys" DROP CONSTRAINT %I', fk);
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys"
	ADD CONSTRAINT "issue_create_idempotency_keys_issue_id_issues_id_fk"
	FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_void_issue_chk"
	CHECK ("state" = 'active' OR "issue_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;
