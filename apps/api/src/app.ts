import express from 'express';
import helmet from 'helmet';
import type { Deps } from './infra/context';
import { errorHandler, notFound } from './infra/errors';
import { h, originCheck, requestContext } from './infra/http';
import { authRoutes, staffRoutes } from './modules/identity/index';
import { platformRoutes } from './modules/platform/index';
import { clinicRoutes, serviceRoutes } from './modules/clinic/index';
import { doctorRoutes } from './modules/scheduling/index';
import { patientRoutes } from './modules/patients/index';
import { privateBookingRoutes, publicRoutes } from './modules/booking/index';
import { appointmentRoutes } from './modules/appointments/index';

export function createApp(deps: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.env.TRUST_PROXY);
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } })); // NFR-SEC-002 headers
  app.use(requestContext(deps));
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', h(async (_req, res) => {
    await deps.prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  }));

  app.use('/api', originCheck(deps));
  app.use('/api/auth', authRoutes(deps));
  app.use('/api/platform', platformRoutes(deps));
  app.use('/api/clinic', clinicRoutes(deps));
  app.use('/api/services', serviceRoutes(deps));
  app.use('/api/doctors', doctorRoutes(deps));
  app.use('/api/staff', staffRoutes(deps));
  const patients = patientRoutes(deps);
  app.use('/api/patients', patients.patients);
  app.use('/api/search', patients.search);
  app.use('/api/public/clinics', publicRoutes(deps));
  app.use('/api/public/booking', privateBookingRoutes(deps));
  const appts = appointmentRoutes(deps);
  app.use('/api/appointments', appts.appointments);
  app.use('/api/availability', appts.availability);
  app.use('/api', (_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
