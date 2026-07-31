import { Link, createFileRoute } from "@tanstack/react-router";
import { Activity, LayoutGrid, NotebookText, Wallet } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { MarketTab } from "@/components/features/miniapp/market-tab";
import {
  readTelegramInitData,
  telegramLogin,
  type TelegramMiniUser,
} from "@/components/features/miniapp/api";
import { PosisiTab } from "@/components/features/posisi/posisi-tab";
import { QuantFeed } from "@/components/features/quant/quant-feed";

/**
 * Telegram Mini App shell — one webview over market snapshot, quant signals,
 * Bybit positions and the journal.
 *
 * Rendered as a fixed full-viewport layer so it covers the web app's own
 * sidebar / top bar / bottom nav without touching the root layout: inside a
 * Telegram webview there is no room for two chromes, and the root shell is
 * shared by every other route.
 *
 * Auth is the whole gate. `window.Telegram.WebApp.initData` is the only
 * credential the webview has; exchanging it once yields the ordinary
 * `mp_session` cookie plus a bearer token, after which every existing endpoint
 * works unchanged. Outside Telegram initData is empty — the page then shows a
 * message and loads no data at all.
 */

export const Route = createFileRoute("/app")({
  component: MiniApp,
  ssr: false,
});

type TabId = "market" | "quant" | "posisi" | "journal";

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "market", label: "Market", icon: LayoutGrid },
  { id: "quant", label: "Quant", icon: Activity },
  { id: "posisi", label: "Posisi", icon: Wallet },
  { id: "journal", label: "Journal", icon: NotebookText },
];

type AuthState =
  | { status: "checking" }
  | { status: "outside" }
  | { status: "ready"; user: TelegramMiniUser }
  | { status: "denied"; message: string };

function MiniApp() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [tab, setTab] = useState<TabId>("market");

  useEffect(() => {
    let cancelled = false;
    const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
    tg?.ready?.();
    tg?.expand?.();

    const initData = readTelegramInitData();
    if (!initData) {
      setAuth({ status: "outside" });
      return;
    }

    telegramLogin(initData)
      .then((login) => {
        if (!cancelled) setAuth({ status: "ready", user: login.telegramUser });
      })
      .catch((err: Error) => {
        if (!cancelled) setAuth({ status: "denied", message: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Market Pulse
          </div>
          <div className="text-sm font-semibold tracking-tight">
            {auth.status === "ready" && auth.user.firstName
              ? `Halo, ${auth.user.firstName}`
              : "Mini App"}
          </div>
        </div>
        {auth.status === "ready" && (
          <span className="rounded-md border border-bullish/30 bg-bullish-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-bullish">
            live
          </span>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-3 pb-24 pt-3">
        {auth.status === "checking" && <div className="h-24 animate-pulse rounded-lg bg-surface" />}

        {auth.status === "outside" && (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm">
            Buka lewat Telegram Mini App.
          </div>
        )}

        {auth.status === "denied" && (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="font-medium">Akses ditolak</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{auth.message}</div>
          </div>
        )}

        {auth.status === "ready" && (
          <>
            {tab === "market" && <MarketTab />}
            {tab === "quant" && <QuantFeed />}
            {tab === "posisi" && <PosisiTab />}
            {tab === "journal" && <JournalTab />}
          </>
        )}
      </main>

      <nav className="border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] pt-1">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                disabled={auth.status !== "ready"}
                className={cn(
                  "flex min-h-11 min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-40",
                  active ? "text-info" : "text-muted-foreground",
                )}
              >
                <t.icon className={cn("h-5 w-5", active && "stroke-[2.4]")} />
                <span className={cn(active && "font-bold")}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** The journal is a full page of its own; the session cookie the Mini App just
 * minted is what makes it open authenticated. */
function JournalTab() {
  return (
    <div className="flex flex-col gap-2">
      <Link
        to="/journal"
        className="rounded-lg border border-border bg-surface p-4 text-sm font-medium"
      >
        Buka Decision Journal →
      </Link>
      <Link
        to="/tracker"
        className="rounded-lg border border-border bg-surface p-4 text-sm font-medium"
      >
        Buka Tracker →
      </Link>
      <p className="px-1 text-[11px] text-muted-foreground">
        Halaman penuh terbuka di luar shell Mini App — sesi kamu sudah aktif, tidak perlu login
        lagi.
      </p>
    </div>
  );
}
