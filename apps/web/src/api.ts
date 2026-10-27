import type { ErrorEnvelope, MeResponse } from '@sc/contracts';

/** Typed API client (SC1-FE-03): sends X-Clinic-Id and X-CSRF-Token; reloads on clinic-selection errors. */
let csrfToken = '';
let clinicId: string | null = null;
export const setSession = (me: Pick<MeResponse, 'csrfToken' | 'selectedClinicId'>) => {
  csrfToken = me.csrfToken;
  clinicId = me.selectedClinicId;
};

export class ApiError extends Error {
  constructor(public status: number, public body: ErrorEnvelope['error']) {
    super(body.message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  if (csrfToken) h['x-csrf-token'] = csrfToken;
  if (clinicId) h['x-clinic-id'] = clinicId;
  const res = await fetch(`/api${path}`, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ error: { code: 'INTERNAL', message: 'Unexpected response', requestId: '' } }));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error);
    // Stale tab or lost membership: reload so the shell re-reads /me and shows the clinic selection (ADR-036).
    if (['CLINIC_CONTEXT_MISMATCH', 'CLINIC_SELECTION_REQUIRED'].includes(err.body.code)) window.location.assign('/app/select-clinic');
    throw err;
  }
  if (data && typeof data === 'object' && 'csrfToken' in data) setSession({ csrfToken: data.csrfToken, selectedClinicId: data.selectedClinicId ?? clinicId });
  return data as T;
}
export const get = <T,>(p: string) => api<T>('GET', p);

/** Downloads a binary staff resource (QR codes) with the clinic/CSRF headers a plain link cannot send. */
export async function download(path: string, filename: string) {
  const h: Record<string, string> = {};
  if (clinicId) h['x-clinic-id'] = clinicId;
  const res = await fetch(`/api${path}`, { headers: h, credentials: 'same-origin' });
  if (!res.ok) throw new Error('Download failed.');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
