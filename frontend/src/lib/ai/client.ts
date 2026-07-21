// Unified BYOK chat client. One `runAiAnalyst` entry point dispatches to the
// OpenAI Chat Completions format or the Anthropic Messages format based on the
// resolved provider. Called directly from the browser so keys stay on-device.

import type { ResolvedAiConfig } from "./providers";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RunAiAnalystOptions {
  config: ResolvedAiConfig;
  system: string;
  messages: AiMessage[];
  signal?: AbortSignal;
  /** Output token ceiling. Kept modest — the analyst memo is short. */
  maxTokens?: number;
}

export interface RunAiAnalystStreamOptions extends RunAiAnalystOptions {
  /** Called with each incremental text fragment as it arrives. */
  onDelta: (textFragment: string) => void;
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 2048;

/** Human-friendly message for a non-2xx response. */
function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const err = parsed.error;
    detail = (typeof err === "string" ? err : err?.message) ?? parsed.message ?? "";
  } catch {
    detail = body.slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return `Auth failed (${status}). Check your API key.${detail ? ` — ${detail}` : ""}`;
  }
  if (status === 404) {
    return `Not found (404). Check the model name and base URL.${detail ? ` — ${detail}` : ""}`;
  }
  if (status === 429) {
    return `Rate limited (429). Slow down or check your plan.${detail ? ` — ${detail}` : ""}`;
  }
  return `Provider error ${status}${detail ? `: ${detail}` : ""}`;
}

/** Wraps a fetch, normalising network/CORS failures into a clear message. */
async function post(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      "Couldn't reach the provider (network or CORS). If this is a self-hosted endpoint, make sure it allows browser requests.",
    );
  }
}

// --- SSE streaming helpers -------------------------------------------------
//
// Both providers' streaming responses are newline-delimited `data: <json>`
// events. `parseSseLines` is a pure function (no I/O) so the chunk-boundary
// buffering logic can be unit-tested with plain strings; `readSseData` wraps
// it around a real `ReadableStream` reader.

/**
 * Splits a raw SSE chunk into complete `data:` payload lines (prefix
 * stripped), carrying any trailing partial line forward to the next call.
 * Non-`data:` lines (`event:`, `id:`, blank keep-alives, etc.) are dropped —
 * both providers put everything we need in the JSON payload itself.
 */
export function parseSseLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split("\n");
  // The final part may be an incomplete line (no trailing "\n" yet) — hold it.
  const nextCarry = parts.pop() ?? "";
  const lines: string[] = [];
  for (const raw of parts) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("data: ")) {
      lines.push(line.slice("data: ".length));
    } else if (line.startsWith("data:")) {
      lines.push(line.slice("data:".length));
    }
  }
  return { lines, carry: nextCarry };
}

/** Reads a response body as SSE, yielding each `data:` payload as it arrives. */
async function* readSseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const { lines, carry: nextCarry } = parseSseLines(
        carry,
        decoder.decode(value, { stream: true }),
      );
      carry = nextCarry;
      yield* lines;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed/errored — nothing more to clean up.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released via cancel() above.
    }
  }
}

async function runOpenAiCompatible(opts: RunAiAnalystOptions): Promise<string> {
  const { config, system, messages, signal, maxTokens = DEFAULT_MAX_TOKENS } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
  // OpenRouter attribution headers — ignored by other OpenAI-compatible servers.
  if (config.provider === "openrouter") {
    headers["X-Title"] = "Market Pulse IQ";
    if (typeof window !== "undefined") headers["HTTP-Referer"] = window.location.origin;
  }

  const cleanBaseUrl = config.baseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const res = await post(`${cleanBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  if (!res.ok) throw new Error(describeHttpError(res.status, await res.text()));

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The model returned an empty response.");
  return text;
}

async function runAnthropic(opts: RunAiAnalystOptions): Promise<string> {
  const { config, system, messages, signal, maxTokens = DEFAULT_MAX_TOKENS } = opts;
  const cleanBaseUrl = config.baseUrl.replace(/\/v1\/messages\/?$/, "").replace(/\/$/, "");
  const res = await post(`${cleanBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // Required to call the Messages API directly from a browser (BYOK).
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) throw new Error(describeHttpError(res.status, await res.text()));

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  if (data.stop_reason === "refusal") {
    throw new Error("Claude declined this request.");
  }
  const text =
    data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim() ?? "";
  if (!text) throw new Error("The model returned an empty response.");
  return text;
}

/** Run one analyst completion against the configured provider. */
export function runAiAnalyst(opts: RunAiAnalystOptions): Promise<string> {
  return opts.config.kind === "anthropic" ? runAnthropic(opts) : runOpenAiCompatible(opts);
}

async function runOpenAiCompatibleStream(opts: RunAiAnalystStreamOptions): Promise<string> {
  const { config, system, messages, signal, maxTokens = DEFAULT_MAX_TOKENS, onDelta } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
  // OpenRouter attribution headers — ignored by other OpenAI-compatible servers.
  if (config.provider === "openrouter") {
    headers["X-Title"] = "Market Pulse IQ";
    if (typeof window !== "undefined") headers["HTTP-Referer"] = window.location.origin;
  }

  const cleanBaseUrl = config.baseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const res = await post(`${cleanBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(describeHttpError(res.status, await res.text()));

  // Some OpenAI-compatible servers ignore `stream: true` and return one JSON
  // body — fall back to the non-streaming shape rather than hanging on SSE.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("The model returned an empty response.");
    onDelta(text);
    return text;
  }

  let full = "";
  for await (const line of readSseData(res)) {
    const payload = line.trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed: { choices?: { delta?: { content?: string | null } }[] };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const fragment = parsed.choices?.[0]?.delta?.content;
    if (typeof fragment === "string" && fragment.length > 0) {
      full += fragment;
      onDelta(fragment);
    }
  }

  const text = full.trim();
  if (!text) throw new Error("The model returned an empty response.");
  return text;
}

async function runAnthropicStream(opts: RunAiAnalystStreamOptions): Promise<string> {
  const { config, system, messages, signal, maxTokens = DEFAULT_MAX_TOKENS, onDelta } = opts;
  const cleanBaseUrl = config.baseUrl.replace(/\/v1\/messages\/?$/, "").replace(/\/$/, "");
  const res = await post(`${cleanBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // Required to call the Messages API directly from a browser (BYOK).
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(describeHttpError(res.status, await res.text()));

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
    };
    if (data.stop_reason === "refusal") {
      throw new Error("Claude declined this request.");
    }
    const text =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim() ?? "";
    if (!text) throw new Error("The model returned an empty response.");
    onDelta(text);
    return text;
  }

  let full = "";
  for await (const line of readSseData(res)) {
    const payload = line.trim();
    if (!payload) continue;
    let event: {
      type?: string;
      delta?: { type?: string; text?: string; stop_reason?: string };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const fragment = event.delta.text ?? "";
      if (fragment) {
        full += fragment;
        onDelta(fragment);
      }
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason === "refusal") {
        throw new Error("Claude declined this request.");
      }
    } else if (event.type === "error") {
      throw new Error(event.error?.message ?? "The provider returned a stream error.");
    }
  }

  const text = full.trim();
  if (!text) throw new Error("The model returned an empty response.");
  return text;
}

/** Run one analyst completion against the configured provider, streaming incremental text via `onDelta`. */
export function runAiAnalystStream(opts: RunAiAnalystStreamOptions): Promise<string> {
  return opts.config.kind === "anthropic"
    ? runAnthropicStream(opts)
    : runOpenAiCompatibleStream(opts);
}
