# Easyhunt RPA engine · stage 3

The engine runs as a separate Node process and listens on `127.0.0.1:4317`. The 31-command API skeleton remains in place. Browser control uses Playwright; BOSS search, candidate, resume, and job commands dispatch through `src/skills/types.ts` and `src/skills/boss/`. Other commands return mock results, except greet/favorite/share, which reject with `ACTION_NOT_IMPLEMENTED` after confirmation and authorization checks. All state, including signed authorizations, is in memory and clears on restart. Resume reads the current URL and DOM before the unfinished step; it does not replay earlier clicks.

## Run and verify

```bash
cd rpa-engine
npm install
npx playwright install chromium   # or use an installed Google Chrome
npm test
npm run typecheck
HEADLESS=false npm start          # omit HEADLESS=false for headless mode
```

On macOS, Linux, or Windows with Google Chrome installed, Playwright uses it if the bundled Chromium is absent. Set `CHROMIUM_EXECUTABLE` to an explicit browser binary if needed. The browser integration test uses an intercepted local fixture at a BOSS-shaped URL, so it does not access BOSS.

Before opening a real platform page, the user must explicitly authorize local automation and sign the platform operation agreement. The desktop toolbar provides that flow. For manual API use, submit the user's actual phone and choices:

```bash
curl -sS -X POST http://127.0.0.1:4317/authorizations \
  -H 'content-type: application/json' \
  -d '{"platform":"boss","phone":"YOUR_BOUND_PHONE","authorized":true,"signedAgreement":true}'
npm run inspect:boss
```

`inspect:boss` opens the fixed BOSS recruiter search URL and reads the current candidate card DOM through `candidates.list`. The page may require manual login. If the site redirects to login or its card markup is not recognized, the operation fails with `LOGIN_REQUIRED`, `UNEXPECTED_PAGE`, or `DOM_UNRECOGNIZED` rather than inventing results. The current BOSS URL and DOM selectors are inferred from incomplete evidence and need calibration in an authorized logged-in session.

After signing authorization and logging in, run the local search and collection workflow with one command:

```bash
npm run collect:boss -- --job "前端工程师" --keyword "React" --target 20
```

It reuses an open BOSS session or opens the fixed search page, applies the keyword, pages until 20 distinct candidates or the configured page limit, marks keyword evidence for quick screening, and reads visible resume details for initial human review. Pass `--job-ref REF` to bind a previously listed platform job before searching. It does not make hiring or rejection decisions. Console output includes `pending`, `running`, and terminal operation statuses; the engine logs the same transitions as JSON lines without candidate details. `POST /workflows/boss/collect` accepts `{sessionRef, jobTitle, jobRef?, keyword, targetCount?, maxPages?}`.

The BOSS skill implements `search.fields/get/set/apply`, `candidates.list/next`, `resume.read/open/close`, and `jobs.list/select`. It supports the configured keyword, city, experience, and education controls when those controls exist on the current page. All selector fallbacks are in `src/skills/boss/selectors.ts`. A changed page that cannot be recognized returns an error rather than a fabricated result.

Set `RPA_MIN_DELAY_MS`, `RPA_MAX_DELAY_MS`, and `RPA_MAX_PER_HOUR` to adjust the randomized gap and rolling hourly operation cap. Defaults are 1500 ms, 3200 ms, and 120. These limits reduce account risk and support platform-protocol compliance; they cannot guarantee platform acceptance. Limit exhaustion fails the operation with `RATE_LIMITED`.

Pause and resume use `POST /sessions/{sessionRef}/control` with `{"action":"session.pause"}` or `{"action":"session.resume"}`. `GET /sessions` lists refs. `DELETE /authorizations/boss` revokes authorization and pauses sessions. Operations remain queryable at `GET /operations/{id}` and cancellable at `POST /operations/{id}/cancel`.

## Electron BrowserView

```bash
cd ../desktop
npm install
npm start
```

Electron creates the BrowserView and starts the RPA process with `EASYHUNT_CDP_URL=http://127.0.0.1:9223`. Playwright connects over CDP to the BrowserView's page, so the user and engine see the same tab. The toolbar signs authorization, opens the search page, reads candidates, pauses for manual control, resumes, and revokes authorization. Its desktop binary must finish installing before `npm start` can run.

No candidate data is sent to a cloud service. The engine stores operation results only in local process memory. The agreement form checks the mobile number format; account ownership verification awaits the account system in a later stage.

## Local resume pipeline (Stage 4)

`npm run resume:demo -- test/fixtures/chen-wei.pdf test/fixtures/lin-xiao.pdf test/fixtures/wang-ning.pdf test/fixtures/chen-wei.pdf` runs three fictional but genuine PDF resumes through the ten report stages, then prints stars, `matched` / `mismatched` / `pending` analysis with verbatim PDF excerpts, and a duplicate result. `npm test` includes the same integration flow. The three PDFs contain no real person's data.

The default storage root is `rpa-engine/data/`, with parsed JSON under `resume/` and original PDFs under `resumeAttachment/`. Set `EASYHUNT_DATA_ROOT`, `EASYHUNT_RESUME_DIR`, or `EASYHUNT_ATTACHMENT_DIR` to override each path. This data directory is git-ignored. No resume is uploaded by this command.

PDF.js extracts text. The `ResumeSchema` validates structured extraction; if no proxy is configured or extraction fails, the local regex parser takes over. `EASYHUNT_RESUME_LLM_PROXY_URL` points to the server-side extraction endpoint, which accepts `{sourceText,schema:"resume-v1",allowRemoteResumeProcessing:true}` and returns `{resume: ...}`. Never set a provider API key in the RPA process. The UI must explicitly disclose and authorize any remote resume processing.

## Stage 6 LLM integration and two-round agent

The cloud server now implements the LLM proxy. For remote resume extraction and scoring, set `EASYHUNT_ALLOW_REMOTE_RESUME_PROCESSING=true`, `EASYHUNT_CLOUD_BASE_URL=http://127.0.0.1:4320`, `EASYHUNT_CLOUD_ACCESS_TOKEN=<user access token>`, and `EASYHUNT_RESUME_LLM_PROXY_URL=http://127.0.0.1:4320/llm/resume-extract` before running `resume:demo`. Without this explicit opt-in, resumes remain entirely local and use regex parsing plus rule scoring. The cloud service does not persist submitted resume text.

For target-mode search, sign the BOSS authorization and platform agreement as described above, log in within the shared BrowserView, and start both the cloud server and RPA engine. Set `EASYHUNT_CLOUD_BASE_URL` and `EASYHUNT_CLOUD_ACCESS_TOKEN` for the RPA process. Save the `/llm/profile` response's `profile` object as `profile.json`, then run:

```bash
npm run agent:boss -- --project PROJECT_UUID --job "后端工程师" --profile profile.json
```

The RPA returns an asynchronous operation. It asks the cloud for up to three search terms per round, runs the existing BOSS skill under signed authorization, pause/resume, and rate limits, and records two rounds of aggregate collected and initial-screen-passed counts in the cloud project. The current initial screen checks whether the locally read resume excerpt contains the job title or search term. That pass rate guides search iteration and is not a hiring decision. `npm test` runs a deterministic two-round mock skill; live BOSS results require an authorized logged-in session and current selectors.
