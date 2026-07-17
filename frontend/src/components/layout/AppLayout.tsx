import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  TrendingUp,
  BarChart3,
  ArrowLeftRight,
  Settings,
  Activity,
} from "lucide-react";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/tokens", label: "Tokens", icon: TrendingUp },
  { to: "/regime", label: "Regime", icon: BarChart3 },
  { to: "/trades", label: "Trades", icon: ArrowLeftRight },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function AppLayout() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 border-r border-border bg-sidebar flex flex-col shrink-0">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
          <Activity className="h-5 w-5 text-info" />
          <span className="font-semibold text-sm tracking-tight">Market Pulse</span>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-accent/50 hover:text-sidebar-foreground"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}