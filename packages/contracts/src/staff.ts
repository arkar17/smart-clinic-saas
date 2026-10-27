import { z } from 'zod';
import { ClinicRole } from './enums';
import { Email } from './common';
import { DisplayName } from './platform';

const Roles = z.array(ClinicRole).min(1, 'At least one role').refine((r) => new Set(r).size === r.length, 'Duplicate role');
export const AddStaffRequest = z.object({ email: Email, displayName: DisplayName, roles: Roles }).strict();
export const UpdateStaffRequest = z.object({ roles: Roles, email: Email }).partial().strict();
