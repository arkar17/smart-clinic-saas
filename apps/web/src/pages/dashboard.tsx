import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, staffStreamHeaders } from '../api';
import { hasRole, useAuth } from '../auth';
import { DataTable, ErrorState, Field, Loading } from '../components';
import { LiveBadge, useLive } from '../live';

type Today = {
  date: string; timezone: string; clinicStatus: string; activeDoctors: number; longestWaitMin: number | null;
  appointments: Record<string, number>; totals: Record<string, number>;
  queue: { doctorId: string; doctor: string; REGISTERED: number; WAITING: number; CALLED: number; IN_CONSULTATION: number; COMPLETED: number; current: string | null }[];
  walkIn: { state: string; used: number; capacity: number | null; remaining: number | null; paused: boolean } | null;
};

const Tile = ({ label, value, to }: { label: string; value: string | number; to?: string }) => {
  const body = <><p className="text-xs text-slate-600">{label}</p><p className="text-2xl font-semibold">{value}</p></>;
  return to ? <Link to={to} className="block rounded bg-white p-3 shadow-sm hover:ring-2 hover:ring-brand focus-visible:ring-2">{body}</Link> : <div className="rounded bg-white p-3 shadow-sm">{body}</div>;
};

/** R-01 Today dashboard (FR-RPT-001), live; role-aware: CA and RC clinic-wide, Doctor own subset only. */
export function DashboardPage() {
  const { me } = useAuth();
  const [d, setD] = useState<Today | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const reload = useCallback(() => get<Today>('/reports/today').then(setD, setError), []);
  useEffect(() => void reload(), [reload]);
  const live = useLive('/staff/stream', staffStreamHeaders(), () => { clearTimeout(timer.current); timer.current = setTimeout(() => void reload(), 200); }, () => void reload());
  if (error) return <ErrorState error={error} />;
  if (!d) return <Loading />;
  const admin = hasRole(me, 'CLINIC_ADMIN');
  const desk = hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST');
  const a = d.appointments;
  const booked = (a.CONFIRMED ?? 0) + (a.CHECKED_IN ?? 0) + (a.COMPLETED ?? 0) + (a.NO_SHOW ?? 0);
  const t = d.totals;
  const mine = !desk ? d.queue[0] : undefined;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Today · {d.date}</h1><LiveBadge state={live} />
        {d.clinicStatus !== 'ACTIVE' && <span className="rounded bg-amber-100 px-2 text-sm">Clinic {d.clinicStatus.toLowerCase().replace('_', ' ')}</span>}
      </div>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label={desk ? 'Appointments today' : 'My appointments today'} value={booked} to="/app/appointments" />
        <Tile label="Checked in" value={(a.CHECKED_IN ?? 0) + (a.COMPLETED ?? 0)} />
        {desk && <Tile label="Awaiting arrival confirmation" value={t.REGISTERED ?? 0} to="/app/queue" />}
        <Tile label="Waiting" value={t.WAITING ?? 0} to={desk ? '/app/queue' : '/app/my-queue'} />
        <Tile label="Called / in consultation" value={(t.CALLED ?? 0) + (t.IN_CONSULTATION ?? 0)} />
        <Tile label="Completed" value={t.COMPLETED ?? 0} />
        <Tile label="Longest current wait" value={d.longestWaitMin === null ? '—' : `${d.longestWaitMin} min`} />
        {d.walkIn && <Tile label="Walk-in capacity used" value={d.walkIn.capacity ? `${d.walkIn.used} / ${d.walkIn.capacity}` : d.walkIn.used} />}
        {d.walkIn && <Tile label="QR walk-in registration" value={d.walkIn.paused ? 'Paused' : d.walkIn.state.replace('_', ' ').toLowerCase()} />}
        {admin && <Tile label="Active doctors" value={d.activeDoctors} to="/app/doctors" />}
      </section>
      {mine && (
        <section className="rounded bg-white p-4 shadow-sm">
          <h2 className="font-semibold">My queue</h2>
          <p>{mine.current ? <>Current patient token <strong>{mine.current}</strong></> : mine.WAITING ? `${mine.WAITING} waiting — call the next patient` : 'No one is waiting.'}</p>
          <Link to="/app/my-queue" className="mt-2 inline-block rounded bg-brand px-3 py-2 text-sm text-white">Open my queue</Link>
        </section>
      )}
      {desk && (
        <section className="space-y-2">
          <h2 className="font-semibold">Queue by doctor</h2>
          <DataTable rows={d.queue} empty="No active doctors." columns={[
            { header: 'Doctor', cell: (q) => q.doctor },
            { header: 'Registered', cell: (q) => q.REGISTERED }, { header: 'Waiting', cell: (q) => q.WAITING },
            { header: 'Called', cell: (q) => q.CALLED }, { header: 'In consultation', cell: (q) => q.IN_CONSULTATION }, { header: 'Completed', cell: (q) => q.COMPLETED },
            { header: 'Now', cell: (q) => q.current ?? '—' },
          ]} />
        </section>
      )}
      <nav aria-label="Quick links" className="flex flex-wrap gap-2 text-sm">
        {desk && <Link className="rounded border bg-white px-3 py-2" to="/app/queue">Queue board</Link>}
        <Link className="rounded border bg-white px-3 py-2" to="/app/appointments">Appointments</Link>
        {admin && <><Link className="rounded border bg-white px-3 py-2" to="/app/staff">Staff</Link><Link className="rounded border bg-white px-3 py-2" to="/app/settings">Settings</Link><Link className="rounded border bg-white px-3 py-2" to="/app/reports">Reports</Link></>}
      </nav>
    </div>
  );
}

type Stats = { count: number; medianMin: number | null; p90Min: number | null; maxMin: number | null };
type Summary = {
  completedVisits: { total: number; byDay: Record<string, number>; bySource: Record<string, number>; byDoctor: Record<string, number>; byService: Record<string, number> };
  waitingTime: { overall: Stats; byDoctor: Record<string, Stats> }; consultationDuration: { overall: Stats; byDoctor: Record<string, Stats> };
  appointments: Record<string, number | null>; queue: Record<string, number | null>;
};

/** A-07 date-range report (FR-RPT-002..005), Clinic Admin only; aggregates and CSV without patient data. */
export function ReportsPage() {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setS(null); get<Summary>(`/reports/summary?from=${from}&to=${to}`).then(setS, setError); }, [from, to]);
  const kv = (m: Record<string, unknown>) => Object.entries(m).map(([k, v]) => ({ k, v }));
  const fmt = (x: Stats) => (x.count ? `median ${x.medianMin} · p90 ${x.p90Min}${x.maxMin !== null ? ` · max ${x.maxMin}` : ''} min (n=${x.count})` : '—');
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <a className="rounded border bg-white px-3 py-2 text-sm" href={`/api/reports/summary.csv?from=${from}&to=${to}`} onClick={(e) => { e.preventDefault(); void import('../api').then((m) => m.download(`/reports/summary.csv?from=${from}&to=${to}`, `report-${from}-${to}.csv`)); }}>Export CSV</a>
      </div>
      {error ? <ErrorState error={error} /> : !s ? <Loading /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <section><h2 className="mb-1 font-semibold">Completed visits: {s.completedVisits.total}</h2>
            <DataTable rows={kv(s.completedVisits.bySource)} empty="No completed visits." columns={[{ header: 'Source', cell: (r) => r.k.replace(/_/g, ' ').toLowerCase() }, { header: 'Visits', cell: (r) => String(r.v) }]} /></section>
          <section><h2 className="mb-1 font-semibold">By doctor</h2>
            <DataTable rows={kv(s.completedVisits.byDoctor)} empty="—" columns={[{ header: 'Doctor', cell: (r) => r.k }, { header: 'Visits', cell: (r) => String(r.v) }, { header: 'Waiting', cell: (r) => fmt(s.waitingTime.byDoctor[r.k]!) }]} /></section>
          <section><h2 className="mb-1 font-semibold">Times</h2><p className="text-sm">Waiting: {fmt(s.waitingTime.overall)}</p><p className="text-sm">Consultation: {fmt(s.consultationDuration.overall)}</p></section>
          <section><h2 className="mb-1 font-semibold">Cancellations and no-shows</h2>
            <DataTable rows={[...kv(s.appointments), ...kv(s.queue)]} columns={[{ header: 'Measure', cell: (r) => r.k.replace(/([A-Z])/g, ' $1').toLowerCase() }, { header: 'Value', cell: (r) => (r.v === null ? '—' : String(r.v)) }]} /></section>
          <section className="md:col-span-2"><h2 className="mb-1 font-semibold">By day</h2>
            <DataTable rows={kv(s.completedVisits.byDay)} empty="No completed visits." columns={[{ header: 'Date', cell: (r) => r.k }, { header: 'Visits', cell: (r) => String(r.v) }]} /></section>
        </div>
      )}
    </div>
  );
}
