import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import { GroqModelProvider, parseGroqDuration } from "../../src/providers/groq.js";
import { createModelProvider, DEFAULT_GROQ_MODEL_ID, resolveModelId } from "../../src/providers/factory.js";

/**
 * A real loopback HTTP server standing in for api.groq.com, the same
 * convention packages/crawler and changelog.test.ts use: the provider's own
 * fetch, header parsing and abort handling all run for real; only the remote
 * end is ours. Nothing here calls Groq.
 */
interface Seen {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Responder = (req: Seen, callIndex: number, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let seen: Seen[];
let responder: Responder;

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const entry: Seen = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      seen.push(entry);
      responder(entry, seen.length - 1, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ok(res: http.ServerResponse, content: string | null, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
}

function makeProvider(extra: Partial<ConstructorParameters<typeof GroqModelProvider>[0]> = {}) {
  const sleeps: number[] = [];
  const provider = new GroqModelProvider({
    modelId: "openai/gpt-oss-120b",
    apiKey: "gsk_test_key_value",
    baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { provider, sleeps };
}

const REQUEST = { prompt: "hello", maxTokens: 100, timeoutMs: 2_000 };

describe("parseGroqDuration", () => {
  it.each([
    ["2.865s", 2865],
    ["1m26.4s", 86_400],
    ["120ms", 120],
    ["1h2m3s", 3_723_000],
    ["7.66s", 7660],
  ])("parses %s", (raw, ms) => {
    expect(parseGroqDuration(raw)).toBeCloseTo(ms);
  });

  it.each([[null], [""], ["soon"], ["5"], ["2s extra"]])("returns undefined for %j", (raw) => {
    expect(parseGroqDuration(raw)).toBeUndefined();
  });
});

describe("GroqModelProvider", () => {
  it("posts an OpenAI-style chat completion with bearer auth and returns the text", async () => {
    responder = (_r, _i, res) => ok(res, '{"score":5,"summary":"fine"}');
    const { provider } = makeProvider();
    const result = await provider.invoke(REQUEST);

    expect(result).toEqual({ text: '{"score":5,"summary":"fine"}', modelId: "openai/gpt-oss-120b" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["authorization"]).toBe("Bearer gsk_test_key_value");
    expect(seen[0]!.body).toMatchObject({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      reasoning_effort: "low",
    });
    // 100 visible + 512 reasoning headroom
    expect(seen[0]!.body["max_tokens"]).toBe(612);
    expect(provider.httpAttempts).toBe(1);
  });

  it("on a 429, waits for Retry-After and then succeeds instead of failing the run", async () => {
    responder = (_r, i, res) => {
      if (i < 2) {
        res.writeHead(429, { "retry-after": "7", "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limit", type: "tokens", code: "rate_limit_exceeded" } }));
        return;
      }
      ok(res, "done");
    };
    const { provider, sleeps } = makeProvider();
    const result = await provider.invoke(REQUEST);

    expect(result.text).toBe("done");
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([7_250, 7_250]);
    expect(provider.rateLimited).toBe(2);
  });

  it("falls back to x-ratelimit-reset-tokens when a 429 has no Retry-After", async () => {
    responder = (_r, i, res) => {
      if (i === 0) {
        res.writeHead(429, { "x-ratelimit-reset-tokens": "2.5s", "content-type": "application/json" });
        res.end("{}");
        return;
      }
      ok(res, "done");
    };
    const { provider, sleeps } = makeProvider();
    await provider.invoke(REQUEST);
    expect(sleeps).toEqual([2_750]);
  });

  it("throws RateLimitError, not a hang, when waiting would outlast maxRateLimitWaitMs", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(429, { "retry-after": "600", "content-type": "application/json" });
      res.end("{}");
    };
    const { provider, sleeps } = makeProvider({ maxRateLimitWaitMs: 10_000 });
    const error = await provider.invoke(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).context["providerErrorName"]).toBe("RateLimitError");
    expect(sleeps).toEqual([]);
  });

  it("paces itself: when the previous response says the tokens bucket cannot fit the next call, it waits for the reset first", async () => {
    let clock = 1_000_000;
    responder = (_r, i, res) =>
      ok(res, `call ${i}`, {
        "x-ratelimit-remaining-tokens": "50",
        "x-ratelimit-reset-tokens": "4s",
        "x-ratelimit-remaining-requests": "900",
        "x-ratelimit-reset-requests": "10s",
      });
    const { provider, sleeps } = makeProvider({ now: () => clock });

    await provider.invoke(REQUEST);
    expect(sleeps).toEqual([]);
    clock += 1_000; // 3s of the 4s reset left
    await provider.invoke(REQUEST);

    expect(sleeps).toEqual([3_250]);
    expect(seen).toHaveLength(2);
  });

  it("does not wait when the bucket has room", async () => {
    responder = (_r, i, res) => ok(res, `call ${i}`, { "x-ratelimit-remaining-tokens": "7000", "x-ratelimit-reset-tokens": "4s" });
    const { provider, sleeps } = makeProvider();
    await provider.invoke(REQUEST);
    await provider.invoke(REQUEST);
    expect(sleeps).toEqual([]);
  });

  it("waits for the requests bucket when it is exhausted", async () => {
    let clock = 5_000;
    responder = (_r, i, res) =>
      ok(res, `call ${i}`, {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "2s",
        "x-ratelimit-remaining-tokens": "7000",
      });
    const { provider, sleeps } = makeProvider({ now: () => clock });
    await provider.invoke(REQUEST);
    clock += 500;
    await provider.invoke(REQUEST);
    expect(sleeps).toEqual([1_750]);
  });

  it("refuses to wait past its budget for a pacing wait, too", async () => {
    let clock = 5_000;
    responder = (_r, i, res) =>
      ok(res, `call ${i}`, { "x-ratelimit-remaining-tokens": "1", "x-ratelimit-reset-tokens": "30s" });
    const { provider } = makeProvider({ now: () => clock, maxRateLimitWaitMs: 1_000 });
    await provider.invoke(REQUEST);
    clock += 10;
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error.context["providerErrorName"]).toBe("RateLimitError");
  });

  it("retries a 5xx inside the provider, then succeeds", async () => {
    responder = (_r, i, res) => {
      if (i === 0) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      ok(res, "recovered");
    };
    const { provider, sleeps } = makeProvider();
    expect((await provider.invoke(REQUEST)).text).toBe("recovered");
    expect(sleeps).toEqual([1_000]);
  });

  it("surfaces a persistent 5xx as a retryable-by-name UpstreamError", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    };
    const { provider } = makeProvider({ maxServerErrorRetries: 1 });
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.context["providerErrorName"]).toBe("ServiceUnavailable");
    expect(seen).toHaveLength(2);
  });

  it("maps a 4xx to a terminal UpstreamError carrying the Groq error code, never the key", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }));
    };
    const { provider } = makeProvider();
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.context["providerErrorName"]).toBe("invalid_api_key");
    expect(JSON.stringify(error.context)).not.toContain("gsk_test_key_value");
    expect(error.message).not.toContain("gsk_test_key_value");
    expect(seen).toHaveLength(1);
  });

  it("falls back to the error type, then the HTTP status, when a 4xx has no code", async () => {
    let n = 0;
    responder = (_r, _i, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(n++ === 0 ? JSON.stringify({ error: { type: "invalid_request_error" } }) : "{}");
    };
    const { provider } = makeProvider();
    const first = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    const second = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(first.context["providerErrorName"]).toBe("invalid_request_error");
    expect(second.context["providerErrorName"]).toBe("Http400");
  });

  it("throws UpstreamError when the response has no text (a reasoning model that ran out of tokens)", async () => {
    responder = (_r, _i, res) => ok(res, "");
    const { provider } = makeProvider();
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.context["providerErrorName"]).toBe("EmptyContent");
  });

  it("declares tools with a permissive schema and renders a tool call into the text", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "On it.",
                tool_calls: [{ function: { name: "add_to_list", arguments: '{"item":"batteries"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    };
    const { provider } = makeProvider();
    const result = await provider.invoke({ ...REQUEST, tools: [{ name: "add_to_list", description: "Adds an item." }] });

    expect(result.text).toBe('On it.\n[tool call] add_to_list({"item":"batteries"})');
    expect(seen[0]!.body["tool_choice"]).toBe("auto");
    expect(seen[0]!.body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "add_to_list", description: "Adds an item.", parameters: { type: "object", additionalProperties: true } },
      },
    ]);
  });

  it("returns a tool call alone (no prose) as text rather than an empty-content error", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{}] }, finish_reason: "tool_calls" }] }));
    };
    const { provider } = makeProvider();
    expect((await provider.invoke(REQUEST)).text).toBe("[tool call] ?()");
  });

  it("hands back a malformed tool call Groq rejected (tool_use_failed) as the model's response", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "tool_use_failed", message: "bad", failed_generation: "<tool>x</tool>" } }));
    };
    const { provider } = makeProvider();
    expect((await provider.invoke(REQUEST)).text).toBe("[tool call, rejected by Groq as malformed] <tool>x</tool>");
  });

  it("sends a conversation, with the assistant's tool call and the tool result, instead of the prompt, and returns tool calls with ids", async () => {
    responder = (_r, i, res) => {
      if (i === 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "call_9", function: { name: "t", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }],
          }),
        );
        return;
      }
      ok(res, "final answer");
    };
    const { provider } = makeProvider();
    const first = await provider.invoke({
      ...REQUEST,
      conversation: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "t", description: "d" }],
    });
    expect(first.toolCalls).toEqual([{ id: "call_9", name: "t", arguments: '{"a":1}' }]);

    const second = await provider.invoke({
      ...REQUEST,
      conversation: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: first.toolCalls! },
        { role: "tool", toolCallId: "call_9", content: '{"ok":true}' },
      ],
      tools: [{ name: "t", description: "d" }],
    });
    expect(second.text).toBe("final answer");
    expect(second.toolCalls).toBeUndefined();
    expect(seen[0]!.body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(seen[1]!.body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "call_9", content: '{"ok":true}' },
    ]);
  });

  it("throws UpstreamError for a non-JSON body", async () => {
    responder = (_r, _i, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    };
    const { provider } = makeProvider();
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error.context["providerErrorName"]).toBe("BadResponse");
  });

  it("throws UpstreamTimeoutError when a call exceeds timeoutMs", async () => {
    responder = () => {
      /* never respond */
    };
    const { provider } = makeProvider();
    await expect(provider.invoke({ ...REQUEST, timeoutMs: 50 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("maps a refused connection to UpstreamError", async () => {
    const { provider } = makeProvider({ baseUrl: "http://127.0.0.1:1" });
    const error = (await provider.invoke(REQUEST).catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.context["providerErrorName"]).toBe("NetworkError");
  });
});

describe("createModelProvider / resolveModelId", () => {
  it("builds a Groq provider, and refuses to without a key", () => {
    expect(createModelProvider({ kind: "groq", modelId: "m", groqApiKey: "k" }).modelId).toBe("m");
    expect(() => createModelProvider({ kind: "groq", modelId: "m" })).toThrow(/GROQ_API_KEY/);
  });

  it("builds a Bedrock provider only with a region", () => {
    expect(createModelProvider({ kind: "bedrock", modelId: "b", awsRegion: "us-east-1" }).modelId).toBe("b");
    expect(() => createModelProvider({ kind: "bedrock", modelId: "b" })).toThrow(/region/);
  });

  it("defaults the Groq model id and never invents a Bedrock one", () => {
    expect(resolveModelId("groq", undefined, "ADVISORY_MODEL_ID")).toBe(DEFAULT_GROQ_MODEL_ID);
    expect(resolveModelId("groq", "other", "ADVISORY_MODEL_ID")).toBe("other");
    expect(() => resolveModelId("bedrock", undefined, "ADVISORY_MODEL_ID")).toThrow(/ADVISORY_MODEL_ID/);
    expect(resolveModelId("bedrock", "b", "ADVISORY_MODEL_ID")).toBe("b");
  });
});
