// @vitest-environment node
// The Gemini adapter against a FAKE fetch: the request is exactly the documented `models.generateContent` shape, carries only
// what the prompt builder produced, and keeps the key out of the URL, the body, errors and logs. Nothing here reaches the network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGeminiBody, GEMINI_ENDPOINT, GeminiProvider, parseGeminiAnswer } from "./gemini";
import { OUTPUT_JSON_SCHEMA } from "./schema";
import { ProviderError, type LlmRequest } from "./types";

const KEY = "AIzaFAKE-KEY-FOR-TESTS-0123456789";
const MODEL = "test-model-1";
const request: LlmRequest = { system: "SYSTEM TEXT", user: "USER TEXT with DATA", temperature: 0, maxOutputTokens: 2048, timeoutMs: 500, jsonSchema: OUTPUT_JSON_SCHEMA };
const answer = (over: Record<string, unknown> = {}) => ({ candidates: [{ content: { parts: [{ text: '{"points":[]}' }], role: "model" }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 }, modelVersion: "test-model-1-001", ...over });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

interface Captured {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: (c: Captured) => Response | Promise<Response>): { fn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fn, calls };
}
const provider = (f: typeof fetch, over: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) => new GeminiProvider({ apiKey: KEY, model: MODEL, fetchImpl: f, ...over });

afterEach(() => vi.restoreAllMocks());

describe("the request", () => {
  it("is a POST to the documented generateContent endpoint, with the key in the x-goog-api-key header only", async () => {
    const f = fakeFetch(() => ok(answer()));
    await provider(f.fn).generate(request);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(`${GEMINI_ENDPOINT}/models/${MODEL}:generateContent`);
    expect(GEMINI_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": KEY });
    expect(url.includes(KEY) || url.includes("key=")).toBe(false);
    expect(String(init.body).includes(KEY)).toBe(false);
  });

  it("carries only the system instruction, the user content and the generation settings: no tools, no grounding, no cached content", async () => {
    const f = fakeFetch(() => ok(answer()));
    await provider(f.fn).generate(request);
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(Object.keys(body).sort()).toEqual(["contents", "generationConfig", "systemInstruction"]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYSTEM TEXT" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "USER TEXT with DATA" }] }]);
    expect(body.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 2048, candidateCount: 1, responseMimeType: "application/json" });
    for (const k of ["tools", "toolConfig", "safetySettings", "cachedContent", "labels"]) expect(body).not.toHaveProperty(k);
  });

  it("requests JSON output in the documented ways, or not at all", () => {
    expect(buildGeminiBody(request, "mime").generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(buildGeminiBody(request, "mime").generationConfig).not.toHaveProperty("responseFormat");
    expect(buildGeminiBody(request, "format").generationConfig).toMatchObject({ responseFormat: { text: { mimeType: "application/json", schema: OUTPUT_JSON_SCHEMA } } });
    expect(buildGeminiBody(request, "format").generationConfig).not.toHaveProperty("responseMimeType");
    expect(buildGeminiBody(request, "none").generationConfig).toEqual({ temperature: 0, maxOutputTokens: 2048, candidateCount: 1 });
  });

  it("encodes the model id into the path and refuses an id that could change the path", () => {
    for (const bad of ["a/b", "../x", "a b", "", "x?y=1", "-leading", "a".repeat(81)]) expect(() => new GeminiProvider({ apiKey: KEY, model: bad }), bad).toThrow(ProviderError);
    expect(() => new GeminiProvider({ apiKey: "", model: MODEL })).toThrow(/GEMINI_API_KEY/);
  });
});

describe("the answer", () => {
  it("returns the text, the model version, the finish reason and token counts", async () => {
    const r = await provider(fakeFetch(() => ok(answer())).fn).generate(request);
    expect(r).toEqual({ text: '{"points":[]}', modelVersion: "test-model-1-001", finishReason: "STOP", usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it("joins text parts, skips thought parts, and ignores non-text parts (a function call is never executed)", () => {
    const r = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "A" }, { thought: true, text: "hidden reasoning" }, { text: "B" }, { functionCall: { name: "x" } } as never] }, finishReason: "STOP" }] });
    expect(r.text).toBe("AB");
  });

  it("passes a truncated answer on as text (the JSON validator then refuses it)", () => {
    const r = parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: '{"points": [' }] }, finishReason: "MAX_TOKENS" }] });
    expect(r).toMatchObject({ text: '{"points": [', finishReason: "MAX_TOKENS" });
  });

  it("treats a blocked prompt or a text-less safety stop as a provider error", () => {
    expect(() => parseGeminiAnswer({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/SAFETY/);
    expect(() => parseGeminiAnswer({ candidates: [{ finishReason: "SAFETY" }] })).toThrow(ProviderError);
    expect(parseGeminiAnswer({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }).text).toBe("");
  });

  it("tolerates missing optional fields", () => {
    expect(parseGeminiAnswer({ candidates: [{ content: { parts: [{ text: "x" }] } }] })).toEqual({ text: "x", modelVersion: null, finishReason: null, usage: null });
  });
});

describe("failures", () => {
  const kindOf = async (status: number, body: unknown = { error: { status: "X", message: "m" } }): Promise<string> => {
    try {
      await provider(fakeFetch(() => new Response(JSON.stringify(body), { status })).fn).generate(request);
    } catch (e) {
      return (e as ProviderError).kind;
    }
    return "none";
  };
  it.each([[400, "bad_request"], [404, "bad_request"], [401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "unavailable"], [503, "unavailable"]])("HTTP %i is %s", async (status, kind) => {
    expect(await kindOf(status)).toBe(kind);
  });

  it("copes with an error body that is not JSON", async () => {
    const f = fakeFetch(() => new Response("<html>gateway</html>", { status: 502 }));
    await expect(provider(f.fn).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps a network failure to unavailable and a non-JSON 200 to unavailable", async () => {
    await expect(provider(fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).fn).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(provider(fakeFetch(() => new Response("not json", { status: 200 })).fn).generate(request)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("times out when no answer arrives, by aborting the request", async () => {
    let aborted = false;
    const f = fakeFetch((c) => new Promise<Response>((_, reject) => {
      (c.init.signal as AbortSignal).addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }));
    await expect(provider(f.fn).generate({ ...request, timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
    expect(aborted).toBe(true);
  });

  it("never lets the key into an error message, even if the service echoes it", async () => {
    const echo = fakeFetch(() => new Response(JSON.stringify({ error: { status: "INVALID", message: `bad key ${KEY} supplied` } }), { status: 400 }));
    try {
      await provider(echo.fn).generate(request);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
      expect((e as Error).message).toContain("[redacted]");
    }
    const net = fakeFetch(() => Promise.reject(new Error(`connect failed for ${KEY}`)));
    await expect(provider(net.fn).generate(request)).rejects.toSatisfy((e: Error) => !e.message.includes(KEY));
  });

  it("writes nothing to the console, key or otherwise", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await provider(fakeFetch(() => ok(answer())).fn).generate(request);
    await provider(fakeFetch(() => new Response("{}", { status: 500 })).fn).generate(request).catch(() => undefined);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("the global fetch is used only through the adapter, and only when no fake is injected", () => {
  it("falls back to the global fetch at call time", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(answer()));
    const r = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.text).toBe('{"points":[]}');
  });
});
