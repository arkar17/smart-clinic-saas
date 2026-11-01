import { useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { hasRole, useAuth } from '../auth';
import { Loading, Select } from '../components';

/** Staff app shell with header clinic switcher (SC1-FE-03). */
export function AppShell({ realm }: { realm: 'app' | 'platform' }) {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" />;
  if (me.user.mustChangePassword) return <Navigate to="/app/change-password" />;
  if (realm === 'platform' && !me.user.isPlatformAdmin) return <Navigate to="/app" />;
  if (realm === 'app' && me.user.isPlatformAdmin) return <Navigate to="/platform" />;
  if (realm === 'app' && !me.selectedClinicId) return <Navigate to="/app/select-clinic" />;

  const links = realm === 'platform'
    ? [{ to: '/platform', label: 'Clinics & accounts' }]
    : [
        { to: '/app', label: 'Today' },
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST') ? [{ to: '/app/queue', label: 'Queue' }] : []),
        ...(me.doctorId ? [{ to: '/app/my-queue', label: 'My queue' }] : []),
        { to: '/app/appointments', label: 'Appointments' },
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR') ? [{ to: '/app/settings', label: 'Settings' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR') ? [{ to: '/app/hours', label: 'Hours & closures' }, { to: '/app/services', label: 'Services' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN', 'RECEPTIONIST') ? [{ to: '/app/doctors', label: 'Doctors & schedules' }] : []),
        ...(hasRole(me, 'CLINIC_ADMIN') ? [{ to: '/app/staff', label: 'Staff' }, { to: '/app/reports', label: 'Reports' }] : []),
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
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">Skip to content</a>
      <header className="flex flex-wrap items-center gap-3 bg-brand px-4 py-2 text-white">
        <button type="button" className="min-h-11 rounded border border-white/50 px-3 md:hidden" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
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
        <nav id="main-nav" aria-label="Main" className={`${menuOpen ? 'block' : 'hidden'} border-b border-slate-200 bg-white p-2 md:block md:min-h-screen md:w-56 md:border-b-0 md:border-r`} key={location.pathname} onClick={() => setMenuOpen(false)}>
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {links.map((l) => (
              <li key={l.to}><NavLink end to={l.to} className={({ isActive }) => `block min-h-11 rounded px-3 py-2.5 text-sm ${isActive ? 'bg-slate-200 font-semibold' : 'hover:bg-slate-100'}`}>{l.label}</NavLink></li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-3 sm:p-4"><Outlet /></main>
      </div>
    </div>
  );
}
