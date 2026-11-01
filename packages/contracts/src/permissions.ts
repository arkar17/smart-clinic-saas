import { PERMISSION_MATRIX } from './permissions.generated';
import type { ClinicRole } from './enums';

export { PERMISSION_MATRIX };
export type CapabilityId = keyof typeof PERMISSION_MATRIX;
export type PermissionValue = 'ALLOW' | 'DENY' | 'READ' | 'READ_OWN' | 'ALLOW_OWN' | 'ALLOW_OWN_TOKEN' | 'ALLOW_OWN_TOKEN_BEFORE_CUTOFF' | 'N/A';
export type AccessMode = 'read' | 'write';
export type Grant = 'ALL' | 'OWN' | null;

const RANK: Record<string, number> = { ALLOW: 2, ALLOW_OWN: 1, READ: 2, READ_OWN: 1 };

/**
 * Union of the selected membership's roles (Arch 7.3). READ / READ_OWN only grant read access.
 * Returns 'ALL', 'OWN' (doctor's own records, scopeGuard applies) or null (denied).
 */
export function resolveGrant(cap: CapabilityId, roles: readonly ClinicRole[], mode: AccessMode): Grant {
  let best = 0;
  for (const role of roles) {
    const v = PERMISSION_MATRIX[cap][role] as PermissionValue;
    if (mode === 'write' && v.startsWith('READ')) continue;
    best = Math.max(best, RANK[v] ?? 0);
  }
  return best === 2 ? 'ALL' : best === 1 ? 'OWN' : null;
}
