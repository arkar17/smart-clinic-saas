# CLAUDE.md — Smart Clinic (Multi-Clinic Management SaaS)

Baseline: **v1.1 revision B** — approved docs in `docs/baseline-v1.1/` (read-only; never edit).
Current gate: **none started.** SC-1 begins only after explicit Product Owner kickoff approval.

## Project overview

Multi-tenant clinic operations SaaS (portfolio project). Two account-free patient journeys:

- **A — Scheduled:** QR → scheduled appointment → booking reference → reception check-in →
  queue token → doctor visit.
- **B — Walk-in:** QR → same-day walk-in → queue token → `REGISTERED` → arrival confirmation →
  `WAITING` → doctor visit.

Public patients must always provide a valid name and phone (BR-037). Patients without a phone are
handled only by the receptionist workflow (FR-QUE-020, ADR-037).
**Only fictional patient data** — in code, tests, fixtures, seeds, demos and conversation.

## Architecture

- Modular monolith in a **pnpm** workspace monorepo (ADR-001):
  `apps/web`, `apps/api` (`server.ts` HTTP, `worker.ts` worker), `packages/contracts`, `packages/config`.
- API domain modules: identity, platform, clinic, scheduling, booking, patients, queue, reporting,
  audit; infrastructure: realtime, jobs, db, http. Modules expose a public `index.ts`; no deep imports.
- Frontend: React + TypeScript (strict) + Vite + Tailwind CSS.
- Backend: Node.js + Express. Database: PostgreSQL 16 + Prisma (hand-written SQL in migrations, ADR-019).
- Shared **Zod** contracts (`.strict()`) for every request, response, error, enum and SSE payload (ADR-002).
- Realtime: Server-Sent Events via transactional outbox + `pg_notify` + in-process hub (ADR-012).
- Tests: Vitest (unit + integration) and Playwright (E2E consolidated in SC-4).
- Docker Compose for the local stack; minimal GitHub Actions CI from SC-1 (ADR-038).

## Documentation authority

1. SRS v1.1 rev B (`01_Smart_Clinic_SRS_v1.1.docx`)
2. Technical Architecture v1.1 rev B (`02_Smart_Clinic_Technical_Architecture_v1.1.docx`)
3. ADR Log (`ADR_LOG_v1.1.md`)
4. Implementation & QA Plan (`03_Smart_Clinic_Implementation_and_QA_Plan_v1.1.docx`)
5. Permission and traceability matrices (`PERMISSION_MATRIX_v1.1.csv`, `TRACEABILITY_MATRIX_v1.1.md`,
   `ACCEPTANCE_TEST_MATRIX_v1.1.csv`)

> Note: `README_DOCUMENTS.md` §1 ranks the Permission Matrix (#4) above the Plan (#10). This is an
> open ordering question for the Product Owner; until decided, treat any conflict between them as
> a contradiction to report.

If documents conflict, **stop and report the contradiction** (and propose an
`INCONSISTENCY_REGISTER_v1.1.md` entry) — never invent a resolution or new requirements.
Per gate, read the gate's traceability rows plus only the specific SRS/architecture section a task needs.

## Critical engineering rules

**Tenancy & identity**
- One global staff account (`app_user`) may belong to multiple clinics via `clinic_member`
  (`UNIQUE (clinic_id, user_id)`). Roles and membership status are clinic-specific.
- Sessions hold one securely selected membership, set only via `POST /api/auth/select-clinic`;
  composite FK `(active_clinic_id, active_member_id, user_id)` prevents referencing another user's membership.
- Re-validate membership (active, clinic accessible, account active) on **every** request.
- Clinic context comes only from the session's selected membership, the public slug, or a token hash.
  **Never trust clinic IDs in request bodies.** `X-Clinic-Id` must match the session
  (`409 CLINIC_CONTEXT_MISMATCH`) and is never used to select data or permissions (ADR-036).
- Every tenant table has `clinic_id NOT NULL`; parents have `UNIQUE (clinic_id, id)`; children use
  composite FKs `(clinic_id, parent_id)`. Repositories require a `ClinicContext` and always filter by it.
  Foreign-clinic IDs return 404.
- Platform administrators must not access private patient records; Clinic Admin account-admin limits per BR-084/ADR-035.

**Scheduling & queue**
- Prevent overlapping doctor appointments at database level: `EXCLUDE USING gist` with half-open
  `tstzrange` (ADR-006); `23P01` → `409 SLOT_UNAVAILABLE`. Reschedule is one conditional UPDATE (ADR-007).
- Allocate daily queue tokens transactionally: `queue_counter` row `SELECT … FOR UPDATE`, gapless (ADR-008).
- QR registration does **not** prove physical arrival. `REGISTERED` is not `WAITING`;
  REGISTERED patients cannot be called/served until arrival confirmation (ADR-028).
- Enforce status transitions server-side in three layers: pure domain functions, conditional
  `UPDATE … WHERE status AND version`, DB guard triggers (ADR-016). Enforce role permissions server-side
  per `PERMISSION_MATRIX_v1.1.csv`.

**Security & privacy**
- Private booking/queue links use 32-byte random access tokens; store only `sha256` hashes; send via
  `X-Access-Token`, never in API logs (ADR-010). Sessions: opaque cookie, hash stored, CSRF token (ADR-003).
- Never expose patient information across clinics through REST or SSE. Event payloads are PII-free;
  staff UIs refetch by ID (ADR-026).
- Store all instants as UTC `timestamptz`; clinic-local dates/times use the clinic's IANA timezone
  (Luxon); "now" comes from an injectable `Clock` (ADR-015).

## Development and credit rules

- Total Claude Cloud development allocation: **$35 maximum target.**
  SC-1 $7 · SC-2 $9 · SC-3 $9 · SC-4 $6 · SC-5 $4.
- Gate budgets are planning caps, not guarantees. Report at 50 %, apply freeze list at 80 %,
  stop and ask the Product Owner at 100 % (Plan §4.6).
- Work on one gate at a time. Do not begin the next gate without explicit approval.
- No subagents, parallel agents or background tasks.
- Prefer targeted tests while developing (e.g. `pnpm test:unit <path>`, `pnpm test:int <path>`);
  run full regression only at gate closure.
- Do not repeat document reviews unnecessarily; rely on this file and the gate's traceability rows.
- Reuse components, helpers, factories and contracts. Keep diffs small; don't reformat untouched files.
- Do not add unnecessary dependencies (state why for any new one) or unrequested features.

## Database and infrastructure safety

- Ask for explicit permission before applying any migration; show the generated SQL (including
  hand-written constraints) first. Never edit an applied migration.
- Ask before running seeds, resets (`prisma migrate reset`), `DROP`, `TRUNCATE`, or any destructive
  data operation. Test-runner fixtures created and destroyed in disposable test DBs are allowed.
- Never modify production or shared databases. Use only approved disposable databases for integration testing.
- No paid services, external SaaS, infrastructure provisioning or deployment without approval.
  No SMS/email providers at all. Release target is a local Docker release.
- No real patient data, ever.

## Commands (to be created in SC-1)

`pnpm lint` · `pnpm typecheck` · `pnpm test:unit <path>` · `pnpm test:int <path>` · `pnpm db:verify`

## Completion rules

- Run relevant lint, typecheck and tests before committing; `db:verify` after any migration.
- Preserve requirement and test IDs (FR-, NFR-, BR-, TC-, CAP-, SCn-BE/FE-); never renumber.
- Record unfinished or deferred items clearly with their IDs.
- Commit and push only verified changes to the designated branch.
- Report at gate end (Plan §4.5): completed work, tests, migrations, blockers, decisions needed, next gate —
  then stop and wait for approval.
