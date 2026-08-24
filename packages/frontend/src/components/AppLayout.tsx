import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clearToken, getCurrentUser } from '../lib/api';
import type { UserRole } from '../lib/types';
import {
  HomeIcon,
  CraneIcon,
  UsersIcon,
  DocumentIcon,
  ArchiveIcon,
  GearIcon,
  LogoutIcon,
  MenuIcon,
  BellIcon,
  UserIcon,
} from '../components/icons';

// Navigation items with role-based access
const NAV_ITEMS: {
  to: string;
  label: string;
  icon: (p: { className?: string }) => JSX.Element;
  roles?: UserRole[];
}[] = [
  { to: '/dashboard', label: 'Dashboard', icon: HomeIcon },
  { to: '/cantieri', label: 'Cantieri', icon: CraneIcon },
  { to: '/dipendenti', label: 'Dipendenti', icon: UsersIcon, roles: ['admin', 'project_manager'] },
  { to: '/report', label: 'Report', icon: DocumentIcon, roles: ['admin', 'project_manager'] },
  { to: '/archivio', label: 'Archivio', icon: ArchiveIcon, roles: ['admin', 'project_manager'] },
];

// Mobile bottom navigation (max 5 items)
const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 5);

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role)),
  );

  function logout() {
    clearToken();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col bg-surface-900">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-600 text-white">
          <GearIcon className="h-5 w-5" />
        </span>
        <span className="text-lg font-semibold text-white">WorkFlow360</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium transition-all duration-150 ${
                isActive
                  ? 'bg-primary-600/10 text-primary-400 border-l-4 border-primary-500'
                  : 'text-surface-300 hover:bg-white/5 hover:text-white'
              }`
            }
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* User section */}
      <div className="border-t border-white/10 p-3">
        <div className="mb-3 flex items-center gap-3 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white">
            <UserIcon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="m-0 truncate text-sm font-medium text-white">{user?.email.split('@')[0]}</p>
            <p className="m-0 truncate text-xs text-surface-500">{user?.email}</p>
          </div>
        </div>
        <button
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-surface-300 transition-all duration-150 hover:bg-white/5 hover:text-white"
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

function MobileHeader({
  onMenuClick,
  onProfileClick,
}: {
  onMenuClick: () => void;
  onProfileClick: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-surface-200 bg-white px-4 py-3 lg:hidden dark:border-surface-700 dark:bg-surface-900">
      <button
        className="btn-ghost p-2 text-surface-600 hover:text-surface-900 dark:text-surface-400 dark:hover:text-white"
        onClick={onMenuClick}
        aria-label="Apri menu"
      >
        <MenuIcon />
      </button>

      <span className="text-lg font-semibold text-surface-900 dark:text-white">WorkFlow360</span>

      <div className="flex items-center gap-1">
        <button
          className="btn-ghost p-2 text-surface-600 hover:text-surface-900 dark:text-surface-400 dark:hover:text-white"
          aria-label="Notifiche"
        >
          <BellIcon />
        </button>
        <button
          className="btn-ghost p-2 text-surface-600 hover:text-surface-900 dark:text-surface-400 dark:hover:text-white"
          onClick={onProfileClick}
          aria-label="Profilo"
        >
          <UserIcon />
        </button>
      </div>
    </header>
  );
}

function MobileBottomNav({ activePath, onNavigate }: { activePath: string; onNavigate: () => void }) {
  const user = getCurrentUser();
  const visibleItems = MOBILE_NAV_ITEMS.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role)),
  );

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-surface-200 bg-white px-2 py-2 lg:hidden dark:border-surface-700 dark:bg-surface-900"
      role="navigation"
      aria-label="Navigazione principale"
    >
      {visibleItems.map((item) => {
        const isActive = activePath === item.to || (item.to !== '/dashboard' && activePath.startsWith(item.to));
        return (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive: navActive }) =>
              `flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs font-medium transition-all duration-150 ${
                navActive
                  ? 'text-primary-600'
                  : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-white'
              }`
            }
            aria-current={isActive ? 'page' : undefined}
          >
            <item.icon className="h-5 w-5" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function ProfileDropdown({
  isOpen,
  onClose,
  onLogout,
}: {
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
}) {
  const user = getCurrentUser();

  if (!isOpen || !user) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 lg:hidden" onClick={onClose} aria-hidden="true" />
      <div className="fixed right-4 top-14 z-50 w-56 rounded-xl border border-surface-200 bg-white py-2 shadow-lg lg:fixed lg:top-16 lg:right-4 dark:border-surface-700 dark:bg-surface-800">
        <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
          <p className="m-0 truncate text-sm font-medium text-surface-900 dark:text-white">{user.email.split('@')[0]}</p>
          <p className="m-0 truncate text-xs text-surface-500">{user.email}</p>
        </div>
        <button
          className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:text-surface-300 dark:hover:bg-surface-800"
          onClick={() => {
            onClose();
            onLogout();
          }}
        >
          <LogoutIcon className="h-4 w-4" />
          Esci
        </button>
      </div>
    </>
  );
}

export default function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activePath, setActivePath] = useState(window.location.pathname);

  useEffect(() => {
    const handleLocationChange = () => {
      setActivePath(window.location.pathname);
    };
    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  const handleLogout = () => {
    clearToken();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-950">
      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-xl">
            <SidebarContent onNavigate={() => setMobileSidebarOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:block lg:w-64">
        <SidebarContent />
      </aside>

      {/* Mobile header */}
      <MobileHeader
        onMenuClick={() => setMobileSidebarOpen(true)}
        onProfileClick={() => setProfileOpen(!profileOpen)}
      />

      {/* Profile dropdown (desktop) */}
      <ProfileDropdown
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        onLogout={handleLogout}
      />

      {/* Main content */}
      <main className="lg:pl-60 pb-20 lg:pb-0">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom navigation */}
      <MobileBottomNav activePath={activePath} onNavigate={() => setMobileSidebarOpen(false)} />
    </div>
  );
}