import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { useDecisions, type DecisionSnapshot } from "@/hooks/useDecisions";
import { useForensicsList } from "@/hooks/useForensics";
import { useScorecard, type ScorecardRow, type SourceSummary } from "@/hooks/useScorecard";
import { cn } from "@/lib/utils";

/**
 * Lab — the evidence tab (docs/IMPLEMENTATION-PLAN.md §3 Sprint 5 task 3).
 *
 * Three questions, in the order they are worth asking:
 *   1. Does a signal source actually work? (`source_scorecard`)
 *   2. What did I decide, and why did I skip? (`decisions.skip_reason`)
 *   3. How did the trades I took actually behave? (existing forensics)
 *
 * The one rule the whole page obeys: a number is either earned or absent.
 * Under `min_n` settled signals there is no hit-rate to show, so the card says
 * "Belum cukup data" — never 0%, never a small percentage that reads as
 * measured (Risiko R3).
 */

export const Route = createFileRoute("/lab")({ component: LabPage });

const SKIP_REASON_LABEL: Record<string, string> = {
  invalid: "setup tidak valid",
  late: "sudah telat",
  no_conviction: "kurang yakin",
  risk: "risiko terlalu besar",
};

const SOURCE_LABEL: Record<string, string> = {
  quant: "Quant",
  smc: "SMC",
  tradeway: "Tradeway",
};

function sourceName(source: string): string {
  return SOURCE_LABEL[source] ?? source.toUpperCase();
}

function percent(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(0)}%`;
}

function signedR(value: number | null): string | null {
  return value === null ? null : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

/** Skips inside the trailing 7 days — Journey E's window. */
function skipsThisWeek(decisions: DecisionSnapshot[], now = Date.now()): DecisionSnapshot[] {
  const since = now - 7 * 24 * 60 * 60 * 1000;
  return decisions.filter((decision) => {
    if (decision.user_action !== "accepted_skip" && decision.user_action !== "rejected_skip")
      return false;
    const at = Date.parse(decision.decided_at ?? decision.created_at);
    return Number.isFinite(at) && at >= since;
  });
}

function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const acc = new Map<string, number>();
  for (const item of items) acc.set(key(item), (acc.get(key(item)) ?? 0) + 1);
  return [...acc.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The Journey E sentence: "minggu ini kamu lewati 6 setup dari sumber hit-rate
 * 61%". Returns null when either half is missing — an unearned hit-rate must
 * not be invented to complete a sentence, and "kamu lewati 0 setup" is not
 * worth a card.
 */
function journeyLine(skips: number, best: SourceSummary | undefined): string | null {
  if (skips === 0) return null;
  if (!best || best.status !== "ok" || best.hit_rate === null) {
    return `Minggu ini kamu lewati ${skips} setup. Track record sumbernya belum cukup untuk menilai apakah itu benar.`;
  }
  return `Minggu ini kamu lewati ${skips} setup dari sumber ${sourceName(best.source)} yang hit-rate-nya ${percent(best.hit_rate)} (${best.n} sinyal, ${best.window_days} hari).`;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function SourceCard({ summary, rows }: { summary: SourceSummary; rows: ScorecardRow[] }) {
  const slices = rows
    .filter((row) => row.source === summary.source)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  return (
    <IqCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>Sumber</CardEyebrow>
          <h3 className="mt-1 text-lg font-bold">{sourceName(summary.source)}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {summary.horizons.join(" · ")} · versi {summary.versions.join(", ")}
          </p>
        </div>
        {summary.status === "ok" ? (
          <div className="text-right">
            <div className="num text-2xl font-bold">{percent(summary.hit_rate)}</div>
            <div className="text-[11px] text-muted-foreground">
              {signedR(summary.avg_r)} · {summary.n} sinyal / {summary.window_days} hari
            </div>
          </div>
        ) : (
          <Badge variant="outline" className="border-warning/40 text-warning">
            Belum cukup data
          </Badge>
        )}
      </div>

      {summary.status !== "ok" && (
        <p className="mt-3 text-sm text-muted-foreground">
          {summary.n} sinyal sudah ter-settle. Angka ditampilkan setelah cukup sampel.
        </p>
      )}

      {slices.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Per regime &amp; horizon
          </div>
          {slices.map((row) => (
            <div
              key={`${row.source_version}-${row.regime}-${row.horizon}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <span className="truncate">
                {row.regime} · {row.horizon}
              </span>
              <span
                className={cn(
                  "num shrink-0 text-xs",
                  row.status === "ok" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {row.status === "ok"
                  ? `${percent(row.hit_rate)} · ${signedR(row.avg_r)} · n=${row.n}`
                  : `n=${row.n} · belum cukup`}
              </span>
            </div>
          ))}
        </div>
      )}
    </IqCard>
  );
}

function LabPage() {
  const scorecard = useScorecard();
  const { decisions, isLoading: decisionsLoading } = useDecisions();
  const forensics = useForensicsList(1, 10);

  const rows = scorecard.data?.data ?? [];
  const meta = scorecard.data?.meta;
  const bySource = meta?.by_source ?? [];

  const weekSkips = useMemo(() => skipsThisWeek(decisions), [decisions]);
  const skipReasons = useMemo(
    () => countBy(weekSkips, (decision) => decision.skip_reason ?? "tanpa alasan"),
    [weekSkips],
  );
  const headline = journeyLine(weekSkips.length, bySource[0]);

  const recentDecisions = useMemo(
    () =>
      [...decisions]
        .sort(
          (a, b) =>
            Date.parse(b.decided_at ?? b.created_at) - Date.parse(a.decided_at ?? a.created_at),
        )
        .slice(0, 12),
    [decisions],
  );

  const forensicsRows = forensics.data?.data ?? [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <CardEyebrow>Lab</CardEyebrow>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Bukti</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Apakah sumbernya benar, apa yang kamu putuskan, dan bagaimana hasilnya.
        </p>
      </header>

      {headline && (
        <IqCard className="border-info/30">
          <CardEyebrow>Minggu ini</CardEyebrow>
          <p className="mt-1 text-sm">{headline}</p>
          {skipReasons.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {skipReasons.map(([reason, count]) => (
                <Badge key={reason} variant="outline" className="text-[11px]">
                  {SKIP_REASON_LABEL[reason] ?? reason} · {count}
                </Badge>
              ))}
            </div>
          )}
        </IqCard>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Track record sumber
        </h2>
        {scorecard.isLoading ? (
          <EmptyNote>Memuat…</EmptyNote>
        ) : bySource.length === 0 ? (
          <IqCard>
            <EmptyNote>
              {meta?.enabled === false
                ? "Perhitungan track record belum diaktifkan. Sinyal tetap direkam; angkanya muncul setelah pass harian jalan."
                : "Belum ada sinyal yang selesai dinilai. Angka muncul setelah setup pertama tuntas."}
            </EmptyNote>
          </IqCard>
        ) : (
          bySource.map((summary) => (
            <SourceCard key={summary.source} summary={summary} rows={rows} />
          ))
        )}
        {meta && meta.live_sources.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Sumber yang tampil di Ideas: {meta.live_sources.map(sourceName).join(", ")}. Sumber lain
            masih direkam diam-diam sampai track record-nya cukup.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Riwayat keputusan
        </h2>
        {decisionsLoading ? (
          <EmptyNote>Memuat…</EmptyNote>
        ) : recentDecisions.length === 0 ? (
          <IqCard>
            <EmptyNote>Belum ada keputusan tercatat.</EmptyNote>
          </IqCard>
        ) : (
          <IqCard padded={false}>
            <ul className="divide-y divide-border">
              {recentDecisions.map((decision) => (
                <li key={decision.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{decision.symbol}</span>
                      <Badge
                        className={cn(
                          "text-[10px] uppercase",
                          decision.direction === "long"
                            ? "bg-bullish-soft text-bullish"
                            : "bg-bearish-soft text-bearish",
                        )}
                      >
                        {decision.direction === "long" ? "Naik" : "Turun"}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {decision.objective}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {decision.user_action ?? "belum diputuskan"}
                      {decision.skip_reason
                        ? ` · ${SKIP_REASON_LABEL[decision.skip_reason] ?? decision.skip_reason}`
                        : ""}
                    </div>
                  </div>
                  <time className="shrink-0 text-[11px] text-muted-foreground">
                    {new Date(decision.decided_at ?? decision.created_at).toLocaleDateString(
                      "id-ID",
                      { day: "numeric", month: "short" },
                    )}
                  </time>
                </li>
              ))}
            </ul>
          </IqCard>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Forensik trade
        </h2>
        {forensics.isLoading ? (
          <EmptyNote>Memuat…</EmptyNote>
        ) : forensicsRows.length === 0 ? (
          <IqCard>
            <EmptyNote>Belum ada trade yang dianalisis.</EmptyNote>
          </IqCard>
        ) : (
          <IqCard padded={false}>
            <ul className="divide-y divide-border">
              {forensicsRows.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{row.binance_trade_id}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1.5">
                      {row.discipline_breach && (
                        <Badge
                          variant="outline"
                          className="border-bearish/40 text-bearish text-[10px]"
                        >
                          stop dilanggar
                        </Badge>
                      )}
                      {row.stop_evidence === "absent" && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          tanpa bukti stop
                        </Badge>
                      )}
                      {row.reentry_after_loss && (
                        <Badge
                          variant="outline"
                          className="border-warning/40 text-warning text-[10px]"
                        >
                          masuk lagi setelah rugi
                        </Badge>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    v{row.forensics_version}
                  </span>
                </li>
              ))}
            </ul>
          </IqCard>
        )}
      </section>
    </main>
  );
}
