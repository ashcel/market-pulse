import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Layers,
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bookmark,
  CandlestickChart,
  ChevronLeft,
  ClipboardList,
  LineChart,
  Newspaper,
  Settings,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUiStore } from "@/stores/ui";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/markets", label: "Markets", icon: Layers },
    ],
  },
  {
    label: "Analysis",
    items: [
      { to: "/regime", label: "Regime", icon: Activity },
      { to: "/rotation", label: "Rotation", icon: ArrowLeftRight },
      { to: "/rankings", label: "Rankings", icon: BarChart3 },
      { to: "/technical", label: "Technical", icon: LineChart },
      { to: "/news", label: "News", icon: Newspaper },
    ],
  },
  {
    label: "Trading",
    items: [
      { to: "/tracker", label: "Tracker", icon: Bookmark },
      { to: "/review", label: "Trade Review", icon: ClipboardList },
      { to: "/trades", label: "Trades", icon: CandlestickChart },
    ],
  },
  {
    label: "Account",
    items: [{ to: "/settings", label: "Settings", icon: Settings }],
  },
];

// Flat NAV for backward compat (used by top-bar mobile nav)
export const NAV = NAV_GROUPS.flatMap((g) => g.items) as readonly NavItem[];

export function IqLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img src="/market-pulse.png" alt="Market Pulse Logo" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
      <div className="leading-tight min-w-0">
        <div className="text-base font-semibold tracking-tight">Market Pulse</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Crypto Market Intelligence
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const collapsed = useUiStore((s) => !s.sidebarOpen);
  const setSidebar = useUiStore((s) => s.setSidebar);

  const toggle = () => setSidebar(collapsed);

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
            <img src="/market-pulse.png" alt="Market Pulse Logo" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
          ) : (
            <IqLogo />
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex flex-col gap-3 px-2 mt-1 flex-1 overflow-y-auto overflow-x-hidden">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
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
                    {group.label}
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
                            {item.label}
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
                          {item.label}
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
              <div className="eyebrow">Market Time</div>
              <div className="mt-1.5 num text-lg font-semibold tracking-tight">
                <MarketClock />
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">UTC+7</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pro upsell + user — only when expanded */}
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="footer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mx-2 mb-4 mt-auto space-y-3 pt-3"
            >
              <div className="rounded-xl border border-sidebar-border bg-surface p-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">Market Pulse Pro</span>
                  <span className="rounded-md bg-info px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-background">
                    Pro
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Unlock advanced insights, alerts, and more.
                </p>
                <button className="mt-3 w-full rounded-md border border-info/30 bg-info/10 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info/20">
                  Upgrade Now
                </button>
              </div>

              <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warning-soft text-warning text-xs font-bold shrink-0">
                  D
                </div>
                <div className="leading-tight min-w-0">
                  <div className="text-xs font-semibold">HeyDewi</div>
                  <div className="text-[10px] text-muted-foreground">Pro Plan</div>
                </div>
              </div>
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
