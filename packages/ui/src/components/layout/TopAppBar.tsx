import React from "react";
import { Bell, LogOut, Settings } from "lucide-react";
import { OrcyMark } from "../ui/icons/OrcyMark.js";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useHabitatStore } from "../../store/habitatStore.js";
import { api } from "../../api/index.js";
import { useAgents } from "../../lib/useHabitatData.js";
import { NotificationDropdown } from "../ui/NotificationDropdown.js";

function getUsername(): string {
  const token = localStorage.getItem("orcy_token");
  if (!token) return "User";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.username || "User";
  } catch {
    return "User";
  }
}

interface NavTab {
  label: string;
  description: string;
  match: (path: string) => boolean;
  href?: string;
  habitatScoped?: string;
}

const navTabs: NavTab[] = [
  {
    label: "Echo Base",
    href: "/",
    match: (path: string) =>
      path === "/" || path.startsWith("/boards") || path.startsWith("/features"),
    description: "Workspace board",
  },
  {
    label: "Orcy Pod",
    href: "/agents",
    match: (path: string) => path.startsWith("/agents"),
    description: "Agent management",
  },
  {
    label: "Wake",
    habitatScoped: "activity",
    match: (path: string) => /\/habitats\/[^/]+\/activity/.test(path),
    description: "Activity log",
  },
  {
    label: "Pod Base",
    href: "/dashboard",
    match: (path: string) => path.startsWith("/dashboard"),
    description: "Analytics dashboard",
  },
];

function resolveNavHref(tab: NavTab, currentHabitatId: string | undefined): string | null {
  if (tab.href !== undefined) return tab.href;
  if (tab.habitatScoped) {
    return currentHabitatId ? `/habitats/${currentHabitatId}/${tab.habitatScoped}` : null;
  }
  return null;
}

const agentStatusConfig: Record<string, { color: string; label: string; pulse: boolean }> = {
  working: { color: "bg-[var(--badge-active)]", label: "Processing", pulse: false },
  idle: { color: "bg-[var(--badge-done)]", label: "Idle", pulse: false },
  offline: { color: "bg-[var(--badge-blocked)]", label: "Stalled", pulse: true },
};

export const TopAppBar = React.memo(function TopAppBar() {
  const { data: agents = [] } = useAgents();
  const notifications = useHabitatStore((s) => s.notifications);
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
  const location = useLocation();
  const habitatMatch = location.pathname.match(/\/habitats\/([^/]+)/);
  const currentHabitatId = habitatMatch?.[1];

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <header
      className="glass-panel ghost-border-b flex h-16 shrink-0 items-center justify-between px-4 md:px-6"
      data-testid="top-app-bar"
    >
      <div className="flex min-w-0 items-center gap-4 md:gap-6">
        <div className="flex items-center gap-2">
          <OrcyMark className="text-primary" size={20} />
          <span className="hidden text-sm font-headline font-black uppercase tracking-[0.22em] text-error sm:inline">
            ORCY POD
          </span>
        </div>
        <div className="hidden h-6 w-px bg-outline-variant md:block" />
        <nav
          className="hidden items-center gap-1 font-headline text-xs font-bold uppercase tracking-wide md:flex"
          aria-label="Primary navigation"
        >
          {navTabs.map((tab) => {
            const active = tab.match(location.pathname);
            const href = resolveNavHref(tab, currentHabitatId);
            const testId = `top-nav-${tab.label.toLowerCase().replace(/\s+/g, "-")}`;
            if (href === null) {
              return (
                <span
                  key={tab.label}
                  title="Open a habitat to view its activity"
                  data-testid={testId}
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-full px-3 py-1.5 text-on-surface-variant/40"
                >
                  {tab.label}
                </span>
              );
            }
            return (
              <NavLink
                key={tab.label}
                to={href}
                title={tab.description}
                className={
                  active
                    ? "rounded-full bg-slate-700/50 px-3 py-1.5 text-on-surface shadow-[0_4px_20px_rgba(0,0,0,0.2)]"
                    : "rounded-full px-3 py-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                }
                data-testid={testId}
              >
                {tab.label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-2 md:gap-3">
        <div
          className="hidden items-center gap-2 rounded-full bg-surface-container-high px-3 py-1.5 lg:flex"
          data-testid="fleet-pulse"
        >
          <span className="text-[10px] font-medium uppercase tracking-wider text-on-surface-variant">
            Fleet Pulse
          </span>
          {agents.length > 0 ? (
            agents.slice(0, 4).map((agent) => {
              const { color, label, pulse } =
                agentStatusConfig[agent.status] ?? agentStatusConfig.idle;
              return (
                <div
                  key={agent.id}
                  className="flex items-center gap-1.5"
                  title={`${agent.name}: ${label}`}
                >
                  <div
                    className={`h-2 w-2 rounded-full ${color}${pulse ? " animate-pulse" : ""}`}
                  />
                  <span className="hidden max-w-24 truncate text-[10px] text-on-surface-variant xl:inline">
                    {agent.name}: {label}
                  </span>
                </div>
              );
            })
          ) : (
            <span className="text-[10px] text-on-surface-variant">No agents online</span>
          )}
          {agents.length > 4 && (
            <span className="text-[10px] font-medium text-on-surface-variant">
              +{agents.length - 4}
            </span>
          )}
        </div>

        <div className="relative" data-testid="notification-bell-container">
          <button
            type="button"
            className="relative rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            title="Notifications"
            onClick={() => setNotificationsOpen((prev) => !prev)}
            data-testid="notification-bell-btn"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-[10px] font-bold text-white"
                data-testid="unread-badge"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          <NotificationDropdown
            isOpen={notificationsOpen}
            onClose={() => setNotificationsOpen(false)}
          />
        </div>

        <UserMenu />
      </div>
    </header>
  );
});

function UserMenu() {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const username = getUsername();

  React.useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // server logout is best-effort per ADR-002
    }
    localStorage.removeItem("orcy_token");
    navigate("/login");
  };

  return (
    <div className="relative" ref={containerRef} data-testid="user-menu-container">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-outline-variant bg-primary-container transition-colors hover:bg-surface-container-high"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="user-avatar-btn"
        aria-label="User menu"
      >
        <span className="text-xs font-bold text-on-surface">
          {username.charAt(0).toUpperCase()}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50" data-testid="user-menu-dropdown">
          <div className="glass-card w-56 rounded-xl shadow-xl border border-outline-variant/15 overflow-hidden">
            <div className="px-3 py-2.5 border-b border-outline-variant/15">
              <p
                className="text-sm font-medium text-on-surface truncate"
                data-testid="user-menu-username"
              >
                {username}
              </p>
            </div>
            <div className="flex flex-col py-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                onClick={() => {
                  setOpen(false);
                  navigate("/settings");
                }}
                data-testid="user-menu-settings"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                onClick={handleLogout}
                data-testid="user-menu-logout"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
