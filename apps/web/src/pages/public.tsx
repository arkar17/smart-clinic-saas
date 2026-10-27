import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicClinic, PublicService } from '@sc/contracts';
import { get } from '../api';
import { Button, EmptyState, ErrorState, Loading, useResource } from '../components';

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
      {slot && (
        <div className="rounded bg-white p-3 shadow-sm">
          <Button disabled className="w-full">Continue</Button>
          <p className="mt-1 text-sm text-slate-600">Reserving this time and entering your name and phone will be available soon.</p>
        </div>
      )}
    </Page>
  );
}
