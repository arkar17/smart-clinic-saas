# smart-clinic-saas
Multi-tenant clinic management SaaS with appointment scheduling, live patient queues, doctor workspaces, and operational analytics.

## Development (SC-1)

Requires Node 22, pnpm 10 and PostgreSQL 16 (or `docker compose up db`). Only fictional data.

```bash
pnpm install            # also generates the Prisma client
pnpm lint && pnpm typecheck
pnpm test:unit          # pure unit tests (no database)
pnpm test:int           # integration tests; DATABASE_URL must point to a disposable *_test database
pnpm db:verify          # checks hand-written constraints/triggers/grants after migrations
```

Planning documents: `docs/baseline-v1.1/`. Engineering rules: `CLAUDE.md`.
