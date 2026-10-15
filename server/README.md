# Easyhunt cloud service (Stage 5)

Single-process Fastify API with PostgreSQL, Redis OTP storage, JWT access/refresh tokens, Drizzle-generated migrations, and account-scoped records. The server stores only resume indexes and limited display metadata. PDF files, extracted text, contact details, work history, and full parsed resumes stay on the client.

## Production-style local setup

```bash
cd server
npm install
cp .env.example .env
docker compose up -d
npm run migrate
npm start
```

`npm run migrate` is repeatable. Set a new random `JWT_SECRET` in `.env`. `DEV_SMS_CODE=true` prints the six-digit code in the server terminal and is restricted to a loopback listener. For a non-development environment, set `DEV_SMS_CODE=false`, `SMS_WEBHOOK_URL`, and optionally `SMS_WEBHOOK_TOKEN`. The webhook receives `{phone,code}`. OTPs expire after 5 minutes, resend cooldown is 60 seconds, and five failed attempts exhaust a code. Access tokens last 15 minutes. Refresh tokens last 30 days and rotate after use.

Run `npm test` and `npm run typecheck`. The tests use PGlite (PostgreSQL in-process) and a memory OTP store, so they do not need Docker. Production entrypoint uses PostgreSQL and Redis. The actual PostgreSQL/Redis container setup was not executed in this development environment because Docker is unavailable there.

## Curl acceptance flow

With the service on `127.0.0.1:4320` and `.env` configured:

```bash
BASE=http://127.0.0.1:4320
PHONE=13800009999
curl -sS -X POST "$BASE/auth/send-code" -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\"}"
```

Read the development code from the server terminal. Then:

```bash
CODE=123456                          # replace with the printed code
curl -sS -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"code\":\"$CODE\"}" > /tmp/easyhunt-login.json
TOKEN=$(python3 -c 'import json;print(json.load(open("/tmp/easyhunt-login.json"))["accessToken"])')
NODE_ENV=development SEED_PHONE="$PHONE" SEED_CREDITS=100 npm run seed
curl -sS -X POST "$BASE/project" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"后端工程师招聘"}' > /tmp/easyhunt-project.json
PROJECT_ID=$(python3 -c 'import json;print(json.load(open("/tmp/easyhunt-project.json"))["id"])')
curl -sS -X POST "$BASE/resumes" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"localRef\":\"resume-local-1\",\"contentHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"stars\":5}"
curl -sS -X POST "$BASE/billing/credits/deduct" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"requestId":"demo-screen-1","kind":"quick_screen"}'
curl -sS -X POST "$BASE/billing/credits/deduct" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"requestId":"demo-screen-1","kind":"quick_screen"}'
curl -sS "$BASE/billing/credits" -H "authorization: Bearer $TOKEN"
curl -sS "$BASE/billing/credits/ledger" -H "authorization: Bearer $TOKEN"
```

The second deduction returns `idempotentReplay:true`; the balance remains 80 and the ledger has one charge. `initial_screen` costs 40. Insufficient balance returns HTTP 409 with `INSUFFICIENT_CREDITS` so the client can stop its task. `requestId` is unique within an account; reusing it for a different charge type returns `REQUEST_ID_CONFLICT`.

For a curl smoke test without Docker, run `npm run start:embedded` instead. It binds `127.0.0.1:4321`, creates demo account `13800009999` with 100 credits in an ephemeral PGlite database, and prints its OTP. Set `BASE=http://127.0.0.1:4321` and skip `npm run seed` in the flow above. The embedded server is a local acceptance harness and loses data on exit.

## API scope

- P0: `/auth/send-code`, `/auth/login`, `/auth/me`, `/auth/refresh`; project create/list/get/update/delete; `/resumes` index create/list and `/resume/:id`; `/user/platform-jobs` list/detail/sync/status/pause; credit balance, ledger and idempotent deduction.
- P1: project search configs and preview, talent profiles, settings versions/rebind/discard, resume decision and history.
- P2: conversations, messages with workflow events/cursor, invitation profile, first-order-offer availability, business events.

The evidence file lists URL paths without full payload contracts. Fields and responses inferred here are marked in source with `DESIGN-DECISION`. `first-order-offer` reports unavailable until actual commercial terms are configured; invitation endpoints issue a code but do not award credits. Platform job sync accepts metadata from an explicitly authorized local client; the cloud service does not hold platform login state or browse third-party pages.

For platform jobs, `POST /user/platform-jobs/sync` with `{platform}` creates a pending sync. A local client can complete it by posting `{platform,syncId,jobs:[{platform,platformJobRef,title,city?}]}` to the same endpoint. Supplying `jobs` in the first request completes it immediately. `POST /user/platform-jobs/sync-status` accepts `{syncId}` and `POST /user/platform-jobs/sync/pause` pauses a pending sync.

## LLM and agent mode (Stage 6)

Configure `LLM_MODEL`, `LLM_BASE_URL`, and `LLM_API_KEY` in `.env` on the server. The default provider is DeepSeek with model `deepseek-flash`. `LLM_TIMEOUT_MS`, `LLM_RETRIES`, and `LLM_MAX_PER_HOUR` control timeout, retries, and the Redis-backed per-account hourly call limit. The provider key never enters the RPA or Electron process. Versioned prompts are in `prompts/*.v1.txt`; responses include `promptVersion`.

Use the access token from the login flow to paste a JD and generate a sourced portrait:

```bash
curl -sS -X POST "$BASE/llm/profile" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jd":"招聘本科以上 Java 后端工程师，负责订单系统，有 Redis 经验加分。"}'
```

The response has `hardConditions`, `businessConditions`, and `bonusItems`. Each item's evidence is checked against the JD. `/llm/resume-score` returns 1–5 stars and `matched`, `mismatched`, `pending` groups; `/llm/resume-extract` returns the Stage 4 resume schema. Both resume endpoints require `allowRemoteResumeProcessing:true`. Resume text is used only for the request and is not written to PostgreSQL or business logs. The RPA pipeline falls back to its local rule scorer if the LLM score fails or its evidence is invalid.

For target mode, `POST /llm/agent/runs` creates a project-owned run with `{projectId,recruitmentMode:"target",profile}`. `POST /llm/agent/runs/:id/terms` suggests the next terms. The local RPA client executes them and posts `{roundNumber,terms,results:[{keyword,collectedCount,passedCount}],promptVersion}` to `/llm/agent/runs/:id/rounds`. `GET /llm/agent/runs/:id` returns both rounds and their aggregate pass rates. Candidate records and resume text stay local. The current flow stops after two rounds. `npm test` verifies that the second prompt receives the first round's output quality.
