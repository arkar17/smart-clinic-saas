# Smart Clinic — Multi-Clinic Management SaaS

A multi-tenant clinic operations platform (portfolio project) that takes a patient from a clinic QR code to the doctor's room without patient accounts, using appointment booking, a live same-day queue, reception and doctor workspaces, and operational reporting. **All data is fictional.**

- **Journey A — scheduled:** QR → service → doctor → slot → name + phone → booking reference and private link → reception check-in → queue token → doctor calls → completed.
- **Journey B — walk-in:** QR → Join Today's Queue → service/doctor → name + phone → token (REGISTERED) → reception confirms physical arrival → WAITING → doctor calls → completed.

Built against an approved baseline (SRS, architecture, ADRs and test matrix in [`docs/baseline-v1.1/`](docs/baseline-v1.1/README_DOCUMENTS.md)) in five gates, SC-1 … SC-5, each closed with full regression and green CI.

## What it does

| Area | Highlights |
|---|---|
| Multi-clinic staff | One global account can belong to several clinics with per-clinic roles (Clinic Admin, Receptionist, Doctor); the active clinic is selected server-side and re-validated on every request. |
| Clinic set-up | Opening hours with breaks, closures, services, doctors, weekly schedules and exceptions; platform activation checklist; suspend/reactivate. |
| Booking | DST-safe availability engine; reservation holds with expiry; no double booking (PostgreSQL exclusion constraint); idempotent confirmation; hashed private links. |
| Live queue | Gapless daily tokens per clinic-local day; REGISTERED ≠ WAITING until reception confirms arrival; call next with row locking; one active patient per doctor; recall limit; day close. |
| Realtime | Transactional outbox + `pg_notify` + Server-Sent Events, isolated per clinic and audience, with Last-Event-ID replay and credential re-validation. |
| Reporting | Live Today dashboard (role-aware) and date-range reports (median/p90 waits, cancellation/no-show rates) with a PII-free CSV export. |

## Architecture

Modular monolith in a pnpm workspace (ADR-001):

```
apps/web            React + TypeScript + Vite + Tailwind (public portal, staff app, platform realm)
apps/api            Express API (server.ts) and worker (worker.ts) sharing one codebase
  src/modules       identity · platform · clinic · scheduling · booking · patients · appointments · queue · realtime · reporting · audit
  prisma/           schema + migrations 0001–0005 (hand-written constraints, triggers, grants) + db-verify manifest
packages/contracts  Shared strict Zod schemas, error codes, permission matrix compiled from the CSV
packages/config     Environment schema and security constants
```

PostgreSQL 16 does the hard guarantees: composite clinic-scoped foreign keys, the appointment exclusion constraint, the queue counter row lock, status-guard triggers and an append-only audit table.

## Prerequisites

- Node.js 22 and pnpm 10 (`corepack enable`)
- PostgreSQL 16 locally **or** Docker with Compose v2
- For browser tests: Playwright 1.63 with Chromium (see *Tests*)

## Quick start with Docker Compose

```bash
cp .env.example .env                 # then replace the placeholder secrets (see docs/RELEASE.md)
docker compose up -d db
docker compose run --rm migrate      # explicit migration step: prisma migrate deploy + db:verify
docker compose up -d api worker web  # http://localhost:5173
docker compose logs -f api           # follow logs
docker compose stop                  # stop, keep data
docker compose down                  # remove containers, keep the db-data volume
docker compose down -v               # DESTRUCTIVE: also deletes the database volume
```

Nothing migrates, seeds or resets automatically. An empty database has no users; to explore the demo, see *Demo walkthrough*.

## Local development without Docker

```bash
pnpm install                          # also generates the Prisma client
export DATABASE_URL=postgresql://…/smartclinic_dev
pnpm --filter @sc/api exec prisma migrate deploy && pnpm db:verify
pnpm --filter @sc/api dev             # API on :3000 (needs the variables in .env.example)
pnpm --filter @sc/api worker          # requires WORKER_ENABLED=true; refuses *_test databases
pnpm --filter @sc/web dev             # web on :5173, proxies /api to :3000
```

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test:unit                        # pure unit tests (no database)
pnpm test:int                         # integration; DATABASE_URL must be a local *_test database
pnpm test:e2e                         # Playwright journeys + axe (Chromium; E2E_BROWSER=webkit where installed)
pnpm db:verify                        # hand-written constraints, triggers, grants exist
```

The integration and E2E runners refuse any database that is not on a local host or whose name does not end in `_test`; they create and truncate their own fictional fixtures. CI runs everything against throwaway PostgreSQL service containers.

## Demo walkthrough

The opt-in seed (`apps/api/scripts/demo-seed.ts`) creates a Platform Admin, two fictional clinics (Asia/Bangkok and Europe/London) with Clinic Admin, Receptionist and Doctor accounts, a doctor who belongs to both clinics, services, schedules, a holiday and two weeks of fictional history. It runs only with explicit confirmation on a `*_dev`/`*_demo` database:

```bash
DEMO_SEED_CONFIRM=yes pnpm --filter @sc/api demo:seed -- --confirm
```

Then, with password `Demo-Fictional-2026!`:

1. **Journey A:** open `/c/sunrise-demo` → *Book an Appointment* → pick a time → enter a fictional name and phone → note the reference and open the private link. Sign in as `reception.sunrise@demo.example` → *Appointments* → *Check in* (a token is issued). Sign in as `doctor.sunrise@demo.example` → *My queue* → *Call next* → *Start* → *Complete*; the patient page updates live.
2. **Journey B:** `/c/sunrise-demo` → *Join Today's Queue* → token shown as REGISTERED. Reception → *Queue* → *Confirm arrival* (now WAITING, live on the patient page) → doctor calls and completes.
3. **Dashboard and reports:** `admin.sunrise@demo.example` → *Today* and *Reports* (history is pre-seeded).
4. **Isolation:** `dual.doctor@demo.example` must choose a clinic and sees only that clinic's queue; `admin.riverside@demo.example` never sees Sunrise data; `platform.admin@demo.example` sees clinic metadata and counts only.

## Security and tenant isolation (summary)

- Clinic context comes only from the session's selected membership (re-validated per request), the public slug or a hashed access token; `X-Clinic-Id` must match and request bodies may not carry clinic IDs (strict schemas).
- Every tenant table carries `clinic_id` with composite foreign keys, so cross-clinic references fail in the database; foreign IDs return identical 404s.
- Permissions are compiled from the approved matrix; doctors see only their own profile's patients and queue; Platform Administrators have no patient-level endpoints.
- Server-side sessions (hashed cookie IDs, idle/absolute expiry), CSRF token + Origin check, Argon2id, lockout, rate limits; private links and reservation secrets stored only as SHA-256 hashes; idempotent responses encrypted at rest (AES-256-GCM).
- SSE events are PII-free and routed per clinic and audience; streams close on clinic switch, membership deactivation, logout and suspension.
- Logs redact cookies, tokens, passwords and phones; unexpected errors log only class/code.

Operations, environment variables, migration and rollback guidance, the release checklist and known limitations: **[docs/RELEASE.md](docs/RELEASE.md)**. Engineering rules for contributors: [`CLAUDE.md`](CLAUDE.md).
