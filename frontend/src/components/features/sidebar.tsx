import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { LayoutDashboard, NotebookText, Layers, Settings } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUiStore } from "@/stores/ui";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
};

// Task-named destinations (2026-07-24 revision): Today = Q1 (should I trade),
// Journal = Q3 (am I trading well), Markets = evidence, Settings = config.
// Checking a specific trade (Q2) moved onto the token chart, so the standalone
// Check slot was retired.
export const NAV: readonly NavItem[] = [
  { to: "/", label: "Today", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: Layers },
  { to: "/journal", label: "Journal", icon: NotebookText },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function IqLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src="/market-pulse.png"
        alt="Market Pulse Logo"
        className="h-9 w-9 shrink-0 rounded-lg object-cover"
      />
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

        {/* Flat nav — no group labels */}
        <nav className="flex flex-col gap-0.5 px-2 mt-1 flex-1 overflow-y-auto overflow-x-hidden">
          {NAV.map((item) => {
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
        </nav>
      </motion.aside>
    </TooltipProvider>
  );
}
