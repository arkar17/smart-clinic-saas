import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider } from './auth';
import { ToastProvider } from './components';
import { ChangePasswordPage, LoginPage, SelectClinicPage } from './pages/auth';
import { AppShell } from './pages/shell';
import { DoctorsPage, HoursPage, ServicesPage, SettingsPage, StaffPage } from './pages/admin';
import { PlatformPage } from './pages/platform';
import { MySchedulePage } from './pages/doctor';
import { BookPage, MyBookingPage, PortalPage } from './pages/public';
import { AppointmentsPage } from './pages/appointments';
import { JoinQueuePage, QueueStatusPage } from './pages/queuePublic';
import { DoctorQueuePage, QueueBoardPage } from './pages/queueStaff';
import { DashboardPage, ReportsPage } from './pages/dashboard';

const Placeholder = ({ text }: { text: string }) => <main className="p-8 text-center text-slate-600">{text}</main>;

// Realms (SC1-FE-01): public (SC-2), app (staff), platform, display (SC-3).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/login" />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/app/change-password" element={<ChangePasswordPage />} />
            <Route path="/app/select-clinic" element={<SelectClinicPage />} />
            <Route path="/app" element={<AppShell realm="app" />}>
              <Route index element={<DashboardPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="appointments" element={<AppointmentsPage />} />
              <Route path="queue" element={<QueueBoardPage />} />
              <Route path="my-queue" element={<DoctorQueuePage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="hours" element={<HoursPage />} />
              <Route path="services" element={<ServicesPage />} />
              <Route path="doctors" element={<DoctorsPage />} />
              <Route path="staff" element={<StaffPage />} />
              <Route path="my-schedule" element={<MySchedulePage />} />
            </Route>
            <Route path="/platform" element={<AppShell realm="platform" />}>
              <Route index element={<PlatformPage />} />
            </Route>
            <Route path="/c/:slug" element={<PortalPage />} />
            <Route path="/c/:slug/book" element={<BookPage />} />
            <Route path="/c/:slug/b/:token" element={<MyBookingPage />} />
            <Route path="/c/:slug/join" element={<JoinQueuePage />} />
            <Route path="/c/:slug/q/:token" element={<QueueStatusPage />} />
            <Route path="/display" element={<Placeholder text="The waiting-room display arrives in SC-3." />} />
            <Route path="*" element={<Placeholder text="Page not found." />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
