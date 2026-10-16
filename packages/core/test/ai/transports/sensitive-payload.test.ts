import { describe, expect, it } from "vitest";
import { SensitivePayloadRefusal, type ClassifierInput, type DraftInput } from "../../../src/mail.js";
import {
  anthropicTransport, ollamaTransport, openaiTransport, opencodeGoTransport, type AiTransport,
} from "../../../src/ai/transports/index.js";
import { portsOf } from "../../../src/ai/transports/host.js";
import { anthropicKey, openAiKey } from "../../../../../test/support/fixture-credentials.js";

/**
 * INVARIANT #1 AT EVERY TRANSPORT. Each provider builds its request through the shared sink
 * (`classifyUserPayload`), which throws on credential material before a payload exists. Asked of
 * all four, both questions, directly and through `portsOf` (what the server and the worker hold):
 * the refusal is `SensitivePayloadRefusal` and the injected fetch is never called. The control
 * shows the same transports DO call it for ordinary mail, so the empty count is earned. A draft
 * goes through its own sink, `draftUserPayload`'s redaction allow-list, asked the same way.
 */

const credential = (): ClassifierInput => ({
  from: { name: null, address: "news@example.test" },
  subject: "Your one-time verification code is 402913",
  snippet: "the weekly roundup",
  headersDigest: "list-id present",
});
const ordinary = (): ClassifierInput => ({ ...credential(), subject: "This week's roundup" });

type Make = (fetchImpl: typeof fetch) => AiTransport;
const TRANSPORTS: Array<[string, Make]> = [
  ["anthropic", (f) => anthropicTransport({
    apiKey: anthropicKey("sensitive-transports"), classifyModel: "claude-haiku-4-5-20251001",
    draftModel: "claude-sonnet-5", fetchImpl: f, timeoutMs: 2000,
  })],
  ["openai", (f) => openaiTransport({
    apiKey: openAiKey("sensitive-transports"), classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1",
    fetchImpl: f, timeoutMs: 2000,
  })],
  ["ollama", (f) => ollamaTransport({
    baseUrl: "http://ollama:11434", classifyModel: "llama3.2", draftModel: "llama3.2", fetchImpl: f, timeoutMs: 2000,
  })],
  ["opencode-go", (f) => opencodeGoTransport({
    apiKey: "sensitive-transports-fixture-token", classifyModel: "glm-5.3-flash", draftModel: "kimi-k3",
    fetchImpl: f, timeoutMs: 2000,
  })],
];

/** A fetch that counts and answers nothing usable: a refused call must never reach it. */
function counting(): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("a credential never reaches a model, whichever transport carries it", () => {
  for (const [name, make] of TRANSPORTS) {
    for (const question of ["classify", "screen"] as const) {
      it(`${name} · ${question}: refused at the sink, and the fetch is never called`, async () => {
        const { calls, fetchImpl } = counting();
        await expect(make(fetchImpl)[question](credential())).rejects.toBeInstanceOf(SensitivePayloadRefusal);
        await expect(portsOf(make(fetchImpl)).classifier[question](credential()))
          .rejects.toBeInstanceOf(SensitivePayloadRefusal);
        expect(calls, `${name} sent a request for a refused payload`).toEqual([]);
      });

      it(`${name} · ${question}: the control — ordinary mail does reach the fetch`, async () => {
        const { calls, fetchImpl } = counting();
        await expect(make(fetchImpl)[question](ordinary())).rejects.toThrow();
        expect(calls.length, `${name} never called its fetch, so the case above proves nothing`).toBeGreaterThan(0);
      });
    }
  }
});

/** A draft input as the drafting service never builds one: the incoming message's whole body. */
const unredacted = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?", body: "the whole message" } as DraftInput["incoming"],
  context: { kbEntries: [], threadMessages: [] },
});
const redacted = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});

describe("an unredacted draft input never reaches a model, whichever transport carries it", () => {
  for (const [name, make] of TRANSPORTS) {
    it(`${name} · draft: refused at the sink (draftUserPayload), and the fetch is never called`, async () => {
      const { calls, fetchImpl } = counting();
      await expect(make(fetchImpl).draft(unredacted())).rejects.toThrow(/redaction violation/);
      await expect(portsOf(make(fetchImpl)).drafter.draft(unredacted())).rejects.toThrow(/redaction violation/);
      expect(calls, `${name} sent a request for an unredacted draft input`).toEqual([]);
    });

    it(`${name} · draft: the control — a redacted input does reach the fetch`, async () => {
      const { calls, fetchImpl } = counting();
      await expect(make(fetchImpl).draft(redacted())).rejects.toThrow();
      expect(calls.length, `${name} never called its fetch, so the case above proves nothing`).toBeGreaterThan(0);
    });
  }
});
