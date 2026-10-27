import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { hasRole, useAuth } from '../auth';
import { Loading, Select } from '../components';

/** Staff app shell with header clinic switcher (SC1-FE-03). */
export function AppShell({ realm }: { realm: 'app' | 'platform' }) {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" />;
  if (me.user.mustChangePassword) return <Navigate to="/app/change-password" />;
  if (realm === 'platform' && !me.user.isPlatformAdmin) return <Navigate to="/app" />;
  if (realm === 'app' && me.user.isPlatformAdmin) return <Navigate to="/platform" />;
  if (realm === 'app' && !me.selectedClinicId) return <Navigate to="/app/select-clinic" />;

  const links = realm === 'platform'
    ? [{ to: '/platform', label: 'Clinics & accounts' }]
    : [
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR') ? [{ to: '/app/settings', label: 'Settings' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR') ? [{ to: '/app/hours', label: 'Hours & closures' }, { to: '/app/services', label: 'Services' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST') ? [{ to: '/app/doctors', label: 'Doctors & schedules' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN') ? [{ to: '/app/staff', label: 'Staff' }] : []),
        ...(me.doctorId ? [{ to: '/app/my-schedule', label: 'My schedule' }] : []),
      ];
  async function switchClinic(clinicId: string) {
    await api('POST', '/auth/select-clinic', { clinicId });
    await refresh();
    nav('/app');
  }
  async function logout() {
    await api('POST', '/auth/logout').catch(() => {});
    window.location.assign('/login');
  }
  const current = me.memberships.find((m) => m.clinicId === me.selectedClinicId);
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-3 bg-brand px-4 py-2 text-white">
        <span className="font-semibold">Smart Clinic</span>
        {realm === 'app' && me.memberships.length > 1 ? (
          <div className="w-56 text-slate-900 [&_span]:sr-only">
            <Select label="Active clinic" value={me.selectedClinicId ?? ''} onChange={(e) => void switchClinic(e.target.value)} options={me.memberships.map((m) => ({ value: m.clinicId, label: m.clinicName }))} />
          </div>
        ) : (
          <span className="text-sm opacity-90">{realm === 'platform' ? 'Platform administration' : current?.clinicName}</span>
        )}
        {current?.clinicStatus === 'SUSPENDED' && <span className="rounded bg-amber-300 px-2 text-xs text-amber-950">Suspended · read-only</span>}
        <span className="ml-auto text-sm">{me.user.displayName}</span>
        <NavLink to="/app/change-password" className="text-sm underline">Password</NavLink>
        <button type="button" onClick={logout} className="text-sm underline">Sign out</button>
      </header>
      <div className="md:flex">
        <nav aria-label="Main" className="border-b border-slate-200 bg-white p-2 md:min-h-screen md:w-56 md:border-b-0 md:border-r">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {links.map((l) => (
              <li key={l.to}><NavLink end to={l.to} className={({ isActive }) => `block rounded px-3 py-1.5 text-sm ${isActive ? 'bg-slate-200 font-semibold' : 'hover:bg-slate-100'}`}>{l.label}</NavLink></li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-4"><Outlet /></main>
      </div>
    </div>
  );
}

export function AppHome() {
  const { me } = useAuth();
  if (me?.doctorId && !hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST')) return <Navigate to="/app/my-schedule" />;
  return <Navigate to="/app/settings" />;
}
