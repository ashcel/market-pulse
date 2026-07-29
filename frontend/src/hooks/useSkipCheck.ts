import { useCallback, useState } from "react";
import { createDecision } from "@/hooks/useDecisions";

/**
 * Skip Check client contract — mirrors
 * `backend/app/execution/skip_check_schemas.py`. Every claim is a typed
 * `code` on a typed `kind`; the string fields are deterministic templates
 * (context only, never load-bearing). "no opinion — insufficient evidence"
 * is a first-class block status, not a gap.
 */

export type SkipObjective = "scalp" | "intraday" | "swing";
export type SkipDirection = "LONG" | "SHORT";
export type VerdictStateValue = "live" | "not_yet" | "wrong_strategy" | "unknown";
export type BlockStatus = "supportive" | "caution" | "no_opinion";
export type SkipAnswerKind = "supportive" | "caution" | "no_opinion";

export type SkipBlockKind =
  | "constitution_headroom"
  | "loss_budget"
  | "portfolio_exposure"
  | "account_state"
  | "risk_reward"
  | "liquidation_buffer"
  | "behavior"
  | "objective_fit"
  | "regime_fit"
  | "catalyst_window";

export interface VerdictContextInput {
  state: VerdictStateValue;
  regime?: string | null;
  regime_aligned?: boolean | null;
  flip_condition?: string | null;
}

export interface SkipCheckRequest {
  symbol: string;
  objective: SkipObjective;
  direction: SkipDirection;
  entry_price?: number | null;
  planned_stop?: number | null;
  take_profit?: number | null;
  risk_percent?: number | null;
  leverage?: number | null;
  margin_type?: "ISOLATED" | "CROSSED";
  correlation_bucket?: string;
  verdict?: VerdictContextInput | null;
  context?: {
    catalyst?: { modifier: string; impactScore: number; direction: string } | null;
    accountFreshness?: string;
    behaviorFlags?: string[];
    tradeQualityScore?: number | null;
    invalidation?: string | null;
  };
}

export interface EvidenceItem {
  label: string;
  value: string;
}

export interface SkipBlock {
  kind: SkipBlockKind;
  status: BlockStatus;
  code: string;
  headline: string;
  detail: string;
  blocking: boolean;
  evidence: EvidenceItem[];
}

export interface WhatFlipsItItem {
  kind: SkipBlockKind;
  condition: string;
}

export interface SizingPreview {
  available: boolean;
  quantity: number | null;
  notional: number | null;
  required_margin: number | null;
  effective_leverage: number | null;
  liquidation_price: number | null;
  liquidation_model: string | null;
  risk_percent: number;
  max_risk_percent_at_leverage: number | null;
  liq_buffer_ok: boolean | null;
  is_estimate: boolean;
}

export interface CheckResultItem {
  check: string;
  passed: boolean;
  detail: string;
  group: string;
}

export interface DryRunPermitPreview {
  status: "APPROVED" | "REJECTED";
  reasons: string[];
  quality_score: number | null;
  quality_disclaimer: string | null;
  checks: CheckResultItem[];
}

export interface SkipCheckAnswer {
  symbol: string;
  objective: SkipObjective;
  direction: SkipDirection;
  answer: SkipAnswerKind;
  viable: boolean;
  headline: string;
  supportive_read: SkipBlock[];
  cautions: SkipBlock[];
  no_opinion: SkipBlock[];
  what_flips_it: WhatFlipsItItem[];
  permit_preview: DryRunPermitPreview;
  sizing: SizingPreview;
  catalyst_available: boolean;
  evaluated_at: string;
  session: string;
}

interface SkipCheckEnvelope {
  data: SkipCheckAnswer;
  meta: null;
  error: null;
}

export function useSkipCheck() {
  const [answer, setAnswer] = useState<SkipCheckAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);

  const runCheck = useCallback(async (req: SkipCheckRequest) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/execution/skip-check", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (res.status === 401) {
        throw new Error("Sign in to run a Skip Check.");
      }
      if (!res.ok) {
        throw new Error(`Skip Check failed: ${res.status}`);
      }
      const envelope = (await res.json()) as SkipCheckEnvelope;
      if (!envelope?.data?.answer) {
        throw new Error("Invalid Skip Check response from server");
      }
      setAnswer(envelope.data);
      const decision = await createDecision({
        symbol: req.symbol,
        objective: req.objective,
        direction: req.direction.toLowerCase() as "long" | "short",
        verdict_at_time: req.verdict?.state ?? "unknown",
        catalyst_modifier: req.context?.catalyst ?? null,
        skip_check_result: envelope.data as unknown as Record<string, unknown>,
        entry_zone: req.entry_price == null ? null : { entry: req.entry_price },
        stop_loss: req.planned_stop ?? null,
        take_profit: req.take_profit ?? null,
        engine_version: import.meta.env.VITE_ENGINE_VERSION ?? "current",
      });
      setDecisionId(decision.id);
      return envelope.data;
    } catch (err: unknown) {
      setError((err as Error).message || "An error occurred");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setAnswer(null);
    setError(null);
    setDecisionId(null);
  }, []);

  return { answer, decisionId, loading, error, runCheck, clear };
}
