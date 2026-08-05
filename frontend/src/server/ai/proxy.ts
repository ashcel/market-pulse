import rawChain from "./proxy-chain.json";
import { runAiAnalyst, type AiMessage } from "@/lib/ai/client";
import { isRetryable } from "@/lib/ai/chain";
import type { ProviderKind, ResolvedAiConfig } from "@/lib/ai/providers";

/**
 * Server-side AI fallback for the free tier.
 *
 * The browser gets one endpoint (`/api/ai/chat/completions`); which upstream
 * vendor actually answers is decided here, and the key never leaves the
 * server. Each entry names its own URL and model, so the chain can hop across
 * vendors on a rate limit or an outage — the failover the client cannot do
 * without being handed credentials.
 *
 * Entries are declared in `proxy-chain.json`. `keyEnv` names an environment
 * variable rather than carrying a secret, so the file is safe to commit and
 * every entry is inert until an operator sets its key.
 */

export interface ProxyEntry {
  id: string;
  label: string;
  kind: ProviderKind;
  url: string;
  model: string;
  keyEnv: string;
  enabled: boolean;
}

export interface ProxyChainConfig {
  version: number;
  chain: ProxyEntry[];
}

const VALID_KINDS = new Set<ProviderKind>(["openai", "anthropic"]);

/** Drops malformed entries rather than failing a request over a typo. */
export function parseProxyChain(input: unknown): ProxyChainConfig {
  const obj = (input ?? {}) as Partial<ProxyChainConfig>;
  const entries = Array.isArray(obj.chain) ? obj.chain : [];
  const seen = new Set<string>();
  const chain: ProxyEntry[] = [];

  for (const raw of entries) {
    const e = (raw ?? {}) as Partial<ProxyEntry>;
    if (typeof e.id !== "string" || !e.id || seen.has(e.id)) continue;
    if (!VALID_KINDS.has(e.kind as ProviderKind)) continue;
    if (typeof e.url !== "string" || !e.url) continue;
    if (typeof e.model !== "string" || !e.model) continue;
    if (typeof e.keyEnv !== "string" || !e.keyEnv) continue;
    seen.add(e.id);
    chain.push({
      id: e.id,
      label: typeof e.label === "string" && e.label ? e.label : e.id,
      kind: e.kind as ProviderKind,
      url: e.url,
      model: e.model,
      keyEnv: e.keyEnv,
      enabled: e.enabled !== false,
    });
  }
  return { version: typeof obj.version === "number" ? obj.version : 1, chain };
}

export const PROXY_CHAIN = parseProxyChain(rawChain);

export interface ProxyCandidate {
  id: string;
  label: string;
  config: ResolvedAiConfig;
}

/**
 * The chain reduced to entries whose key is actually present in `env`, in
 * declaration order. An entry with no key is skipped silently — that is how an
 * operator enables a vendor: set the variable, restart, done.
 */
export function buildProxyCandidates(
  env: Record<string, string | undefined> = process.env,
  config: ProxyChainConfig = PROXY_CHAIN,
): ProxyCandidate[] {
  const out: ProxyCandidate[] = [];
  for (const entry of config.chain) {
    if (!entry.enabled) continue;
    const apiKey = (env[entry.keyEnv] ?? "").trim();
    if (!apiKey) continue;
    out.push({
      id: entry.id,
      label: entry.label,
      config: {
        provider: "custom",
        kind: entry.kind,
        baseUrl: entry.url.replace(/\/+$/, ""),
        apiKey,
        model: entry.model,
      },
    });
  }
  return out;
}

export interface ProxyAttempt {
  id: string;
  error: string;
}

export interface ProxyResult {
  text: string;
  usedId: string;
  model: string;
  attempts: ProxyAttempt[];
}

export class NoProxyProviderError extends Error {
  constructor() {
    super("The free AI tier is not configured on this server.");
    this.name = "NoProxyProviderError";
  }
}

export class ProxyChainFailedError extends Error {
  readonly attempts: ProxyAttempt[];
  constructor(attempts: ProxyAttempt[]) {
    super("Every configured AI provider failed.");
    this.name = "ProxyChainFailedError";
    this.attempts = attempts;
  }
}

/**
 * Per-attempt ceiling. A vendor that accepts the connection and then never
 * answers is the worst failure mode in a chain: without this, one hung upstream
 * stalls the whole request and the healthy providers behind it are never tried.
 * (Observed in the wild — a free endpoint whose /models responded fine while
 * /chat/completions hung indefinitely.)
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;

export function attemptTimeoutFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.AI_PROXY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

/** A hung upstream, surfaced as a normal retryable error rather than an abort. */
export class AttemptTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${Math.round(ms / 1000)}s`);
    this.name = "AttemptTimeoutError";
  }
}

export interface RunProxyOptions {
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  config?: ProxyChainConfig;
  /** Overrides the per-attempt timeout; defaults to AI_PROXY_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Try each configured upstream until one answers. Retry semantics are the
 * client's (`isRetryable`): transport and capacity failures move on, a refusal
 * or a malformed request stops — every vendor would reject it identically, and
 * burning four free quotas on the same bad request helps nobody.
 */
export async function runProxyChain(opts: RunProxyOptions): Promise<ProxyResult> {
  const candidates = buildProxyCandidates(opts.env, opts.config);
  if (candidates.length === 0) throw new NoProxyProviderError();

  const timeoutMs = opts.timeoutMs ?? attemptTimeoutFromEnv(opts.env);
  const attempts: ProxyAttempt[] = [];

  for (const candidate of candidates) {
    // One controller per attempt, aborted by either the caller giving up or
    // this attempt running out of time. `timedOut` disambiguates the two: a
    // caller abort must stop the chain, a timeout must advance it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const text = await runAiAnalyst({
        config: candidate.config,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        signal: controller.signal,
      });
      return { text, usedId: candidate.id, model: candidate.config.model, attempts };
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const failure = timedOut ? new AttemptTimeoutError(candidate.label, timeoutMs) : error;
      attempts.push({
        id: candidate.id,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      if (!timedOut && !isRetryable(error)) break;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
  throw new ProxyChainFailedError(attempts);
}
