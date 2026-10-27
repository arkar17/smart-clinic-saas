import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, get, staffStreamHeaders } from '../api';
import { hasRole, useAuth } from '../auth';
import { Button, ErrorState, Field, Loading, Select, fieldsOf, messageOf, useToast } from '../components';
import { LiveBadge, useLive } from '../live';

type Entry = { id: string; token: string; status: string; source: string; doctorId: string; doctor: string; service: string; serviceId: string; patient: { fullName: string; phone: string | null }; recallCount: number; version: number };
type Today = { date: string; timezone: string; lastEventId: string; counter: { lastToken: number; walkInCount: number; capacity: number | null; paused: boolean }; entries: Entry[] };
type Named = { id: string; name?: string; displayName?: string };

/** Snapshot + live stream: every event triggers a debounced REST reload (ADR-026: events carry no names). */
function useQueueToday(doctorId?: string | null) {
  const [data, setData] = useState<Today | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const path = `/queue/today${doctorId ? `?doctorId=${doctorId}` : ''}`;
  const reload = useCallback(() => get<Today>(path).then(setData, setError), [path]);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => void reload(), 150); }, [reload]);
  useEffect(() => void reload(), [reload]);
  const live = useLive('/staff/stream', staffStreamHeaders(), () => soon(), () => void reload());
  return { data, error, reload, live };
}

const COLUMNS = [
  { key: 'REGISTERED', label: 'Registered — confirm arrival' }, { key: 'WAITING', label: 'Waiting' },
  { key: 'CALLED', label: 'Called' }, { key: 'IN_CONSULTATION', label: 'In consultation' },
];

/** R-02 queue board with counters and pause toggle; R-05 staff walk-in (SC3-FE-02). */
export function QueueBoardPage() {
  const { me } = useAuth();
  const toast = useToast();
  const isAdmin = hasRole(me, 'CLINIC_ADMIN');
  const { data, error, reload, live } = useQueueToday();
  const [services, setServices] = useState<Named[]>([]);
  const [doctors, setDoctors] = useState<Named[]>([]);
  useEffect(() => { void get<{ items: Named[] }>('/services').then((r) => setServices(r.items)); void get<{ items: Named[] }>('/doctors').then((r) => setDoctors(r.items)); }, []);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const act = async (e: Entry, action: string, needsReason = false) => {
    const reason = needsReason ? window.prompt('Operational reason (do not enter medical information)') : undefined;
    if (needsReason && !reason) return;
    try { await api('POST', `/queue/entries/${e.id}/${action}`, { version: e.version, ...(reason ? { reason } : {}) }); void reload(); } catch (x) { toast(messageOf(x), 'error'); }
  };
  const reassign = async (e: Entry, doctorId: string) => {
    try { await api('POST', `/queue/entries/${e.id}/reassign`, { doctorId, version: e.version }); void reload(); } catch (x) { toast(messageOf(x), 'error'); }
  };
  const togglePause = async () => {
    try { await api(data.counter.paused ? 'DELETE' : 'PUT', '/clinic/walk-in-pause'); void reload(); } catch (x) { toast(messageOf(x), 'error'); }
  };
  const c = data.counter;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Today’s queue</h1><LiveBadge state={live} />
        <span className="text-sm">Last token {String(c.lastToken).padStart(3, '0')} · Walk-ins {c.walkInCount}{c.capacity ? ` / ${c.capacity}` : ''}</span>
        <Button variant={c.paused ? 'primary' : 'secondary'} onClick={togglePause}>{c.paused ? 'Resume QR walk-ins' : 'Pause QR walk-ins'}</Button>
      </div>
      <WalkInForm services={services} doctors={doctors} onDone={() => void reload()} />
      <div className="grid gap-3 md:grid-cols-4">
        {COLUMNS.map((col) => (
          <section key={col.key} className="rounded bg-white p-2 shadow-sm" aria-label={col.label}>
            <h2 className="mb-2 text-sm font-semibold">{col.label} ({data.entries.filter((e) => e.status === col.key).length})</h2>
            <ul className="space-y-2">
              {data.entries.filter((e) => e.status === col.key).map((e) => (
                <li key={e.id} className="rounded border border-slate-200 p-2 text-sm">
                  <div className="flex justify-between"><strong className="font-mono text-lg">{e.token}</strong><span className="text-xs text-slate-500">{e.source.replace('_', ' ').toLowerCase()}</span></div>
                  <div>{e.patient.fullName} <span className="text-xs text-slate-500">{e.patient.phone}</span></div>
                  <div className="text-xs text-slate-600">{e.service} · {e.doctor}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {e.status === 'REGISTERED' && <Button onClick={() => act(e, 'confirm-arrival')}>Confirm arrival</Button>}
                    {(e.status === 'REGISTERED' || e.status === 'WAITING') && <Button variant="secondary" onClick={() => act(e, 'cancel', true)}>Cancel</Button>}
                    {e.status === 'WAITING' && (
                      <select aria-label="Reassign doctor" className="rounded border text-xs" value="" onChange={(x) => x.target.value && void reassign(e, x.target.value)}>
                        <option value="">Reassign…</option>{doctors.filter((d) => d.id !== e.doctorId).map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
                      </select>
                    )}
                    {e.status === 'CALLED' && <><Button variant="secondary" onClick={() => act(e, 'return-to-waiting')}>Return</Button><Button variant="secondary" onClick={() => act(e, 'no-show')}>No-show</Button></>}
                    {isAdmin && e.status === 'CALLED' && <Button onClick={() => act(e, 'start')}>Start</Button>}
                    {isAdmin && e.status === 'IN_CONSULTATION' && <Button onClick={() => act(e, 'complete')}>Complete</Button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function WalkInForm({ services, doctors, onDone }: { services: Named[]; doctors: Named[]; onDone: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [needReason, setNeedReason] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ queueEntry: { token: string } }>('POST', '/queue/walk-ins', {
        serviceId: f.get('serviceId'), doctorId: f.get('doctorId'), fullName: f.get('fullName'), phone: f.get('phone'), ...(f.get('overrideReason') ? { overrideReason: f.get('overrideReason') } : {}),
      });
      toast(`Walk-in registered: token ${r.queueEntry.token}`);
      setError(null); setNeedReason(false);
      (e.target as HTMLFormElement).reset();
      onDone();
    } catch (x) {
      setError(x);
      if ((x as { body?: { code?: string } }).body?.code === 'OVERRIDE_REASON_REQUIRED') setNeedReason(true);
    }
  }
  const fe = fieldsOf(error);
  return (
    <form onSubmit={submit} className="grid gap-2 rounded bg-white p-3 shadow-sm sm:grid-cols-6 sm:items-end">
      <Select label="Service" name="serviceId" options={services.map((s) => ({ value: s.id, label: s.name ?? '' }))} />
      <Select label="Doctor" name="doctorId" options={doctors.map((d) => ({ value: d.id, label: d.displayName ?? '' }))} />
      <Field label="Patient name" name="fullName" required error={fe.fullName} />
      <Field label="Phone" name="phone" type="tel" required error={fe.phone} />
      {needReason && <Field label="Over-capacity reason" name="overrideReason" required />}
      <Button type="submit">Register walk-in</Button>
      {error && !Object.keys(fe).length ? <div className="sm:col-span-6"><ErrorState error={error} /></div> : null}
    </form>
  );
}

/** D-01 doctor workspace: own line, call next, start, complete, return, no-show (SC3-FE-03). No clinical data. */
export function DoctorQueuePage() {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, reload, live } = useQueueToday(me?.doctorId);
  if (!me?.doctorId) return <p>No doctor profile is linked to your membership in this clinic.</p>;
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const current = data.entries.find((e) => e.status === 'CALLED' || e.status === 'IN_CONSULTATION');
  const line = data.entries.filter((e) => e.status === 'WAITING');
  const run = async (path: string, body: unknown = {}) => {
    try { const r = await api<unknown>('POST', path, body); if (r === undefined) toast('No one is waiting.'); void reload(); } catch (x) { toast(messageOf(x), 'error'); }
  };
  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center gap-3"><h1 className="text-xl font-semibold">My queue</h1><LiveBadge state={live} /></div>
      <section className="rounded bg-white p-4 shadow-sm" aria-live="polite">
        {current ? (
          <>
            <p className="text-sm text-slate-600">{current.status === 'CALLED' ? 'Called' : 'In consultation'}</p>
            <p className="text-4xl font-bold">{current.token}</p>
            <p>{current.patient.fullName} · {current.service}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {current.status === 'CALLED' && <><Button onClick={() => run(`/queue/entries/${current.id}/start`, { version: current.version })}>Start consultation</Button>
                <Button variant="secondary" onClick={() => run(`/queue/entries/${current.id}/return-to-waiting`, { version: current.version })}>Patient absent — return to waiting</Button>
                <Button variant="secondary" onClick={() => run(`/queue/entries/${current.id}/no-show`, { version: current.version })}>No-show</Button></>}
              {current.status === 'IN_CONSULTATION' && <Button onClick={() => run(`/queue/entries/${current.id}/complete`, { version: current.version })}>Complete</Button>}
            </div>
          </>
        ) : <Button className="w-full py-3 text-lg" onClick={() => run(`/queue/doctors/${me.doctorId}/call-next`)}>Call next</Button>}
      </section>
      <section><h2 className="mb-2 font-semibold">Waiting ({line.length})</h2>
        <ol className="space-y-1">{line.map((e) => <li key={e.id} className="rounded bg-white p-2 text-sm shadow-sm"><strong className="font-mono">{e.token}</strong> {e.patient.fullName} · {e.service}</li>)}</ol>
      </section>
    </div>
  );
}
