import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  X,
  Send,
  Bot,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiSettingsStore } from "@/stores/ai-settings";
import { useAiContext, type PageAiContext } from "@/stores/ai-context";
import { useDeskReviewsStore, type DeskReviewHistoryEntry } from "@/stores/desk-reviews";
import { buildCandidates, runAiStreamWithFallback, runAiWithFallback } from "@/lib/ai/chain";
import { type AiMessage } from "@/lib/ai/client";
import {
  buildAnalystSystem,
  buildGeneralAnalystSystem,
  MEMO_INSTRUCTION,
  type ChartStructure,
  type EconCalendarItem,
  type MarketConditionSummary,
} from "@/lib/ai/analyst-context";
import { fearGreedLabel } from "@/lib/engine/external-context";
import {
  useEconomicEvents,
  useRegime,
  useRotation,
  useSectors,
  useSentiment,
  useSnapshotMeta,
} from "@/hooks/queries";
import {
  computeDeskAnchor,
  parseTradeIdeaFast,
  parseIntentParseResponse,
  buildIntentParsePrompt,
  type TradeIdea,
  type DeskAnchor,
  type DeskOutcome,
} from "@/lib/ai/trade-idea";
import { buildEvidencePack, type EvidencePack } from "@/lib/ai/evidence-pack";
import {
  buildDeskSystem,
  parseDeskReview,
  type DeskChallenge,
  type DeskReviewResult,
} from "@/lib/ai/desk-review";
import { INTENTS, type IntentAssessment, type TradingIntent } from "@/lib/engine/intent";
import type { SignalEvaluation } from "@/lib/engine/quant";
import type { ExternalContext } from "@/lib/engine/external-context";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import { MarkdownText } from "@/components/features/markdown-text";

// ── Deterministic evidence gate ─────────────────────────────────────────────
// Zero-cost (no LLM call) check for whether the open page's context actually
// grounds a review of `idea`. Prefers the full per-intent map (added to
// `PageAiContext` for this feature) so the match works regardless of which
// tab happens to be active on the token page; falls back to the single active
// `assessment` when its own intent happens to match.

type EvidenceGate =
  | { usable: false }
  | {
      usable: true;
      symbol: string;
      timeframe: TokenTimeframe;
      evaluation: SignalEvaluation;
      assessment: IntentAssessment;
      chartStructure: ChartStructure | null;
      externalContext: ExternalContext | null;
    };

function resolveEvidenceGate(context: PageAiContext | null, idea: TradeIdea): EvidenceGate {
  const ideaSymbol = idea.symbol;
  const intent = idea.intent;
  if (!context || !ideaSymbol || !intent) return { usable: false };
  if (!context.symbol || context.symbol.toUpperCase() !== ideaSymbol.toUpperCase()) {
    return { usable: false };
  }
  if (!context.evaluation || !context.timeframe) return { usable: false };
  const assessment =
    context.assessments?.[intent] ??
    (context.assessment && context.assessment.intent === intent ? context.assessment : null) ??
    null;
  if (!assessment) return { usable: false };
  return {
    usable: true,
    symbol: context.symbol,
    timeframe: context.timeframe,
    evaluation: context.evaluation,
    assessment,
    chartStructure: context.chartStructure ?? null,
    externalContext: context.externalContext ?? null,
  };
}

/** The forced "no-evidence" verdict, rendered without ever calling the LLM. */
function buildNoEvidenceResult(anchor: DeskAnchor): DeskReviewResult {
  return {
    outcome: "no-evidence",
    thesis: anchor.reasons[0] ?? "Not enough evidence to review this idea.",
    challenges: [],
    conditions: [],
    invalidation: null,
    watch: [],
    confidence: null,
    citedIds: [],
    warnings: [],
    raw: "",
  };
}

const OUTCOME_STYLES: Record<DeskOutcome, { label: string; classes: string; dot: string }> = {
  approve: {
    label: "APPROVED",
    classes: "border-bullish/30 bg-bullish-soft text-bullish",
    dot: "bg-bullish",
  },
  conditional: {
    label: "CONDITIONAL",
    classes: "border-warning/30 bg-warning-soft text-warning",
    dot: "bg-warning",
  },
  reject: {
    label: "REJECTED",
    classes: "border-bearish/30 bg-bearish-soft text-bearish",
    dot: "bg-bearish",
  },
  "out-of-scope": {
    label: "OUT OF SCOPE",
    classes: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
  "no-evidence": {
    label: "NO EVIDENCE",
    classes: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
};

function formatWarning(w: string): string {
  if (w === "clamped-to-anchor") return "Clamped to ceiling";
  if (w === "forced-to-anchor") return "Forced verdict";
  if (w === "unstructured-response") return "Unstructured response";
  if (w === "invalid-outcome") return "Invalid outcome";
  if (w.startsWith("unverified-number:"))
    return `Unverified number: ${w.slice("unverified-number:".length)}`;
  if (w.startsWith("unknown-citation:"))
    return `Unknown citation: ${w.slice("unknown-citation:".length)}`;
  return w;
}

function ageFromIso(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

type FollowupMessage = { role: "user" | "assistant"; text: string };
type SidebarMode = "composer" | "chips" | "chat" | "review" | "summary";

export function AskAiSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<SidebarMode>("composer");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Plain-chat fallback (unparseable free text with no symbol/direction).
  const [chat, setChat] = useState<
    Array<{ role: "user" | "assistant"; text: string; source?: string }>
  >([]);
  const [chatLoading, setChatLoading] = useState(false);

  // Step 1→2: fast/LLM parse result awaiting confirmation as chips.
  const [parsedIdea, setParsedIdea] = useState<TradeIdea | null>(null);
  const [parsing, setParsing] = useState(false);

  // Step 4→5: the review in flight / rendered.
  const [reviewIdea, setReviewIdea] = useState<TradeIdea | null>(null);
  const [reviewAnchor, setReviewAnchor] = useState<DeskAnchor | null>(null);
  const [reviewPack, setReviewPack] = useState<EvidencePack | null>(null);
  const [reviewSystem, setReviewSystem] = useState<string | null>(null);
  const [reviewResult, setReviewResult] = useState<DeskReviewResult | null>(null);
  const [reviewStreaming, setReviewStreaming] = useState(false);
  const [reviewStreamText, setReviewStreamText] = useState("");

  // Step 6: follow-up thread scoped to the rendered review.
  const [followups, setFollowups] = useState<FollowupMessage[]>([]);
  const [followupStreaming, setFollowupStreaming] = useState(false);
  const [followupStreamText, setFollowupStreamText] = useState("");

  // Step 7: history summary view (no re-run).
  const [summaryEntry, setSummaryEntry] = useState<DeskReviewHistoryEntry | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const context = useAiContext((s) => s.context);
  const reviews = useDeskReviewsStore((s) => s.reviews);
  const addReview = useDeskReviewsStore((s) => s.addReview);

  // Economic calendar + market condition — every AI entry point below (plain
  // chat, ungrounded chat, desk review) threads the same two payloads in.
  // Fetched here (not inside the pure lib/ai builders) so those stay
  // network-free; this sidebar stays mounted for the page's lifetime, so the
  // query is warm well before the trader asks anything.
  const econEvents = useEconomicEvents(7, "medium");
  const econCalendar = useMemo<EconCalendarItem[] | null>(
    () => (econEvents.data && econEvents.data.length > 0 ? econEvents.data : null),
    [econEvents.data],
  );

  const regime = useRegime();
  const rotation = useRotation();
  const sectors = useSectors();
  const sentiment = useSentiment();
  const snapshotMeta = useSnapshotMeta();
  const marketCondition = useMemo<MarketConditionSummary | null>(() => {
    if (!regime.data || !rotation.data || !sentiment.data) return null;
    const sectorList = sectors.data ?? [];
    return {
      regime: regime.data.regime,
      regimeConfidence: regime.data.confidence,
      rotationWinning: rotation.data.winning,
      rotationLosing: rotation.data.losing,
      sectorsUp: sectorList.filter((s) => s.change > 0).length,
      sectorsTotal: sectorList.length,
      fearGreed: sentiment.data.fearGreed,
      fearGreedLabel: fearGreedLabel(sentiment.data.fearGreed),
      updatedAt: snapshotMeta.data?.updatedAt ?? new Date().toISOString(),
    };
  }, [regime.data, rotation.data, sectors.data, sentiment.data, snapshotMeta.data]);

  const aiProvider = useAiSettingsStore((s) => s.provider);
  const aiApiKeys = useAiSettingsStore((s) => s.apiKeys);
  const aiModels = useAiSettingsStore((s) => s.models);
  const aiCustomBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);

  // The full settings snapshot, plus whether ANY endpoint in the fallback chain
  // is currently usable. `aiReady` replaces the old single-provider check: the
  // panel works as long as one candidate resolves, not only the active provider.
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
  // Which endpoint answered last — shown under the memo so a silent failover is
  // never invisible.
  const [aiSource, setAiSource] = useState<string | null>(null);

  const busy = parsing || chatLoading || reviewStreaming || followupStreaming;

  // Abort any in-flight request when the sidebar closes or unmounts — this
  // sidebar stays mounted (only `open` toggles), so both guards matter.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const recordHistory = useCallback(
    (idea: TradeIdea, outcome: DeskOutcome, thesis: string) => {
      addReview({
        id:
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}`,
        at: new Date().toISOString(),
        ideaText: idea.rawText,
        symbol: idea.symbol,
        direction: idea.direction,
        intent: idea.intent,
        outcome,
        thesis,
      });
    },
    [addReview],
  );

  const resetToComposer = useCallback(() => {
    abortRef.current?.abort();
    setMode("composer");
    setQuestion("");
    setError(null);
    setChat([]);
    setChatLoading(false);
    setParsedIdea(null);
    setParsing(false);
    setReviewIdea(null);
    setReviewAnchor(null);
    setReviewPack(null);
    setReviewSystem(null);
    setReviewResult(null);
    setReviewStreaming(false);
    setReviewStreamText("");
    setFollowups([]);
    setFollowupStreaming(false);
    setFollowupStreamText("");
    setSummaryEntry(null);
  }, []);

  // Plain-chat completion — same behavior as the pre-rebuild sidebar: grounded
  // in the page context when available, generic otherwise.
  const runChatAnalysis = useCallback(
    async (ask?: string) => {
      const fallbackMsg =
        "AI configuration is missing. Please configure an AI provider in Settings.";
      if (!aiReady) {
        setChat((items) =>
          [
            ...items,
            ...(ask ? [{ role: "user" as const, text: ask }] : []),
            { role: "assistant" as const, text: fallbackMsg, source: "system" },
          ].slice(-20),
        );
        return;
      }

      const priorForModel = chat;
      setChat((items) =>
        [...items, ...(ask ? [{ role: "user" as const, text: ask }] : [])].slice(-20),
      );
      setChatLoading(true);
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const system =
          context?.symbol && context?.timeframe && context?.evaluation
            ? buildAnalystSystem(
                context.symbol,
                context.timeframe,
                context.evaluation,
                context.assessment || null,
                false,
                context.chartStructure || null,
                context.externalContext || null,
                econCalendar,
              )
            : buildGeneralAnalystSystem(marketCondition, econCalendar);

        const history = priorForModel.reduce<AiMessage[]>((acc, m) => {
          if (acc.length === 0 && m.role !== "user") return acc;
          return [...acc, { role: m.role, content: m.text }];
        }, []);

        const messages: AiMessage[] = [
          ...history,
          { role: "user", content: ask ?? MEMO_INSTRUCTION },
        ];
        const completion = await runAiWithFallback({
          settings: aiSettings,
          system,
          messages,
          signal: controller.signal,
        });
        setAiSource(completion.model);
        setChat((items) =>
          [
            ...items,
            { role: "assistant" as const, text: completion.text, source: completion.model },
          ].slice(-20),
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Request failed.");
        setChat((items) =>
          [
            ...items,
            {
              role: "assistant" as const,
              text: "Sorry, I encountered an error answering that request.",
              source: "system",
            },
          ].slice(-20),
        );
      } finally {
        setChatLoading(false);
      }
    },
    [aiSettings, aiReady, chat, context, econCalendar, marketCondition],
  );

  // Composer submit: fast-parse → (LLM parse fallback) → chips, or plain chat.
  const handleComposerSubmit = useCallback(
    async (rawInput: string) => {
      const text = rawInput.trim();
      if (!text) return;
      setQuestion("");
      setError(null);

      const fastIdea = parseTradeIdeaFast(text);
      if (fastIdea.symbol && fastIdea.direction) {
        setParsedIdea(fastIdea);
        setMode("chips");
        return;
      }

      if (aiReady) {
        setParsing(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const parsed = parseIntentParseResponse(
            (
              await runAiWithFallback({
                settings: aiSettings,
                system: buildIntentParsePrompt(text),
                messages: [{ role: "user", content: text }],
                maxTokens: 300,
                signal: controller.signal,
              })
            ).text,
            text,
          );
          setParsing(false);
          if (parsed && parsed.symbol && parsed.direction) {
            setParsedIdea(parsed);
            setMode("chips");
            return;
          }
        } catch (e) {
          setParsing(false);
          if (e instanceof DOMException && e.name === "AbortError") return;
          // Parser failed — fall through to plain chat rather than surfacing a
          // parse error for what might just be a genuine question.
        }
      }

      setMode("chat");
      await runChatAnalysis(text);
    },
    [aiSettings, aiReady, runChatAnalysis],
  );

  // Chips → "Run desk review": deterministic gate first, LLM only if usable.
  const runDeskReview = useCallback(
    async (idea: TradeIdea) => {
      const gate = resolveEvidenceGate(context, idea);

      if (!gate.usable) {
        const anchor = computeDeskAnchor(idea, null);
        const result = buildNoEvidenceResult(anchor);
        setReviewIdea(idea);
        setReviewAnchor(anchor);
        setReviewPack(null);
        setReviewSystem(null);
        setReviewResult(result);
        setReviewStreamText("");
        setFollowups([]);
        setError(null);
        setMode("review");
        recordHistory(idea, result.outcome, result.thesis);
        return;
      }

      const pack = buildEvidencePack({
        symbol: gate.symbol,
        timeframe: gate.timeframe,
        evaluation: gate.evaluation,
        assessment: gate.assessment,
        chartStructure: gate.chartStructure,
        externalContext: gate.externalContext,
        econCalendar,
      });
      const anchor = computeDeskAnchor(idea, gate.assessment);
      const system = buildDeskSystem(idea, anchor, pack);

      setReviewIdea(idea);
      setReviewAnchor(anchor);
      setReviewPack(pack);
      setReviewSystem(system);
      setReviewResult(null);
      setReviewStreamText("");
      setFollowups([]);
      setError(null);
      setMode("review");

      if (!aiReady) {
        setError("AI configuration is missing. Please configure an AI provider in Settings.");
        return;
      }

      setReviewStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const completion = await runAiStreamWithFallback({
          settings: aiSettings,
          system,
          messages: [{ role: "user", content: "Review this idea now." }],
          signal: controller.signal,
          onDelta: (frag) => setReviewStreamText((t) => t + frag),
          // A provider that dies mid-stream leaves half a sentence on screen;
          // clear it before the next one starts writing.
          onRestart: () => setReviewStreamText(""),
        });
        setAiSource(completion.model);
        const result = parseDeskReview(completion.text, anchor, pack);
        setReviewResult(result);
        recordHistory(idea, result.outcome, result.thesis);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        setReviewStreaming(false);
      }
    },
    [aiSettings, aiReady, context, recordHistory, econCalendar],
  );

  // Follow-up question scoped to the rendered review's system prompt.
  const handleFollowupSubmit = useCallback(
    async (text: string) => {
      if (!reviewIdea || !reviewResult || !reviewSystem) return;
      setQuestion("");
      setError(null);

      if (!aiReady) {
        setFollowups((f) => [
          ...f,
          { role: "user", text },
          {
            role: "assistant",
            text: "AI configuration is missing. Please configure an AI provider in Settings.",
          },
        ]);
        return;
      }

      const priorFollowups = followups;
      setFollowups((f) => [...f, { role: "user", text }]);
      setFollowupStreaming(true);
      setFollowupStreamText("");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const followupSystem = `${reviewSystem}\n\nFollow-up mode: answer in concise grounded Markdown prose, still citing evidence IDs in square brackets; do not output JSON again.`;
        // The idea + the review's own raw JSON anchor the thread; only the
        // last 8 follow-up exchanges ride along after that.
        const history: AiMessage[] = [
          { role: "user", content: reviewIdea.rawText },
          { role: "assistant", content: reviewResult.raw },
          ...priorFollowups.slice(-8).map((m) => ({ role: m.role, content: m.text })),
          { role: "user", content: text },
        ];
        const completion = await runAiStreamWithFallback({
          settings: aiSettings,
          system: followupSystem,
          messages: history,
          signal: controller.signal,
          onDelta: (frag) => setFollowupStreamText((t) => t + frag),
          onRestart: () => setFollowupStreamText(""),
        });
        setAiSource(completion.model);
        setFollowups((f) => [...f, { role: "assistant", text: completion.text }]);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Request failed.");
        setFollowups((f) => [
          ...f,
          { role: "assistant", text: "Sorry, I encountered an error answering that request." },
        ]);
      } finally {
        setFollowupStreaming(false);
        setFollowupStreamText("");
      }
    },
    [aiSettings, aiReady, reviewIdea, reviewResult, reviewSystem, followups],
  );

  const handleSend = useCallback(() => {
    const text = question.trim();
    if (!text || busy) return;
    if (mode === "review" && reviewResult && reviewSystem) {
      void handleFollowupSubmit(text);
    } else if (mode === "chat") {
      setQuestion("");
      void runChatAnalysis(text);
    } else {
      void handleComposerSubmit(text);
    }
  }, [
    question,
    busy,
    mode,
    reviewResult,
    reviewSystem,
    handleFollowupSubmit,
    runChatAnalysis,
    handleComposerSubmit,
  ]);

  const toggleDirection = useCallback(() => {
    setParsedIdea((idea) =>
      idea ? { ...idea, direction: idea.direction === "long" ? "short" : "long" } : idea,
    );
  }, []);

  const cycleObjective = useCallback(() => {
    setParsedIdea((idea) => {
      if (!idea) return idea;
      const idx = idea.intent ? INTENTS.findIndex((d) => d.intent === idea.intent) : -1;
      const next = INTENTS[(idx + 1) % INTENTS.length];
      return { ...idea, intent: next.intent };
    });
  }, []);

  if (!open) return null;

  const composerPlaceholder =
    mode === "review" && reviewResult && reviewSystem
      ? "Ask a follow-up…"
      : "Describe a trade idea or ask a question…";
  const showComposerInput = mode !== "chips" && mode !== "summary";
  const showNewReviewButton = mode === "review" || mode === "summary";

  return (
    <div className="w-80 border-l border-border bg-background flex flex-col shrink-0">
      <div className="flex items-center justify-between p-5 border-b border-border/50">
        <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">
          AI Desk Review {context?.symbol ? `· ${context.symbol}` : ""}
        </h2>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Standing disclaimer: the model narrates the engine's context, it does
          not verify it, and it can be confidently wrong. */}
      <p className="border-b border-border/50 bg-warning-soft/40 px-5 py-2 text-[10px] leading-snug text-muted-foreground">
        AI can make mistakes — it may misread the data or state something false. Treat this as a
        second opinion, verify against the chart and your own plan, and never trade on it alone.
      </p>

      <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-6">
        {mode === "composer" && (
          <>
            <p className="text-sm text-muted-foreground">
              Describe a trade idea in plain words — symbol, direction, and how long you&apos;d hold
              it — and the desk will pressure-test it against the engine&apos;s evidence
              {context?.symbol ? ` for ${context.symbol}` : ""}.
            </p>
            <div className="flex flex-col gap-3">
              <PromptSuggestion
                icon={<TrendingUp className="w-4 h-4 text-bullish" />}
                text={
                  context?.symbol
                    ? `Try: "Long ${context.symbol} for the next few hours"`
                    : 'Try: "Long BTC for the next few hours"'
                }
                onClick={() =>
                  handleComposerSubmit(
                    context?.symbol
                      ? `Long ${context.symbol} for the next few hours`
                      : "Long BTC for the next few hours",
                  )
                }
              />
              <PromptSuggestion
                icon={<Sparkles className="w-4 h-4 text-info" />}
                text='Or just ask: "Why is the market Risk On today?"'
                onClick={() => handleComposerSubmit("Why is the market Risk On today?")}
              />
            </div>
            {parsing && (
              <div className="flex items-center gap-2 text-muted-foreground text-xs italic ml-1">
                <Bot className="w-3.5 h-3.5 animate-pulse" /> Reading your idea...
              </div>
            )}
            {reviews.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Recent desk reviews
                </p>
                <div className="flex flex-col gap-1">
                  {reviews.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setSummaryEntry(r);
                        setMode("summary");
                      }}
                      className="flex items-center gap-2 rounded-lg border border-border/40 bg-surface/30 px-2.5 py-2 text-left hover:bg-surface/60 transition-colors"
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          OUTCOME_STYLES[r.outcome].dot,
                        )}
                      />
                      <span className="text-xs text-foreground/90 flex-1 truncate">
                        {r.direction ? r.direction.toUpperCase() : "?"} {r.symbol ?? "?"}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {ageFromIso(r.at)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {mode === "chips" && parsedIdea && (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                setParsedIdea(null);
                setMode("composer");
              }}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground w-fit"
            >
              <ArrowLeft className="w-3 h-3" /> Start over
            </button>
            <p className="text-xs text-muted-foreground">I read this as:</p>
            <div className="flex flex-wrap gap-1.5">
              {parsedIdea.symbol && <Chip>{parsedIdea.symbol}</Chip>}
              {parsedIdea.direction && (
                <button
                  onClick={toggleDirection}
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-semibold",
                    parsedIdea.direction === "long"
                      ? "border-bullish/30 bg-bullish-soft text-bullish"
                      : "border-bearish/30 bg-bearish-soft text-bearish",
                  )}
                >
                  {parsedIdea.direction === "long" ? (
                    <TrendingUp className="w-3 h-3" />
                  ) : (
                    <TrendingDown className="w-3 h-3" />
                  )}
                  {parsedIdea.direction.toUpperCase()}
                </button>
              )}
              <button
                onClick={cycleObjective}
                className="px-2.5 py-1 rounded-full border border-info/30 bg-info-soft text-info text-xs font-medium"
              >
                {parsedIdea.intent
                  ? (() => {
                      const def = INTENTS.find((d) => d.intent === parsedIdea.intent);
                      return def ? `${def.label} · ~${def.horizon}` : "objective unclear";
                    })()
                  : "objective unclear (tap to set)"}
              </button>
              {parsedIdea.entry !== undefined && <Chip>entry {parsedIdea.entry}</Chip>}
              {parsedIdea.stop !== undefined && <Chip>stop {parsedIdea.stop}</Chip>}
              {parsedIdea.target !== undefined && <Chip>target {parsedIdea.target}</Chip>}
            </div>
            {parsedIdea.intent === "scalp" && parsedIdea.horizonNote && (
              <p className="text-[10px] text-muted-foreground italic leading-relaxed">
                {parsedIdea.horizonNote}
              </p>
            )}
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => runDeskReview(parsedIdea)}
                className="flex-1 rounded-lg bg-info text-info-foreground text-xs font-semibold py-2.5 hover:opacity-90 transition-opacity"
              >
                Run desk review
              </button>
              <button
                onClick={() => {
                  const text = parsedIdea.rawText;
                  setParsedIdea(null);
                  setMode("chat");
                  runChatAnalysis(text);
                }}
                className="flex-1 rounded-lg border border-border bg-surface/50 text-xs font-semibold py-2.5 hover:bg-surface transition-colors"
              >
                Ask as question
              </button>
            </div>
          </div>
        )}

        {mode === "chat" && (
          <div className="flex flex-col gap-4">
            {chat.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex flex-col gap-1.5",
                  msg.role === "user" ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "px-4 py-2.5 rounded-2xl text-sm max-w-[90%]",
                    msg.role === "user"
                      ? "bg-info text-info-foreground rounded-tr-sm"
                      : "bg-surface border border-border/50 text-foreground rounded-tl-sm",
                  )}
                >
                  {msg.role === "user" ? (
                    msg.text
                  ) : (
                    <div className="prose prose-sm dark:prose-invert text-xs leading-relaxed max-w-none">
                      <MarkdownText text={msg.text} />
                    </div>
                  )}
                </div>
                {msg.source && msg.role === "assistant" && (
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wider ml-1">
                    {msg.source}
                  </span>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="flex items-center gap-2 text-muted-foreground text-xs italic ml-1">
                <Bot className="w-3.5 h-3.5 animate-pulse" /> Generating analysis...
              </div>
            )}
          </div>
        )}

        {mode === "review" && reviewIdea && reviewAnchor && (
          <div className="flex flex-col gap-4">
            {reviewStreaming && !reviewResult && (
              <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-surface/30 p-3">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Bot className="w-4 h-4 animate-pulse text-info shrink-0" />
                  Desk reviewing {reviewIdea.symbol} {reviewIdea.direction}…
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70 leading-snug break-all line-clamp-3">
                  {reviewStreamText.length > 0
                    ? `${reviewStreamText.length} chars · …${reviewStreamText.slice(-120)}`
                    : "waiting for the model…"}
                </p>
              </div>
            )}

            {reviewResult && (
              <VerdictCard
                idea={reviewIdea}
                anchor={reviewAnchor}
                result={reviewResult}
                pack={reviewPack}
                model={aiSource ?? undefined}
                showOpenPageLink={
                  reviewResult.outcome === "no-evidence" &&
                  reviewIdea.symbol !== null &&
                  (!context?.symbol ||
                    context.symbol.toUpperCase() !== reviewIdea.symbol.toUpperCase())
                }
              />
            )}

            {reviewResult && reviewSystem && (
              <div className="flex flex-col gap-3">
                {followups.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex flex-col gap-1",
                      m.role === "user" ? "items-end" : "items-start",
                    )}
                  >
                    <div
                      className={cn(
                        "px-3 py-2 rounded-xl text-xs max-w-[92%]",
                        m.role === "user"
                          ? "bg-info text-info-foreground rounded-tr-sm"
                          : "bg-surface border border-border/50 text-foreground rounded-tl-sm",
                      )}
                    >
                      {m.role === "user" ? m.text : <MarkdownText text={m.text} />}
                    </div>
                  </div>
                ))}
                {followupStreaming && (
                  <div className="flex flex-col gap-1 items-start">
                    <div className="px-3 py-2 rounded-xl text-xs max-w-[92%] bg-surface border border-border/50 text-foreground rounded-tl-sm">
                      <MarkdownText text={followupStreamText || "…"} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "summary" && summaryEntry && (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                setSummaryEntry(null);
                setMode("composer");
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit"
            >
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
            <div
              className={cn(
                "inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-bold tracking-wide",
                OUTCOME_STYLES[summaryEntry.outcome].classes,
              )}
            >
              {OUTCOME_STYLES[summaryEntry.outcome].label}
            </div>
            <p className="text-xs text-muted-foreground">
              {summaryEntry.direction ? summaryEntry.direction.toUpperCase() : "?"}{" "}
              {summaryEntry.symbol ?? "?"}
              {summaryEntry.intent
                ? ` · ${INTENTS.find((d) => d.intent === summaryEntry.intent)?.label.toLowerCase() ?? summaryEntry.intent}`
                : ""}{" "}
              · {ageFromIso(summaryEntry.at)} ago
            </p>
            <p className="text-sm italic text-muted-foreground">
              &quot;{summaryEntry.ideaText}&quot;
            </p>
            <p className="text-sm text-foreground/90 leading-relaxed">{summaryEntry.thesis}</p>
            <p className="text-[10px] text-muted-foreground">
              This is a stored summary — it is not re-run against live evidence.
            </p>
          </div>
        )}

        {error && (
          <div className="text-xs text-warning bg-warning/10 border border-warning/20 p-2 rounded-md">
            Error: {error}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-border/50">
        {showComposerInput && (
          <div className="relative">
            <input
              type="text"
              placeholder={composerPlaceholder}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && question.trim() && !busy) handleSend();
              }}
              className="w-full bg-surface/50 border border-border rounded-lg pl-4 pr-10 py-3 text-sm focus:outline-none focus:border-info/50 disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={!question.trim() || busy}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded bg-surface border border-border flex items-center justify-center text-info hover:bg-info hover:text-background transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {showNewReviewButton && (
          <button
            onClick={resetToComposer}
            className={cn(
              "w-full rounded-lg border border-border bg-surface/50 text-xs font-semibold py-2.5 hover:bg-surface transition-colors",
              showComposerInput && "mt-2",
            )}
          >
            New review
          </button>
        )}
        <p className="text-[10px] text-muted-foreground text-center mt-3 leading-relaxed">
          AI responses are generated and may be inaccurate. Not financial advice.
        </p>
      </div>
    </div>
  );
}

function PromptSuggestion({
  icon,
  text,
  onClick,
}: {
  icon: React.ReactNode;
  text: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-surface/30 hover:bg-surface/60 transition-colors text-left group"
    >
      <span className="text-sm text-foreground/90 group-hover:text-foreground">{text}</span>
      <span className="shrink-0 ml-3 opacity-70 group-hover:opacity-100">{icon}</span>
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2.5 py-1 rounded-full border border-border/50 bg-surface/50 text-xs text-foreground/90">
      {children}
    </span>
  );
}

function ChallengeRow({ challenge, pack }: { challenge: DeskChallenge; pack: EvidencePack }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="w-3 h-3 text-warning mt-0.5 shrink-0" />
        <p className="text-xs text-foreground/90 flex-1">{challenge.claim}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1 ml-[18px]">
        {challenge.citations.map((id) => (
          <button
            key={id}
            onClick={() => toggle(id)}
            className="px-1.5 py-0.5 rounded border border-border/50 bg-surface/50 text-[10px] font-mono text-info hover:bg-surface"
          >
            [{id}]
          </button>
        ))}
        {challenge.citations.length === 0 && (
          <span className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-soft text-[10px] text-warning">
            uncited
          </span>
        )}
      </div>
      {[...expanded].map((id) => {
        const item = pack.items.find((it) => it.id === id);
        if (!item) return null;
        return (
          <p
            key={id}
            className="ml-[18px] text-[10px] text-muted-foreground bg-surface/40 border border-border/40 rounded p-1.5"
          >
            [{id}] {item.text}
          </p>
        );
      })}
    </div>
  );
}

function EngineCeiling({ anchor }: { anchor: DeskAnchor }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/50 bg-surface/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground"
      >
        <span>{t("components.askAiSidebar.engineCeiling", { maxOutcome: anchor.maxOutcome })}</span>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <ul className="px-3 pb-2.5 flex flex-col gap-1">
          {anchor.reasons.map((r, i) => (
            <li key={i} className="text-[10px] text-muted-foreground leading-relaxed">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WarningBadges({ warnings }: { warnings: string[] }) {
  const unique = [...new Set(warnings.filter((w) => w !== "uncited-claim"))];
  if (unique.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {unique.map((w) => (
        <span
          key={w}
          className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-soft text-[9px] text-warning"
        >
          {formatWarning(w)}
        </span>
      ))}
    </div>
  );
}

function VerdictCard({
  idea,
  anchor,
  result,
  pack,
  showOpenPageLink,
  model,
}: {
  idea: TradeIdea;
  anchor: DeskAnchor;
  result: DeskReviewResult;
  pack: EvidencePack | null;
  showOpenPageLink: boolean;
  model?: string;
}) {
  const style = OUTCOME_STYLES[result.outcome];
  const def = idea.intent ? INTENTS.find((d) => d.intent === idea.intent) : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-surface/40 p-4">
      <div
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-bold tracking-wide",
          style.classes,
        )}
      >
        {style.label}
      </div>
      <p className="text-xs text-muted-foreground">
        {idea.direction ? idea.direction.toUpperCase() : "?"} {idea.symbol ?? "?"}
        {def ? ` · ${def.label.toLowerCase()} · ~${def.horizon}` : ""}
      </p>

      {result.thesis && (
        <p className="text-sm text-foreground/90 leading-relaxed">{result.thesis}</p>
      )}

      {showOpenPageLink && idea.symbol && (
        <Link
          to="/token/$symbol"
          params={{ symbol: idea.symbol }}
          className="text-xs text-info hover:underline w-fit"
        >
          Open the {idea.symbol} page and run the review there →
        </Link>
      )}

      {result.challenges.length > 0 && pack && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Pushback
          </p>
          {result.challenges.map((c, i) => (
            <ChallengeRow key={i} challenge={c} pack={pack} />
          ))}
        </div>
      )}

      {result.conditions.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Conditions
          </p>
          <ul className="flex flex-col gap-1">
            {result.conditions.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-foreground/90">
                <span className="mt-0.5 w-3 h-3 shrink-0 rounded-sm border border-border/70" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.invalidation && (
        <p className="text-xs text-bearish leading-relaxed">
          <span className="font-semibold">This idea dies if:</span> {result.invalidation}
        </p>
      )}

      {result.watch.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Watch
          </p>
          <ul className="flex flex-col gap-1">
            {result.watch.map((w, i) => (
              <li key={i} className="text-xs text-foreground/80">
                • {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <EngineCeiling anchor={anchor} />
      <WarningBadges warnings={result.warnings} />

      {model && (
        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{model}</p>
      )}
    </div>
  );
}
