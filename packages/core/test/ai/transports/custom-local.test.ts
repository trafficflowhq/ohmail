import { describe, expect, it } from "vitest";
import { ModelDeclinedError } from "../../../src/mail.js";
import { customLocalTransport, resolveCustomLocalUrls } from "../../../src/ai/transports/ai-custom-local.js";

const input = { from: { name: null, address: "news@example.test" }, subject: "Weekly news", snippet: "The roundup", headersDigest: "" };
const answer = { destination: "ohmail/News", confidence: 0.9, rationale: "a newsletter", spam: false };
const completion = () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
function transport(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return responses.shift()!();
  }) as typeof fetch;
  return { calls, ai: customLocalTransport({
    baseUrl: "http://127.0.0.1:1234/v1", classifyModel: "local-model", draftModel: "draft-model", fetchImpl, timeoutMs: 2000,
  }) };
}

describe("keyless OpenAI-compatible transport", () => {
  it.each([
    ["http://localhost:1234", "http://localhost:1234/v1"],
    ["http://localhost:1234/v1/", "http://localhost:1234/v1"],
    ["http://localhost:1234/v1/chat/completions", "http://localhost:1234/v1"],
    ["http://localhost:1234/custom/api/", "http://localhost:1234/custom/api"],
  ])("resolves %s without losing the API prefix", (input, base) => {
    expect(resolveCustomLocalUrls(input)).toEqual({ chatUrl: `${base}/chat/completions`, modelsUrl: `${base}/models` });
  });

  it("verifies both configured models against the actual catalogue, without inference", async () => {
    const { ai, calls } = transport([() => Response.json({ data: [{ id: "local-model" }] })]);
    expect(await ai.probe()).toMatchObject({ ok: false, reason: "model_absent", models: ["local-model"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:1234/v1/models");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("lists only discovered models and accepts both configured IDs", async () => {
    const { ai } = transport([() => Response.json({ data: [{ id: "local-model" }, { id: "draft-model" }, { id: "local-model" }] })]);
    expect(await ai.probe()).toEqual({ ok: true, reason: null, detail: null, models: ["local-model", "draft-model"] });
  });

  it("retries once without response_format when a server explicitly rejects structured output", async () => {
    const { ai, calls } = transport([() => new Response("response_format is unsupported", { status: 400 }), completion]);
    expect((await ai.classify(input)).destination).toBe("ohmail/News");
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]!.init.body as string);
    expect(first.response_format.type).toBe("json_schema");
    const { response_format: _format, ...rest } = first;
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual(rest);
    for (const { init } of calls) {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not retry unrelated errors or include their body in the thrown error", async () => {
    const { ai, calls } = transport([() => new Response("private error detail", { status: 400 })]);
    await expect(ai.classify(input)).rejects.toThrow("classifier: the model refused the request (400)");
    expect(calls).toHaveLength(1);
  });

  it("preserves a model refusal as a decline rather than a transport fault", async () => {
    const { ai } = transport([() => Response.json({ choices: [{ message: { content: null, refusal: "declined" } }] })]);
    await expect(ai.classify(input)).rejects.toBeInstanceOf(ModelDeclinedError);
  });
});
