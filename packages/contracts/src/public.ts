import { z } from 'zod';
import { IsoDate, Uuid } from './common';

export const PublicServicesQuery = z.object({ mode: z.enum(['booking', 'walk_in']).default('booking') }).strict();
export const AvailabilityDatesQuery = z.object({ serviceId: Uuid, doctorId: Uuid, from: IsoDate.optional(), to: IsoDate.optional() }).strict();
export const AvailabilitySlotsQuery = z.object({ serviceId: Uuid, doctorId: Uuid, date: IsoDate }).strict();

export type WalkInState = 'OPEN' | 'NOT_YET_OPEN' | 'CLOSED' | 'FULL' | 'PAUSED' | 'DISABLED';
export interface ActionState { enabled: boolean; reason?: string }

/** GET /api/public/clinics/:slug (Arch 14.2). Contains no patient data. */
export interface PublicClinic {
  slug: string;
  name: string;
  address: string | null;
  contactPhone: string | null;
  timezone: string;
  today: { date: string; intervals: { start: string; end: string }[]; closedLabel?: string };
  walkIn: { state: WalkInState; opensAt?: string; closesAt?: string };
  actions: { book: ActionState; joinQueue: ActionState };
}

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  doctors: { id: string; displayName: string; titleLabel: string | null }[];
  preselectedDoctorId: string | null;
}
