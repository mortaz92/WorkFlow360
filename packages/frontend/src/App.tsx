import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getToken } from './lib/api';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import DashboardPage from './pages/DashboardPage';
import CantieriPage from './pages/CantieriPage';
import CantiereDetailPage from './pages/CantiereDetailPage';
import DipendentiPage from './pages/DipendentiPage';
import DipendenteDetailPage from './pages/DipendenteDetailPage';
import OperaioPage from './pages/OperaioPage';
import FirmaPage from './pages/FirmaPage';
import ReportPage from './pages/ReportPage';
import ArchivioPage from './pages/ArchivioPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// Pagine raggiungibili senza token. Non è solo /login: /reset-password arriva da un
// link email con un token nella query string — senza questa lista, il redirect qui
// sotto sbatterebbe l'utente su /login PRIMA che la pagina possa leggere quel token,
// perdendolo (trappola trovata in FASE 2 di questo round, mai riprodotta prima perché
// nessuna pagina pubblica oltre /login era mai esistita).
const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password', '/privacy', '/termini'];

export default function App() {
  // Stato minimo: qui teniamo solo il routing. L'utente loggato viene letto
  // dalla dashboard tramite il token decodificato lato client se necessario.
  const [ready] = useState(true);
  const navigate = useNavigate();
  useEffect(() => {
    if (!getToken() && !PUBLIC_PATHS.includes(window.location.pathname)) {
      navigate('/login', { replace: true });
    }
  }, [navigate]);
  if (!ready) return null;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/termini" element={<TermsPage />} />
      {/* Dashboard e Report condividono la sidebar (AppLayout). L'Operaio resta fuori:
          è mobile-first e non deve portare in giro una sidebar pensata per desktop. */}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/cantieri" element={<CantieriPage />} />
        <Route path="/cantieri/:id" element={<CantiereDetailPage />} />
        <Route path="/dipendenti" element={<DipendentiPage />} />
        <Route path="/dipendenti/:id" element={<DipendenteDetailPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/archivio" element={<ArchivioPage />} />
      </Route>
      <Route
        path="/operaio"
        element={
          <RequireAuth>
            <OperaioPage />
          </RequireAuth>
        }
      />
      {/* Schermo intero, senza sidebar/header: pensata per essere messa in mano al
          cliente sul telefono dell'operaio. Fuori da PUBLIC_PATHS: la GET di anteprima e
          "Il cliente non firma" restano autenticate con la sessione dell'operaio — solo
          la POST finale di firma (rapportini.routes.ts) è davvero pubblica lato server. */}
      <Route
        path="/firma/:id"
        element={
          <RequireAuth>
            <FirmaPage />
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
