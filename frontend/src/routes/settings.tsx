import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/features/page-header";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
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
  Link2,
  Coins,
  Gem,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StopMethod } from "@/lib/engine/quant";
import type { CapSegment } from "@/stores/preferences";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { PROVIDERS, PROVIDER_ORDER, resolveAiConfig } from "@/lib/ai/providers";
import { useBinanceKeyStatus, useDeleteBinanceKey, useSaveBinanceKey } from "@/hooks/useReview";
import { putCapSegment } from "@/hooks/usePreferencesSync";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { TradingConstitutionCard } from "@/components/features/trading-constitution-card";
import { requireSession } from "@/lib/auth/guard";

export const Route = createFileRoute("/settings")({
  beforeLoad: () => requireSession("/settings"),
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
  const { t } = useTranslation();
  const { theme, toggleTheme } = useUiStore();
  const watchlist = useWatchlistStore();
  const prefs = usePreferencesStore();

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.settings.eyebrow")}
        title={t("routes.settings.title")}
        subtitle={t("routes.settings.subtitle")}
      />

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>{t("routes.settings.theme")}</CardEyebrow>
        <div className="flex gap-2">
          {(["dark", "light"] as const).map((th) => (
            <button
              key={th}
              onClick={() => (th !== theme ? toggleTheme() : null)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-colors",
                theme === th
                  ? "border-info bg-info-soft text-info"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {th === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              {th === "dark" ? t("routes.settings.dark") : t("routes.settings.light")}
            </button>
          ))}
        </div>
      </IqCard>

      <IqCard className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <CardEyebrow>{t("routes.settings.watchlist")}</CardEyebrow>
          <span className="text-xs text-muted-foreground">
            {t("routes.settings.assetsCount", { count: watchlist.tickers.length })}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {watchlist.tickers.map((ti) => (
            <span
              key={ti}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium"
            >
              <Star className="h-3 w-3 fill-warning text-warning" />
              {ti}
              <button
                onClick={() => watchlist.toggle(ti)}
                className="text-muted-foreground hover:text-bearish"
                aria-label={t("routes.settings.removeAria", { ticker: ti })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {watchlist.tickers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t("routes.settings.addFavoritesFromRankings")}
            </p>
          )}
        </div>
      </IqCard>

      <AccountSecurityCard />

      <TradingConstitutionCard />

      <TradingFocusCard />

      <TradeRiskCard />

      <AiAnalystCard />

      <BinanceConnectionCard />

      <IqCard className="flex flex-col gap-4">
        <CardEyebrow>{t("routes.settings.notifications")}</CardEyebrow>
        <BrowserPermissionRow />
        {(
          [
            ["triggerAlert", "notifTriggerAlert"],
            ["regime", "notifRegime"],
            ["rotation", "notifRotation"],
            ["highQualitySetup", "notifHighQualitySetup"],
            ["spikeAlert", "notifSpikeAlert"],
            ["highImpactNews", "notifHighImpactNews"],
          ] as const
        ).map(([key, labelKey]) => (
          <label
            key={key}
            className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3"
          >
            <span className="text-sm">{t(`routes.settings.${labelKey}`)}</span>
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
        <CardEyebrow>{t("routes.settings.refreshInterval")}</CardEyebrow>
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
          <CardEyebrow>{t("routes.settings.apiStatus")}</CardEyebrow>
          <div className="mt-1 text-sm font-medium">{t("routes.settings.allSystemsOperational")}</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-bullish-soft px-2.5 py-1 text-xs font-semibold text-bullish">
          <Check className="h-3 w-3" />
          {t("routes.settings.online")}
        </span>
      </IqCard>
    </div>
  );
}

function BrowserPermissionRow() {
  const { t } = useTranslation();
  const { permission, requestPermission } = useNotificationsStore();

  const status =
    permission === "granted"
      ? {
          label: t("routes.settings.browserNotifEnabled"),
          hint: t("routes.settings.browserNotifEnabledHint"),
          tone: "text-bullish",
        }
      : permission === "denied"
        ? {
            label: t("routes.settings.browserNotifBlocked"),
            hint: t("routes.settings.browserNotifBlockedHint"),
            tone: "text-bearish",
          }
        : permission === "unsupported"
          ? {
              label: t("routes.settings.browserNotifUnsupported"),
              hint: t("routes.settings.browserNotifUnsupportedHint"),
              tone: "text-muted-foreground",
            }
          : {
              label: t("routes.settings.browserNotifNotEnabled"),
              hint: t("routes.settings.browserNotifNotEnabledHint"),
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
            {t("routes.settings.browserNotifications")}{" "}
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
          {t("routes.settings.enable")}
        </button>
      )}
    </div>
  );
}

const ACCOUNT_SIZES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const RISK_PER_TRADE = [0.25, 0.5, 1, 2];
const MIN_RR = [1.2, 1.6, 2, 3];
const STOP_METHODS: { labelKey: string; value: StopMethod; hintKey: string }[] = [
  { labelKey: "stopSwing", value: "swing", hintKey: "stopSwingHint" },
  { labelKey: "stopAtr", value: "atr", hintKey: "stopAtrHint" },
  { labelKey: "stopFixedPercent", value: "fixed-percent", hintKey: "stopFixedPercentHint" },
];

function AccountSecurityCard() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const submit = async () => {
    setMessage("");
    if (newPassword.length < 8) {
      setState("error");
      setMessage(t("routes.settings.newPasswordMinLength"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setState("error");
      setMessage(t("routes.settings.newPasswordsDontMatch"));
      return;
    }
    setState("working");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "change-password", currentPassword, newPassword }),
      });
      if (r.ok) {
        setState("done");
        setMessage(t("routes.settings.passwordChanged"));
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else if (r.status === 401 && !currentPassword) {
        setState("error");
        setMessage(t("routes.settings.signInFirstChangePassword"));
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setState("error");
        setMessage(j.error ?? t("routes.settings.couldNotChangePassword"));
      }
    } catch {
      setState("error");
      setMessage(t("routes.settings.networkError"));
    }
  };

  return (
    <IqCard className="flex flex-col gap-4">
      <CardEyebrow>{t("routes.settings.account")}</CardEyebrow>
      <p className="text-xs text-muted-foreground">{t("routes.settings.changePasswordNote")}</p>
      <form
        className="flex flex-col gap-3 sm:max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="border-input bg-background rounded-md border px-3 py-2 text-sm"
          placeholder={t("routes.settings.currentPassword")}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <input
          className="border-input bg-background rounded-md border px-3 py-2 text-sm"
          placeholder={t("routes.settings.newPasswordPlaceholder")}
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <input
          className="border-input bg-background rounded-md border px-3 py-2 text-sm"
          placeholder={t("routes.settings.confirmNewPassword")}
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        <button
          className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          type="submit"
          disabled={state === "working"}
        >
          {state === "working" ? t("routes.settings.changing") : t("routes.settings.changePassword")}
        </button>
      </form>
      {message ? (
        <p className={state === "error" ? "text-destructive text-xs" : "text-xs text-bullish"}>
          {message}
        </p>
      ) : null}
    </IqCard>
  );
}

const CAP_SEGMENT_OPTIONS: {
  segment: Exclude<CapSegment, null>;
  labelKey: string;
  hintKey: string;
  icon: typeof Coins;
}[] = [
  { segment: "bigcap", labelKey: "bigCaps", hintKey: "bigCapsHint", icon: Coins },
  { segment: "smallcap", labelKey: "smallCaps", hintKey: "smallCapsHint", icon: Gem },
];

function TradingFocusCard() {
  const { t } = useTranslation();
  const { capSegment, setCapSegment } = usePreferencesStore();
  const [justChanged, setJustChanged] = useState(false);

  const choose = (segment: Exclude<CapSegment, null>) => {
    if (segment === capSegment) return;
    setCapSegment(segment);
    putCapSegment(segment);
    setJustChanged(true);
  };

  return (
    <IqCard className="flex flex-col gap-4">
      <CardEyebrow>{t("routes.settings.tradingFocus")}</CardEyebrow>
      <p className="text-xs text-muted-foreground">{t("routes.settings.tradingFocusNote")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {CAP_SEGMENT_OPTIONS.map((o) => (
          <button
            key={o.segment}
            onClick={() => choose(o.segment)}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
              capSegment === o.segment
                ? "border-info bg-info-soft"
                : "border-border bg-surface hover:border-muted-foreground/40",
            )}
          >
            <o.icon
              className={cn(
                "h-4 w-4 shrink-0",
                capSegment === o.segment ? "text-info" : "text-muted-foreground",
              )}
            />
            <div>
              <div
                className={cn(
                  "text-sm font-semibold",
                  capSegment === o.segment ? "text-info" : "text-foreground",
                )}
              >
                {t(`routes.settings.${o.labelKey}`)}
              </div>
              <div className="text-[11px] text-muted-foreground">{t(`routes.settings.${o.hintKey}`)}</div>
            </div>
          </button>
        ))}
      </div>
      {justChanged && <p className="text-xs text-bullish">{t("routes.settings.riskDefaultsUpdated")}</p>}
      {capSegment === null && (
        <p className="text-xs text-muted-foreground">{t("routes.settings.notSetYet")}</p>
      )}
    </IqCard>
  );
}

function TradeRiskCard() {
  const { t } = useTranslation();
  const { risk, setRisk } = usePreferencesStore();
  const dollarRisk = (risk.accountSize * risk.maxRiskPerTradePercent) / 100;

  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("routes.settings.tradeRisk")}</CardEyebrow>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning">
          <ShieldAlert className="h-3.5 w-3.5" />
          {t("routes.settings.sizesEveryTradePlan")}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("routes.settings.accountSize")}
        </span>
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
          <span className="text-xs font-medium text-muted-foreground">
            {t("routes.settings.maxRiskPerTrade")}
          </span>
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
          <span className="text-xs font-medium text-muted-foreground">
            {t("routes.settings.minimumRewardRisk")}
          </span>
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
        <span className="text-xs font-medium text-muted-foreground">
          {t("routes.settings.stopPlacement")}
        </span>
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
                {t(`routes.settings.${m.labelKey}`)}
              </div>
              <div className="text-[11px] text-muted-foreground">{t(`routes.settings.${m.hintKey}`)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        {t("routes.settings.riskSummaryPrefix")}{" "}
        <span className="num font-semibold text-foreground">
          ${dollarRisk.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>{" "}
        {t("routes.settings.riskSummaryMid")}{" "}
        <span className="num font-semibold text-foreground">≥{risk.minimumRewardRisk}R</span>{" "}
        {t("routes.settings.riskSummarySuffix")}
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
  const { t } = useTranslation();
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
        {t("routes.settings.orExactBalance")}
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
        aria-label={t("routes.settings.customBalanceAria")}
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
  const { t } = useTranslation();
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
        <CardEyebrow>{t("routes.settings.aiAnalyst")}</CardEyebrow>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            configured ? "bg-bullish-soft text-bullish" : "bg-muted text-muted-foreground",
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          {configured ? t("routes.settings.connected") : t("routes.settings.notConfigured")}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{t("routes.settings.aiAnalystNote")}</p>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("routes.settings.provider")}</span>
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
          <span className="text-xs font-medium text-muted-foreground">{t("routes.settings.apiKey")}</span>
          <a
            href={meta.keyHelpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-info hover:underline"
          >
            {t("routes.settings.getAKey", { label: meta.keyHelpLabel })}
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
            aria-label={`${meta.label} ${t("routes.settings.apiKey")}`}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={showKey ? t("routes.settings.hideKey") : t("routes.settings.showKey")}
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {meta.editableBaseUrl && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">{t("routes.settings.baseUrl")}</span>
          <input
            type="text"
            value={customBaseUrl}
            onChange={(e) => setCustomBaseUrl(e.currentTarget.value)}
            placeholder={meta.baseUrlPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-info"
            aria-label={t("routes.settings.customBaseUrlAria")}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("routes.settings.model")}</span>
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
          aria-label={t("routes.settings.modelNameAria")}
        />
        <span className="text-[11px] text-muted-foreground">{t("routes.settings.pickPresetOrType")}</span>
      </div>
    </IqCard>
  );
}

function BinanceConnectionCard() {
  const { t } = useTranslation();
  const { connected, lastSyncedAt, isLoading } = useBinanceKeyStatus();
  const saveKey = useSaveBinanceKey();
  const deleteKey = useDeleteBinanceKey();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    setMessage(null);
    if (!apiKey.trim() || !apiSecret.trim()) {
      setMessage(t("routes.settings.enterKeyAndSecret"));
      return;
    }
    try {
      await saveKey.mutateAsync({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
      setApiKey("");
      setApiSecret("");
      setMessage(t("routes.settings.connectedSyncHint"));
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("routes.settings.binanceConnection")}</CardEyebrow>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            connected ? "bg-bullish-soft text-bullish" : "bg-muted text-muted-foreground",
          )}
        >
          <Link2 className="h-3.5 w-3.5" />
          {isLoading
            ? t("routes.settings.checking")
            : connected
              ? t("routes.settings.connected")
              : t("routes.settings.notConnected")}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{t("routes.settings.binanceConnectionNote")}</p>

      {connected && lastSyncedAt && (
        <p className="text-xs text-muted-foreground">
          {t("routes.settings.lastSynced", { date: new Date(lastSyncedAt).toLocaleString() })}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("routes.settings.binanceApiKeyLabel")}
        </span>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
          placeholder={t("routes.settings.binanceApiKeyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-info"
          aria-label={t("routes.settings.binanceApiKeyPlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("routes.settings.binanceApiSecretLabel")}
        </span>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <input
            type={showSecret ? "text" : "password"}
            value={apiSecret}
            onChange={(e) => setApiSecret(e.currentTarget.value)}
            placeholder={t("routes.settings.binanceApiSecretPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label={t("routes.settings.binanceApiSecretPlaceholder")}
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={showSecret ? t("routes.settings.hideSecret") : t("routes.settings.showSecret")}
          >
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void submit()} disabled={saveKey.isPending}>
          {saveKey.isPending
            ? t("routes.settings.connecting")
            : connected
              ? t("routes.settings.updateAndReconnect")
              : t("routes.settings.saveAndConnect")}
        </Button>
        {connected && (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-bearish"
            onClick={() => deleteKey.mutate()}
            disabled={deleteKey.isPending}
          >
            {t("routes.settings.disconnect")}
          </Button>
        )}
      </div>

      {message && (
        <p className={saveKey.isError ? "text-destructive text-xs" : "text-xs text-bullish"}>
          {message}
        </p>
      )}
    </IqCard>
  );
}
