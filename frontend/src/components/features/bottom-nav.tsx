import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Layers, NotebookText, Settings } from "lucide-react";

interface BottomNavTab {
  to: "/" | "/markets" | "/journal" | "/settings";
  label: string;
  icon: React.ElementType;
  primary?: boolean;
}

// Today · Markets · Journal · Settings (2026-07-24 revision). Checking a trade
// now happens on the token chart (drag entry/stop/target -> permit), so the
// standalone Check slot was retired.
const TABS: BottomNavTab[] = [
  { to: "/", label: "Today", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: Layers },
  { to: "/journal", label: "Journal", icon: NotebookText },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function BottomNav() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-md items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] pt-1.5">
        {TABS.map((t) => {
          const active = pathname === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "flex min-w-[52px] flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[10px] font-medium transition-colors",
                t.primary
                  ? active
                    ? "text-info"
                    : "text-info/80 hover:text-info"
                  : active
                    ? "text-info"
                    : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className={cn(t.primary ? "h-6 w-6" : "h-5 w-5", active && "stroke-[2.4]")} />
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
