import { z } from 'zod';
import { ClinicRole } from './enums';
import { Email, Uuid } from './common';

export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(128) }).strict();
export const SelectClinicRequest = z.object({ clinicId: Uuid }).strict();
/** BR-080 length rule; "not equal to email" and the common-password list are checked on the server. */
export const NewPassword = z.string().min(12, 'At least 12 characters').max(128, 'At most 128 characters');
export const ChangePasswordRequest = z.object({ currentPassword: z.string().min(1).max(128), newPassword: NewPassword }).strict();

export const MembershipSummary = z.object({
  clinicId: Uuid,
  clinicName: z.string(),
  clinicStatus: z.string(),
  roles: z.array(ClinicRole),
  doctorId: Uuid.nullable(),
});
export type MembershipSummary = z.infer<typeof MembershipSummary>;

export interface MeResponse {
  user: { id: string; email: string; displayName: string; mustChangePassword: boolean; isPlatformAdmin: boolean };
  memberships: MembershipSummary[];
  selectedClinicId: string | null;
  roles: ClinicRole[];
  doctorId: string | null;
  csrfToken: string;
}
