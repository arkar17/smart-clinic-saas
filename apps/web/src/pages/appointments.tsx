import { useState, type FormEvent } from 'react';
import { api, get } from '../api';
import { hasRole, useAuth } from '../auth';
import { Button, DataTable, Dialog, ErrorState, Field, Loading, Select, fieldsOf, messageOf, useResource, useToast } from '../components';

type Appt = { id: string; status: string; bookingReference: string | null; startAt: string; endAt: string; channel: string; version: number; service: { id: string; name: string }; doctor: { id: string; displayName: string }; patient: { fullName: string; phone: string | null } | null };
type Named = { id: string; name?: string; displayName?: string };
const today = () => new Date().toISOString().slice(0, 10);

/** R-03 appointments (FR-APT-010, -011, -015, -016): day list with filters, create, reschedule, cancel, conflicts. */
export function AppointmentsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const canManage = hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST');
  const [from, setFrom] = useState(today());
  const [doctorId, setDoctorId] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ from, ...(doctorId ? { doctorId } : {}), ...(status ? { status } : {}) }).toString();
  const list = useResource<{ timezone: string; items: Appt[] }>(`/appointments?${qs}`);
  const conflicts = useResource<{ items: Appt[] }>(canManage ? '/appointments/conflicts' : null);
  const doctors = useResource<{ items: Named[] }>('/doctors');
  const services = useResource<{ items: Named[] }>(canManage ? '/services' : null);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Appt | null>(null);
  if (list.error) return <ErrorState error={list.error} />;
  const zone = list.data?.timezone ?? 'UTC';
  const time = (iso: string) => new Date(iso).toLocaleString([], { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
  const reload = () => { list.reload(); conflicts.reload(); };

  async function cancel(a: Appt) {
    const reason = window.prompt('Operational reason for cancelling (do not enter medical information)');
    if (!reason) return;
    try { await api('POST', `/appointments/${a.id}/cancel`, { reason, version: a.version }); reload(); } catch (e) { toast(messageOf(e), 'error'); }
  }
  // R-06 check-in (FR-APT-012): allocates the queue token; outside the window a reason is required (A-019).
  async function checkIn(a: Appt, overrideReason?: string) {
    try {
      const r = await api<{ queueEntry: { token: string } }>('POST', `/appointments/${a.id}/check-in`, { version: a.version, ...(overrideReason ? { overrideReason } : {}) });
      toast(`Checked in — queue token ${r.queueEntry.token}`);
      reload();
    } catch (e) {
      if ((e as { body?: { code?: string } }).body?.code === 'OVERRIDE_REASON_REQUIRED') {
        const reason = window.prompt('Outside the check-in window. Operational reason for checking in:');
        if (reason) return checkIn(a, reason);
      } else toast(messageOf(e), 'error');
    }
  }
  async function noShow(a: Appt) {
    try { await api('POST', `/appointments/${a.id}/no-show`, { version: a.version }); reload(); } catch (e) { toast(messageOf(e), 'error'); }
  }
  const columns = [
    { header: 'Time', cell: (a: Appt) => time(a.startAt) },
    { header: 'Patient', cell: (a: Appt) => <>{a.patient?.fullName}<div className="text-xs text-slate-500">{a.patient?.phone}</div></> },
    { header: 'Service / doctor', cell: (a: Appt) => <>{a.service.name}<div className="text-xs text-slate-500">{a.doctor.displayName}</div></> },
    { header: 'Reference', cell: (a: Appt) => <span className="font-mono text-xs">{a.bookingReference}</span> },
    { header: 'Status', cell: (a: Appt) => a.status.replace('_', ' ').toLowerCase() },
    { header: '', cell: (a: Appt) => canManage && a.status === 'CONFIRMED' && (
      <div className="flex flex-wrap gap-1">
        <Button onClick={() => checkIn(a)}>Check in</Button>
        <Button variant="secondary" onClick={() => setMoving(a)}>Reschedule</Button><Button variant="secondary" onClick={() => cancel(a)}>Cancel</Button>
        <Button variant="secondary" onClick={() => noShow(a)}>No-show</Button>
      </div>
    ) },
  ];
  const doctorOptions = [{ value: '', label: 'All doctors' }, ...(doctors.data?.items ?? []).map((d) => ({ value: d.id, label: d.displayName ?? '' }))];
  return (
    <div className="max-w-6xl space-y-4">
      <h1 className="text-xl font-semibold">Appointments</h1>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Date" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <div className="w-48"><Select label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} options={doctorOptions} /></div>
        <div className="w-40"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={['', 'CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW'].map((s) => ({ value: s, label: s ? s.replace('_', ' ').toLowerCase() : 'Active and past' }))} /></div>
        {canManage && <Button onClick={() => setCreating(true)}>New appointment</Button>}
      </div>
      {!list.data ? <Loading /> : <DataTable rows={list.data.items} columns={columns} empty="No appointments for this day." />}
      {canManage && conflicts.data && conflicts.data.items.length > 0 && (
        <section className="space-y-2"><h2 className="font-semibold text-amber-800">Conflicts — no longer fit current hours or schedules</h2><DataTable rows={conflicts.data.items} columns={columns} /></section>
      )}
      <Dialog open={creating} title="New appointment" onClose={() => setCreating(false)}>
        {creating && <SlotForm doctors={doctors.data?.items ?? []} services={services.data?.items ?? []} withPatient onDone={(msg) => { setCreating(false); toast(msg); reload(); }} onCancel={() => setCreating(false)} />}
      </Dialog>
      <Dialog open={!!moving} title="Reschedule appointment" onClose={() => setMoving(null)}>
        {moving && <SlotForm appt={moving} doctors={doctors.data?.items ?? []} services={[]} onDone={(msg) => { setMoving(null); toast(msg); reload(); }} onCancel={() => setMoving(null)} />}
      </Dialog>
    </div>
  );
}

/** R-04 new/edit: pick service, doctor, date and a staff slot (no minimum notice). */
function SlotForm({ appt, doctors, services, withPatient, onDone, onCancel }: { appt?: Appt; doctors: Named[]; services: Named[]; withPatient?: boolean; onDone: (msg: string) => void; onCancel: () => void }) {
  const [serviceId, setServiceId] = useState(appt?.service.id ?? services[0]?.id ?? '');
  const [doctorId, setDoctorId] = useState(appt?.doctor.id ?? doctors[0]?.id ?? '');
  const [date, setDate] = useState(today());
  const [slots, setSlots] = useState<{ startAt: string }[] | null>(null);
  const [zone, setZone] = useState('UTC');
  const [startAt, setStartAt] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function find() {
    setError(null);
    try {
      const qs = new URLSearchParams({ serviceId, doctorId, date, ...(appt ? { excludeAppointmentId: appt.id } : {}) }).toString();
      const r = await get<{ timezone: string; slots: { startAt: string }[] }>(`/availability/slots?${qs}`);
      setZone(r.timezone);
      setSlots(r.slots);
    } catch (e) { setError(e); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      if (appt) {
        await api('POST', `/appointments/${appt.id}/reschedule`, { startAt, doctorId, version: appt.version });
        onDone('Appointment rescheduled. The reference and private link are unchanged.');
      } else {
        const r = await api<{ appointment: { bookingReference: string }; privateUrl: string }>('POST', '/appointments', { serviceId, doctorId, startAt, fullName: f.get('fullName'), phone: f.get('phone') });
        window.prompt(`Booked ${r.appointment.bookingReference}. Private link for the patient (shown once):`, r.privateUrl);
        onDone('Appointment created');
      }
    } catch (x) { setError(x); }
  }
  const fe = fieldsOf(error);
  return (
    <form onSubmit={submit} className="space-y-2">
      {!appt && <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)} options={services.map((s) => ({ value: s.id, label: s.name ?? '' }))} />}
      <Select label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} options={doctors.map((d) => ({ value: d.id, label: d.displayName ?? '' }))} />
      <div className="flex items-end gap-2"><Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /><Button variant="secondary" onClick={find}>Find times</Button></div>
      {slots && (slots.length ? (
        <div className="flex flex-wrap gap-1">{slots.map((s) => (
          <button key={s.startAt} type="button" aria-pressed={startAt === s.startAt} onClick={() => setStartAt(s.startAt)} className={`rounded border px-2 py-1 text-xs ${startAt === s.startAt ? 'border-brand bg-teal-50 font-semibold' : 'border-slate-300'}`}>
            {new Date(s.startAt).toLocaleTimeString([], { timeZone: zone, hour: '2-digit', minute: '2-digit' })}
          </button>
        ))}</div>
      ) : <p className="text-sm text-slate-600">No free times on this date.</p>)}
      {withPatient && <><Field label="Patient full name" name="fullName" required error={fe.fullName} /><Field label="Phone" name="phone" type="tel" required error={fe.phone} /></>}
      {error && !Object.keys(fe).length ? <ErrorState error={error} /> : null}
      <div className="flex gap-2"><Button type="submit" disabled={!startAt}>{appt ? 'Reschedule' : 'Create'}</Button><Button variant="secondary" onClick={onCancel}>Close</Button></div>
    </form>
  );
}
