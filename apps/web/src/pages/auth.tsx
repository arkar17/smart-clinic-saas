import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { MeResponse } from '@sc/contracts';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorState, Field, fieldsOf } from '../components';

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <main className="mx-auto mt-16 max-w-sm rounded-lg bg-white p-6 shadow">
    <h1 className="mb-4 text-xl font-semibold">{title}</h1>
    {children}
  </main>
);

/** S-01 Login */
export function LoginPage() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const me = await api<MeResponse>('POST', '/auth/login', { email: f.get('email'), password: f.get('password') });
      setMe(me);
      nav(me.user.mustChangePassword ? '/app/change-password' : me.user.isPlatformAdmin ? '/platform' : me.selectedClinicId ? '/app' : '/app/select-clinic');
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Card title="Staff sign-in">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        {error ? <ErrorState error={error} /> : null}
        <Button type="submit" className="w-full">Sign in</Button>
      </form>
    </Card>
  );
}

/** S-02 Change password */
export function ChangePasswordPage() {
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<unknown>(null);
  if (!me) return <Navigate to="/login" />;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('confirm')) return setError(new Error('The new passwords do not match.'));
    try {
      const updated = await api<MeResponse>('POST', '/auth/change-password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
      setMe(updated);
      nav(updated.user.isPlatformAdmin ? '/platform' : updated.selectedClinicId ? '/app' : '/app/select-clinic');
    } catch (err) {
      setError(err);
    }
  }
  const fields = fieldsOf(error);
  return (
    <Card title={me.user.mustChangePassword ? 'Choose a new password' : 'Change password'}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required error={fields.currentPassword} />
        <Field label="New password (12–128 characters)" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required error={fields.newPassword} />
        <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" required />
        {error && !Object.keys(fields).length ? <ErrorState error={error} /> : null}
        <Button type="submit" className="w-full">Save password</Button>
      </form>
    </Card>
  );
}

/** S-03 Select clinic */
export function SelectClinicPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<unknown>(null);
  if (!me) return <Navigate to="/login" />;
  async function choose(clinicId: string) {
    try {
      await api('POST', '/auth/select-clinic', { clinicId });
      await refresh();
      nav('/app');
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Card title="Select clinic">
      {me.memberships.length === 0 && <p className="text-sm">You have no active clinic membership.</p>}
      <ul className="space-y-2">
        {me.memberships.map((m) => (
          <li key={m.clinicId}>
            <Button variant="secondary" className="w-full text-left" onClick={() => choose(m.clinicId)}>
              {m.clinicName} <span className="text-xs text-slate-500">· {m.roles.join(', ').toLowerCase()}{m.clinicStatus === 'SUSPENDED' ? ' · read-only' : ''}</span>
            </Button>
          </li>
        ))}
      </ul>
      {error ? <ErrorState error={error} /> : null}
    </Card>
  );
}
