import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { fetchListingBrief } from "@/hooks/useListings";
import { buildCandidates, isAbort, runAiStreamWithFallback } from "@/lib/ai/chain";
import type { AiMessage } from "@/lib/ai/client";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { cn } from "@/lib/utils";

/**
 * AI read of one listing.
 *
 * The model narrates a *pre-computed* evidence pack (`/listings/:symbol/brief`)
 * — every number in the prompt was derived deterministically by the worker
 * before the model was called. It never fetches, never scores, and is told in
 * the system prompt that it cannot originate a recommendation. That is the
 * same boundary the desk review holds: AI explains and challenges the
 * evidence, it does not produce the verdict.
 *
 * Runs on demand rather than on mount, because it spends the reader's own
 * API budget.
 */

const SYSTEM_PROMPT = `You are a risk-first crypto analyst reviewing a NEW Binance listing for a trader.

You are given a JSON evidence pack that was computed deterministically before you were called. Rules:
- Use ONLY numbers present in the pack. Never invent a metric, a price, or a date.
- You did NOT produce the screener score. Do not restate it as your own judgement; explain what drives it and where it may be misleading.
- Coverage matters: if coverage is low, say plainly which evidence is missing and how that limits the read.
- Treat holder concentration, unlock overhang (FDV vs market cap) and farmed social buzz as the primary risks of a new listing.
- This is not financial advice and never a buy/sell instruction. No entry, stop, or position size.

Write 4 short sections, plain prose, no preamble:
1. What this is — one or two sentences.
2. The case for attention — the strongest evidence, named.
3. What would hurt — the concrete risks, with the numbers behind them.
4. What to watch next — the specific observable that would change the read.

Be concise and specific. Under 250 words.`;

type Phase = "idle" | "loading" | "streaming" | "done" | "error";

export function ListingAiAnalysis({ symbol, className }: { symbol: string; className?: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const provider = useAiSettingsStore((s) => s.provider);
  const apiKeys = useAiSettingsStore((s) => s.apiKeys);
  const models = useAiSettingsStore((s) => s.models);
  const customBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);

  const aiSettings = useMemo(
    () => ({ provider, apiKeys, models, customBaseUrl }),
    [provider, apiKeys, models, customBaseUrl],
  );
  const aiReady = useMemo(() => buildCandidates(aiSettings).length > 0, [aiSettings]);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("loading");
    setText("");
    setError(null);
    setSource(null);

    try {
      const brief = await fetchListingBrief(symbol);
      const messages: AiMessage[] = [
        {
          role: "user",
          content: `Evidence pack for ${symbol.toUpperCase()}:\n\n${JSON.stringify(brief, null, 2)}`,
        },
      ];

      setPhase("streaming");
      const completion = await runAiStreamWithFallback({
        settings: aiSettings,
        system: SYSTEM_PROMPT,
        messages,
        signal: controller.signal,
        onDelta: (fragment) => setText((current) => current + fragment),
      });
      setSource(completion.model);
      setPhase("done");
    } catch (e) {
      if (isAbort(e)) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [aiSettings, symbol]);

  const busy = phase === "loading" || phase === "streaming";

  return (
    <IqCard className={className}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>{t("listings.ai.title")}</CardEyebrow>
          <p className="mt-1 text-xs text-muted-foreground">{t("listings.ai.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy || !aiReady}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            aiReady
              ? "bg-info-soft text-info hover:bg-info-soft/80"
              : "cursor-not-allowed bg-muted text-muted-foreground",
            busy && "opacity-70",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {busy
            ? t("listings.ai.running")
            : phase === "done"
              ? t("listings.ai.rerun")
              : t("listings.ai.run")}
        </button>
      </div>

      {!aiReady && (
        <p className="mt-3 text-xs text-muted-foreground">{t("listings.ai.noProvider")}</p>
      )}

      {phase === "loading" && (
        <p className="mt-3 text-xs text-muted-foreground">{t("listings.ai.gathering")}</p>
      )}

      {text && (
        <div className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {text}
        </div>
      )}

      {phase === "error" && error && (
        <p className="mt-3 rounded-lg bg-bearish-soft px-3 py-2 text-[11px] leading-relaxed text-bearish">
          {t("listings.ai.failed", { error })}
        </p>
      )}

      {source && phase === "done" && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {t("listings.ai.source", { model: source })}
        </p>
      )}
    </IqCard>
  );
}
