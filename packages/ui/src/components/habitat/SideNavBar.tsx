import React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  BarChart3,
  Plus,
  Activity,
  GitBranch,
  CircleHelp,
  Globe,
  ShieldCheck,
} from "lucide-react";
import { OrcyMark } from "../ui/icons/OrcyMark.js";

interface NavItem {
  label: string;
  icon: React.ReactNode;
  href: string;
  activePattern: string;
}

const navItems: NavItem[] = [
  {
    label: "Pod Base",
    icon: <BarChart3 className="h-4 w-4" />,
    href: "/dashboard",
    activePattern: "/dashboard",
  },
  {
    label: "Echo Base",
    icon: <LayoutDashboard className="h-4 w-4" />,
    href: "/",
    activePattern: "/",
  },
  {
    label: "Orcy Pod",
    icon: <Users className="h-4 w-4" />,
    href: "/agents",
    activePattern: "/agents",
  },
  {
    label: "Wake",
    icon: <Activity className="h-4 w-4" />,
    href: "/activity",
    activePattern: "/activity",
  },
  {
    label: "Remote Pods",
    icon: <Globe className="h-4 w-4" />,
    href: "/remote-pods",
    activePattern: "/remote-pods",
  },
];

interface SideNavBarProps {
  onDeployAgent?: () => void;
  onOpenStats?: () => void;
  onOpenDependencies?: () => void;
}

export const SideNavBar = React.memo(function SideNavBar({
  onDeployAgent,
  onOpenStats,
  onOpenDependencies,
}: SideNavBarProps) {
  const location = useLocation();
  const habitatMatch = location.pathname.match(/\/habitats\/([^/]+)/);
  const currentHabitatId = habitatMatch?.[1];
  const toolItems = [
    { label: "Stats", icon: <BarChart3 className="h-4 w-4" />, onClick: onOpenStats },
    { label: "Dependencies", icon: <GitBranch className="h-4 w-4" />, onClick: onOpenDependencies },
  ];

  return (
    <nav
      className="glass-panel ghost-border-r hidden md:flex flex-col w-64 shrink-0 h-full"
      data-testid="side-nav-bar"
    >
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary text-on-primary shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
          <OrcyMark size={16} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-grotesk font-bold leading-none tracking-wide text-on-surface">
            POD BASE
          </h3>
          <p className="mt-1 text-[10px] font-medium leading-none text-on-surface-variant">
            v2.4.0-Alpha
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-5 px-3 overflow-y-auto">
        <div className="space-y-1">
          <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            VIEWS
          </p>
          {navItems.map((item) => {
            const isActive =
              location.pathname === item.activePattern ||
              (item.activePattern === "/" && location.pathname.startsWith("/boards"));

            return (
              <Link
                key={item.label}
                to={item.href}
                data-testid={`nav-item-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-primary-container text-on-surface font-medium"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="space-y-1">
          <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            TOOLS
          </p>
          {toolItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              disabled={!item.onClick}
              data-testid={`tool-item-${item.label.toLowerCase()}`}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
              title={item.onClick ? item.label : "Open a workspace board first"}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {currentHabitatId && (
          <div className="space-y-1">
            <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
              ADMIN
            </p>
            <Link
              to={`/habitats/${currentHabitatId}/admin/workflows`}
              data-testid="nav-item-workflow-metrics"
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                location.pathname.includes("/admin/workflows")
                  ? "bg-primary-container text-on-surface font-medium"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span>Workflow Metrics</span>
            </Link>
          </div>
        )}
      </div>

      <div className="border-t border-outline-variant/40 p-3 space-y-1">
        <a
          href="mailto:support@agent-command.local"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <CircleHelp className="h-4 w-4" />
          Support
        </a>
      </div>

      <div className="p-3">
        <button
          type="button"
          onClick={onDeployAgent}
          className="btn-primary flex w-full items-center justify-center gap-2 text-sm"
          data-testid="deploy-agent-btn"
        >
          <Plus className="h-4 w-4" />
          Deploy New Agent
        </button>
      </div>
    </nav>
  );
});
