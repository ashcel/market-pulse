import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "@/server/auth/session";
import { AiRateLimiter, callerKey, limitsFromEnv } from "@/server/ai/rate-limit";
import {
  NoProxyProviderError,
  ProxyChainFailedError,
  buildProxyCandidates,
  runProxyChain,
} from "@/server/ai/proxy";
import type { AiMessage } from "@/lib/ai/client";

/**
 * The free-tier AI endpoint: one URL for the browser, an operator-configured
 * fallback chain behind it (`server/ai/proxy.ts`). Keys stay server-side, and
 * a rate limit stands between a public page and the operator's quota.
 *
 * Speaks the OpenAI Chat Completions request/response shape, so the existing
 * BYOK client can point at it as just another `openai`-kind endpoint with no
 * special-casing. Non-streaming on purpose: the client's stream path already
 * falls back to a single JSON body when the response is not an event stream.
 */

/** Ceiling on what one call may cost, regardless of what the client asks for. */
const MAX_OUTPUT_TOKENS = 1200;
/**
 * Floor on the output budget. Free tiers are mostly reasoning models, which
 * spend the budget on hidden reasoning tokens before writing a single visible
 * character — ask one for 10 tokens and it returns an empty `content`. Callers
 * that legitimately want a one-line answer (the tracker verdict asks for 120)
 * would otherwise read as "provider broken" and burn the whole chain.
 */
const MIN_OUTPUT_TOKENS = 512;
/** Total characters of prompt accepted. Long enough for an evidence pack. */
const MAX_INPUT_CHARS = 24_000;
const MAX_MESSAGES = 24;

const limiter = new AiRateLimiter(limitsFromEnv());

interface ChatCompletionsBody {
  messages?: { role?: string; content?: unknown }[];
  max_tokens?: unknown;
}

/** Splits the OpenAI-style message list into a system prompt + turn history. */
export function splitMessages(raw: ChatCompletionsBody["messages"]): {
  system: string;
  messages: AiMessage[];
  chars: number;
} {
  const system: string[] = [];
  const messages: AiMessage[] = [];
  let chars = 0;
  for (const m of raw ?? []) {
    const content = typeof m?.content === "string" ? m.content : "";
    if (!content) continue;
    chars += content.length;
    if (m?.role === "system") system.push(content);
    else if (m?.role === "assistant") messages.push({ role: "assistant", content });
    else messages.push({ role: "user", content });
  }
  return { system: system.join("\n\n"), messages, chars };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const Route = createFileRoute("/api/ai/chat/completions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (buildProxyCandidates().length === 0) {
          return json({ error: { message: "The free AI tier is not enabled here." } }, 503);
        }

        const auth = await getAuth(request);
        const decision = limiter.check(callerKey(auth?.user.id ?? null, request));
        if (!decision.allowed) {
          return json(
            {
              error: {
                message:
                  decision.reason === "daily"
                    ? "The free tier's daily budget is spent. Add your own API key in Settings to keep going."
                    : "Rate limit reached for the free tier. Try again later, or add your own API key in Settings.",
              },
            },
            429,
            {
              "retry-after": String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))),
            },
          );
        }

        let body: ChatCompletionsBody;
        try {
          body = (await request.json()) as ChatCompletionsBody;
        } catch {
          return json({ error: { message: "invalid body" } }, 400);
        }

        const { system, messages, chars } = splitMessages(body.messages);
        if (messages.length === 0) return json({ error: { message: "messages required" } }, 400);
        if (messages.length > MAX_MESSAGES || chars > MAX_INPUT_CHARS) {
          return json({ error: { message: "Prompt too large for the free tier." } }, 413);
        }

        const requested = Number(body.max_tokens);
        const maxTokens =
          Number.isFinite(requested) && requested > 0
            ? Math.min(Math.max(Math.floor(requested), MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS)
            : MAX_OUTPUT_TOKENS;

        try {
          const result = await runProxyChain({
            system,
            messages,
            maxTokens,
            signal: request.signal,
          });
          // OpenAI-shaped so the BYOK client parses it unchanged. `model`
          // reports whichever upstream actually answered.
          return json(
            {
              id: `mp-${Date.now()}`,
              object: "chat.completion",
              model: result.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: result.text },
                  finish_reason: "stop",
                },
              ],
            },
            200,
            { "x-mp-provider": result.usedId, "x-mp-remaining": String(decision.remaining) },
          );
        } catch (error) {
          if (error instanceof NoProxyProviderError) {
            return json({ error: { message: error.message } }, 503);
          }
          if (error instanceof ProxyChainFailedError) {
            // Upstream detail is logged, not returned: it can name vendors and
            // quote provider-side messages the caller has no business seeing.
            console.error("[ai-proxy] all upstreams failed", error.attempts);
            return json(
              { error: { message: "No AI provider is available right now. Try again shortly." } },
              502,
            );
          }
          console.error("[ai-proxy] unexpected failure", error);
          return json({ error: { message: "AI request failed." } }, 500);
        }
      },
    },
  },
});
