import { useEffect, useState, type FormEvent } from 'react';
import type { DaySchedule } from '@sc/contracts';
import { api, download } from '../api';
import { hasRole, useAuth } from '../auth';
import { Button, DataTable, Dialog, ErrorState, Field, Loading, WeekEditor, fieldsOf, messageOf, useResource, useToast } from '../components';

const useCanEdit = () => {
  const { me } = useAuth();
  const suspended = me?.memberships.find((m) => m.clinicId === me.selectedClinicId)?.clinicStatus === 'SUSPENDED';
  return hasRole(me, 'CLINIC_ADMIN') && !suspended;
};
const H1 = ({ children }: { children: React.ReactNode }) => <h1 className="mb-4 text-xl font-semibold">{children}</h1>;
type Obj = Record<string, unknown>;
const formObject = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;

/** A-01 Settings: clinic profile, booking and walk-in settings (FR-CLN-001, -005, -006). */
export function SettingsPage() {
  const { me } = useAuth();
  const canEdit = useCanEdit();
  const toast = useToast();
  const profile = useResource<Obj>('/clinic/profile');
  const settings = useResource<Obj>('/clinic/settings');
  const [err, setErr] = useState<unknown>(null);
  if (profile.error || settings.error) return <ErrorState error={profile.error ?? settings.error} />;
  if (!profile.data || !settings.data) return <Loading />;
  const p = profile.data, s = settings.data;

  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = formObject(e);
    const body: Obj = { name: f.name, address: f.address || null, contactPhone: f.contactPhone || null, defaultPhoneRegion: f.defaultPhoneRegion, privacyNotice: f.privacyNotice || null };
    if (!p.slugLocked) Object.assign(body, { slug: f.slug, timezone: f.timezone });
    try {
      profile.setData(await api('PATCH', '/clinic/profile', body, { 'if-match': String(p.version) }));
      setErr(null);
      toast('Profile saved');
    } catch (x) { setErr(x); }
  }
  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => Number(f.get(k));
    const body = {
      slotGranularityMin: num('slotGranularityMin'), holdMinutes: num('holdMinutes'), minNoticeMin: num('minNoticeMin'), horizonDays: num('horizonDays'),
      cancelCutoffMin: num('cancelCutoffMin'), checkinBeforeMin: num('checkinBeforeMin'), checkinAfterMin: num('checkinAfterMin'), noShowGraceMin: num('noShowGraceMin'),
      maxActiveBookings: num('maxActiveBookings'), walkinEnabled: f.get('walkinEnabled') === 'on',
      walkinDailyCapacity: f.get('walkinDailyCapacity') ? num('walkinDailyCapacity') : null, walkinOpensOffsetMin: num('walkinOpensOffsetMin'), walkinClosesBeforeMin: num('walkinClosesBeforeMin'),
    };
    try {
      settings.setData(await api('PATCH', '/clinic/settings', body, { 'if-match': String(s.version) }));
      setErr(null);
      toast('Settings saved');
    } catch (x) { setErr(x); }
  }
  const fe = fieldsOf(err);
  const n = (name: string, label: string) => <Field key={name} label={label} name={name} type="number" defaultValue={String(s[name] ?? '')} disabled={!canEdit} error={fe[name]} />;
  return (
    <div className="max-w-3xl space-y-6">
      <H1>Clinic settings</H1>
      {err && !Object.keys(fe).length ? <ErrorState error={err} /> : null}
      <form onSubmit={saveProfile} className="grid gap-3 rounded bg-white p-4 shadow-sm sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Profile</h2>
        <Field label="Display name" name="name" defaultValue={String(p.name)} disabled={!canEdit} error={fe.name} />
        <Field label={`Slug${p.slugLocked ? ' (locked after activation)' : ''}`} name="slug" defaultValue={String(p.slug)} disabled={!canEdit || !!p.slugLocked} error={fe.slug} />
        <Field label="Address" name="address" defaultValue={String(p.address ?? '')} disabled={!canEdit} error={fe.address} />
        <Field label="Contact phone (+country…)" name="contactPhone" defaultValue={String(p.contactPhone ?? '')} disabled={!canEdit} error={fe.contactPhone} />
        <Field label={`Time zone${p.slugLocked ? ' (locked after activation)' : ''}`} name="timezone" defaultValue={String(p.timezone)} disabled={!canEdit || !!p.slugLocked} error={fe.timezone} />
        <Field label="Default phone region" name="defaultPhoneRegion" defaultValue={String(p.defaultPhoneRegion)} maxLength={2} disabled={!canEdit} error={fe.defaultPhoneRegion} />
        <Field label="Privacy notice (blank = platform template)" name="privacyNotice" defaultValue={String(p.privacyNotice ?? '')} disabled={!canEdit} />
        {canEdit && <div className="sm:col-span-2"><Button type="submit">Save profile</Button></div>}
      </form>
      {hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST') && (
        <section className="space-y-2 rounded bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Clinic QR code</h2>
          <p className="text-sm text-slate-600">Encodes only the permanent public address /c/{String(p.slug)}.</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => download('/clinic/qr.png', `${p.slug}-qr.png`).catch((x) => toast(messageOf(x), 'error'))}>Download PNG</Button>
            <Button variant="secondary" onClick={() => download('/clinic/qr.svg', `${p.slug}-qr.svg`).catch((x) => toast(messageOf(x), 'error'))}>Download SVG</Button>
          </div>
        </section>
      )}
      <form onSubmit={saveSettings} className="grid gap-3 rounded bg-white p-4 shadow-sm sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">Booking</h2>
        {n('slotGranularityMin', 'Slot granularity (5,10,15,20,30,60)')}{n('holdMinutes', 'Hold minutes (5–30)')}{n('minNoticeMin', 'Minimum notice (min)')}
        {n('horizonDays', 'Booking horizon (days)')}{n('cancelCutoffMin', 'Cancellation cutoff (min)')}{n('maxActiveBookings', 'Max active bookings per phone')}
        {n('checkinBeforeMin', 'Check-in opens (min before)')}{n('checkinAfterMin', 'Check-in closes (min after)')}{n('noShowGraceMin', 'No-show grace (min)')}
        <h2 className="font-semibold sm:col-span-3">Walk-in</h2>
        <Field label="QR walk-in enabled" name="walkinEnabled" type="checkbox" defaultChecked={!!s.walkinEnabled} disabled={!canEdit} />
        {n('walkinDailyCapacity', 'Daily capacity (1–500)')}{n('walkinOpensOffsetMin', 'Opens (min after opening)')}{n('walkinClosesBeforeMin', 'Closes (min before closing)')}
        {canEdit && <div className="sm:col-span-3"><Button type="submit">Save settings</Button></div>}
      </form>
    </div>
  );
}

/** A-02 Hours & closures (FR-CLN-003, -004). */
export function HoursPage() {
  const canEdit = useCanEdit();
  const toast = useToast();
  const hours = useResource<{ timezone: string; days: DaySchedule[] }>('/clinic/business-hours');
  const closures = useResource<{ items: Obj[] }>('/clinic/closures');
  const [week, setWeek] = useState<DaySchedule[]>([]);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (hours.data) setWeek(hours.data.days); }, [hours.data]);
  if (hours.error) return <ErrorState error={hours.error} />;
  if (!hours.data || !closures.data) return <Loading />;
  async function save() {
    try {
      hours.setData(await api('PUT', '/clinic/business-hours', { days: week }));
      setErr(null);
      toast('Opening hours saved');
    } catch (x) { setErr(x); }
  }
  async function addClosure(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = formObject(e);
    try {
      await api('POST', '/clinic/closures', { startDate: f.startDate, endDate: f.endDate || f.startDate, startTime: f.startTime || null, endTime: f.endTime || null, label: f.label || null });
      closures.reload();
      (e.target as HTMLFormElement).reset();
    } catch (x) { toast(messageOf(x), 'error'); }
  }
  return (
    <div className="max-w-4xl space-y-6">
      <H1>Opening hours & closures</H1>
      <p className="text-sm text-slate-600">Times are clinic-local ({hours.data.timezone}).</p>
      <fieldset disabled={!canEdit}><WeekEditor value={week} onChange={setWeek} errors={fieldsOf(err)} /></fieldset>
      {err ? <ErrorState error={err} /> : null}
      {canEdit && <Button onClick={save}>Save hours</Button>}
      <h2 className="font-semibold">Closures</h2>
      <DataTable rows={closures.data.items} empty="No closures." columns={[
        { header: 'Dates', cell: (c) => `${c.startDate}${c.endDate !== c.startDate ? ` – ${c.endDate}` : ''}` },
        { header: 'Time', cell: (c) => (c.startTime ? `${c.startTime}–${c.endTime}` : 'Full day') },
        { header: 'Label', cell: (c) => String(c.label ?? '') },
        { header: '', cell: (c) => canEdit && <Button variant="secondary" onClick={async () => { await api('DELETE', `/clinic/closures/${c.id}`); closures.reload(); }}>Delete</Button> },
      ]} />
      {canEdit && (
        <form onSubmit={addClosure} className="grid gap-2 rounded bg-white p-3 shadow-sm sm:grid-cols-6 sm:items-end">
          <Field label="From" name="startDate" type="date" required /><Field label="To" name="endDate" type="date" />
          <Field label="Start time (partial)" name="startTime" type="time" /><Field label="End time" name="endTime" type="time" />
          <Field label="Public label" name="label" maxLength={80} /><Button type="submit">Add closure</Button>
        </form>
      )}
    </div>
  );
}

/** A-03 Services and eligible doctors (FR-SVC-001..003). */
export function ServicesPage() {
  const canEdit = useCanEdit();
  const toast = useToast();
  const services = useResource<{ items: Obj[] }>('/services');
  const doctors = useResource<{ items: Obj[] }>('/doctors');
  const [editing, setEditing] = useState<Obj | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (services.error) return <ErrorState error={services.error} />;
  if (!services.data) return <Loading />;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: f.get('name'), description: f.get('description') || null, durationMin: Number(f.get('durationMin')), onlineBookingEnabled: f.get('online') === 'on',
      walkInEnabled: f.get('walkin') === 'on', isActive: f.get('active') === 'on', displayOrder: Number(f.get('displayOrder') || 0),
    };
    try {
      const saved = editing?.id ? await api<Obj>('PATCH', `/services/${editing.id}`, body) : await api<Obj>('POST', '/services', body);
      await api('PUT', `/services/${saved.id}/doctors`, { doctorIds: f.getAll('doctorIds') });
      setEditing(null);
      setErr(null);
      services.reload();
      toast('Service saved');
    } catch (x) { setErr(x); }
  }
  const docName = (id: unknown) => String(doctors.data?.items.find((d) => d.id === id)?.displayName ?? '');
  const fe = fieldsOf(err);
  return (
    <div className="max-w-4xl space-y-4">
      <H1>Services</H1>
      {canEdit && <Button onClick={() => setEditing({})}>New service</Button>}
      <DataTable rows={services.data.items} columns={[
        { header: 'Name', cell: (s) => String(s.name) },
        { header: 'Duration', cell: (s) => `${s.durationMin} min` },
        { header: 'Channels', cell: (s) => [s.onlineBookingEnabled && 'Online', s.walkInEnabled && 'Walk-in'].filter(Boolean).join(', ') || '—' },
        { header: 'Doctors', cell: (s) => (s.doctorIds as string[]).map(docName).join(', ') || '—' },
        { header: 'Status', cell: (s) => (s.isActive ? 'Active' : 'Inactive') },
        { header: '', cell: (s) => canEdit && <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button> },
      ]} />
      <Dialog open={!!editing} title={editing?.id ? 'Edit service' : 'New service'} onClose={() => setEditing(null)}>
        {editing && (
          <form onSubmit={save} className="space-y-2" key={String(editing.id ?? 'new')}>
            <Field label="Name" name="name" defaultValue={String(editing.name ?? '')} required error={fe.name} />
            <Field label="Description (operational, no clinical advice)" name="description" defaultValue={String(editing.description ?? '')} maxLength={300} />
            <Field label="Duration (min, multiple of 5)" name="durationMin" type="number" step={5} min={5} max={240} defaultValue={String(editing.durationMin ?? 15)} error={fe.durationMin} />
            <Field label="Display order" name="displayOrder" type="number" defaultValue={String(editing.displayOrder ?? 0)} />
            <Field label="Online booking" name="online" type="checkbox" defaultChecked={editing.onlineBookingEnabled !== false} />
            <Field label="Walk-in" name="walkin" type="checkbox" defaultChecked={editing.walkInEnabled !== false} />
            <Field label="Active" name="active" type="checkbox" defaultChecked={editing.isActive !== false} />
            <fieldset className="text-sm"><legend className="font-medium">Eligible doctors</legend>
              {doctors.data?.items.map((d) => (
                <label key={String(d.id)} className="mr-3 inline-block"><input type="checkbox" name="doctorIds" value={String(d.id)} defaultChecked={((editing.doctorIds as string[]) ?? []).includes(String(d.id))} /> {String(d.displayName)}</label>
              ))}
            </fieldset>
            {err && !Object.keys(fe).length ? <ErrorState error={err} /> : null}
            <div className="flex gap-2"><Button type="submit">Save</Button><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              {editing.id ? <Button variant="danger" onClick={async () => { try { await api('DELETE', `/services/${editing.id}`); setEditing(null); services.reload(); } catch (x) { setErr(x); } }}>Delete</Button> : null}
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}

/** A-04 Doctors & schedules (FR-DOC-001..004). */
export function DoctorsPage() {
  const canEdit = useCanEdit();
  const toast = useToast();
  const doctors = useResource<{ items: Obj[] }>('/doctors');
  const staff = useResource<{ items: Obj[] }>(canEdit ? '/staff' : null);
  const [editing, setEditing] = useState<Obj | null>(null);
  const [week, setWeek] = useState<DaySchedule[]>([]);
  const [err, setErr] = useState<unknown>(null);
  if (doctors.error) return <ErrorState error={doctors.error} />;
  if (!doctors.data) return <Loading />;
  const open = (d: Obj) => { setEditing(d); setWeek((d.weekly as DaySchedule[]) ?? Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, closed: true, breaks: [] }))); setErr(null); };
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { displayName: f.get('displayName'), titleLabel: f.get('titleLabel') || null, isActive: f.get('active') === 'on', displayOrder: Number(f.get('displayOrder') || 0), memberId: f.get('memberId') || null };
    try {
      const saved = editing?.id ? await api<Obj>('PATCH', `/doctors/${editing.id}`, body) : await api<Obj>('POST', '/doctors', body);
      const withSchedule = await api<Obj>('PUT', `/doctors/${saved.id}/availability`, { days: week });
      doctors.reload();
      setEditing(null);
      const warnings = withSchedule.warnings as unknown[];
      toast(warnings.length ? 'Saved. Some hours are outside clinic hours and will not be bookable.' : 'Doctor saved');
    } catch (x) { setErr(x); }
  }
  const doctorMembers = (staff.data?.items ?? []).filter((m) => (m.roles as string[]).includes('DOCTOR'));
  return (
    <div className="max-w-5xl space-y-4">
      <H1>Doctors & schedules</H1>
      {canEdit && <Button onClick={() => open({})}>New doctor</Button>}
      <DataTable rows={doctors.data.items} columns={[
        { header: 'Name', cell: (d) => <>{String(d.displayName)}<div className="text-xs text-slate-500">{String(d.titleLabel ?? '')}</div></> },
        { header: 'Weekly schedule', cell: (d) => (d.weekly as DaySchedule[]).filter((x) => !x.closed).map((x) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][x.weekday - 1]} ${x.open}–${x.close}`).join(' · ') || 'Not working' },
        { header: 'Warnings', cell: (d) => ((d.warnings as unknown[]).length ? <span className="text-amber-700">Outside clinic hours</span> : '') },
        { header: 'Status', cell: (d) => (d.isActive ? 'Active' : 'Inactive') },
        { header: '', cell: (d) => canEdit && <Button variant="secondary" onClick={() => open(d)}>Edit</Button> },
      ]} />
      <Dialog open={!!editing} title={editing?.id ? 'Edit doctor' : 'New doctor'} onClose={() => setEditing(null)}>
        {editing && (
          <form onSubmit={save} className="max-h-[75vh] space-y-2 overflow-y-auto" key={String(editing.id ?? 'new')}>
            <Field label="Display name" name="displayName" defaultValue={String(editing.displayName ?? '')} required error={fieldsOf(err).displayName} />
            <Field label="Public title (non-clinical)" name="titleLabel" defaultValue={String(editing.titleLabel ?? '')} />
            <Field label="Display order" name="displayOrder" type="number" defaultValue={String(editing.displayOrder ?? 0)} />
            <Field label="Active" name="active" type="checkbox" defaultChecked={editing.isActive !== false} />
            <label className="block text-sm"><span className="font-medium">Linked staff login (DOCTOR role)</span>
              <select name="memberId" defaultValue={String(editing.memberId ?? '')} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5">
                <option value="">— none —</option>
                {doctorMembers.map((m) => <option key={String(m.memberId)} value={String(m.memberId)}>{String(m.displayName)} ({String(m.email)})</option>)}
              </select>
              {fieldsOf(err).memberId?.map((x) => <span key={x} role="alert" className="block text-xs text-red-600">{x}</span>)}
            </label>
            <h3 className="font-semibold">Weekly schedule</h3>
            <WeekEditor value={week} onChange={setWeek} errors={fieldsOf(err)} />
            {err && !Object.keys(fieldsOf(err)).length ? <ErrorState error={err} /> : null}
            <div className="flex gap-2"><Button type="submit">Save</Button><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button></div>
            {editing.id ? <ExceptionsEditor doctorId={String(editing.id)} canEdit={canEdit} /> : null}
          </form>
        )}
      </Dialog>
    </div>
  );
}

export function ExceptionsEditor({ doctorId, canEdit }: { doctorId: string; canEdit: boolean }) {
  const ex = useResource<{ items: Obj[] }>(`/doctors/${doctorId}/exceptions`);
  const toast = useToast();
  const [draft, setDraft] = useState({ exceptionDate: '', kind: 'UNAVAILABLE', startTime: '', endTime: '', reason: '' });
  async function add() {
    try {
      await api('POST', `/doctors/${doctorId}/exceptions`, { ...draft, startTime: draft.startTime || null, endTime: draft.endTime || null, reason: draft.reason || null });
      ex.reload();
    } catch (x) { toast(messageOf(x), 'error'); }
  }
  return (
    <section className="mt-4 space-y-2">
      <h3 className="font-semibold">Exceptions</h3>
      <DataTable rows={ex.data?.items ?? []} empty="No exceptions." columns={[
        { header: 'Date', cell: (e) => String(e.exceptionDate) },
        { header: 'Kind', cell: (e) => (e.kind === 'UNAVAILABLE' ? 'Unavailable' : 'Modified hours') },
        { header: 'Time', cell: (e) => (e.startTime ? `${e.startTime}–${e.endTime}` : 'Full day') },
        { header: '', cell: (e) => canEdit && <Button variant="secondary" onClick={async () => { await api('DELETE', `/doctors/${doctorId}/exceptions/${e.id}`); ex.reload(); }}>Delete</Button> },
      ]} />
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Date" type="date" value={draft.exceptionDate} onChange={(e) => setDraft({ ...draft, exceptionDate: e.target.value })} />
          <label className="block text-sm"><span className="font-medium">Kind</span>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5">
              <option value="UNAVAILABLE">Unavailable</option><option value="MODIFIED_HOURS">Modified hours</option>
            </select></label>
          <Field label="From (blank = full day)" type="time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
          <Field label="To" type="time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
          <Field label="Operational reason" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
          <Button onClick={add}>Add exception</Button>
        </div>
      )}
    </section>
  );
}

/** A-05 Staff memberships (FR-STF-001..005). */
export function StaffPage() {
  const toast = useToast();
  const staff = useResource<{ items: Obj[] }>('/staff');
  const [temp, setTemp] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (staff.error) return <ErrorState error={staff.error} />;
  if (!staff.data) return <Loading />;
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ temporaryPassword: string | null }>('POST', '/staff', { email: f.get('email'), displayName: f.get('displayName'), roles: f.getAll('roles') });
      setTemp(r.temporaryPassword);
      if (!r.temporaryPassword) toast('Existing account added to this clinic. Their password is unchanged.');
      setErr(null);
      staff.reload();
      (e.target as HTMLFormElement).reset();
    } catch (x) { setErr(x); }
  }
  const act = async (path: string, body?: unknown) => {
    try {
      const r = await api<{ temporaryPassword?: string }>(path.endsWith('roles') ? 'PATCH' : 'POST', path.replace(/\/roles$/, ''), body);
      if (r?.temporaryPassword) setTemp(r.temporaryPassword);
      staff.reload();
    } catch (x) { toast(messageOf(x), 'error'); }
  };
  const ROLES = ['CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR'];
  const fe = fieldsOf(err);
  return (
    <div className="max-w-5xl space-y-4">
      <H1>Staff</H1>
      {temp && (
        <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          Temporary password (shown once): <code className="font-mono font-bold">{temp}</code>. It must be changed at first sign-in.
          <Button variant="secondary" className="ml-2" onClick={() => setTemp(null)}>Done</Button>
        </div>
      )}
      <DataTable rows={staff.data.items} columns={[
        { header: 'Name', cell: (m) => <>{String(m.displayName)}<div className="text-xs text-slate-500">{String(m.email)}</div></> },
        { header: 'Roles', cell: (m) => (
          <div className="flex flex-wrap gap-2">{ROLES.map((r) => (
            <label key={r} className="text-xs"><input type="checkbox" checked={(m.roles as string[]).includes(r)} onChange={(e) => {
              const roles = e.target.checked ? [...(m.roles as string[]), r] : (m.roles as string[]).filter((x) => x !== r);
              if (roles.length) void act(`/staff/${m.memberId}/roles`, { roles });
            }} /> {r.replace('_', ' ').toLowerCase()}</label>
          ))}</div>
        ) },
        { header: 'Status', cell: (m) => (m.isActive ? 'Active' : 'Inactive') },
        { header: '', cell: (m) => (
          <div className="flex gap-1">
            {m.isActive ? <Button variant="secondary" onClick={() => act(`/staff/${m.memberId}/deactivate`)}>Deactivate</Button> : <Button variant="secondary" onClick={() => act(`/staff/${m.memberId}/reactivate`)}>Reactivate</Button>}
            <Button variant="secondary" onClick={() => act(`/staff/${m.memberId}/reset-password`)}>Reset password</Button>
          </div>
        ) },
      ]} />
      <form onSubmit={add} className="grid gap-2 rounded bg-white p-3 shadow-sm sm:grid-cols-4 sm:items-end">
        <Field label="Email" name="email" type="email" required error={fe.email} />
        <Field label="Display name" name="displayName" required error={fe.displayName} />
        <fieldset className="text-sm"><legend className="font-medium">Roles</legend>
          {ROLES.map((r) => <label key={r} className="mr-2 inline-block"><input type="checkbox" name="roles" value={r} defaultChecked={r === 'RECEPTIONIST'} /> {r.replace('_', ' ').toLowerCase()}</label>)}
          {fe.roles?.map((x) => <span key={x} role="alert" className="block text-xs text-red-600">{x}</span>)}
        </fieldset>
        <Button type="submit">Add staff</Button>
      </form>
      {err && !Object.keys(fe).length ? <ErrorState error={err} /> : null}
    </div>
  );
}
