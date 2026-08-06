import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Layers,
  CandlestickChart,
  Settings,
  Bookmark,
  CalendarDays,
  Compass,
  LogIn,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const SIGNED_IN_TABS = [
  { to: "/", labelKey: "dashboard", icon: LayoutDashboard },
  { to: "/markets", labelKey: "markets", icon: Layers },
  { to: "/trades", labelKey: "trades", icon: CandlestickChart },
  { to: "/tracker", labelKey: "tracker", icon: Bookmark },
  { to: "/settings", labelKey: "settings", icon: Settings },
] as const;

// Anonymous visitors get the market plane plus a way in — never a tab that
// would bounce them straight back to /login.
const ANONYMOUS_TABS = [
  { to: "/", labelKey: "dashboard", icon: LayoutDashboard },
  { to: "/markets", labelKey: "markets", icon: Layers },
  { to: "/discover", labelKey: "discover", icon: Compass },
  { to: "/events", labelKey: "events", icon: CalendarDays },
  { to: "/login", labelKey: "signIn", icon: LogIn },
] as const;

export function BottomNav() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { isAuthed } = useAuth();
  const TABS = isAuthed ? SIGNED_IN_TABS : ANONYMOUS_TABS;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-md items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] pt-1.5">
        {TABS.map((tab) => {
          const active = pathname === tab.to;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={cn(
                "flex min-w-[52px] flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[10px] font-medium transition-colors",
                active ? "text-info" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tab.icon className={cn("h-5 w-5", active && "stroke-[2.4]")} />
              <span>{t(`nav.items.${tab.labelKey}`)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
