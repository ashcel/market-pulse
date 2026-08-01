import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  Link,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Sidebar } from "../components/features/sidebar";
import { TopBar } from "../components/features/top-bar";
import { BottomNav } from "../components/features/bottom-nav";
import { FloatingPnlWidget } from "../components/features/floating-pnl-widget";
import { ThemeSync } from "../components/features/theme-sync";
import { Toaster } from "../components/ui/sonner";
import { useLiveUniverseSubscription } from "../hooks/useLiveUniverseSubscription";
import { useWatchlistSync } from "../hooks/useTokenEvents";
import { useNotificationStream } from "../hooks/useNotificationStream";
import { useTriggerAlerts } from "../hooks/useTriggerAlerts";
import { usePreferencesSync } from "../hooks/usePreferencesSync";
import { useTelegramMiniApp } from "../hooks/useTelegramMiniApp";
import { CapSegmentModal } from "../components/features/cap-segment-modal";
import { useAiDeskStore } from "../stores/ai-desk";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="eyebrow">404</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-info px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-info/90"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong. Try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-info px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-info/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Market Pulse" },
      {
        name: "description",
        content:
          "Market Pulse is a capital-at-risk decision journal wrapped in a market-intelligence brief. Understand today's regime, capital rotation, and technical structure in under 10 seconds.",
      },
      { name: "author", content: "HeyDewi" },
      { property: "og:title", content: "Market Pulse" },
      {
        property: "og:description",
        content:
          "Market Pulse is a capital-at-risk decision journal wrapped in a market-intelligence brief. Understand today's market regime, capital rotation, and top assets before you trade.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "/market-pulse.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "/market-pulse.png" },
      { name: "theme-color", content: "#0e1015" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/market-pulse.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/market-pulse.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
    // Telegram Mini App SDK — injects window.Telegram.WebApp (incl. initData)
    // when the page is opened inside a Telegram webview. Without it the Mini
    // App cannot read initData and shows the "open in Telegram" gate even when
    // it IS opened from Telegram.
    scripts: [{ src: "https://telegram.org/js/telegram-web-app.js" }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

import { AskAiSidebar } from "../components/features/ask-ai-sidebar";

function RootContent() {
  useNotificationStream();
  useTriggerAlerts();
  useLiveUniverseSubscription();
  useWatchlistSync();
  usePreferencesSync();
  // Sprint 5: one route tree. Inside a Telegram webview this adapts the shell
  // (theme, safe area, native BackButton); outside it, it is a no-op and the
  // web app renders exactly as before. The old parallel `/app` shell retired.
  const miniApp = useTelegramMiniApp();
  const askAiOpen = useAiDeskStore((state) => state.open);
  const setAskAiOpen = useAiDeskStore((state) => state.setOpen);

  return (
    <>
      <ThemeSync />
      <Toaster position="top-right" />
      <CapSegmentModal />
      <div
        className="flex h-screen w-full bg-background overflow-hidden"
        style={
          miniApp
            ? {
                // Telegram's header/handle overlap a naive 100vh page, and its
                // stable height excludes the keyboard — both come from the SDK.
                height: "var(--tg-viewport-height, 100vh)",
                paddingTop: "var(--tg-safe-top, 0px)",
                paddingLeft: "var(--tg-safe-left, 0px)",
                paddingRight: "var(--tg-safe-right, 0px)",
              }
            : undefined
        }
      >
        {/* The client supplies its own back navigation and header, so the web
            chrome would be a second, redundant one inside the webview. */}
        {!miniApp && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!miniApp && <TopBar onToggleAskAi={() => setAskAiOpen(!askAiOpen)} />}
          <div className="flex flex-1 overflow-hidden">
            <main
              className="flex-1 overflow-y-auto px-4 pb-24 pt-4 sm:px-6 sm:pt-6 lg:pb-8"
              style={
                miniApp ? { paddingBottom: "calc(6rem + var(--tg-safe-bottom, 0px))" } : undefined
              }
            >
              <Outlet />
            </main>
            {!miniApp && <AskAiSidebar open={askAiOpen} onClose={() => setAskAiOpen(false)} />}
          </div>
        </div>
        <BottomNav />
      </div>
      {!miniApp && <FloatingPnlWidget />}
    </>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <RootContent />
    </QueryClientProvider>
  );
}
