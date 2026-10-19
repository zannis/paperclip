ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_bump_issue_revision()
RETURNS trigger AS $$
BEGIN
	NEW."revision" := OLD."revision" + 1;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_revision_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_revision_trigger
BEFORE UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision();
