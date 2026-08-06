import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Trash2, TrendingDown, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useForwardTestRecord } from "@/hooks/useForwardTestRecord";
import { useForwardTestRecords } from "@/hooks/useForwardTestRecords";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTrackedFollows, useUnfollowSignal } from "@/hooks/useTrackedFollows";
import { buildCandidates, runAiWithFallback } from "@/lib/ai/chain";
import { INTENTS } from "@/lib/engine/intent";
import {
  evaluateTrackedSignal,
  isTerminalStatus,
  summarizeTrackedSignals,
  type TrackedSignal,
  type TrackedSignalStatus,
} from "@/lib/engine/tracker";
import {
  MIN_SHADOW_RECORD_TRADES,
  summarizeShadowRecord,
  type ShadowRecordSummary,
  type ShadowSignal,
  type ShadowSignalStatus,
} from "@/lib/engine/shadow";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { formatEntryRange, formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { requireSession } from "@/lib/auth/guard";

const PAGE_SIZE = 10;

function humanize(value: string): string {
  return value
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export const Route = createFileRoute("/tracker")({
  beforeLoad: () => requireSession("/tracker"),
  head: () => ({
    meta: [
      { title: "Signal Tracker — Market Pulse" },
      {
        name: "description",
        content: "Forward-test the signals you've followed against live price.",
      },
      { property: "og:title", content: "Signal Tracker — Market Pulse" },
      {
        property: "og:description",
        content: "No backtest hindsight — just what actually happened after you followed a call.",
      },
    ],
  }),
  component: TrackerPage,
});

const STATUS_LABEL_KEY: Record<TrackedSignalStatus, string> = {
  active: "statusActive",
  "target1-hit": "statusTarget1Hit",
  "target2-hit": "statusTarget2Hit",
  "stopped-out": "statusStoppedOut",
};

const STATUS_TONE: Record<TrackedSignalStatus, string> = {
  active: "border-info/30 bg-info-soft text-info",
  "target1-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "target2-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "stopped-out": "border-bearish/30 bg-bearish-soft text-bearish",
};

const SHADOW_STATUS_LABEL_KEY: Record<ShadowSignalStatus, string> = {
  active: "statusActive",
  "target1-hit": "statusTarget1Hit",
  "target2-hit": "statusTarget2Hit",
  "stopped-out": "statusStoppedOut",
  expired: "statusExpired",
};

const SHADOW_STATUS_TONE: Record<ShadowSignalStatus, string> = {
  active: "border-info/30 bg-info-soft text-info",
  "target1-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "target2-hit": "border-bullish/30 bg-bullish-soft text-bullish",
  "stopped-out": "border-bearish/30 bg-bearish-soft text-bearish",
  expired: "border-border bg-surface text-muted-foreground",
};

type Filter = "all" | "open" | "closed";

const FILTERS: { labelKey: string; value: Filter }[] = [
  { labelKey: "filterAll", value: "all" },
  { labelKey: "filterOpen", value: "open" },
  { labelKey: "filterClosed", value: "closed" },
];

const INTENT_LABEL = new Map(INTENTS.map((def) => [def.intent, def.label]));

/** Client-side page slice — both lists here are already fully fetched (no server-side paging in the underlying hooks). */
function usePageSlice<T>(items: T[], page: number, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), totalPages, clampedPage };
}

function Pager({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {t("tracker.pagerPrev")}
      </Button>
      <span className="text-xs text-muted-foreground">
        {t("tracker.pagerPage", { page, total: totalPages })}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        {t("tracker.pagerNext")}
      </Button>
    </div>
  );
}

function TrackerPage() {
  const { t } = useTranslation();
  const { data: records = [] } = useForwardTestRecords();
  const { follows: signals, authenticated } = useTrackedFollows();
  const [filter, setFilter] = useState<Filter>("all");
  const summary = summarizeTrackedSignals(signals);

  const autoFiltered = records.filter((r) => {
    if (filter === "open") return r.status === "active";
    if (filter === "closed") return r.status !== "active";
    return true;
  });

  const filtered = signals.filter((s) => {
    if (filter === "open") return !isTerminalStatus(s.status);
    if (filter === "closed") return isTerminalStatus(s.status);
    return true;
  });

  const [autoPage, setAutoPage] = useState(1);
  const [followPage, setFollowPage] = useState(1);

  // Filters apply to both lists — jump both back to page 1 when they change,
  // otherwise a filter switch can strand the viewer on a now-empty page.
  useEffect(() => {
    setAutoPage(1);
    setFollowPage(1);
  }, [filter]);

  const autoSlice = usePageSlice(autoFiltered, autoPage);
  const followSlice = usePageSlice(filtered, followPage);

  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow={t("tracker.eyebrow")}
        title={t("tracker.title")}
        subtitle={t("tracker.subtitle")}
      />

      <TrackerMetricsCard records={records} summary={summarizeShadowRecord(records)} />

      <EngineRecord />

      <div className="flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-info/30 bg-info-soft text-info"
                : "border-border bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`tracker.${f.labelKey}`)}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 pt-1">
        <CardEyebrow>{t("tracker.autoTrackedEyebrow")}</CardEyebrow>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t("tracker.autoTrackedNote")}</p>

      {records.length === 0 ? (
        <IqCard className="text-center text-sm text-muted-foreground">
          {t("tracker.noFavoredVerdicts")}
        </IqCard>
      ) : autoFiltered.length === 0 ? (
        <IqCard className="text-center text-sm text-muted-foreground">
          {t("tracker.noSignalsMatchFilter")}
        </IqCard>
      ) : (
        <div className="space-y-2.5">
          {autoSlice.pageItems.map((signal) => (
            <AutoTrackedSignalRow key={signal.id} signal={signal} />
          ))}
          <Pager
            page={autoSlice.clampedPage}
            totalPages={autoSlice.totalPages}
            onPageChange={setAutoPage}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-1">
        <CardEyebrow>{t("tracker.followedEyebrow")}</CardEyebrow>
      </div>

      <IqCard className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label={t("tracker.statFollowed")} value={String(summary.total)} />
        <StatTile label={t("tracker.statOpen")} value={String(summary.open)} />
        <StatTile
          label={t("tracker.statWinRate")}
          value={summary.closed ? `${summary.winRate}%` : "—"}
          tone={summary.closed ? (summary.winRate >= 50 ? "bullish" : "bearish") : undefined}
        />
        <StatTile
          label={t("tracker.statAvgRClosed")}
          value={summary.closed ? `${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R` : "—"}
          tone={summary.closed ? (summary.averageR >= 0 ? "bullish" : "bearish") : undefined}
        />
      </IqCard>
      {summary.lowSample && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("tracker.lowSampleNote", { count: summary.closed })}
        </p>
      )}

      {!authenticated && signals.length === 0 ? (
        <IqCard className="space-y-2 text-center text-sm text-muted-foreground">
          <p>{t("tracker.followsServerNote")}</p>
          <p>
            <Link to="/login" className="font-medium text-info underline-offset-2 hover:underline">
              {t("common.signIn")}
            </Link>{" "}
            {t("tracker.signInToFollowSuffix")}
          </p>
        </IqCard>
      ) : filtered.length === 0 ? (
        <IqCard className="text-center text-sm text-muted-foreground">
          {signals.length === 0 ? t("tracker.noFollowsYet") : t("tracker.noSignalsMatchFilter")}
        </IqCard>
      ) : (
        <div className="space-y-2.5">
          {followSlice.pageItems.map((signal) => (
            <TrackedSignalRow key={signal.id} signal={signal} />
          ))}
          <Pager
            page={followSlice.clampedPage}
            totalPages={followSlice.totalPages}
            onPageChange={setFollowPage}
          />
        </div>
      )}
    </div>
  );
}

interface TrackerMetrics {
  opened: number;
  closed: number;
  total: number;
  /** Mean realized R across closed (terminal) auto-tracked signals — null when there are none yet. */
  currentRR: number | null;
  winRate: number | null;
  bestTrade: ShadowSignal | null;
}

function computeTrackerMetrics(
  records: ShadowSignal[],
  summary: ShadowRecordSummary,
): TrackerMetrics {
  const bestTrade = records
    .filter((s) => s.status !== "active" && typeof s.resultR === "number")
    .reduce<ShadowSignal | null>((best, s) => {
      if (!best) return s;
      return (s.resultR ?? -Infinity) > (best.resultR ?? -Infinity) ? s : best;
    }, null);

  return {
    opened: summary.open,
    closed: summary.closed,
    total: summary.total,
    currentRR: summary.closed ? summary.averageR : null,
    winRate: summary.closed ? summary.winRate : null,
    bestTrade,
  };
}

/**
 * Top-of-page metrics summary — 6 tiles computed entirely from the engine's
 * auto-tracked forward-test signals (`ShadowSignal`s, the "Signals the Engine
 * Is Tracking" list), never from the user's own follows or a Binance/exchange
 * account. The 6th tile (edge verdict) is the only AI-backed one and is
 * generated on demand, not on mount.
 */
function TrackerMetricsCard({
  records,
  summary,
}: {
  records: ShadowSignal[];
  summary: ShadowRecordSummary;
}) {
  const { t } = useTranslation();
  const metrics = computeTrackerMetrics(records, summary);
  const bestTradeLabel = metrics.bestTrade
    ? `${metrics.bestTrade.symbol} ${(metrics.bestTrade.resultR ?? 0) >= 0 ? "+" : ""}${metrics.bestTrade.resultR}R`
    : "—";

  return (
    <IqCard className="space-y-3">
      <CardEyebrow>{t("tracker.autoTrackMetricsEyebrow")}</CardEyebrow>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile label={t("tracker.statOpenedTrades")} value={String(metrics.opened)} />
        <StatTile label={t("tracker.statClosedTrades")} value={String(metrics.closed)} />
        <StatTile label={t("tracker.statTotalTrades")} value={String(metrics.total)} />
        <StatTile
          label={t("tracker.statCurrentRR")}
          value={
            metrics.currentRR !== null
              ? `${metrics.currentRR >= 0 ? "+" : ""}${metrics.currentRR}R`
              : "—"
          }
          tone={
            metrics.currentRR !== null
              ? metrics.currentRR >= 0
                ? "bullish"
                : "bearish"
              : undefined
          }
        />
        <StatTile
          label={t("tracker.statBestTrade")}
          value={bestTradeLabel}
          tone={
            metrics.bestTrade
              ? (metrics.bestTrade.resultR ?? 0) >= 0
                ? "bullish"
                : "bearish"
              : undefined
          }
        />
        <EdgeVerdictTile metrics={metrics} />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("tracker.computedNote")}</p>
    </IqCard>
  );
}

/** The one AI-backed tile — fires only on button click, result cached in state, never auto-refetched. */
function EdgeVerdictTile({ metrics }: { metrics: TrackerMetrics }) {
  const { t } = useTranslation();
  const [verdict, setVerdict] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiProvider = useAiSettingsStore((s) => s.provider);
  const aiApiKeys = useAiSettingsStore((s) => s.apiKeys);
  const aiModels = useAiSettingsStore((s) => s.models);
  const aiCustomBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);
  const aiSettings = useMemo(
    () => ({
      provider: aiProvider,
      apiKeys: aiApiKeys,
      models: aiModels,
      customBaseUrl: aiCustomBaseUrl,
    }),
    [aiProvider, aiApiKeys, aiModels, aiCustomBaseUrl],
  );
  const aiReady = useMemo(() => buildCandidates(aiSettings).length > 0, [aiSettings]);

  const generateVerdict = async () => {
    if (!aiReady || loading) return;
    setLoading(true);
    setError(null);
    try {
      const system =
        "You are a terse trading coach reviewing the engine's auto-tracked forward-test record. " +
        "Reply with exactly one short sentence (max ~25 words) verdicting whether the engine's edge is " +
        "working, marginal, or broken right now, and the single main reason why. No hedging, no " +
        "markdown, no preamble — just the sentence.";
      const bestTradeText = metrics.bestTrade
        ? `${metrics.bestTrade.symbol} at ${(metrics.bestTrade.resultR ?? 0) >= 0 ? "+" : ""}${metrics.bestTrade.resultR}R`
        : "none closed yet";
      const content =
        `Track record: ${metrics.total} total auto-tracked signals, ${metrics.opened} still open, ` +
        `${metrics.closed} closed. Win rate: ` +
        `${metrics.winRate !== null ? `${metrics.winRate}%` : "n/a (no closed trades yet)"}. ` +
        `Average R on closed trades: ` +
        `${metrics.currentRR !== null ? `${metrics.currentRR >= 0 ? "+" : ""}${metrics.currentRR}R` : "n/a"}. ` +
        `Best trade: ${bestTradeText}.`;
      const completion = await runAiWithFallback({
        settings: aiSettings,
        system,
        messages: [{ role: "user", content }],
        maxTokens: 120,
      });
      setVerdict(completion.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("tracker.verdictGenerationFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="col-span-2 rounded-lg border border-border bg-surface p-2.5 sm:col-span-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("tracker.currentBestEdgeVerdict")}
        </div>
        {aiReady && (
          <button
            onClick={generateVerdict}
            disabled={loading}
            className="shrink-0 rounded-md border border-info/30 bg-info-soft px-2 py-0.5 text-[10px] font-medium text-info transition-colors hover:bg-info-soft/80 disabled:opacity-50"
          >
            {loading
              ? t("tracker.generating")
              : verdict
                ? t("tracker.regenerate")
                : t("tracker.generateVerdict")}
          </button>
        )}
      </div>

      {!aiReady ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("tracker.addAiKeyPrefix")}{" "}
          <Link to="/settings" className="font-medium text-info underline-offset-2 hover:underline">
            {t("common.settings")}
          </Link>{" "}
          {t("tracker.addAiKeySuffix")}
        </p>
      ) : error ? (
        <p className="mt-1 text-[11px] text-bearish">{error}</p>
      ) : verdict ? (
        <p className="mt-1 text-xs leading-relaxed">{verdict}</p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("tracker.tapGenerateVerdict")}</p>
      )}
    </div>
  );
}

function EngineRecord() {
  const { t } = useTranslation();
  const { data: forwardTest } = useForwardTestRecord();
  const summary = forwardTest?.shadow.summary;
  const combos = forwardTest?.shadow.combos ?? [];

  if (!summary) return null;

  return (
    <IqCard className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>{t("tracker.liveRecordEyebrow")}</CardEyebrow>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("tracker.liveRecordNotePrefix")}{" "}
            <span className="font-semibold">{t("tracker.liveRecordNoteFavored")}</span>{" "}
            {t("tracker.liveRecordNoteSuffix")}
          </p>
        </div>
      </div>

      {summary.total === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-3 text-xs text-muted-foreground">
          {t("tracker.noFavoredVerdictsOwnRecord")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label={t("tracker.statCallsMade")} value={String(summary.total)} />
            <StatTile label={t("tracker.statStillOpen")} value={String(summary.open)} />
            <StatTile
              label={t("tracker.statWinRate")}
              value={summary.closed ? `${summary.winRate}%` : "—"}
              tone={summary.closed ? (summary.winRate >= 50 ? "bullish" : "bearish") : undefined}
            />
            <StatTile
              label={t("tracker.statAvgRSettled")}
              value={
                summary.closed ? `${summary.averageR >= 0 ? "+" : ""}${summary.averageR}R` : "—"
              }
              tone={summary.closed ? (summary.averageR >= 0 ? "bullish" : "bearish") : undefined}
            />
          </div>

          {summary.lowSample && (
            <p className="text-[11px] text-muted-foreground">
              {t("tracker.lowSampleSettledNote", {
                count: summary.closed,
                minTrades: MIN_SHADOW_RECORD_TRADES,
              })}
            </p>
          )}

          {combos.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("tracker.bySetupRegime")}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="pb-1.5 pr-2 font-semibold">{t("tracker.colSetup")}</th>
                      <th className="pb-1.5 pr-2 font-semibold">{t("tracker.colRegime")}</th>
                      <th className="pb-1.5 pr-2 text-right font-semibold">
                        {t("tracker.colSettled")}
                      </th>
                      <th className="pb-1.5 pr-2 text-right font-semibold">
                        {t("tracker.colWin")}
                      </th>
                      <th className="pb-1.5 text-right font-semibold">{t("tracker.colAvgR")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combos.map((combo) => (
                      <tr
                        key={`${combo.setupType}|${combo.regime}`}
                        className="border-t border-border/60"
                      >
                        <td className="py-1.5 pr-2 font-medium">
                          <span className="flex items-center gap-1.5">
                            {humanize(combo.setupType)}
                            {combo.demoted && (
                              <Badge
                                variant="outline"
                                className="border-warning/30 bg-warning-soft px-1 py-0 text-[9px] text-warning"
                              >
                                {t("tracker.demoted")}
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-muted-foreground">
                          {humanize(combo.regime)}
                        </td>
                        <td className="num py-1.5 pr-2 text-right text-muted-foreground">
                          {combo.closed}
                        </td>
                        <td className="num py-1.5 pr-2 text-right">{combo.winRate}%</td>
                        <td
                          className={cn(
                            "num py-1.5 text-right font-semibold",
                            combo.averageR >= 0 ? "text-bullish" : "text-bearish",
                          )}
                        >
                          {combo.averageR >= 0 ? "+" : ""}
                          {combo.averageR}R
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </IqCard>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bullish" | "bearish";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "num mt-0.5 text-sm font-semibold",
          tone === "bullish" && "text-bullish",
          tone === "bearish" && "text-bearish",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * The engine's own auto-recorded favored call — same visual language as
 * `TrackedSignalRow` (below), adapted for `ShadowSignal`'s shape: a single
 * `entry` (no ideal zone), no follow-time confidence, and no unfollow action
 * since this record isn't owned by the viewer. Live price/unrealized R is
 * display-only, exactly like the followed rows — the settled record itself
 * only ever comes from the worker.
 */
function AutoTrackedSignalRow({ signal }: { signal: ShadowSignal }) {
  const { t } = useTranslation();
  const terminal = signal.status !== "active";
  const live = useLivePrice(signal.symbol, !terminal, signal.market);

  const long = signal.direction === "long";
  const currentPrice = live?.price ?? signal.closePrice ?? signal.entry;

  let liveR: number | null = null;
  if (signal.status === "active") {
    const riskPerUnit = Math.abs(signal.entry - signal.stop);
    if (riskPerUnit > 0) {
      const raw = long
        ? (currentPrice - signal.entry) / riskPerUnit
        : (signal.entry - currentPrice) / riskPerUnit;
      liveR = Math.round(raw * 100) / 100;
    }
  }

  return (
    <IqCard className="flex flex-wrap items-center gap-3 p-3">
      <AssetIcon ticker={signal.symbol} className="h-8 w-8 text-sm" />
      <div className="min-w-[110px] flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{signal.symbol}</span>
          {long ? (
            <TrendingUp className="h-3.5 w-3.5 text-bullish" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-bearish" />
          )}
          <span className="text-xs text-muted-foreground">
            {INTENT_LABEL.get(signal.intent) ?? signal.intent} · {signal.timeframe}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t("tracker.recorded", { date: new Date(signal.openedAt).toLocaleString() })}
        </div>
      </div>

      <Badge variant="outline" className={cn("shrink-0", SHADOW_STATUS_TONE[signal.status])}>
        {t(`tracker.${SHADOW_STATUS_LABEL_KEY[signal.status]}`)}
      </Badge>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label={t("tracker.entry")} value={formatMoney(signal.entry)} />
        <Metric label={t("tracker.stop")} value={formatMoney(signal.stop)} />
        <Metric label={t("tracker.target1")} value={formatMoney(signal.target1)} />
        <Metric label={t("tracker.target2")} value={formatMoney(signal.target2)} />
        <Metric
          label={terminal ? t("tracker.closedAt") : t("tracker.current")}
          value={formatMoney(terminal ? (signal.closePrice ?? currentPrice) : currentPrice)}
        />
        <Metric
          label={terminal ? t("tracker.result") : t("tracker.unrealized")}
          value={
            terminal
              ? signal.resultR !== undefined
                ? `${signal.resultR >= 0 ? "+" : ""}${signal.resultR}R`
                : "—"
              : liveR !== null
                ? `${liveR >= 0 ? "+" : ""}${liveR}R`
                : "—"
          }
        />
      </div>
    </IqCard>
  );
}

function TrackedSignalRow({ signal: serverSignal }: { signal: TrackedSignal }) {
  const { t } = useTranslation();
  const unfollow = useUnfollowSignal();
  const serverTerminal = isTerminalStatus(serverSignal.status);
  const live = useLivePrice(serverSignal.symbol, !serverTerminal, serverSignal.market ?? "spot");

  // Display-only: a live tick through a level shows the exit immediately, but
  // the record itself is settled by the worker against real candle highs/lows
  // — the provisional read is never written anywhere.
  const provisional =
    !serverTerminal && live?.price
      ? evaluateTrackedSignal(serverSignal, live.price, new Date().toISOString())
      : null;
  const signal = provisional ? { ...serverSignal, ...provisional } : serverSignal;
  const terminal = isTerminalStatus(signal.status);

  const long = signal.direction === "long";
  const currentPrice = live?.price ?? signal.closePrice ?? signal.entryPrice;

  let liveR: number | null = null;
  if (signal.status === "active") {
    const riskPerUnit = Math.abs(signal.entryPrice - signal.stop);
    if (riskPerUnit > 0) {
      const raw = long
        ? (currentPrice - signal.entryPrice) / riskPerUnit
        : (signal.entryPrice - currentPrice) / riskPerUnit;
      liveR = Math.round(raw * 100) / 100;
    }
  }

  return (
    <IqCard className="flex flex-wrap items-center gap-3 p-3">
      <AssetIcon ticker={signal.symbol} className="h-8 w-8 text-sm" />
      <div className="min-w-[110px] flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{signal.symbol}</span>
          {long ? (
            <TrendingUp className="h-3.5 w-3.5 text-bullish" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-bearish" />
          )}
          <span className="text-xs text-muted-foreground">
            {INTENT_LABEL.get(signal.intent) ?? signal.intent} · {signal.timeframe}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t("tracker.followedAt", { date: new Date(signal.followedAt).toLocaleString() })}
        </div>
      </div>

      <Badge variant="outline" className={cn("shrink-0", STATUS_TONE[signal.status])}>
        {t(`tracker.${STATUS_LABEL_KEY[signal.status]}`)}
        {provisional ? t("tracker.settlingSuffix") : ""}
      </Badge>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Metric label={t("tracker.entry")} value={formatMoney(signal.entryPrice)} />
        <Metric
          label={t("tracker.idealZoneWas")}
          value={formatEntryRange(signal.entryLow, signal.entryHigh)}
        />
        <Metric label={t("tracker.stop")} value={formatMoney(signal.stop)} />
        <Metric label={t("tracker.target1")} value={formatMoney(signal.target1)} />
        <Metric label={t("tracker.target2")} value={formatMoney(signal.target2)} />
        <Metric
          label={terminal ? t("tracker.closedAt") : t("tracker.current")}
          value={formatMoney(terminal ? (signal.closePrice ?? currentPrice) : currentPrice)}
        />
        <Metric
          label={terminal ? t("tracker.result") : t("tracker.unrealized")}
          value={
            terminal
              ? signal.resultR !== undefined
                ? `${signal.resultR >= 0 ? "+" : ""}${signal.resultR}R`
                : "—"
              : liveR !== null
                ? `${liveR >= 0 ? "+" : ""}${liveR}R`
                : "—"
          }
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto shrink-0 text-muted-foreground hover:text-bearish"
        onClick={() => unfollow.mutate(signal.id)}
        disabled={unfollow.isPending}
        aria-label={t("tracker.removeFromTracker", { symbol: signal.symbol })}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </IqCard>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}
