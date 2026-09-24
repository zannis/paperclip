ALTER TABLE "issue_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "retain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_state_chk" CHECK ("state" IN ('active', 'void'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
DO $$
DECLARE
	old_fk text;
	new_fk_exists boolean;
	issue_id_attnum smallint;
BEGIN
	SELECT attnum INTO issue_id_attnum
	FROM pg_attribute
	WHERE attrelid = 'issue_create_idempotency_keys'::regclass AND attname = 'issue_id';

	SELECT conname INTO old_fk FROM pg_constraint
	WHERE conrelid = 'issue_create_idempotency_keys'::regclass
	  AND contype = 'f'
	  AND confrelid = 'issues'::regclass
	  AND conkey = ARRAY[issue_id_attnum];

	IF old_fk IS NOT NULL THEN
		EXECUTE format('ALTER TABLE "issue_create_idempotency_keys" DROP CONSTRAINT %I', old_fk);
	ELSE
		SELECT EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conrelid = 'issue_create_idempotency_keys'::regclass
			  AND contype = 'f'
			  AND conname = 'issue_create_idempotency_keys_issue_id_issues_id_fk'
		) INTO new_fk_exists;
		IF NOT new_fk_exists THEN
			RAISE EXCEPTION 'issue_create_idempotency_keys: expected either the original issue_id->issues foreign key or issue_create_idempotency_keys_issue_id_issues_id_fk to exist, found neither';
		END IF;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_create_idempotency_keys"
		ADD CONSTRAINT "issue_create_idempotency_keys_issue_id_issues_id_fk"
		FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_void_issue_chk"
	CHECK ("state" = 'active' OR "issue_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;
