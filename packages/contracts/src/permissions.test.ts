import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PERMISSION_MATRIX, resolveGrant } from './permissions';
// @ts-expect-error plain ESM script without types
import { compileMatrix } from '../scripts/gen-permissions.mjs';

describe('permission matrix compilation (Arch 7.3)', () => {
  it('generated table matches PERMISSION_MATRIX_v1.1.csv exactly (no drift)', () => {
    const csv = readFileSync(new URL('../../../docs/baseline-v1.1/PERMISSION_MATRIX_v1.1.csv', import.meta.url), 'utf8');
    expect(compileMatrix(csv)).toEqual(PERMISSION_MATRIX);
    expect(Object.keys(PERMISSION_MATRIX)).toHaveLength(47);
  });

  it('READ grants read but never write; union of roles applies', () => {
    expect(resolveGrant('CAP-CLN-02', ['RECEPTIONIST'], 'read')).toBe('ALL');
    expect(resolveGrant('CAP-CLN-02', ['RECEPTIONIST'], 'write')).toBeNull();
    expect(resolveGrant('CAP-CLN-05', ['DOCTOR'], 'read')).toBe('OWN');
    expect(resolveGrant('CAP-CLN-05', ['DOCTOR'], 'write')).toBeNull();
    expect(resolveGrant('CAP-CLN-05', ['DOCTOR', 'CLINIC_ADMIN'], 'write')).toBe('ALL');
    expect(resolveGrant('CAP-CLN-07', ['RECEPTIONIST', 'DOCTOR'], 'write')).toBeNull();
    expect(resolveGrant('CAP-QUE-06', ['RECEPTIONIST'], 'write')).toBeNull();
    expect(resolveGrant('CAP-QUE-06', ['DOCTOR'], 'write')).toBe('OWN');
  });
});
