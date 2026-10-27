// db:verify (ADR-019, TC-NFR-007): fails if any hand-written object from the manifest is missing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/index.js';

interface Manifest {
  extensions: string[];
  roles: string[];
  constraints: string[];
  indexes: string[];
  triggers: { table: string; name: string }[];
  privileges: { role: string; table: string; privilege: string; expected: boolean }[];
  generatedColumns?: { table: string; column: string }[];
}

export async function verifyDatabase(prisma: PrismaClient): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(new URL('../prisma/db-verify-manifest.json', import.meta.url), 'utf8')) as Manifest;
  const problems: string[] = [];
  const names = async (sql: string) => new Set((await prisma.$queryRawUnsafe<{ n: string }[]>(sql)).map((r) => r.n));

  const ext = await names('SELECT extname AS n FROM pg_extension');
  const roles = await names('SELECT rolname AS n FROM pg_roles');
  const cons = await names("SELECT conname AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace WHERE s.nspname = 'public'");
  const idx = await names("SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'");
  const trg = await names("SELECT c.relname || '.' || t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal");

  for (const e of manifest.extensions) if (!ext.has(e)) problems.push(`missing extension ${e}`);
  for (const r of manifest.roles) if (!roles.has(r)) problems.push(`missing role ${r}`);
  for (const c of manifest.constraints) if (!cons.has(c)) problems.push(`missing constraint ${c}`);
  for (const i of manifest.indexes) if (!idx.has(i)) problems.push(`missing index ${i}`);
  for (const t of manifest.triggers) if (!trg.has(`${t.table}.${t.name}`)) problems.push(`missing trigger ${t.table}.${t.name}`);
  for (const p of manifest.privileges) {
    const [row] = await prisma.$queryRawUnsafe<{ ok: boolean }[]>('SELECT has_table_privilege($1, $2, $3) AS ok', p.role, `public.${p.table}`, p.privilege);
    if (row?.ok !== p.expected) problems.push(`privilege ${p.privilege} on ${p.table} for ${p.role} should be ${p.expected}`);
  }
  for (const g of manifest.generatedColumns ?? []) {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 AND is_generated = 'ALWAYS'", g.table, g.column);
    if (!row || Number(row.n) !== 1) problems.push(`missing generated column ${g.table}.${g.column}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prisma = new PrismaClient();
  verifyDatabase(prisma)
    .then((problems) => {
      if (problems.length) {
        console.error(`db:verify FAILED\n- ${problems.join('\n- ')}`);
        process.exitCode = 1;
      } else console.log('db:verify OK');
    })
    .finally(() => prisma.$disconnect());
}
