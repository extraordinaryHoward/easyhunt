ALTER TABLE resume_shares ADD COLUMN expires_at timestamptz;
--> statement-breakpoint
UPDATE resume_shares SET expires_at=created_at + interval '1 month' WHERE expires_at IS NULL;
--> statement-breakpoint
ALTER TABLE resume_shares ALTER COLUMN expires_at SET NOT NULL;
--> statement-breakpoint
ALTER TABLE resume_shares ALTER COLUMN expires_at SET DEFAULT (now() + interval '1 month');
--> statement-breakpoint
CREATE INDEX resume_shares_expires_idx ON resume_shares(expires_at);
