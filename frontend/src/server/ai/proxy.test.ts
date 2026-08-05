import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttemptTimeoutError,
  NoProxyProviderError,
  PROXY_CHAIN,
  ProxyChainFailedError,
  buildProxyCandidates,
  parseProxyChain,
  runProxyChain,
  type ProxyChainConfig,
} from "./proxy";

vi.mock("@/lib/ai/client", () => ({ runAiAnalyst: vi.fn() }));
import { runAiAnalyst } from "@/lib/ai/client";
const mockRun = vi.mocked(runAiAnalyst);

afterEach(() => vi.resetAllMocks());

const chain: ProxyChainConfig = {
  version: 1,
  chain: [
    {
      id: "groq",
      label: "Groq",
      kind: "openai",
      url: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      keyEnv: "K_GROQ",
      enabled: true,
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      kind: "openai",
      url: "https://openrouter.ai/api/v1/",
      model: "deepseek/deepseek-chat-v3-0324:free",
      keyEnv: "K_OR",
      enabled: true,
    },
  ],
};

const bothKeys = { K_GROQ: "g", K_OR: "o" };

const run = (env: Record<string, string | undefined> = bothKeys) =>
  runProxyChain({
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
    env,
    config: chain,
  });

describe("parseProxyChain", () => {
  it("requires a keyEnv — an entry with no named credential is unusable", () => {
    const parsed = parseProxyChain({
      chain: [
        { id: "ok", kind: "openai", url: "https://x/v1", model: "m", keyEnv: "K" },
        { id: "no-env", kind: "openai", url: "https://x/v1", model: "m" },
      ],
    });
    expect(parsed.chain.map((c) => c.id)).toEqual(["ok"]);
  });

  it("survives junk and rejects duplicates", () => {
    expect(parseProxyChain(null).chain).toEqual([]);
    const dup = parseProxyChain({
      chain: [
        { id: "a", kind: "openai", url: "u", model: "m", keyEnv: "K" },
        { id: "a", kind: "openai", url: "u2", model: "m2", keyEnv: "K2" },
      ],
    });
    expect(dup.chain).toHaveLength(1);
  });
});

describe("the shipped proxy chain", () => {
  it("names every credential by env var and carries none inline", () => {
    expect(PROXY_CHAIN.chain.length).toBeGreaterThan(0);
    for (const entry of PROXY_CHAIN.chain) {
      expect(entry.keyEnv).toMatch(/^AI_PROXY_[A-Z_]+$/);
      expect(JSON.stringify(entry)).not.toMatch(/sk-[a-z0-9-]/i);
      expect(Object.keys(entry)).not.toContain("apiKey");
    }
  });

  it("is inert until an operator sets a key", () => {
    expect(buildProxyCandidates({}, PROXY_CHAIN)).toEqual([]);
  });
});

describe("buildProxyCandidates", () => {
  it("includes only entries whose env key is present, in declared order", () => {
    expect(buildProxyCandidates(bothKeys, chain).map((c) => c.id)).toEqual(["groq", "openrouter"]);
    expect(buildProxyCandidates({ K_OR: "o" }, chain).map((c) => c.id)).toEqual(["openrouter"]);
    expect(buildProxyCandidates({ K_GROQ: "   " }, chain)).toEqual([]);
  });

  it("normalises the base url and carries the key through", () => {
    const [, openrouter] = buildProxyCandidates(bothKeys, chain);
    expect(openrouter.config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter.config.apiKey).toBe("o");
  });

  it("honours enabled:false", () => {
    const off = { version: 1, chain: [{ ...chain.chain[0], enabled: false }] };
    expect(buildProxyCandidates(bothKeys, off)).toEqual([]);
  });
});

describe("runProxyChain", () => {
  it("uses the first configured upstream", async () => {
    mockRun.mockResolvedValueOnce("answer");
    const result = await run();
    expect(result).toMatchObject({ text: "answer", usedId: "groq" });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("hops to the next vendor when the first is rate limited", async () => {
    mockRun.mockRejectedValueOnce(new Error("Rate limited (429)."));
    mockRun.mockResolvedValueOnce("second answer");

    const result = await run();
    expect(result.usedId).toBe("openrouter");
    expect(result.attempts).toEqual([{ id: "groq", error: "Rate limited (429)." }]);
    expect(mockRun.mock.calls[0][0].config.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(mockRun.mock.calls[1][0].config.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("does not burn a second free quota on a request every vendor would reject", async () => {
    mockRun.mockRejectedValueOnce(new Error("Provider error 400: bad request"));
    await expect(run()).rejects.toBeInstanceOf(ProxyChainFailedError);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("reports failure once every upstream is exhausted", async () => {
    mockRun.mockRejectedValue(new Error("Provider error 503"));
    await expect(run()).rejects.toBeInstanceOf(ProxyChainFailedError);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it("says the tier is unconfigured rather than pretending it failed", async () => {
    await expect(run({})).rejects.toBeInstanceOf(NoProxyProviderError);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("per-attempt timeout", () => {
  it("advances to the next vendor when one accepts the connection then hangs", async () => {
    // The failure that motivated this: an upstream whose /models answered fine
    // while /chat/completions never returned.
    mockRun.mockImplementationOnce(
      (o) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    mockRun.mockResolvedValueOnce("second answer");

    const result = await runProxyChain({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      env: bothKeys,
      config: chain,
      timeoutMs: 20,
    });

    expect(result.usedId).toBe("openrouter");
    expect(result.attempts[0].error).toMatch(/did not respond within/);
  });

  it("stops when the caller aborts, rather than spending another provider", async () => {
    const caller = new AbortController();
    mockRun.mockImplementationOnce(
      (o) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          caller.abort();
        }),
    );

    await expect(
      runProxyChain({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        env: bothKeys,
        config: chain,
        signal: caller.signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(DOMException);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("names the vendor that hung", () => {
    expect(new AttemptTimeoutError("Groq", 30_000).message).toBe("Groq did not respond within 30s");
  });
});
