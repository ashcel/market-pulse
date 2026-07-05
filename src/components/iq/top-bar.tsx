import { Search, Bell, Sun, Moon, Menu } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { IqLogo, NAV } from "./sidebar";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { theme, toggleTheme } = useUiStore();
  const [mounted, setMounted] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
      <MobileNav />
      <div className="flex items-center gap-2 lg:hidden">
        <IqLogo className="[&>div:last-child]:hidden" />
      </div>

      <div className="hidden max-w-md flex-1 lg:flex">
        <TokenSearchForm />
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Sheet open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
          <SheetTrigger asChild>
            <button
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
              aria-label="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          </SheetTrigger>
          <SheetContent side="top" className="border-border bg-background p-4">
            <SheetTitle className="sr-only">Search token</SheetTitle>
            <TokenSearchForm
              autoFocus
              onSearch={() => setMobileSearchOpen(false)}
              placeholder="Search ticker..."
            />
          </SheetContent>
        </Sheet>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-info" />
        </button>
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label="Toggle theme"
        >
          {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <div className="ml-1 h-8 w-8 rounded-full bg-gradient-to-br from-info to-primary" />
      </div>
    </header>
  );
}

function TokenSearchForm({
  autoFocus,
  onSearch,
  placeholder = "Search assets, news, or metrics...",
}: {
  autoFocus?: boolean;
  onSearch?: () => void;
  placeholder?: string;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  return (
    <form
      className="group flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted-foreground focus-within:border-ring"
      onSubmit={(event) => {
        event.preventDefault();
        const symbol = value
          .trim()
          .replace(/[^a-z0-9]/gi, "")
          .toUpperCase();
        if (!symbol) return;
        setValue("");
        onSearch?.();
        void navigate({ to: "/token/$symbol", params: { symbol } });
      }}
    >
      <Search className="h-4 w-4" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
      />
      <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono sm:block">
        Enter
      </kbd>
    </form>
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
        <nav className="mt-8 flex flex-col gap-0.5">
          {NAV.map((item) => {
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
        </nav>
      </SheetContent>
    </Sheet>
  );
}
