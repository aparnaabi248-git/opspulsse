import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { RealtimeProvider } from './context/RealtimeContext';
import { ToastProvider } from './components/ui/ToastProvider';
import AppLayout from './components/layout/AppLayout';

import Landing from './pages/Landing';
import AuthForm from './pages/AuthForm';
import Dashboard from './pages/Dashboard';
import Monitors from './pages/Monitors';
import MonitorForm from './pages/MonitorForm';
import MonitorDetail from './pages/MonitorDetail';
import Analytics from './pages/Analytics';
import Incidents from './pages/Incidents';
import IncidentDetail from './pages/IncidentDetail';
import Notifications from './pages/Notifications';
import Reports from './pages/Reports';
import TeamManagement from './pages/TeamManagement';
import Settings from './pages/Settings';
import { LoadingState } from './components/ui/EmptyState';
import ErrorBoundary from './components/ui/ErrorBoundary';

/**
 * Routes
 * ------
 * Only pages that are actually implemented are registered. The incidents,
 * notification centre, team management and settings pages are added in their
 * phases — there are no placeholder screens anywhere.
 */

/** Blocks a page until we know whether the visitor is signed in. */
function RequireAuth({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-shell">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

/** Keeps a signed-in user away from the login/register screens. */
function RedirectIfAuthed({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <LoadingState />;
  if (isAuthenticated) return <Navigate to="/app" replace />;
  return children;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>
            <Routes>
              <Route path="/" element={<Landing />} />

              <Route
                path="/login"
                element={
                  <RedirectIfAuthed>
                    <AuthForm mode="login" />
                  </RedirectIfAuthed>
                }
              />
              <Route
                path="/register"
                element={
                  <RedirectIfAuthed>
                    <AuthForm mode="register" />
                  </RedirectIfAuthed>
                }
              />

              <Route
                path="/app"
                element={
                  <RequireAuth>
                    <ErrorBoundary>
                      <AppLayout />
                    </ErrorBoundary>
                  </RequireAuth>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="monitors" element={<Monitors />} />
                <Route path="monitors/new" element={<MonitorForm />} />
                <Route path="monitors/:monitorId" element={<MonitorDetail />} />
                <Route path="monitors/:monitorId/edit" element={<MonitorForm />} />
                <Route path="analytics" element={<Analytics />} />
                <Route path="reports" element={<Reports />} />
                <Route path="incidents" element={<Incidents />} />
                <Route path="incidents/:incidentId" element={<IncidentDetail />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="team" element={<TeamManagement />} />
                <Route path="settings" element={<Settings />} />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}