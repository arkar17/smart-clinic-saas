import { z } from 'zod';
import { Uuid } from './common';

export const ServiceRequest = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(300).nullable(),
    durationMin: z.number().int().min(5).max(240).multipleOf(5, 'Multiple of 5 minutes'),
    onlineBookingEnabled: z.boolean(),
    walkInEnabled: z.boolean(),
    isActive: z.boolean(),
    displayOrder: z.number().int().min(0).max(999),
  })
  .strict();
export const CreateServiceRequest = ServiceRequest.extend({ description: ServiceRequest.shape.description.optional(), isActive: z.boolean().default(true), displayOrder: z.number().int().min(0).max(999).default(0) }).strict();
export const UpdateServiceRequest = ServiceRequest.partial().strict();
export const ServiceDoctorsRequest = z.object({ doctorIds: z.array(Uuid).max(200) }).strict();
