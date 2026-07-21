import { Search, Sun, Moon, Menu, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { usePreferencesStore } from "@/stores/preferences";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Link, useRouterState } from "@tanstack/react-router";
import { IqLogo, NAV_GROUPS } from "./sidebar";
import { SearchCommand } from "./search-command";
import { NotificationBell } from "./notification-bell";
import { cn } from "@/lib/utils";

export function TopBar({ onToggleAskAi }: { onToggleAskAi?: () => void }) {
  const { theme, toggleTheme, sidebarOpen, setSidebar } = useUiStore();
  const marketType = usePreferencesStore((s) => s.marketType);
  const setMarketType = usePreferencesStore((s) => s.setMarketType);
  const [mounted, setMounted] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
      {/* Desktop sidebar toggle */}
      <button
        onClick={() => setSidebar(!sidebarOpen)}
        className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:flex"
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarOpen ? (
          <PanelLeftClose className="h-4 w-4" />
        ) : (
          <PanelLeftOpen className="h-4 w-4" />
        )}
      </button>

      {/* Mobile hamburger */}
      <MobileNav />
      <div className="flex items-center gap-2 lg:hidden">
        <IqLogo className="[&>div:last-child]:hidden" />
      </div>

      <div className="hidden max-w-sm flex-1 lg:flex">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="group flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-ring"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search assets, news, or metrics...</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono">
            Shift ⏎
          </kbd>
        </button>
      </div>

      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />

      <div className="ml-auto flex items-center gap-1">
        <div className="mr-1 hidden items-center rounded-md border border-border bg-surface p-0.5 text-xs sm:flex">
          {(["spot", "perp"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMarketType(m)}
              title={m === "spot" ? "Binance spot" : "Binance USDⓈ-M perpetual futures"}
              className={cn(
                "h-8 rounded px-2.5 font-semibold transition-colors",
                marketType === m
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "spot" ? "Spot" : "Perp"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <NotificationBell />
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Toggle theme"
        >
          {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        {onToggleAskAi && (
          <button
            onClick={onToggleAskAi}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-info transition-colors hover:bg-surface"
            aria-label="Toggle AI"
          >
            <Sparkles className="h-4 w-4" />
          </button>
        )}
        <div className="ml-1 h-8 w-8 rounded-full bg-gradient-to-br from-info to-primary" />
      </div>
    </header>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          aria-label="Menu"
        >
          <Menu className="h-4 w-4" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 bg-sidebar p-5">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <IqLogo />
        <nav className="mt-8 flex flex-col gap-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.to;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setOpen(false)}
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
              </div>
            </div>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
