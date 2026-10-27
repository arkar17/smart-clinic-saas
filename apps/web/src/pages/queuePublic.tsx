import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicQueueStatus, PublicService } from '@sc/contracts';
import { ApiError, api, get } from '../api';
import { Button, EmptyState, ErrorState, Field, Loading, fieldsOf } from '../components';
import { LiveBadge, useLive } from '../live';

const Page = ({ children }: { children: React.ReactNode }) => <main className="mx-auto max-w-xl space-y-4 p-4">{children}</main>;
type Eligibility = { eligible: boolean; reason?: string; reasonText?: string; opensAt?: string; closesAt?: string; services: PublicService[] };
type Joined = { token: string; status: string; doctor: string; service: string; privateUrl: string };

/** P-08 eligibility + service/doctor, P-09 details → token (Journey B, FR-QUE-001..005). */
export function JoinQueuePage() {
  const { slug } = useParams();
  const [el, setEl] = useState<Eligibility | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [service, setService] = useState<PublicService | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [done, setDone] = useState<Joined | null>(null);
  const key = useRef(crypto.randomUUID());
  useEffect(() => void get<Eligibility>(`/public/clinics/${slug}/walk-in/eligibility`).then(setEl, setError), [slug]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      setDone(await api<Joined>('POST', `/public/clinics/${slug}/walk-ins`, { serviceId: service!.id, doctorId, fullName: f.get('fullName'), phone: f.get('phone'), privacyAccepted: f.get('privacy') === 'on' }, { 'idempotency-key': key.current }));
    } catch (x) {
      setError(x);
      if (x instanceof ApiError && x.body.code !== 'VALIDATION_ERROR') key.current = crypto.randomUUID();
    }
  }
  if (!el && !error) return <Page><Loading /></Page>;
  if (done) {
    return (
      <Page>
        <section className="space-y-2 rounded border border-green-300 bg-green-50 p-4" aria-live="polite">
          <p className="text-sm">Your number</p>
          <p className="text-5xl font-bold tracking-widest">{done.token}</p>
          <p>{done.service} · {done.doctor}</p>
          <p className="rounded bg-amber-100 p-2 font-medium">Please go to reception to confirm you have arrived. You join the waiting line only after reception confirms your arrival.</p>
          <a className="inline-block rounded bg-brand px-3 py-1.5 text-sm text-white" href={new URL(done.privateUrl).pathname}>Follow my place in the queue</a>
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(done.privateUrl)}>Copy link</Button>
        </section>
      </Page>
    );
  }
  if (!el?.eligible) return <Page><Link to={`/c/${slug}`} className="text-sm underline">← Back</Link><h1 className="text-xl font-semibold">Join today’s queue</h1><p className="rounded bg-amber-50 p-3">{el?.reasonText ?? 'Queue registration is not available.'}</p>{error ? <ErrorState error={error} /> : null}</Page>;
  const fields = fieldsOf(error);
  const choice = (active: boolean) => `rounded border px-3 py-2 text-left text-sm ${active ? 'border-brand bg-teal-50 font-semibold' : 'border-slate-300 bg-white'}`;
  return (
    <Page>
      <Link to={`/c/${slug}`} className="text-sm underline">← Back</Link>
      <h1 className="text-xl font-semibold">Join today’s queue</h1>
      <p className="text-sm text-slate-600">Registration is open until {el.closesAt}.</p>
      <section><h2 className="mb-2 font-semibold">1. Service</h2>
        {el.services.length === 0 ? <EmptyState text="No walk-in services are available." /> : (
          <div className="grid gap-2">{el.services.map((s) => <button key={s.id} type="button" aria-pressed={service?.id === s.id} className={choice(service?.id === s.id)} onClick={() => { setService(s); setDoctorId(s.preselectedDoctorId); }}>{s.name}</button>)}</div>
        )}
      </section>
      {service && (
        <section><h2 className="mb-2 font-semibold">2. Doctor</h2>
          {service.preselectedDoctorId ? <p className="text-sm">With {service.doctors[0]!.displayName}</p> : (
            <div className="grid gap-2">{service.doctors.map((d) => <button key={d.id} type="button" aria-pressed={doctorId === d.id} className={choice(doctorId === d.id)} onClick={() => setDoctorId(d.id)}>{d.displayName}</button>)}</div>
          )}
        </section>
      )}
      {service && doctorId && (
        <form onSubmit={submit} className="space-y-3 rounded bg-white p-4 shadow-sm">
          <h2 className="font-semibold">3. Your details</h2>
          <Field label="Full name" name="fullName" autoComplete="name" required maxLength={100} error={fields.fullName} />
          <Field label="Phone number" name="phone" type="tel" autoComplete="tel" required error={fields.phone} />
          <p className="text-xs text-slate-600">Your number is used only by the clinic to contact you about this visit.</p>
          <Field label="I have read the clinic's privacy notice" name="privacy" type="checkbox" required error={fields.privacyAccepted} />
          {error && !Object.keys(fields).length ? <ErrorState error={error} /> : null}
          <Button type="submit">Get my number</Button>
        </form>
      )}
    </Page>
  );
}

/** Live queue status card, shared by P-10 and the booking page after check-in (FR-QUE-014). */
export function QueueStatusCard({ token, initial }: { token: string; initial?: PublicQueueStatus }) {
  const [s, setS] = useState<PublicQueueStatus | null>(initial ?? null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => api<PublicQueueStatus>('GET', '/public/queue-entry', undefined, { 'x-access-token': token }).then(setS, setError), [token]);
  useEffect(() => { if (!initial) void reload(); }, [reload, initial]);
  const live = useLive('/public/stream', { 'x-access-token': token }, (event, data) => { if (event === 'status') setS(data as PublicQueueStatus); }, () => void reload());
  async function leave() {
    if (!window.confirm('Leave the queue? You will lose your place.')) return;
    try { setS(await api<PublicQueueStatus>('POST', '/public/queue-entry/leave', {}, { 'x-access-token': token, 'idempotency-key': crypto.randomUUID() })); } catch (x) { setError(x); }
  }
  if (!s && error instanceof ApiError && error.status === 404) return <section className="rounded bg-white p-4 shadow-sm"><h2 className="text-lg font-semibold">This link is not valid</h2><p className="text-sm text-slate-600">It may have expired. Please contact the clinic.</p></section>;
  if (!s) return error ? <ErrorState error={error} /> : <Loading />;
  return (
    <section className="space-y-2 rounded bg-white p-4 text-center shadow-sm" aria-live="polite">
      <div className="flex justify-end"><LiveBadge state={live} /></div>
      <p className="text-sm">Your number</p>
      <p className="text-6xl font-bold tracking-widest">{s.token}</p>
      <p className={`text-lg font-semibold ${s.status === 'CALLED' ? 'text-green-700' : ''}`}>{s.statusText}</p>
      <p className="text-sm">Doctor: {s.doctor}</p>
      {s.nowServingToken && <p className="text-sm">Now serving: <strong>{s.nowServingToken}</strong></p>}
      {s.peopleAhead !== null && <p className="text-sm">People ahead of you: <strong>{s.peopleAhead}</strong></p>}
      {error ? <ErrorState error={error} /> : null}
      {s.canLeave && <Button variant="secondary" onClick={leave}>Leave the queue</Button>}
    </section>
  );
}

/** P-10 /c/:slug/q/:token — the token is sent only as X-Access-Token (ADR-010). */
export function QueueStatusPage() {
  const { token } = useParams();
  return <Page><h1 className="text-xl font-semibold">Your place in the queue</h1><QueueStatusCard token={token ?? ''} /></Page>;
}
