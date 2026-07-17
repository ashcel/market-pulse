import { Link, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Layers, BarChart3, Newspaper, Settings } from "lucide-react";

const TABS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: Layers },
  { to: "/rankings", label: "Rankings", icon: BarChart3 },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function BottomNav() {
  const pathname = useLocation().pathname;
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
                active ? "text-info" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className={cn("h-5 w-5", active && "stroke-[2.4]")} />
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}