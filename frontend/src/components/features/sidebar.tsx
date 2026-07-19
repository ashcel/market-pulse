import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Layers,
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bookmark,
  ClipboardList,
  LineChart,
  Newspaper,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";

export const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: Layers },
  { to: "/regime", label: "Regime", icon: Activity },
  { to: "/rotation", label: "Rotation", icon: ArrowLeftRight },
  { to: "/rankings", label: "Rankings", icon: BarChart3 },
  { to: "/technical", label: "Technical", icon: LineChart },
  { to: "/tracker", label: "Tracker", icon: Bookmark },
  { to: "/trade", label: "Trade Desk", icon: Zap },
  { to: "/review", label: "Trade Review", icon: ClipboardList },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function IqLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-info text-background">
        <Sparkles className="h-4 w-4" strokeWidth={2.5} />
      </div>
      <div className="leading-tight">
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
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-4 py-5 lg:flex">
      <div className="px-1.5">
        <IqLogo />
      </div>

      <nav className="mt-8 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-lg bg-sidebar-accent"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <item.icon className="relative h-4 w-4" />
              <span className="relative">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 border-t border-sidebar-border pt-5">
        <div className="eyebrow">Market Time</div>
        <div className="mt-1.5 num text-lg font-semibold tracking-tight">
          <MarketClock />
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">Jul 3, 2026 · UTC+7</div>
      </div>

      <div className="mt-auto space-y-3 pt-6">
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
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warning-soft text-warning text-xs font-bold">
            D
          </div>
          <div className="leading-tight">
            <div className="text-xs font-semibold">HeyDewi</div>
            <div className="text-[10px] text-muted-foreground">Pro Plan</div>
          </div>
        </div>
      </div>
    </aside>
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
