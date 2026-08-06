import { Search, Sun, Moon, Menu, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui";
import { usePreferencesStore } from "@/stores/preferences";
import { useSnapshotMeta } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Link, useRouterState } from "@tanstack/react-router";
import { IqLogo, visibleNavGroups } from "./sidebar";
import { SearchCommand } from "./search-command";
import { NotificationBell } from "./notification-bell";
import { LocaleSwitcher } from "./locale-sync";
import { cn } from "@/lib/utils";

export function TopBar({ onToggleAskAi }: { onToggleAskAi?: () => void }) {
  const { t } = useTranslation();
  const { theme, toggleTheme, sidebarOpen, setSidebar } = useUiStore();
  const marketType = usePreferencesStore((s) => s.marketType);
  const setMarketType = usePreferencesStore((s) => s.setMarketType);
  const [mounted, setMounted] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { isAuthed, isPending } = useAuth();
  useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
      {/* Desktop sidebar toggle */}
      <button
        onClick={() => setSidebar(!sidebarOpen)}
        className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:flex"
        aria-label={sidebarOpen ? t("topBar.collapseSidebar") : t("topBar.expandSidebar")}
        title={sidebarOpen ? t("topBar.collapseSidebar") : t("topBar.expandSidebar")}
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
          <span className="flex-1 text-left">{t("topBar.searchPlaceholder")}</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono">
            Shift ⏎
          </kbd>
        </button>
      </div>

      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />

      <div className="ml-auto flex items-center gap-1">
        <ExchangeClock />
        <LocaleSwitcher />
        <div className="mr-1 hidden items-center rounded-md border border-border bg-surface p-0.5 text-xs sm:flex">
          {(["spot", "perp"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMarketType(m)}
              title={m === "spot" ? t("topBar.spotTitle") : t("topBar.perpTitle")}
              className={cn(
                "h-8 rounded px-2.5 font-semibold transition-colors",
                marketType === m
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "spot" ? t("topBar.spot") : t("topBar.perp")}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          aria-label={t("topBar.search")}
        >
          <Search className="h-4 w-4" />
        </button>
        {isAuthed && <NotificationBell />}
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          aria-label={t("topBar.toggleTheme")}
        >
          {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        {onToggleAskAi && (
          <button
            onClick={onToggleAskAi}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-info transition-colors hover:bg-surface"
            aria-label={t("topBar.toggleAi")}
          >
            <Sparkles className="h-4 w-4" />
          </button>
        )}
        {isPending ? null : isAuthed ? (
          <Link
            to="/settings"
            aria-label={t("topBar.account")}
            className="ml-1 h-8 w-8 rounded-full bg-gradient-to-br from-info to-primary"
          />
        ) : (
          <Link
            to="/login"
            className="ml-1 rounded-lg border border-info/30 bg-info/10 px-3 py-1.5 text-xs font-semibold text-info transition-colors hover:bg-info/20"
          >
            {t("common.signIn")}
          </Link>
        )}
      </div>
    </header>
  );
}

/**
 * Data-source + wall-clock indicator. The dot reads the snapshot's own
 * provenance: green when the last snapshot came from Binance, amber when the
 * app fell back to the deterministic demo build.
 */
function ExchangeClock() {
  const { t } = useTranslation();
  const meta = useSnapshotMeta();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(id);
  }, []);

  const live = meta.data?.source === "live";
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
  const updatedTime = meta.data ? new Date(meta.data.updatedAt).toLocaleTimeString() : "";

  return (
    <div
      className="mr-2 hidden items-center gap-2 text-xs md:flex"
      title={
        meta.data
          ? t(live ? "topBar.snapshotTitleLive" : "topBar.snapshotTitleDemo", { time: updatedTime })
          : t("topBar.snapshotTitleWaiting")
      }
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          !meta.data ? "bg-muted-foreground" : live ? "bg-bullish" : "bg-warning",
        )}
      />
      <span className="font-medium text-foreground">{live ? "Binance" : t("topBar.demo")}</span>
      <span className="num text-muted-foreground">
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} {offset}
      </span>
    </div>
  );
}

function MobileNav() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { isAuthed } = useAuth();
  const groups = visibleNavGroups(isAuthed);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          aria-label={t("topBar.menu")}
        >
          <Menu className="h-4 w-4" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 bg-sidebar p-5">
        <SheetTitle className="sr-only">{t("topBar.navigation")}</SheetTitle>
        <IqLogo />
        <nav className="mt-8 flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.groupKey}>
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {t(`nav.groups.${group.groupKey}`)}
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
                      {t(`nav.items.${item.labelKey}`)}
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
