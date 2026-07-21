import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseSseLines, runAiAnalystStream } from "./client";
import type { ResolvedAiConfig } from "./providers";

// --- parseSseLines: pure buffering logic ------------------------------------

describe("parseSseLines", () => {
  it("extracts a complete data line with no carry", () => {
    const { lines, carry } = parseSseLines("", 'data: {"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(carry).toBe("");
  });

  it("buffers a line split across chunk boundaries", () => {
    const first = parseSseLines("", 'data: {"a":1');
    expect(first.lines).toEqual([]);
    expect(first.carry).toBe('data: {"a":1');

    const second = parseSseLines(first.carry, "}\n");
    expect(second.lines).toEqual(['{"a":1}']);
    expect(second.carry).toBe("");
  });

  it("handles multiple data lines within one chunk", () => {
    const { lines, carry } = parseSseLines("", 'data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(carry).toBe("");
  });

  it("drops non-data SSE lines (event:, id:, blank keep-alives)", () => {
    const { lines } = parseSseLines("", 'event: content_block_delta\nid: 42\n\ndata: {"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("strips a trailing \\r for CRLF-terminated lines", () => {
    const { lines } = parseSseLines("", 'data: {"a":1}\r\n\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("handles a byte split across a multi-byte boundary carried in as a string", () => {
    // The decoder itself handles multi-byte UTF-8 splitting (via {stream:true});
    // parseSseLines just needs to buffer a partial *line* correctly regardless
    // of what's inside it.
    const first = parseSseLines("", 'data: {"text":"café');
    const second = parseSseLines(first.carry, '"}\n\n');
    expect(second.lines).toEqual(['{"text":"café"}']);
  });

  it("carries forward the [DONE] terminator line unmodified for the caller to detect", () => {
    const { lines } = parseSseLines("", "data: [DONE]\n\n");
    expect(lines).toEqual(["[DONE]"]);
  });

  it("returns no lines and empty carry for an empty chunk", () => {
    const { lines, carry } = parseSseLines("", "");
    expect(lines).toEqual([]);
    expect(carry).toBe("");
  });
});

// --- runAiAnalystStream: end-to-end SSE consumption -------------------------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function streamResponse(chunks: string[], contentType = "text/event-stream"): Response {
  return new Response(sseStream(chunks), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

const openaiConfig: ResolvedAiConfig = {
  provider: "openai",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-4o-mini",
};

const anthropicConfig: ResolvedAiConfig = {
  provider: "anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "test-key",
  model: "claude-opus-4-8",
};

describe("runAiAnalystStream", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("streams OpenAI-compatible deltas and returns the concatenated text", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":", "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: openaiConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["Hello", ", ", "world"]);
    expect(text).toBe("Hello, world");
  });

  it("skips deltas with null/absent content", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{}}]}\n\n',
        'data: {"choices":[{"delta":{"content":null}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: openaiConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["ok"]);
    expect(text).toBe("ok");
  });

  it("buffers a JSON payload split across two raw chunks", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: openaiConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["Hello"]);
    expect(text).toBe("Hello");
  });

  it("falls back to the non-streaming shape when the response isn't SSE", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "plain reply" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: openaiConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["plain reply"]);
    expect(text).toBe("plain reply");
  });

  it("throws the same empty-response error as non-streaming on an empty OpenAI stream", async () => {
    fetchMock.mockResolvedValue(streamResponse(["data: [DONE]\n\n"]));

    await expect(
      runAiAnalystStream({
        config: openaiConfig,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      }),
    ).rejects.toThrow("The model returned an empty response.");
  });

  it("streams Anthropic text_delta events and returns the concatenated text", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"type":"message_start"}\n\n',
        'data: {"type":"content_block_start","index":0}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: anthropicConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["Hi ", "there"]);
    expect(text).toBe("Hi there");
  });

  it("throws when Anthropic reports a refusal stop_reason mid-stream", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n',
      ]),
    );

    await expect(
      runAiAnalystStream({
        config: anthropicConfig,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      }),
    ).rejects.toThrow("Claude declined this request.");
  });

  it("throws with the provider message on an Anthropic error event", async () => {
    fetchMock.mockResolvedValue(
      streamResponse(['data: {"type":"error","error":{"message":"overloaded"}}\n\n']),
    );

    await expect(
      runAiAnalystStream({
        config: anthropicConfig,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      }),
    ).rejects.toThrow("overloaded");
  });

  it("falls back to the non-streaming Anthropic shape when the response isn't SSE", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "plain claude reply" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const fragments: string[] = [];
    const text = await runAiAnalystStream({
      config: anthropicConfig,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (f) => fragments.push(f),
    });

    expect(fragments).toEqual(["plain claude reply"]);
    expect(text).toBe("plain claude reply");
  });

  it("surfaces a non-2xx response via describeHttpError before streaming starts", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      runAiAnalystStream({
        config: openaiConfig,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      }),
    ).rejects.toThrow(/Auth failed/);
  });
});
