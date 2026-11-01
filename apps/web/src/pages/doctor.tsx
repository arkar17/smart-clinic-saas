import { useState } from 'react';
import { useAuth } from '../auth';
import { DataTable, ErrorState, Field, Loading, useResource } from '../components';

type Day = { date: string; clinic: { start: string; end: string }[]; doctor: { start: string; end: string }[]; bookable: { start: string; end: string }[]; exceptions: { kind: string; startTime: string | null; endTime: string | null; reason: string | null }[] };
const fmt = (l: { start: string; end: string }[]) => l.map((i) => `${i.start}–${i.end}`).join(', ') || '—';
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** D-02 My schedule (FR-DOC-005): own hours and exceptions; appointments arrive in SC-2. */
export function MySchedulePage() {
  const { me } = useAuth();
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const sched = useResource<{ timezone: string; days: Day[] }>(me?.doctorId ? `/doctors/${me.doctorId}/schedule?from=${from}&to=${plusDays(from, 6)}` : null);
  if (!me?.doctorId) return <p>No doctor profile is linked to your membership in this clinic.</p>;
  if (sched.error) return <ErrorState error={sched.error} />;
  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-xl font-semibold">My schedule</h1>
      <Field label="Week starting" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
      {!sched.data ? <Loading /> : (
        <>
          <p className="text-sm text-slate-600">Times in clinic time ({sched.data.timezone}).</p>
          <DataTable rows={sched.data.days} columns={[
            { header: 'Date', cell: (d) => d.date },
            { header: 'My hours', cell: (d) => fmt(d.doctor) },
            { header: 'Clinic open', cell: (d) => fmt(d.clinic) },
            { header: 'Bookable', cell: (d) => fmt(d.bookable) },
            { header: 'Exceptions', cell: (d) => d.exceptions.map((e) => `${e.kind === 'UNAVAILABLE' ? 'Unavailable' : 'Modified'} ${e.startTime ? `${e.startTime}–${e.endTime}` : 'all day'}`).join('; ') },
          ]} />
        </>
      )}
    </div>
  );
}
