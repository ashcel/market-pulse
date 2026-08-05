import rawChain from "./fallback-chain.json";
import { runAiAnalyst, runAiAnalystStream } from "./client";
import {
  resolveAiConfig,
  type AiProvider,
  type AiSettingsSnapshot,
  type ProviderKind,
  type ResolvedAiConfig,
} from "./providers";
import type { AiMessage } from "./client";

/**
 * Provider fallback for the AI analyst.
 *
 * The chain is declared as data (`fallback-chain.json`) so endpoints can be
 * added, reordered or disabled without touching call sites. Each entry brings
 * its own URL, wire format and model, which is what lets a Chat-Completions
 * host, the Anthropic Messages API and a same-origin proxy sit in one list.
 *
 * Rules that keep this honest:
 * - An entry is only *usable* when its credential is present. A `direct` entry
 *   whose key the user has not set is skipped, never called unauthenticated.
 * - Only transient failures fall through (network/CORS, 429, 5xx, empty reply).
 *   A user abort stops everything, and a 401/403/404 on the user's OWN provider
 *   is reported rather than silently papered over with a different vendor.
 * - No credential ever belongs in the JSON. A shared "free tier" key must sit
 *   behind a `proxy` entry, server-side; anything in this file ships to every
 *   visitor's browser.
 */

export type ChainTransport = "byok" | "direct" | "proxy";

export interface ChainEntry {
  id: string;
  label: string;
  transport: ChainTransport;
  enabled: boolean;
  kind?: ProviderKind;
  url?: string;
  model?: string;
  /** Which stored BYOK key a `direct` entry authenticates with. */
  keyFrom?: AiProvider;
}

export interface FallbackChainConfig {
  version: number;
  chain: ChainEntry[];
}

const VALID_TRANSPORTS = new Set<ChainTransport>(["byok", "direct", "proxy"]);
const VALID_KINDS = new Set<ProviderKind>(["openai", "anthropic"]);

/**
 * Validates the declared chain, dropping malformed entries rather than letting
 * a typo become a runtime crash mid-analysis. Returns entries in file order.
 */
export function parseChainConfig(input: unknown): FallbackChainConfig {
  const obj = (input ?? {}) as Partial<FallbackChainConfig>;
  const entries = Array.isArray(obj.chain) ? obj.chain : [];
  const seen = new Set<string>();
  const chain: ChainEntry[] = [];

  for (const raw of entries) {
    const e = (raw ?? {}) as Partial<ChainEntry>;
    if (typeof e.id !== "string" || !e.id || seen.has(e.id)) continue;
    if (!VALID_TRANSPORTS.has(e.transport as ChainTransport)) continue;
    if (e.transport !== "byok") {
      if (!VALID_KINDS.has(e.kind as ProviderKind)) continue;
      if (typeof e.url !== "string" || !e.url) continue;
      if (typeof e.model !== "string" || !e.model) continue;
    }
    seen.add(e.id);
    chain.push({
      id: e.id,
      label: typeof e.label === "string" && e.label ? e.label : e.id,
      transport: e.transport as ChainTransport,
      enabled: e.enabled !== false,
      kind: e.kind,
      url: e.url,
      model: e.model,
      keyFrom: e.keyFrom,
    });
  }

  return { version: typeof obj.version === "number" ? obj.version : 1, chain };
}

export const FALLBACK_CHAIN = parseChainConfig(rawChain);

export interface ChainCandidate {
  id: string;
  label: string;
  transport: ChainTransport;
  config: ResolvedAiConfig;
}

/**
 * The chain reduced to entries that can actually be called right now, in
 * order, with duplicates removed — if the user's own provider is OpenRouter,
 * the OpenRouter fallback entry is not worth a second attempt with the same
 * key, URL and model.
 */
export function buildCandidates(
  settings: AiSettingsSnapshot,
  config: FallbackChainConfig = FALLBACK_CHAIN,
): ChainCandidate[] {
  const out: ChainCandidate[] = [];
  const fingerprints = new Set<string>();

  const push = (candidate: ChainCandidate) => {
    const fp = `${candidate.config.baseUrl}|${candidate.config.model}|${candidate.config.apiKey}`;
    if (fingerprints.has(fp)) return;
    fingerprints.add(fp);
    out.push(candidate);
  };

  for (const entry of config.chain) {
    if (!entry.enabled) continue;

    if (entry.transport === "byok") {
      const resolved = resolveAiConfig(settings);
      if (resolved) {
        push({ id: entry.id, label: entry.label, transport: entry.transport, config: resolved });
      }
      continue;
    }

    if (entry.transport === "proxy") {
      // The server holds the credential; the browser sends none.
      push({
        id: entry.id,
        label: entry.label,
        transport: entry.transport,
        config: {
          provider: "custom",
          kind: entry.kind ?? "openai",
          baseUrl: entry.url!.replace(/\/+$/, ""),
          apiKey: "",
          model: entry.model!,
        },
      });
      continue;
    }

    // direct: usable only when the key it names is stored.
    const apiKey = (entry.keyFrom ? (settings.apiKeys[entry.keyFrom] ?? "") : "").trim();
    if (!apiKey) continue;
    push({
      id: entry.id,
      label: entry.label,
      transport: entry.transport,
      config: {
        provider: entry.keyFrom ?? "custom",
        kind: entry.kind ?? "openai",
        baseUrl: entry.url!.replace(/\/+$/, ""),
        apiKey,
        model: entry.model!,
      },
    });
  }

  return out;
}

/** A user abort must never be retried against another provider. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Whether a failed attempt is worth retrying elsewhere. Transport-level and
 * capacity problems are; a refusal or a malformed request is a property of the
 * request, and every provider would reject it the same way.
 */
export function isRetryable(error: unknown): boolean {
  if (isAbort(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/declined this request/i.test(message)) return false;
  if (/\b(400|422)\b/.test(message)) return false;
  return true;
}

export interface ChainAttempt {
  id: string;
  label: string;
  error: string;
}

export interface ChainResult {
  text: string;
  /** The candidate that produced the text. */
  usedId: string;
  usedLabel: string;
  model: string;
  /** Everything that failed before it, in order. Empty on a first-try success. */
  attempts: ChainAttempt[];
}

export class NoAiProviderError extends Error {
  constructor() {
    super("No AI provider is configured. Add a key in Settings to enable analysis.");
    this.name = "NoAiProviderError";
  }
}

/** Thrown when every candidate failed; carries the per-provider detail. */
export class AllProvidersFailedError extends Error {
  readonly attempts: ChainAttempt[];
  constructor(attempts: ChainAttempt[]) {
    const detail = attempts.map((a) => `${a.label}: ${a.error}`).join(" · ");
    super(`Every AI provider failed. ${detail}`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

export interface RunChainOptions {
  settings: AiSettingsSnapshot;
  system: string;
  messages: AiMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  config?: FallbackChainConfig;
  /** Notified before each attempt — lets the UI say which provider is being tried. */
  onAttempt?: (candidate: ChainCandidate, index: number) => void;
}

/** Non-streaming run: try each usable candidate until one returns text. */
export async function runAiWithFallback(opts: RunChainOptions): Promise<ChainResult> {
  const candidates = buildCandidates(opts.settings, opts.config);
  if (candidates.length === 0) throw new NoAiProviderError();

  const attempts: ChainAttempt[] = [];
  for (const [index, candidate] of candidates.entries()) {
    opts.onAttempt?.(candidate, index);
    try {
      const text = await runAiAnalyst({
        config: candidate.config,
        system: opts.system,
        messages: opts.messages,
        signal: opts.signal,
        maxTokens: opts.maxTokens,
      });
      return {
        text,
        usedId: candidate.id,
        usedLabel: candidate.label,
        model: candidate.config.model,
        attempts,
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      attempts.push({
        id: candidate.id,
        label: candidate.label,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isRetryable(error)) break;
    }
  }
  throw new AllProvidersFailedError(attempts);
}

export interface RunChainStreamOptions extends RunChainOptions {
  onDelta: (fragment: string) => void;
  /**
   * Called when a provider fails *after* emitting text, so the caller can clear
   * the partial output before the next provider starts writing over it.
   */
  onRestart?: () => void;
}

/**
 * Streaming run. A provider that fails before emitting anything falls through
 * silently; one that fails mid-stream can only be retried by discarding what it
 * already wrote, so `onRestart` fires first and the caller resets its buffer.
 */
export async function runAiStreamWithFallback(opts: RunChainStreamOptions): Promise<ChainResult> {
  const candidates = buildCandidates(opts.settings, opts.config);
  if (candidates.length === 0) throw new NoAiProviderError();

  const attempts: ChainAttempt[] = [];
  for (const [index, candidate] of candidates.entries()) {
    opts.onAttempt?.(candidate, index);
    let emitted = false;
    try {
      const text = await runAiAnalystStream({
        config: candidate.config,
        system: opts.system,
        messages: opts.messages,
        signal: opts.signal,
        maxTokens: opts.maxTokens,
        onDelta: (fragment) => {
          emitted = true;
          opts.onDelta(fragment);
        },
      });
      return {
        text,
        usedId: candidate.id,
        usedLabel: candidate.label,
        model: candidate.config.model,
        attempts,
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      attempts.push({
        id: candidate.id,
        label: candidate.label,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isRetryable(error)) break;
      if (emitted) opts.onRestart?.();
    }
  }
  throw new AllProvidersFailedError(attempts);
}
