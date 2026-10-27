# Smart Clinic — Release and Operations Guide (SC-5)

Target: a **local Docker release** for portfolio demonstration (D-10). Live hosting needs separate approval.

## 1. Environment variables

Copy `.env.example` to `.env`; never commit `.env` (it is git-ignored). Generate real values for every secret.

| Variable | Used by | Notes |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | db, all Node services | Compose refuses to start without `POSTGRES_PASSWORD`. |
| `DATABASE_URL` | host-side tools | Compose builds its own URL from the three values above. |
| `APP_ORIGIN` | api | Exact browser origin; state-changing requests with any other Origin get 403 (CSRF). Must be `https://…` in production. |
| `PUBLIC_BASE_URL` | api | Host encoded in clinic QR codes and private links. |
| `COOKIE_SECURE` | api | `true` behind HTTPS; the API refuses to start in production without it. |
| `TRUST_PROXY` | api | Number of reverse-proxy hops (used for client IPs in rate limits). |
| `IP_HASH_PEPPER` | api, worker | ≥ 16 random characters (`openssl rand -base64 24`). |
| `IDEMPOTENCY_ENC_KEY` | api, worker | base64 of 32 random bytes (`openssl rand -base64 32`); rotating it invalidates stored replays (24 h). |
| `LOG_LEVEL` | api, worker | `info` by default. |
| `WORKER_ENABLED` | worker | Must be `true`; set by Compose. The worker also refuses `*_test` databases. |
| `VITE_DEMO` | web | `true` shows the “Demo — fictional data” banner (FR-DEM-002). |
| Rate-limit overrides (`LOGIN_RATE_LIMIT_PER_10_MIN`, `PUBLIC_RATE_LIMIT_PER_MIN`, `HOLD_RATE_LIMIT_PER_MIN`, `TOKEN_FAILURE_LIMIT_PER_10_MIN`) | api | Defaults follow SRS 14.5; raise only in tests. |

## 2. Start, stop, restart

```bash
docker compose up -d db
docker compose run --rm migrate          # only when migrations changed
docker compose up -d api worker web
docker compose ps                        # api health = GET /readyz (database reachable)
docker compose restart api worker        # safe: state is in PostgreSQL; SSE clients reconnect and resync
docker compose stop                      # graceful stop
docker compose down                      # keep data; `down -v` deletes the db-data volume (destructive)
```

Services restart `unless-stopped`; `api` waits for a healthy `db`, `worker` and `web` wait for a healthy `api`.

## 3. Migrations and rollback

- Migrations live in `apps/api/prisma/migrations` (0001–0005) and contain Prisma-generated SQL plus hand-written constraints, triggers and grants (ADR-019). Applied migrations are never edited.
- Apply only through the explicit step `docker compose run --rm migrate` (`prisma migrate deploy` then `db:verify`). Never use `prisma migrate reset` or `migrate dev` against a shared database.
- **Rollback:** there are no down-migrations. Before applying a new migration, take a backup (§5). To roll back, restore the backup into a fresh volume and redeploy the previous commit; for forward fixes write a new migration (expand → backfill → contract).

## 4. Worker and SSE

- The worker (`pnpm --filter @sc/api worker`) runs: hold expiry every 60 s, day close every 5 min (finalises past clinic-local days), event purge (> 24 h) and idempotency purge hourly. All jobs are idempotent; correctness never depends on their timing.
- The API keeps one dedicated `LISTEN clinic_event` connection; state changes commit an outbox row and `pg_notify`. Streams send a heartbeat every 25 s, re-validate credentials every 60 s and replay missed events from `Last-Event-ID`.
- Behind a reverse proxy, disable response buffering for `/api/staff/stream` and `/api/public/stream` (e.g. nginx `proxy_buffering off;`; the API also sends `X-Accel-Buffering: no`) and allow long read timeouts.
- The hub is in-process: run **one API instance** (multi-instance fan-out is post-MVP, ADR-012).

## 5. Backup and restore (procedure — not yet executed on a demo database)

```bash
docker compose exec db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > backup-$(date +%F).dump
# restore into an empty database:
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup-YYYY-MM-DD.dump
```

## 6. Database roles

Migration 0001 creates `sc_owner` and `sc_app`; `sc_app` has DML on tenant tables and only INSERT/SELECT on `audit_log`. The local Compose stack connects as the database owner for simplicity. For any shared or hosted environment, create a login role granted `sc_app` for the API/worker and keep the owner credentials for the migrate step only:

```sql
CREATE ROLE smartclinic_app LOGIN PASSWORD '…' IN ROLE sc_app;
```

## 7. Demo data

`apps/api/scripts/demo-seed.ts` is opt-in (FR-DEM-001/002): it needs `DEMO_SEED_CONFIRM=yes`, `--confirm`, a database named `*_dev`/`*_demo` and an empty clinic table. Reset (FR-DEM-003) = `docker compose down -v`, start `db`, run `migrate`, seed again. **Status: written and type-checked; not executed (awaiting approval).**

## 8. Release checklist

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:int`, `pnpm db:verify`, web build — green
- [x] Chromium E2E (journeys A/B desktop + mobile, staff/security, keyboard, axe, responsive incl. 640 px ≈ 200 % zoom) — green locally
- [x] GitHub Actions run 40469309851: check, integration and e2e jobs green; E2E 7/7 on Chromium and 7/7 on WebKit (CI only — the development container has Chromium only)
- [x] `docker compose config` valid; secrets only via `.env`; no automatic migrate/seed/reset
- [x] Production guard: Secure cookies and https origin required when `NODE_ENV=production`
- [ ] Demo seed executed on an approved demo database (pending approval)
- [ ] Backup/restore executed once on the demo database (SC5-BE-05, pending)
- [ ] Load test at reference load on a separate disposable dataset (SC5-BE-04, D-09, pending)
- [ ] Lighthouse mobile run on P-01/P-10 (TC-NFR-006) — not available in the build environment
- [ ] README screenshots (SC5-FE-01) — not produced
- [ ] Product Owner sign-off

## 9. Known limitations and deferred requirements

- **Deferred SHOULD items:** waiting-room display (FR-QUE-017), receptionist no-phone exception (FR-QUE-020), doctor unavailable-today (FR-DOC-006), staff notification jobs (ADR-014), audit log screens (FR-AUD-004), patient correction/anonymise (FR-PAT-004), patient detail screen R-08, `.ics` calendar and printable QR poster, portal visit counters (FR-QR-006, COULD).
- **Accepted dependency advisories (review before any hosted release):** `zod` 3.x memory-exhaustion advisory (fix requires the zod 4 major upgrade; request bodies are capped at 100 KB and contract arrays are length-limited), `deepmerge-ts` via the Prisma CLI config loader (build tooling, not the request path), and `react-router` 6.x open-redirect/SSR advisories (moderate; links are internal constants, no SSR). CI blocks critical advisories.
- **Verification gaps:** WebKit verified in CI only (the WebKit step is non-blocking, so a future WebKit failure would not turn CI red); Lighthouse/LCP not measured; 200 % zoom approximated by a 640 px viewport; TC-QUE-009 latency checked per run, not as p95 over 20 runs; permission-matrix test generated for SC-1 capabilities, later capabilities covered by per-feature tests.
- **Operational:** single API instance for SSE; Compose runs the API via `tsx` (development-style runtime) and connects as the database owner; no external messaging (by design).
