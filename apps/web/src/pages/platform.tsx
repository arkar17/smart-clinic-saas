import { useState, type FormEvent } from 'react';
import { api, get } from '../api';
import { Button, DataTable, ErrorState, Field, Loading, fieldsOf, messageOf, useResource, useToast } from '../components';

type Obj = Record<string, unknown>;

/** PA-01 Clinics and accounts (FR-PLT-001..006). Metadata only — no patient data. */
export function PlatformPage() {
  const toast = useToast();
  const clinics = useResource<{ items: Obj[] }>('/platform/clinics');
  const [temp, setTemp] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [account, setAccount] = useState<Obj | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const r = await api<{ temporaryPassword: string | null }>('POST', '/platform/clinics', f);
      setTemp(r.temporaryPassword);
      if (!r.temporaryPassword) toast('Clinic created; the existing account became its Clinic Admin.');
      setErr(null);
      clinics.reload();
      (e.target as HTMLFormElement).reset();
    } catch (x) { setErr(x); }
  }
  async function lifecycle(c: Obj, action: 'activate' | 'suspend' | 'reactivate') {
    const reason = action === 'activate' ? undefined : window.prompt(`Reason to ${action} ${c.name}`);
    if (action !== 'activate' && !reason) return;
    try {
      await api('POST', `/platform/clinics/${c.id}/${action}`, reason ? { reason } : {});
      clinics.reload();
    } catch (x) {
      const missing = (x as { body?: { details?: { missing?: string[] } } }).body?.details?.missing;
      toast(missing ? `Setup incomplete: ${missing.join(', ').toLowerCase().replaceAll('_', ' ')}` : messageOf(x), 'error');
    }
  }
  async function lookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email'));
    try {
      setAccount(await get<Obj>(`/platform/users?email=${encodeURIComponent(email)}`));
    } catch (x) { setAccount(null); toast(messageOf(x), 'error'); }
  }
  async function accountAction(action: 'password-reset' | 'deactivate' | 'reactivate') {
    if (!account) return;
    const reason = action === 'password-reset' ? undefined : window.prompt(`Reason to ${action} this account`);
    if (action !== 'password-reset' && !reason) return;
    try {
      const r = await api<{ temporaryPassword?: string }>('POST', `/platform/users/${account.id}/${action}`, reason ? { reason } : {});
      if (r.temporaryPassword) setTemp(r.temporaryPassword);
      setAccount(await get<Obj>(`/platform/users?email=${encodeURIComponent(String(account.email))}`));
    } catch (x) { toast(messageOf(x), 'error'); }
  }

  if (clinics.error) return <ErrorState error={clinics.error} />;
  if (!clinics.data) return <Loading />;
  const fe = fieldsOf(err);
  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold">Clinics & accounts</h1>
      {temp && (
        <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          Temporary password (shown once): <code className="font-mono font-bold">{temp}</code>
          <Button variant="secondary" className="ml-2" onClick={() => setTemp(null)}>Done</Button>
        </div>
      )}
      <DataTable rows={clinics.data.items} columns={[
        { header: 'Clinic', cell: (c) => <>{String(c.name)}<div className="text-xs text-slate-500">/{String(c.slug)} · {String(c.timezone)}</div></> },
        { header: 'Status', cell: (c) => <>{String(c.status)}{c.statusReason ? <div className="text-xs text-slate-500">{String(c.statusReason)}</div> : null}</> },
        { header: 'Active members', cell: (c) => String(c.activeMembershipCount) },
        { header: 'Appointments (30 d)', cell: (c) => String(c.appointmentsLast30Days ?? 0) },
        { header: 'Queue visits (30 d)', cell: (c) => String(c.queueVisitsLast30Days ?? 0) },
        { header: 'Created', cell: (c) => new Date(String(c.createdAt)).toLocaleDateString() },
        { header: '', cell: (c) => (
          <>
            {c.status === 'PENDING_SETUP' && <Button onClick={() => lifecycle(c, 'activate')}>Activate</Button>}
            {c.status === 'ACTIVE' && <Button variant="danger" onClick={() => lifecycle(c, 'suspend')}>Suspend</Button>}
            {c.status === 'SUSPENDED' && <Button onClick={() => lifecycle(c, 'reactivate')}>Reactivate</Button>}
          </>
        ) },
      ]} />
      <form onSubmit={create} className="grid gap-2 rounded bg-white p-4 shadow-sm sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">New clinic</h2>
        <Field label="Name" name="name" required error={fe.name} />
        <Field label="Slug" name="slug" required error={fe.slug} />
        <Field label="IANA time zone" name="timezone" placeholder="Asia/Bangkok" required error={fe.timezone} />
        <Field label="Default phone region" name="defaultPhoneRegion" placeholder="TH" maxLength={2} required error={fe.defaultPhoneRegion} />
        <Field label="First Clinic Admin name" name="adminName" required error={fe.adminName} />
        <Field label="First Clinic Admin email" name="adminEmail" type="email" required error={fe.adminEmail} />
        {err && !Object.keys(fe).length ? <ErrorState error={err} /> : null}
        <div className="sm:col-span-3"><Button type="submit">Create clinic</Button></div>
      </form>
      <section className="space-y-2 rounded bg-white p-4 shadow-sm">
        <h2 className="font-semibold">Account lookup</h2>
        <form onSubmit={lookup} className="flex items-end gap-2"><Field label="Email" name="email" type="email" required /><Button type="submit">Find</Button></form>
        {account && (
          <div className="space-y-2 text-sm">
            <p><strong>{String(account.displayName)}</strong> · {String(account.email)} · {account.isActive ? 'Active' : `Deactivated (${String(account.deactivationReason)})`}</p>
            <DataTable rows={account.memberships as Obj[]} empty="No clinic memberships." columns={[
              { header: 'Clinic', cell: (m) => String(m.clinicName) }, { header: 'Roles', cell: (m) => (m.roles as string[]).join(', ') }, { header: 'Membership', cell: (m) => (m.isActive ? 'Active' : 'Inactive') },
            ]} />
            {!account.isPlatformAdmin && (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => accountAction('password-reset')}>Reset password</Button>
                {account.isActive ? <Button variant="danger" onClick={() => accountAction('deactivate')}>Deactivate account</Button> : <Button onClick={() => accountAction('reactivate')}>Reactivate account</Button>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
