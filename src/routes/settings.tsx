import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/iq/page-header";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { useUiStore } from "@/stores/ui";
import { useWatchlistStore } from "@/stores/watchlist";
import { usePreferencesStore } from "@/stores/preferences";
import { useNotificationsStore } from "@/stores/notifications";
import {
  Sun,
  Moon,
  Star,
  X,
  Check,
  ShieldAlert,
  BellRing,
  BellOff,
  Bot,
  Eye,
  EyeOff,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StopMethod } from "@/lib/engine/quant";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { PROVIDERS, PROVIDER_ORDER, resolveAiConfig } from "@/lib/ai/providers";
import { useState } from "react";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Market Pulse" },
      {
        name: "description",
        content: "Manage your Market Pulse preferences, watchlist, and notifications.",
      },
      { property: "og:title", content: "Settings — Market Pulse" },
      { property: "og:description", content: "Tune Market Pulse to your workflow." },
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

      <AiAnalystCard />

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>Notifications</CardEyebrow>
        <BrowserPermissionRow />
        {(
          [
            ["triggerAlert", "Verdict trigger hit (a held verdict's level breaks)"],
            ["regime", "Regime change alerts"],
            ["rotation", "Capital rotation shifts"],
            ["highQualitySetup", "High-quality setup found"],
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

function BrowserPermissionRow() {
  const { permission, requestPermission } = useNotificationsStore();

  const status =
    permission === "granted"
      ? { label: "Enabled", hint: "This browser will show OS notifications.", tone: "text-bullish" }
      : permission === "denied"
        ? {
            label: "Blocked",
            hint: "Re-enable notifications for this site in your browser settings.",
            tone: "text-bearish",
          }
        : permission === "unsupported"
          ? {
              label: "Unsupported",
              hint: "This browser doesn't support notifications.",
              tone: "text-muted-foreground",
            }
          : {
              label: "Not enabled",
              hint: "Allow notifications to get alerts even when this tab isn't focused.",
              tone: "text-muted-foreground",
            };

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        {permission === "granted" ? (
          <BellRing className="h-4 w-4 shrink-0 text-bullish" />
        ) : (
          <BellOff className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div>
          <div className="text-sm font-medium">
            Browser notifications{" "}
            <span className={cn("font-normal", status.tone)}>· {status.label}</span>
          </div>
          <div className="text-xs text-muted-foreground">{status.hint}</div>
        </div>
      </div>
      {permission === "default" && (
        <button
          onClick={() => requestPermission()}
          className="shrink-0 rounded-lg border border-info bg-info-soft px-3 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info/20"
        >
          Enable
        </button>
      )}
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
        <CustomBalanceInput
          value={risk.accountSize}
          isCustom={!ACCOUNT_SIZES.includes(risk.accountSize)}
          onCommit={(accountSize) => setRisk({ accountSize })}
        />
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

const MIN_BALANCE = 1;
const MAX_BALANCE = 1_000_000_000;

function parseBalance(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value < MIN_BALANCE) return null;
  return Math.round(Math.min(value, MAX_BALANCE) * 100) / 100;
}

function CustomBalanceInput({
  value,
  isCustom,
  onCommit,
}: {
  value: number;
  isCustom: boolean;
  onCommit: (value: number) => void;
}) {
  const commit = (input: HTMLInputElement) => {
    const parsed = parseBalance(input.value);
    if (parsed === null) {
      input.value = value.toLocaleString();
    } else {
      onCommit(parsed);
      input.value = parsed.toLocaleString();
    }
  };

  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
        isCustom ? "border-info bg-info-soft" : "border-border bg-surface",
      )}
    >
      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
        Or exact balance
      </span>
      <span className={cn("text-sm font-medium", isCustom ? "text-info" : "text-foreground")}>
        $
      </span>
      {/* Uncontrolled + keyed remount: preset clicks refresh the field, while
          typing stays free of store round-trips until blur/Enter commits. */}
      <input
        key={value}
        type="text"
        inputMode="decimal"
        defaultValue={value.toLocaleString()}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget);
        }}
        aria-label="Custom account balance in dollars"
        className={cn(
          "num w-full min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none",
          isCustom ? "text-info" : "text-foreground",
        )}
      />
    </label>
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

function AiAnalystCard() {
  const {
    provider,
    apiKeys,
    models,
    customBaseUrl,
    setProvider,
    setApiKey,
    setModel,
    setCustomBaseUrl,
  } = useAiSettingsStore();
  const [showKey, setShowKey] = useState(false);

  const meta = PROVIDERS[provider];
  const configured = resolveAiConfig({ provider, apiKeys, models, customBaseUrl }) !== null;
  const key = apiKeys[provider] ?? "";
  const model = models[provider] ?? "";

  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>AI Analyst</CardEyebrow>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            configured ? "bg-bullish-soft text-bullish" : "bg-muted text-muted-foreground",
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          {configured ? "Connected" : "Not configured"}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        Bring your own key to power the AI analyst on token pages. Your key is stored only in this
        browser and sent directly to the provider — never to our servers. Without a key, the analyst
        falls back to a deterministic memo.
      </p>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Provider</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDER_ORDER.map((id) => {
            const p = PROVIDERS[id];
            const active = provider === id;
            return (
              <button
                key={id}
                onClick={() => setProvider(id)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  active
                    ? "border-info bg-info-soft"
                    : "border-border bg-surface hover:border-muted-foreground/40",
                )}
              >
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-sm font-semibold",
                    active ? "text-info" : "text-foreground",
                  )}
                >
                  {p.label}
                  {apiKeys[id] ? <Check className="h-3.5 w-3.5 text-bullish" /> : null}
                </div>
                <div className="text-[11px] leading-snug text-muted-foreground">{p.blurb}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">API key</span>
          <a
            href={meta.keyHelpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-info hover:underline"
          >
            Get a key · {meta.keyHelpLabel}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <input
            type={showKey ? "text" : "password"}
            value={key}
            onChange={(e) => setApiKey(provider, e.currentTarget.value)}
            placeholder={meta.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label={`${meta.label} API key`}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={showKey ? "Hide key" : "Show key"}
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {meta.editableBaseUrl && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Base URL</span>
          <input
            type="text"
            value={customBaseUrl}
            onChange={(e) => setCustomBaseUrl(e.currentTarget.value)}
            placeholder={meta.baseUrlPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-info"
            aria-label="Custom base URL"
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Model</span>
        {meta.recommendedModels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {meta.recommendedModels.map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(provider, m.id)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  model === m.id
                    ? "border-info bg-info-soft text-info"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground",
                )}
                title={m.id}
              >
                {m.label}
                {m.note ? <span className="ml-1 opacity-60">· {m.note}</span> : null}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(provider, e.currentTarget.value)}
          placeholder={meta.defaultModel || meta.modelPlaceholder}
          autoComplete="off"
          spellCheck={false}
          className="num rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-info"
          aria-label="Model name"
        />
        <span className="text-[11px] text-muted-foreground">
          Pick a preset or type any model the provider supports.
        </span>
      </div>
    </IqCard>
  );
}
