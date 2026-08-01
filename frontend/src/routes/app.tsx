import { createFileRoute } from "@tanstack/react-router";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

/**
 * The standalone Telegram Mini App shell, retired (docs/IMPLEMENTATION-PLAN.md
 * §3 Sprint 5 task 6: "Rute `/app` pensiun → redirect ke `/`").
 *
 * It was a second product: its own tabs, its own components, its own idea of
 * what Market Pulse is — which meant every feature had to be built twice or
 * exist in only one of them. There is now **one route tree**; inside Telegram
 * the ordinary app adapts itself (`hooks/useTelegramMiniApp.ts`: theme, safe
 * area, native BackButton/MainButton, and the initData login that used to live
 * in this file).
 *
 * The redirect is gated on NAV_V2 with everything else, so `NAV_V2=0` remains
 * the single-line rollback for the whole sprint. The body below is what a Mini
 * App user sees only in that rollback state — it points at the same place
 * rather than re-implementing the old shell, which is the point of retiring it.
 */
export const Route = createFileRoute("/app")({
  beforeLoad: () => redirectIfNavV2("/app"),
  component: RetiredMiniAppShell,
  ssr: false,
});

function RetiredMiniAppShell() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold tracking-tight">Halaman ini sudah pindah</h1>
      <p className="text-sm text-muted-foreground">
        Mini App sekarang memakai aplikasi yang sama dengan versi web — satu tampilan, satu alamat.
      </p>
      <a
        href="/"
        className="mt-2 inline-flex items-center justify-center rounded-md bg-info px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-info/90"
      >
        Buka Market Pulse
      </a>
    </div>
  );
}
