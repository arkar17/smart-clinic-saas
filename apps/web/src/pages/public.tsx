import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicBooking, PublicClinic, PublicService } from '@sc/contracts';
import { ApiError, api, get } from '../api';
import { Button, EmptyState, ErrorState, Field, Loading, fieldsOf, messageOf, useResource } from '../components';

const Page = ({ children }: { children: React.ReactNode }) => <main className="mx-auto max-w-xl space-y-4 p-4">{children}</main>;
const Unavailable = () => (
  <Page>
    <h1 className="text-xl font-semibold">This clinic page is currently unavailable</h1>
    <p className="text-sm text-slate-600">Please check the address or contact the clinic directly.</p>
  </Page>
);
const fmtTime = (iso: string, zone: string) => new Date(iso).toLocaleTimeString([], { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const WALK_IN_TEXT: Record<string, (w: PublicClinic['walkIn']) => string> = {
  OPEN: (w) => `Walk-ins open until ${w.closesAt}`, NOT_YET_OPEN: (w) => `Walk-in registration opens at ${w.opensAt}`, CLOSED: () => 'Walk-in registration is closed today',
  FULL: () => 'Walk-ins are full today', PAUSED: () => 'Walk-in registration is paused', DISABLED: () => 'Walk-ins are not offered online',
};

/** P-01 Public clinic portal /c/:slug (FR-QR-004/005). */
export function PortalPage() {
  const { slug } = useParams();
  const { data, error } = useResource<PublicClinic>(`/public/clinics/${slug}`);
  if (error) return <Unavailable />;
  if (!data) return <Page><Loading /></Page>;
  return (
    <Page>
      <header>
        <h1 className="text-2xl font-semibold">{data.name}</h1>
        {data.address && <p className="text-sm text-slate-600">{data.address}</p>}
        {data.contactPhone && <p className="text-sm"><a className="underline" href={`tel:${data.contactPhone}`}>{data.contactPhone}</a></p>}
      </header>
      <section className="rounded bg-white p-3 shadow-sm" aria-label="Today">
        <h2 className="font-semibold">Today</h2>
        {data.today.intervals.length ? <p>Open {data.today.intervals.map((i) => `${i.start}–${i.end}`).join(', ')}</p> : <p className="font-medium text-red-700">{data.today.closedLabel}</p>}
        <p className="text-sm text-slate-600">{WALK_IN_TEXT[data.walkIn.state]?.(data.walkIn)}</p>
        <p className="text-xs text-slate-500">Times shown in clinic time ({data.timezone}).</p>
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          {data.actions.book.enabled ? <Link to={`/c/${slug}/book`} className="block rounded bg-brand px-4 py-3 text-center font-medium text-white">Book an Appointment</Link>
            : <Button disabled className="w-full py-3">Book an Appointment</Button>}
          {data.actions.book.reason && <p className="mt-1 text-sm text-slate-600">{data.actions.book.reason}</p>}
        </div>
        <div>
          <Button disabled={!data.actions.joinQueue.enabled} className="w-full py-3">Join Today’s Queue</Button>
          {data.actions.joinQueue.reason && <p className="mt-1 text-sm text-slate-600">{data.actions.joinQueue.reason}</p>}
        </div>
      </div>
    </Page>
  );
}

/** P-02 Booking: service → doctor → date → time (FR-APT-001..003). Hold and confirmation arrive in SC-2B. */
export function BookPage() {
  const { slug } = useParams();
  const services = useResource<{ timezone: string; items: PublicService[] }>(`/public/clinics/${slug}/services?mode=booking`);
  const [service, setService] = useState<PublicService | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [dates, setDates] = useState<string[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ startAt: string; endAt: string }[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const base = `/public/clinics/${slug}/availability`;

  useEffect(() => {
    setDates(null); setDate(null); setSlots(null); setSlot(null);
    if (service && doctorId) get<{ dates: string[] }>(`${base}/dates?serviceId=${service.id}&doctorId=${doctorId}`).then((r) => setDates(r.dates), setError);
  }, [service, doctorId, base]);
  useEffect(() => {
    setSlots(null); setSlot(null);
    if (service && doctorId && date) get<{ slots: { startAt: string; endAt: string }[] }>(`${base}/slots?serviceId=${service.id}&doctorId=${doctorId}&date=${date}`).then((r) => setSlots(r.slots), setError);
  }, [service, doctorId, date, base]);

  if (services.error) return <Unavailable />;
  if (!services.data) return <Page><Loading /></Page>;
  const zone = services.data.timezone;
  const choice = (active: boolean) => `rounded border px-3 py-2 text-left text-sm ${active ? 'border-brand bg-teal-50 font-semibold' : 'border-slate-300 bg-white hover:bg-slate-50'}`;
  return (
    <Page>
      <Link to={`/c/${slug}`} className="text-sm underline">← Back</Link>
      <h1 className="text-xl font-semibold">Book an appointment</h1>
      {error ? <ErrorState error={error} /> : null}
      <section aria-labelledby="svc"><h2 id="svc" className="mb-2 font-semibold">1. Service</h2>
        {services.data.items.length === 0 && <EmptyState text="No services are available for online booking." />}
        <div className="grid gap-2">{services.data.items.map((s) => (
          <button key={s.id} type="button" aria-pressed={service?.id === s.id} className={choice(service?.id === s.id)} onClick={() => { setService(s); setDoctorId(s.preselectedDoctorId); }}>
            {s.name} · {s.durationMin} min{s.description && <span className="block font-normal text-slate-600">{s.description}</span>}
          </button>
        ))}</div>
      </section>
      {service && (
        <section aria-labelledby="doc"><h2 id="doc" className="mb-2 font-semibold">2. Doctor</h2>
          {service.preselectedDoctorId ? <p className="text-sm">With {service.doctors[0]!.displayName}{service.doctors[0]!.titleLabel ? ` · ${service.doctors[0]!.titleLabel}` : ''}</p> : (
            <div className="grid gap-2">{service.doctors.map((d) => (
              <button key={d.id} type="button" aria-pressed={doctorId === d.id} className={choice(doctorId === d.id)} onClick={() => setDoctorId(d.id)}>{d.displayName}{d.titleLabel ? ` · ${d.titleLabel}` : ''}</button>
            ))}</div>
          )}
        </section>
      )}
      {service && doctorId && (
        <section aria-labelledby="date"><h2 id="date" className="mb-2 font-semibold">3. Date</h2>
          {!dates ? <Loading /> : dates.length === 0 ? <EmptyState text="No available dates. Please try another doctor or contact the clinic." /> : (
            <div className="flex flex-wrap gap-2">{dates.map((d) => <button key={d} type="button" aria-pressed={date === d} className={choice(date === d)} onClick={() => setDate(d)}>{fmtDate(d)}</button>)}</div>
          )}
        </section>
      )}
      {date && (
        <section aria-labelledby="time"><h2 id="time" className="mb-2 font-semibold">4. Time <span className="text-xs font-normal text-slate-500">({zone})</span></h2>
          {!slots ? <Loading /> : slots.length === 0 ? <EmptyState text="No times left on this date." /> : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{slots.map((s) => <button key={s.startAt} type="button" aria-pressed={slot === s.startAt} className={choice(slot === s.startAt)} onClick={() => setSlot(s.startAt)}>{fmtTime(s.startAt, zone)}</button>)}</div>
          )}
        </section>
      )}
      {slot && service && doctorId && <ReserveAndConfirm key={slot} slug={slug!} serviceId={service.id} doctorId={doctorId} startAt={slot} zone={zone} onLost={() => { const d = date; setDate(null); setTimeout(() => setDate(d), 0); }} />}
    </Page>
  );
}

type Hold = { reservationId: string; reservationSecret: string; expiresAt: string; summary: { service: string; doctor: string; startAt: string; endAt: string } };
type Confirmed = { bookingReference: string; privateUrl: string; startAt: string; service: string; doctor: string; timezone: string };

/** P-05 details with hold countdown → P-06 confirmed (FR-APT-005..007). */
function ReserveAndConfirm({ slug, serviceId, doctorId, startAt, zone, onLost }: { slug: string; serviceId: string; doctorId: string; startAt: string; zone: string; onLost: () => void }) {
  const [hold, setHold] = useState<Hold | null>(null);
  const [done, setDone] = useState<Confirmed | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [left, setLeft] = useState(0);
  const confirmKey = useRef(crypto.randomUUID()); // same key for retries of one confirmation (BR-025)
  const base = `/public/clinics/${slug}/reservations`;

  async function reserve() {
    setError(null);
    try {
      setHold(await api<Hold>('POST', base, { serviceId, doctorId, startAt }, { 'idempotency-key': crypto.randomUUID() }));
      confirmKey.current = crypto.randomUUID();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.body.code === 'SLOT_UNAVAILABLE') onLost();
    }
  }
  useEffect(() => {
    if (!hold) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(hold.expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [hold]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hold) return;
    const f = new FormData(e.currentTarget);
    try {
      setDone(await api<Confirmed>('POST', `${base}/${hold.reservationId}/confirm`,
        { reservationSecret: hold.reservationSecret, fullName: f.get('fullName'), phone: f.get('phone'), privacyAccepted: f.get('privacy') === 'on' },
        { 'idempotency-key': confirmKey.current }));
    } catch (x) {
      setError(x);
      if (x instanceof ApiError && ['HOLD_EXPIRED', 'SLOT_UNAVAILABLE'].includes(x.body.code)) { setHold(null); onLost(); }
    }
  }
  async function release() {
    if (hold) await api('POST', `${base}/${hold.reservationId}/release`, { reservationSecret: hold.reservationSecret }, { 'idempotency-key': crypto.randomUUID() }).catch(() => {});
    setHold(null);
  }

  if (done) {
    return (
      <section className="space-y-2 rounded border border-green-300 bg-green-50 p-4" aria-live="polite">
        <h2 className="text-lg font-semibold">Your appointment is confirmed</h2>
        <p>Booking reference: <strong className="font-mono">{done.bookingReference}</strong></p>
        <p>{done.service} with {done.doctor}, {new Date(done.startAt).toLocaleString([], { timeZone: done.timezone, dateStyle: 'full', timeStyle: 'short' })}</p>
        <p className="text-sm">Keep this private link to view or cancel your booking. Anyone with the link can see it.</p>
        <div className="flex flex-wrap gap-2">
          <a className="rounded bg-brand px-3 py-1.5 text-sm text-white" href={new URL(done.privateUrl).pathname}>Open my booking</a>
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(done.privateUrl)}>Copy link</Button>
        </div>
      </section>
    );
  }
  if (!hold) {
    return (
      <div className="rounded bg-white p-3 shadow-sm">
        {error ? <ErrorState error={error} /> : null}
        <Button className="w-full" onClick={reserve}>Continue with {fmtTime(startAt, zone)}</Button>
      </div>
    );
  }
  const fields = fieldsOf(error);
  return (
    <form onSubmit={submit} className="space-y-3 rounded bg-white p-4 shadow-sm">
      <h2 className="font-semibold">Your details</h2>
      <p className="text-sm" role="timer">{hold.summary.service} with {hold.summary.doctor} at {fmtTime(hold.summary.startAt, zone)} — held for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
      <Field label="Full name" name="fullName" autoComplete="name" required maxLength={100} error={fields.fullName} />
      <Field label="Phone number" name="phone" type="tel" autoComplete="tel" required error={fields.phone} />
      <p className="text-xs text-slate-600">Your number is used only by the clinic to contact you about this visit.</p>
      <Field label="I have read the clinic's privacy notice" name="privacy" type="checkbox" required error={fields.privacyAccepted} />
      {error && !Object.keys(fields).length ? <ErrorState error={error} /> : null}
      <div className="flex gap-2"><Button type="submit" disabled={left === 0}>Confirm booking</Button><Button variant="secondary" onClick={release}>Change time</Button></div>
      {left === 0 && <p role="alert" className="text-sm text-red-700">Your hold has expired. Please choose a time again.</p>}
    </form>
  );
}

/** P-07 my booking: /c/:slug/b/:token — the token is sent only in the X-Access-Token header (ADR-010). */
export function MyBookingPage() {
  const { token } = useParams();
  const [data, setData] = useState<PublicBooking | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<PublicBooking>('GET', '/public/booking', undefined, { 'x-access-token': token ?? '' }).then(setData, setError);
  useEffect(() => void load(), [token]);
  if (error && !data) return <Page><h1 className="text-xl font-semibold">This link is not valid</h1><p className="text-sm text-slate-600">It may have expired. Please contact the clinic.</p></Page>;
  if (!data) return <Page><Loading /></Page>;
  async function cancel() {
    if (!window.confirm('Cancel this appointment?')) return;
    setBusy(true);
    try {
      await api('POST', '/public/booking/cancel', {}, { 'x-access-token': token ?? '', 'idempotency-key': crypto.randomUUID() });
      await load();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Page>
      <h1 className="text-xl font-semibold">{data.clinic.name}</h1>
      {data.clinic.suspended && <p className="rounded bg-amber-50 p-2 text-sm">This clinic is currently unavailable online. Please contact the clinic.</p>}
      <dl className="grid grid-cols-3 gap-2 rounded bg-white p-4 text-sm shadow-sm">
        <dt className="font-medium">Reference</dt><dd className="col-span-2 font-mono">{data.bookingReference}</dd>
        <dt className="font-medium">Status</dt><dd className="col-span-2">{data.status.replace('_', ' ').toLowerCase()}</dd>
        <dt className="font-medium">When</dt><dd className="col-span-2">{new Date(data.startAt).toLocaleString([], { timeZone: data.clinic.timezone, dateStyle: 'full', timeStyle: 'short' })}</dd>
        <dt className="font-medium">Service</dt><dd className="col-span-2">{data.service.name} ({data.service.durationMin} min)</dd>
        <dt className="font-medium">Doctor</dt><dd className="col-span-2">{data.doctor.displayName}</dd>
        <dt className="font-medium">Patient</dt><dd className="col-span-2">{data.patient.firstName} · {data.patient.maskedPhone}</dd>
      </dl>
      {error ? <ErrorState error={error} /> : null}
      {data.cancellation.allowed ? <Button variant="danger" disabled={busy} onClick={cancel}>Cancel appointment</Button>
        : data.status === 'CONFIRMED' && <p className="text-sm">To change or cancel, please call {data.clinic.contactPhone ? <a className="underline" href={`tel:${data.clinic.contactPhone}`}>{data.clinic.contactPhone}</a> : 'the clinic'}.</p>}
      {error ? <p className="text-xs text-slate-500">{messageOf(error)}</p> : null}
    </Page>
  );
}
