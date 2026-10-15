CREATE TABLE "resume_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resume_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"audience" varchar(20) NOT NULL,
	"encrypted_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"permission" varchar(10) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_shares" ADD CONSTRAINT "resume_shares_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_shares" ADD CONSTRAINT "resume_shares_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_share_id_resume_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."resume_shares"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_shares_owner_idx" ON "resume_shares" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_recipient_idx" ON "share_recipients" USING btree ("share_id","account_id");