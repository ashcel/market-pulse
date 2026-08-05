import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AllProvidersFailedError,
  FALLBACK_CHAIN,
  NoAiProviderError,
  buildCandidates,
  isRetryable,
  parseChainConfig,
  runAiStreamWithFallback,
  runAiWithFallback,
  type FallbackChainConfig,
} from "./chain";
import type { AiSettingsSnapshot } from "./providers";

vi.mock("./client", () => ({
  runAiAnalyst: vi.fn(),
  runAiAnalystStream: vi.fn(),
}));

import { runAiAnalyst, runAiAnalystStream } from "./client";

const mockRun = vi.mocked(runAiAnalyst);
const mockStream = vi.mocked(runAiAnalystStream);

afterEach(() => {
  // resetAllMocks, not clearAllMocks: the latter leaves queued `…Once`
  // implementations in place, which then leak into the next test.
  vi.resetAllMocks();
});

function settings(over: Partial<AiSettingsSnapshot> = {}): AiSettingsSnapshot {
  return {
    provider: "openrouter",
    apiKeys: {},
    models: {},
    customBaseUrl: "",
    ...over,
  };
}

const chain: FallbackChainConfig = {
  version: 1,
  chain: [
    { id: "byok", label: "Your provider", transport: "byok", enabled: true },
    {
      id: "openai-mini",
      label: "OpenAI mini",
      transport: "direct",
      kind: "openai",
      url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      keyFrom: "openai",
      enabled: true,
    },
    {
      id: "claude",
      label: "Claude",
      transport: "direct",
      kind: "anthropic",
      url: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
      keyFrom: "anthropic",
      enabled: true,
    },
  ],
};

/** All three chain entries usable: the user is on OpenRouter and has both fallback keys. */
const ALL_KEYS = { openrouter: "k-or", openai: "k-openai", anthropic: "k-claude" };

const run = (over: Partial<Parameters<typeof runAiWithFallback>[0]> = {}) =>
  runAiWithFallback({
    settings: settings({ apiKeys: ALL_KEYS }),
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    config: chain,
    ...over,
  });

describe("parseChainConfig", () => {
  it("drops entries that could not be called", () => {
    const parsed = parseChainConfig({
      version: 1,
      chain: [
        { id: "ok", transport: "direct", kind: "openai", url: "https://x/v1", model: "m" },
        { id: "no-url", transport: "direct", kind: "openai", model: "m" },
        { id: "no-model", transport: "direct", kind: "openai", url: "https://x/v1" },
        { id: "bad-kind", transport: "direct", kind: "grpc", url: "https://x/v1", model: "m" },
        { id: "bad-transport", transport: "carrier-pigeon" },
        { transport: "byok" },
      ],
    });
    expect(parsed.chain.map((c) => c.id)).toEqual(["ok"]);
  });

  it("keeps a byok entry without url or model, since those come from settings", () => {
    const parsed = parseChainConfig({ chain: [{ id: "byok", transport: "byok" }] });
    expect(parsed.chain).toHaveLength(1);
    expect(parsed.chain[0].label).toBe("byok");
    expect(parsed.chain[0].enabled).toBe(true);
  });

  it("rejects duplicate ids and survives junk input", () => {
    const dup = parseChainConfig({
      chain: [
        { id: "a", transport: "byok" },
        { id: "a", transport: "byok" },
      ],
    });
    expect(dup.chain).toHaveLength(1);
    expect(parseChainConfig(null).chain).toEqual([]);
    expect(parseChainConfig({ chain: "nope" }).chain).toEqual([]);
  });
});

describe("the shipped chain", () => {
  it("parses, and tries the user's own provider first", () => {
    expect(FALLBACK_CHAIN.chain.length).toBeGreaterThan(1);
    expect(FALLBACK_CHAIN.chain[0].transport).toBe("byok");
  });

  it("never carries a credential in the config file", () => {
    for (const entry of FALLBACK_CHAIN.chain) {
      expect(Object.keys(entry)).not.toContain("apiKey");
      expect(JSON.stringify(entry)).not.toMatch(/sk-[a-z0-9-]/i);
    }
  });
});

describe("buildCandidates", () => {
  it("skips direct entries whose key is not stored", () => {
    const only = buildCandidates(settings({ apiKeys: { openai: "k" } }), chain);
    expect(only.map((c) => c.id)).toEqual(["openai-mini"]);
  });

  it("puts the configured provider first, then the keyed fallbacks", () => {
    const built = buildCandidates(
      settings({
        provider: "openai",
        apiKeys: { openai: "k-openai", anthropic: "k-claude" },
        models: { openai: "gpt-4o" },
      }),
      chain,
    );
    expect(built.map((c) => c.id)).toEqual(["byok", "openai-mini", "claude"]);
    expect(built[0].config.model).toBe("gpt-4o");
  });

  it("does not queue the same url+model+key twice", () => {
    const built = buildCandidates(
      settings({ provider: "openai", apiKeys: { openai: "k" }, models: { openai: "gpt-4o-mini" } }),
      chain,
    );
    // BYOK openai resolves to the exact endpoint the openai-mini entry names.
    expect(built.map((c) => c.id)).toEqual(["byok"]);
  });

  it("keeps a proxy entry without a key and strips its trailing slash", () => {
    const built = buildCandidates(settings(), {
      version: 1,
      chain: [
        {
          id: "house",
          label: "House",
          transport: "proxy",
          kind: "openai",
          url: "/api/ai/completions/",
          model: "server-selected",
          enabled: true,
        },
      ],
    });
    expect(built[0].config.apiKey).toBe("");
    expect(built[0].config.baseUrl).toBe("/api/ai/completions");
  });

  it("honours enabled:false", () => {
    const built = buildCandidates(settings({ apiKeys: { openai: "k" } }), {
      version: 1,
      chain: [{ ...chain.chain[1], enabled: false }],
    });
    expect(built).toEqual([]);
  });
});

describe("isRetryable", () => {
  it("moves on for transport and capacity failures", () => {
    expect(isRetryable(new Error("Rate limited (429)."))).toBe(true);
    expect(isRetryable(new Error("Provider error 503"))).toBe(true);
    expect(isRetryable(new Error("Couldn't reach the provider (network or CORS)."))).toBe(true);
    expect(isRetryable(new Error("The model returned an empty response."))).toBe(true);
    expect(isRetryable(new Error("Auth failed (401). Check your API key."))).toBe(true);
  });

  it("stops on a refusal or a malformed request, which every provider would reject", () => {
    expect(isRetryable(new Error("Claude declined this request."))).toBe(false);
    expect(isRetryable(new Error("Provider error 400: bad request"))).toBe(false);
  });
});

describe("runAiWithFallback", () => {
  it("returns the first success without touching the rest", async () => {
    mockRun.mockResolvedValueOnce("memo");
    const result = await run();
    expect(result.text).toBe("memo");
    expect(result.usedId).toBe("byok");
    expect(result.attempts).toEqual([]);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next endpoint on a transient failure", async () => {
    mockRun.mockRejectedValueOnce(new Error("Provider error 503"));
    mockRun.mockResolvedValueOnce("memo from the backup");

    const result = await run();
    expect(result.text).toBe("memo from the backup");
    expect(result.usedId).toBe("openai-mini");
    expect(result.attempts).toEqual([
      { id: "byok", label: "Your provider", error: "Provider error 503" },
    ]);
    // Each attempt used its own URL and wire format.
    expect(mockRun.mock.calls[0][0].config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(mockRun.mock.calls[1][0].config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("crosses wire formats when the openai-shaped hosts are all down", async () => {
    mockRun.mockRejectedValueOnce(new Error("Provider error 500"));
    mockRun.mockRejectedValueOnce(new Error("Rate limited (429)."));
    mockRun.mockResolvedValueOnce("claude memo");

    const result = await run();
    expect(result.usedId).toBe("claude");
    expect(mockRun.mock.calls[2][0].config.kind).toBe("anthropic");
    expect(result.attempts).toHaveLength(2);
  });

  it("reports every failure when nothing works", async () => {
    mockRun.mockRejectedValue(new Error("Provider error 500"));
    await expect(run()).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it("stops at a non-retryable failure instead of shopping the same bad request around", async () => {
    mockRun.mockRejectedValueOnce(new Error("Claude declined this request."));
    await expect(run()).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("propagates an abort instead of retrying it elsewhere", async () => {
    mockRun.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(run()).rejects.toBeInstanceOf(DOMException);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("throws NoAiProviderError when nothing is configured at all", async () => {
    await expect(
      runAiWithFallback({ settings: settings(), system: "s", messages: [], config: chain }),
    ).rejects.toBeInstanceOf(NoAiProviderError);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("announces each provider it is about to try", async () => {
    mockRun.mockRejectedValueOnce(new Error("Provider error 500"));
    mockRun.mockResolvedValueOnce("ok");
    const seen: string[] = [];
    await run({ onAttempt: (c) => seen.push(c.id) });
    expect(seen).toEqual(["byok", "openai-mini"]);
  });
});

describe("runAiStreamWithFallback", () => {
  const streamRun = (over: Partial<Parameters<typeof runAiStreamWithFallback>[0]> = {}) =>
    runAiStreamWithFallback({
      settings: settings({ apiKeys: ALL_KEYS }),
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      config: chain,
      onDelta: () => {},
      ...over,
    });

  it("falls through silently when the first provider dies before emitting", async () => {
    mockStream.mockRejectedValueOnce(new Error("Provider error 503"));
    mockStream.mockImplementationOnce(async (o) => {
      o.onDelta("hello");
      return "hello";
    });
    const onRestart = vi.fn();
    const result = await streamRun({ onRestart });
    expect(result.usedId).toBe("openai-mini");
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("tells the caller to discard partial text when a provider dies mid-stream", async () => {
    mockStream.mockImplementationOnce(async (o) => {
      o.onDelta("half a sen");
      throw new Error("Provider error 500");
    });
    mockStream.mockImplementationOnce(async (o) => {
      o.onDelta("a whole answer");
      return "a whole answer";
    });

    const chunks: string[] = [];
    const onRestart = vi.fn(() => chunks.splice(0, chunks.length));
    const result = await streamRun({ onDelta: (f) => chunks.push(f), onRestart });

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("a whole answer");
    expect(chunks.join("")).toBe("a whole answer");
  });
});
