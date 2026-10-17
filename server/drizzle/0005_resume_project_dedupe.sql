-- A candidate can appear in more than one project. Keep one index per project
-- while continuing to deduplicate repeated collection within that project.
DROP INDEX IF EXISTS resumes_account_hash_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS resumes_project_hash_idx ON resumes(account_id, project_id, content_hash);
