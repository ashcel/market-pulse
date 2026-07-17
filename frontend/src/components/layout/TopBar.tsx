import { Search, Sun, Moon, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { IqLogo, NAV } from "./Sidebar";
import { cn } from "@/lib/utils";

export function TopBar() {
  const [mounted, setMounted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
      <button
        onClick={() => setMobileMenuOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
        aria-label="Menu"
      >
        <Menu className="h-4 w-4" />
      </button>

      {mobileMenuOpen && (
        <MobileNav onClose={() => setMobileMenuOpen(false)} />
      )}

      <div className="flex items-center gap-2 lg:hidden">
        <IqLogo className="[&>div:last-child]:hidden" />
      </div>

      <div className="hidden max-w-sm flex-1 lg:flex">
        <button
          type="button"
          onClick={() => {}}
          className="group flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-ring"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search assets, news, or metrics...</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono">
            Shift ⏎
          </kbd>
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <div className="mr-1 hidden items-center rounded-md border border-border bg-surface p-0.5 text-xs sm:flex">
          {(["spot", "perp"] as const).map((m) => (
            <button
              key={m}
              type="button"
              title={m === "spot" ? "Binance spot" : "Binance USDⓈ-M perpetual futures"}
              className={cn(
                "h-8 rounded px-2.5 font-semibold transition-colors",
                m === "spot"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "spot" ? "Spot" : "Perp"}
            </button>
          ))}
        </div>
        <button
          onClick={() => {}}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Notifications"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Toggle theme"
        >
          {mounted ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <div className="ml-1 h-8 w-8 rounded-full bg-gradient-to-br from-info to-primary" />
      </div>
    </header>
  );
}

function MobileNav({ onClose }: { onClose: () => void }) {
  const pathname = useLocation().pathname;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={onClose} />
      <div className="fixed inset-y-0 left-0 z-50 w-72 bg-sidebar p-5 shadow-lg lg:hidden">
        <div className="flex items-center justify-between">
          <IqLogo />
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <nav className="mt-8 flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}