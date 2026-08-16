import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Layers,
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Bookmark,
  CalendarDays,
  CandlestickChart,
  ClipboardList,
  Compass,
  Rocket,
  LineChart,
  Newspaper,
  Settings,
  Star,
  FlaskConical,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { useUiStore } from "@/stores/ui";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type NavItem = {
  to: string;
  /** Key under `nav.items.*` in the i18n resources — render via `t(\`nav.items.${labelKey}\`)`. */
  labelKey: string;
  icon: React.ElementType;
  /** Personal-plane destination: hidden from anonymous visitors and guarded server-side. */
  requiresAuth?: boolean;
};

type NavGroup = {
  /** Key under `nav.groups.*`. */
  groupKey: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    groupKey: "overview",
    items: [
      { to: "/", labelKey: "dashboard", icon: LayoutDashboard },
      { to: "/markets", labelKey: "markets", icon: Layers },
      { to: "/discover", labelKey: "discover", icon: Compass },
      { to: "/listings", labelKey: "listings", icon: Rocket },
      { to: "/news", labelKey: "news", icon: Newspaper },
      { to: "/events", labelKey: "events", icon: CalendarDays },
      { to: "/watchlist", labelKey: "watchlist", icon: Star, requiresAuth: true },
    ],
  },
  {
    groupKey: "analysis",
    items: [
      { to: "/regime", labelKey: "regime", icon: Activity },
      { to: "/rotation", labelKey: "rotation", icon: ArrowLeftRight },
      { to: "/rankings", labelKey: "rankings", icon: BarChart3 },
      { to: "/technical", labelKey: "technical", icon: LineChart },
      { to: "/forward-test", labelKey: "forwardTest", icon: FlaskConical },
    ],
  },
  {
    groupKey: "trading",
    items: [
      { to: "/tracker", labelKey: "tracker", icon: Bookmark, requiresAuth: true },
      { to: "/review", labelKey: "review", icon: ClipboardList, requiresAuth: true },
      { to: "/trades", labelKey: "trades", icon: CandlestickChart, requiresAuth: true },
      { to: "/alerts", labelKey: "alerts", icon: Bell, requiresAuth: true },
    ],
  },
  {
    groupKey: "account",
    items: [{ to: "/settings", labelKey: "settings", icon: Settings, requiresAuth: true }],
  },
];

// Flat NAV for backward compat (used by top-bar mobile nav)
export const NAV = NAV_GROUPS.flatMap((g) => g.items) as readonly NavItem[];

/**
 * The nav an anonymous visitor sees: the market plane only. Groups that end up
 * empty drop out entirely rather than rendering a bare heading.
 */
export function visibleNavGroups(isAuthed: boolean): NavGroup[] {
  if (isAuthed) return NAV_GROUPS;
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.requiresAuth),
  })).filter((g) => g.items.length > 0);
}

export function IqLogo({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src="/market-pulse.png"
        alt="Market Pulse Logo"
        className="h-9 w-9 shrink-0 rounded-lg object-cover"
      />
      <div className="leading-tight min-w-0">
        <div className="text-base font-semibold tracking-tight">{t("common.appName")}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("common.tagline")}
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const collapsed = useUiStore((s) => !s.sidebarOpen);
  const setSidebar = useUiStore((s) => s.setSidebar);
  const { isAuthed, isPending } = useAuth();
  const groups = visibleNavGroups(isAuthed);

  return (
    <TooltipProvider delayDuration={0}>
      <motion.aside
        animate={{ width: collapsed ? 64 : 240 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="relative hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex overflow-hidden"
        style={{ minWidth: 0 }}
      >
        {/* Logo / brand */}
        <div className={cn("flex items-center px-4 py-5", collapsed ? "justify-center" : "")}>
          {collapsed ? (
            <img
              src="/market-pulse.png"
              alt="Market Pulse Logo"
              className="h-9 w-9 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <IqLogo />
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex flex-col gap-3 px-2 mt-1 flex-1 overflow-y-auto overflow-x-hidden">
          {groups.map((group) => (
            <div key={group.groupKey}>
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    key="label"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60"
                  >
                    {t(`nav.groups.${group.groupKey}`)}
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.to;
                  const link = (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={cn(
                        "relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors",
                        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        active && "bg-sidebar-accent text-sidebar-accent-foreground",
                        collapsed ? "justify-center px-0" : "px-3",
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="sidebar-active"
                          className="absolute inset-0 rounded-lg bg-sidebar-accent"
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                        />
                      )}
                      <item.icon className="relative h-4 w-4 shrink-0" />
                      <AnimatePresence initial={false}>
                        {!collapsed && (
                          <motion.span
                            key="label"
                            className="relative whitespace-nowrap overflow-hidden"
                            initial={{ opacity: 0, width: 0 }}
                            animate={{ opacity: 1, width: "auto" }}
                            exit={{ opacity: 0, width: 0 }}
                            transition={{ duration: 0.15 }}
                          >
                            {t(`nav.items.${item.labelKey}`)}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </Link>
                  );

                  if (collapsed) {
                    return (
                      <Tooltip key={item.to}>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                          {t(`nav.items.${item.labelKey}`)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  }
                  return link;
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Market Time */}
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="market-time"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mx-2 border-t border-sidebar-border pt-4 pb-2 px-2"
            >
              <div className="eyebrow">{t("sidebar.marketTime")}</div>
              <div className="mt-1.5 num text-lg font-semibold tracking-tight">
                <MarketClock />
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">UTC+7</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Account block — only when expanded */}
        <AnimatePresence initial={false}>
          {!collapsed && !isPending && (
            <motion.div
              key="footer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mx-2 mb-4 mt-auto space-y-3 pt-3"
            >
              {isAuthed ? (
                <AccountBlock />
              ) : (
                <div className="rounded-xl border border-sidebar-border bg-surface p-4">
                  <div className="text-sm font-semibold">{t("sidebar.signInTitle")}</div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {t("sidebar.signInBody")}
                  </p>
                  <Link
                    to="/login"
                    className="mt-3 block rounded-md border border-info/30 bg-info/10 py-1.5 text-center text-xs font-medium text-info transition-colors hover:bg-info/20"
                  >
                    {t("common.signIn")}
                  </Link>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.aside>
    </TooltipProvider>
  );
}

import { useEffect, useState } from "react";
function MarketClock() {
  const [now, setNow] = useState(() =>
    new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
  );
  useEffect(() => {
    const id = setInterval(
      () =>
        setNow(
          new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        ),
      15000,
    );
    return () => clearInterval(id);
  }, []);
  return <>{now}</>;
}

function AccountBlock() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const initial = (user?.displayName || user?.email || "?").charAt(0).toUpperCase();
  return (
    <>
      <div className="rounded-xl border border-sidebar-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{t("sidebar.proTitle")}</span>
          <span className="rounded-md bg-info px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-background">
            {t("sidebar.proLabel")}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t("sidebar.proBody")}</p>
        <button className="mt-3 w-full rounded-md border border-info/30 bg-info/10 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info/20">
          {t("sidebar.upgradeNow")}
        </button>
      </div>

      <Link
        to="/settings"
        className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-sidebar-accent"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warning-soft text-warning text-xs font-bold shrink-0">
          {initial}
        </div>
        <div className="leading-tight min-w-0">
          <div className="text-xs font-semibold truncate">
            {user?.displayName ?? t("common.account")}
          </div>
          <div className="text-[10px] text-muted-foreground">{t("common.signedIn")}</div>
        </div>
      </Link>
    </>
  );
}
