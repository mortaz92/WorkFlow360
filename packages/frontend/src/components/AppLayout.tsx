import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clearToken, getCurrentUser } from '../lib/api';
import type { UserRole } from '../lib/types';
import { CraneIcon, DocumentIcon, GearIcon, HomeIcon, LogoutIcon, PackageIcon, UsersIcon } from '../components/icons';

// Dipendenti/Report/Archivio vivono dietro rotte riservate ad admin/project_manager sul
// backend (stesso gate di /reports): senza questo filtro, un ruolo diverso (resource/qa/
// stakeholder) vedeva comunque il link in sidebar e ci finiva su un 403. Dashboard e
// Cantieri restano aperti a tutti, coerenti con la lettura non ristretta di /projects.
const NAV_ITEMS: { to: string; label: string; icon: (p: { className?: string }) => JSX.Element; roles?: UserRole[] }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: HomeIcon },
  { to: '/cantieri', label: 'Cantieri', icon: CraneIcon },
  { to: '/dipendenti', label: 'Dipendenti', icon: UsersIcon, roles: ['admin', 'project_manager'] },
  { to: '/report', label: 'Report', icon: DocumentIcon, roles: ['admin', 'project_manager'] },
  { to: '/archivio', label: 'Archivio', icon: PackageIcon, roles: ['admin', 'project_manager'] },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const visibleNavItems = NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role)));

  function logout() {
    clearToken();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white">
          <GearIcon className="h-5 w-5" />
        </span>
        <span className="text-lg font-semibold text-white">WorkFlow360</span>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-4 py-3 text-base font-medium transition-colors ${
                isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
              }`
            }
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <button
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800/60 hover:text-white"
          onClick={logout}
          title={user?.email}
        >
          <LogoutIcon className="h-4 w-4" />
          Esci
        </button>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Sidebar fissa desktop (>=1024px) */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:block lg:w-60">
        <SidebarContent />
      </aside>

      {/* Overlay mobile/tablet (<1024px) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-xl">
            <div className="flex justify-end bg-slate-900 p-3">
              <button className="btn-ghost text-slate-300 hover:text-white" onClick={() => setMobileOpen(false)} aria-label="Chiudi menu">
                ✕
              </button>
            </div>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Header mobile con hamburger (<1024px) */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-3 lg:hidden">
        <button
          className="btn-ghost px-2 text-slate-300 hover:text-white"
          onClick={() => setMobileOpen(true)}
          aria-label="Apri menu"
        >
          ☰
        </button>
        <span className="text-lg font-semibold text-white">WorkFlow360</span>
      </header>

      <main className="lg:pl-60">
        <div className="mx-auto max-w-5xl p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
