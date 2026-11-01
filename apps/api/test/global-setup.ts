import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests run only against an approved, disposable database (CLAUDE.md, R-05).
 * Guard: the host must be local and the database name must end in "_test". Migrations are applied with `prisma migrate deploy`.
 */
export default function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  const parsed = new URL(url);
  const name = parsed.pathname.replace('/', '');
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error(`Refusing to run integration tests against non-local host "${parsed.hostname}"`);
  if (!name.endsWith('_test')) throw new Error(`Refusing to run integration tests against "${name}": database name must end in _test`);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd, stdio: 'inherit', env: process.env });
}
