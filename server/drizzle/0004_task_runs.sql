CREATE TABLE IF NOT EXISTS task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  operation_id uuid NOT NULL,
  platform varchar(32) NOT NULL,
  status varchar(20) NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS task_runs_operation_idx ON task_runs(account_id, operation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS task_runs_project_idx ON task_runs(project_id);
