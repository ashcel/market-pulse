import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/iq/page-header";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { useUiStore } from "@/stores/ui";
import { useWatchlistStore } from "@/stores/watchlist";
import { usePreferencesStore } from "@/stores/preferences";
import { Sun, Moon, Star, X, Check, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StopMethod } from "@/lib/engine/quant";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — IQ" },
      { name: "description", content: "Manage your IQ preferences, watchlist, and notifications." },
      { property: "og:title", content: "Settings — IQ" },
      { property: "og:description", content: "Tune IQ to your workflow." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { theme, toggleTheme } = useUiStore();
  const watchlist = useWatchlistStore();
  const prefs = usePreferencesStore();

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        subtitle="Preferences, watchlist, and notifications."
      />

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>Theme</CardEyebrow>
        <div className="flex gap-2">
          {(["dark", "light"] as const).map((t) => (
            <button
              key={t}
              onClick={() => (t !== theme ? toggleTheme() : null)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-colors",
                theme === t
                  ? "border-info bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              {t === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </IqCard>

      <IqCard className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <CardEyebrow>Watchlist</CardEyebrow>
          <span className="text-xs text-muted-foreground">{watchlist.tickers.length} assets</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {watchlist.tickers.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium"
            >
              <Star className="h-3 w-3 fill-warning text-warning" />
              {t}
              <button
                onClick={() => watchlist.toggle(t)}
                className="text-muted-foreground hover:text-bearish"
                aria-label={`Remove ${t}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {watchlist.tickers.length === 0 && (
            <p className="text-xs text-muted-foreground">Add favorites from the Rankings page.</p>
          )}
        </div>
      </IqCard>

      <TradeRiskCard />

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>Notifications</CardEyebrow>
        {(
          [
            ["regime", "Regime change alerts"],
            ["rotation", "Capital rotation shifts"],
            ["highImpactNews", "High-impact news"],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3"
          >
            <span className="text-sm">{label}</span>
            <button
              onClick={() => prefs.toggleNotification(key)}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                prefs.notifications[key] ? "bg-info" : "bg-muted",
              )}
              aria-pressed={prefs.notifications[key]}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform",
                  prefs.notifications[key] ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
          </label>
        ))}
      </IqCard>

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>Refresh Interval</CardEyebrow>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "15s", v: 15_000 },
            { label: "30s", v: 30_000 },
            { label: "1m", v: 60_000 },
            { label: "5m", v: 300_000 },
          ].map((o) => (
            <button
              key={o.v}
              onClick={() => prefs.setRefreshInterval(o.v)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                prefs.refreshIntervalMs === o.v
                  ? "border-info bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </IqCard>

      <IqCard className="flex items-center justify-between">
        <div>
          <CardEyebrow>API Status</CardEyebrow>
          <div className="mt-1 text-sm font-medium">All systems operational</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-bullish-soft px-2.5 py-1 text-xs font-semibold text-bullish">
          <Check className="h-3 w-3" />
          Online
        </span>
      </IqCard>
    </div>
  );
}

const ACCOUNT_SIZES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const RISK_PER_TRADE = [0.25, 0.5, 1, 2];
const MIN_RR = [1.2, 1.6, 2, 3];
const STOP_METHODS: { label: string; value: StopMethod; hint: string }[] = [
  { label: "Swing", value: "swing", hint: "Below the last structural low/high" },
  { label: "ATR", value: "atr", hint: "Volatility-scaled distance" },
  { label: "Fixed %", value: "fixed-percent", hint: "Flat percentage from entry" },
];

function TradeRiskCard() {
  const { risk, setRisk } = usePreferencesStore();
  const dollarRisk = (risk.accountSize * risk.maxRiskPerTradePercent) / 100;

  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>Trade Risk</CardEyebrow>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning">
          <ShieldAlert className="h-3.5 w-3.5" />
          Sizes every trade plan
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Account size</span>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ACCOUNT_SIZES.map((v) => (
            <OptionButton
              key={v}
              active={risk.accountSize === v}
              onClick={() => setRisk({ accountSize: v })}
            >
              ${v >= 1000 ? `${v / 1000}k` : v}
            </OptionButton>
          ))}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Max risk per trade</span>
          <div className="grid grid-cols-4 gap-2">
            {RISK_PER_TRADE.map((v) => (
              <OptionButton
                key={v}
                active={risk.maxRiskPerTradePercent === v}
                onClick={() => setRisk({ maxRiskPerTradePercent: v })}
              >
                {v}%
              </OptionButton>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Minimum reward/risk</span>
          <div className="grid grid-cols-4 gap-2">
            {MIN_RR.map((v) => (
              <OptionButton
                key={v}
                active={risk.minimumRewardRisk === v}
                onClick={() => setRisk({ minimumRewardRisk: v })}
              >
                {v}R
              </OptionButton>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Stop placement</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {STOP_METHODS.map((m) => (
            <button
              key={m.value}
              onClick={() => setRisk({ stopMethod: m.value })}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                risk.stopMethod === m.value
                  ? "border-info bg-info-soft"
                  : "border-border bg-surface hover:border-muted-foreground/40",
              )}
            >
              <div
                className={cn(
                  "text-sm font-semibold",
                  risk.stopMethod === m.value ? "text-info" : "text-foreground",
                )}
              >
                {m.label}
              </div>
              <div className="text-[11px] text-muted-foreground">{m.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        With these settings, every plan risks at most{" "}
        <span className="num font-semibold text-foreground">
          ${dollarRisk.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>{" "}
        per trade and only setups offering{" "}
        <span className="num font-semibold text-foreground">≥{risk.minimumRewardRisk}R</span> pass
        the reward/risk check.
      </div>
    </IqCard>
  );
}

function OptionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-info bg-info-soft text-info"
          : "border-border bg-surface text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
