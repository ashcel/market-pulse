import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/utils";

import { apiV1Fetch } from "../miniapp/api";

/**
 * Open Bybit positions, served by the separate tradeway-api (localhost:8100)
 * through `/api/v1/tradeway/positions`.
 *
 * That service does not exist yet, so "upstream down" is the expected state,
 * not an error path: a 503 renders as an offline card. Polls while mounted —
 * the tab is only mounted when it is the visible one.
 */

interface TradewayPosition {
  symbol: string;
  side?: string;
  size?: number | string;
  entryPrice?: number | string;
  markPrice?: number | string;
  unrealisedPnl?: number | string;
  unrealizedPnl?: number | string;
  leverage?: number | string;
}

interface PositionsResult {
  offline: boolean;
  detail?: string;
  positions: TradewayPosition[];
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The upstream shape is not pinned yet — accept a bare array or a wrapped one. */
function extractPositions(body: unknown): TradewayPosition[] {
  if (Array.isArray(body)) return body as TradewayPosition[];
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const key of ["positions", "data", "result"]) {
      const v = rec[key];
      if (Array.isArray(v)) return v as TradewayPosition[];
      if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).list)) {
        return (v as { list: TradewayPosition[] }).list;
      }
    }
  }
  return [];
}

async function fetchPositions(): Promise<PositionsResult> {
  const res = await apiV1Fetch("/api/v1/tradeway/positions");
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.status === 503) {
    const detail = (body as { detail?: string } | null)?.detail;
    return { offline: true, detail, positions: [] };
  }
  if (!res.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ?? `positions failed (${res.status})`,
    );
  }
  return { offline: false, positions: extractPositions(body) };
}

function PositionCard({ p }: { p: TradewayPosition }) {
  const pnl = num(p.unrealisedPnl ?? p.unrealizedPnl);
  const side = (p.side ?? "").toUpperCase();
  const isShort = side.startsWith("S");
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">{p.symbol}</span>
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              isShort
                ? "border-bearish/30 bg-bearish-soft text-bearish"
                : "border-bullish/30 bg-bullish-soft text-bullish",
            )}
          >
            {isShort ? "SHORT" : "LONG"}
          </span>
          {p.leverage != null && (
            <span className="text-[10px] text-muted-foreground">{p.leverage}x</span>
          )}
        </div>
        <span
          className={cn(
            "num text-sm font-semibold",
            pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-bullish" : "text-bearish",
          )}
        >
          {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
        <div>
          <div className="uppercase tracking-wider">Size</div>
          <div className="num text-foreground">{p.size ?? "—"}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider">Entry</div>
          <div className="num text-foreground">{p.entryPrice ?? "—"}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider">Mark</div>
          <div className="num text-foreground">{p.markPrice ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

export function PosisiTab() {
  const query = useQuery({
    queryKey: ["tradeway-positions"],
    queryFn: fetchPositions,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-surface" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Posisi tidak bisa dimuat.
        <div className="mt-1 text-[11px]">{(query.error as Error).message}</div>
      </div>
    );
  }

  const result = query.data!;

  if (result.offline) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm">
        <div className="font-medium">Tradeway API belum aktif</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Posisi Bybit akan muncul di sini begitu servisnya jalan (localhost:8100).
        </div>
      </div>
    );
  }

  if (result.positions.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Tidak ada posisi terbuka.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {result.positions.map((p, i) => (
        <PositionCard key={`${p.symbol}-${i}`} p={p} />
      ))}
    </div>
  );
}
