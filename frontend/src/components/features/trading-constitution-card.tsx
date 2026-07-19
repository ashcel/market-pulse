import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  ConstitutionValidationError,
  useConstitution,
  useSaveConstitution,
  type ConstitutionInput,
} from "@/hooks/useConstitution";

const SESSIONS = [
  { value: "asia", label: "Asia" },
  { value: "london", label: "London" },
  { value: "new_york", label: "New York" },
] as const;

const BEHAVIOR_DETECTORS = [
  { value: "revenge", label: "Revenge trading", hint: "Loss → re-entry within window, size-up" },
  { value: "overtrading", label: "Overtrading", hint: "Frequency vs. your own baseline" },
  { value: "tilt", label: "Tilt", hint: "Risk escalation after a losing streak" },
] as const;

const DEFAULTS: ConstitutionInput = {
  risk_per_trade_percent: 1,
  daily_loss_limit_percent: 3,
  weekly_loss_limit_percent: 8,
  max_leverage: 5,
  max_concurrent_positions: 3,
  max_correlated_exposure_percent: 40,
  min_risk_reward: 1.5,
  allowed_sessions: ["asia", "london", "new_york"],
  allowed_symbols: [],
  binding_cooldowns: {},
};

/**
 * Settings surface for the Trading Constitution (M9-T1 / EDR 0020 decision
 * 2): the deterministic, versioned per-account risk config the future risk
 * engine reads. Every accepted edit creates a new version server-side and
 * writes its own audit row — this card only ever creates new versions, it
 * never mutates one in place.
 */
export function TradingConstitutionCard() {
  const { constitution, isLoading, authenticated } = useConstitution();
  const save = useSaveConstitution();
  const [form, setForm] = useState<ConstitutionInput>(DEFAULTS);
  const [symbolsText, setSymbolsText] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  // Seed the form from the server once the current version loads. Re-seeds
  // whenever the underlying version id changes (e.g. after a successful save).
  useEffect(() => {
    if (!constitution) return;
    setForm({
      risk_per_trade_percent: constitution.risk_per_trade_percent,
      daily_loss_limit_percent: constitution.daily_loss_limit_percent,
      weekly_loss_limit_percent: constitution.weekly_loss_limit_percent,
      max_leverage: constitution.max_leverage,
      max_concurrent_positions: constitution.max_concurrent_positions,
      max_correlated_exposure_percent: constitution.max_correlated_exposure_percent,
      min_risk_reward: constitution.min_risk_reward,
      allowed_sessions: constitution.allowed_sessions,
      allowed_symbols: constitution.allowed_symbols,
      binding_cooldowns: constitution.binding_cooldowns,
    });
    setSymbolsText(constitution.allowed_symbols.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constitution?.id]);

  const setField = <K extends keyof ConstitutionInput>(key: K, value: ConstitutionInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleSession = (session: string) => {
    setForm((f) => {
      const has = f.allowed_sessions.includes(session);
      return {
        ...f,
        allowed_sessions: has
          ? f.allowed_sessions.filter((s) => s !== session)
          : [...f.allowed_sessions, session],
      };
    });
  };

  const toggleBindingDetector = (detector: string, binding: boolean) => {
    setForm((f) => ({
      ...f,
      binding_cooldowns: { ...f.binding_cooldowns, [detector]: binding },
    }));
  };

  const removeDetector = (detector: string) => {
    setForm((f) => {
      const next = { ...f.binding_cooldowns };
      delete next[detector];
      return { ...f, binding_cooldowns: next };
    });
  };

  const submit = async () => {
    setMessage(null);
    setFieldErrors({});
    const payload: ConstitutionInput = {
      ...form,
      allowed_symbols: symbolsText
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    };
    try {
      await save.mutateAsync(payload);
      setMessage(`Saved as version ${(constitution?.version ?? 0) + 1}.`);
    } catch (err) {
      if (err instanceof ConstitutionValidationError) {
        const byField: Record<string, string> = {};
        for (const e of err.errors) byField[e.field] = e.message;
        setFieldErrors(byField);
        setMessage("Some values are out of the allowed band — see the highlighted fields below.");
      } else {
        setMessage((err as Error).message);
      }
    }
  };

  if (!authenticated) {
    return (
      <IqCard className="flex flex-col gap-2">
        <CardEyebrow>Trading Constitution</CardEyebrow>
        <p className="text-xs text-muted-foreground">
          Sign in to view or edit your Trading Constitution.
        </p>
      </IqCard>
    );
  }

  return (
    <IqCard className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>Trading Constitution</CardEyebrow>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          {isLoading ? "Loading…" : constitution ? `v${constitution.version}` : "Not set"}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        The deterministic risk rules that will gate every IQ-placed order (M9). No AI output can
        override a hard-limit rejection here. Every saved change creates a new version and is
        journaled — nothing is edited in place.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Risk per trade"
          suffix="%"
          value={form.risk_per_trade_percent}
          onChange={(v) => setField("risk_per_trade_percent", v)}
          step={0.1}
          error={fieldErrors.risk_per_trade_percent}
          hint="Band: 0.5%–3% of account equity per trade"
        />
        <NumberField
          label="Minimum reward/risk"
          suffix="R"
          value={form.min_risk_reward}
          onChange={(v) => setField("min_risk_reward", v)}
          step={0.1}
          error={fieldErrors.min_risk_reward}
        />
        <NumberField
          label="Daily loss limit"
          suffix="%"
          value={form.daily_loss_limit_percent}
          onChange={(v) => setField("daily_loss_limit_percent", v)}
          step={0.5}
          error={fieldErrors.daily_loss_limit_percent}
        />
        <NumberField
          label="Weekly loss limit"
          suffix="%"
          value={form.weekly_loss_limit_percent}
          onChange={(v) => setField("weekly_loss_limit_percent", v)}
          step={0.5}
          error={fieldErrors.weekly_loss_limit_percent}
          hint="Must be ≥ the daily limit"
        />
        <NumberField
          label="Max leverage"
          suffix="x"
          value={form.max_leverage}
          onChange={(v) => setField("max_leverage", Math.round(v))}
          step={1}
          error={fieldErrors.max_leverage}
        />
        <NumberField
          label="Max concurrent positions"
          value={form.max_concurrent_positions}
          onChange={(v) => setField("max_concurrent_positions", Math.round(v))}
          step={1}
          error={fieldErrors.max_concurrent_positions}
        />
        <NumberField
          label="Max correlated exposure"
          suffix="%"
          value={form.max_correlated_exposure_percent}
          onChange={(v) => setField("max_correlated_exposure_percent", v)}
          step={5}
          error={fieldErrors.max_correlated_exposure_percent}
          hint="Share of the book allowed in one correlated sector bucket"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted-foreground">Allowed sessions</Label>
        <div className="flex flex-wrap gap-3">
          {SESSIONS.map((s) => (
            <label key={s.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.allowed_sessions.includes(s.value)}
                onCheckedChange={() => toggleSession(s.value)}
              />
              {s.label}
            </label>
          ))}
        </div>
        {fieldErrors.allowed_sessions && (
          <p className="text-destructive text-xs">{fieldErrors.allowed_sessions}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="allowed-symbols" className="text-xs font-medium text-muted-foreground">
          Allowed symbols
        </Label>
        <Input
          id="allowed-symbols"
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.currentTarget.value)}
          placeholder="Leave blank to allow every supported symbol, or e.g. BTCUSDT, ETHUSDT"
          className="num"
        />
        {fieldErrors.allowed_symbols && (
          <p className="text-destructive text-xs">{fieldErrors.allowed_symbols}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted-foreground">
          Behavior detector cooldowns
        </Label>
        <p className="text-[11px] text-muted-foreground">
          Unchecked detectors stay advisory (they flag, they don't block). Checking one makes it
          binding: it rejects a trade permit like any hard rule.
        </p>
        <div className="flex flex-col gap-2">
          {BEHAVIOR_DETECTORS.map((d) => {
            const binding = form.binding_cooldowns[d.value] === true;
            const tracked = d.value in form.binding_cooldowns;
            return (
              <label
                key={d.value}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{d.label}</div>
                  <div className="text-[11px] text-muted-foreground">{d.hint}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      binding ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {tracked ? (binding ? "Binding" : "Advisory") : "Not configured"}
                  </span>
                  <Checkbox
                    checked={binding}
                    onCheckedChange={(checked) => {
                      if (checked === false && tracked && !binding) {
                        removeDetector(d.value);
                      } else {
                        toggleBindingDetector(d.value, checked === true);
                      }
                    }}
                  />
                </div>
              </label>
            );
          })}
        </div>
        {fieldErrors.binding_cooldowns && (
          <p className="text-destructive text-xs">{fieldErrors.binding_cooldowns}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void submit()} disabled={save.isPending || isLoading}>
          {save.isPending ? "Saving…" : "Save new version"}
        </Button>
      </div>

      {message && (
        <p className={save.isError ? "text-destructive text-xs" : "text-xs text-bullish"}>
          {message}
        </p>
      )}
    </IqCard>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  step = 1,
  error,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  step?: number;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.currentTarget.value);
            onChange(Number.isFinite(parsed) ? parsed : 0);
          }}
          className="num w-full min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {error ? (
        <p className="text-destructive text-[11px]">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
