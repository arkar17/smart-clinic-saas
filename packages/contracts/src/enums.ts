import { z } from 'zod';

// Arch 10.3 enumerations used from SC-1 onwards.
export const ClinicRole = z.enum(['CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR']);
export type ClinicRole = z.infer<typeof ClinicRole>;
export const PlatformRole = z.enum(['NONE', 'PLATFORM_ADMIN']);
export const ClinicStatus = z.enum(['PENDING_SETUP', 'ACTIVE', 'SUSPENDED']);
export type ClinicStatus = z.infer<typeof ClinicStatus>;
export const ScheduleExceptionKind = z.enum(['UNAVAILABLE', 'MODIFIED_HOURS']);
export type ScheduleExceptionKind = z.infer<typeof ScheduleExceptionKind>;
export const ActorType = z.enum(['STAFF', 'PUBLIC_PATIENT', 'SYSTEM']);
