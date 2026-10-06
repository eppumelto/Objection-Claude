import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router';
import { AuthProvider, RequireAuth, useAuth } from './auth.tsx';
import { api } from './api.ts';
import { LoginPage, RegisterPage } from './pages/Auth.tsx';
import { CasesPage } from './pages/Cases.tsx';
import { EditorPage } from './pages/Editor.tsx';
import { TrialPage } from './pages/Trial.tsx';
import { HistoryPage, ReplayPage } from './pages/History.tsx';
import { StatsPage } from './pages/Stats.tsx';
import type { ReactNode } from 'react';

function Shell({ children }: { children: ReactNode }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    setUser(null);
    navigate('/login', { replace: true });
  };
  return (
    <RequireAuth>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <NavLink to="/cases" className="brand" aria-label="OBJECTION! home">OBJECTION!</NavLink>
        <nav aria-label="Main">
          <NavLink to="/cases">Cases</NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/stats">Stats</NavLink>
        </nav>
        <div className="who">
          <span className="email" title={user?.email}>{user?.email}</span>
          <button type="button" className="btn ghost small" data-testid="logout" onClick={logout}>Log out</button>
        </div>
      </header>
      <main id="main" className="page">{children}</main>
    </RequireAuth>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/cases" element={<Shell><CasesPage /></Shell>} />
      <Route path="/cases/new" element={<Shell><EditorPage /></Shell>} />
      <Route path="/cases/:id/edit" element={<Shell><EditorPage /></Shell>} />
      <Route path="/trial/:trialId" element={<Shell><TrialPage /></Shell>} />
      <Route path="/history" element={<Shell><HistoryPage /></Shell>} />
      <Route path="/history/:trialId" element={<Shell><ReplayPage /></Shell>} />
      <Route path="/stats" element={<Shell><StatsPage /></Shell>} />
      <Route path="*" element={<Shell><Navigate to="/cases" replace /></Shell>} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
