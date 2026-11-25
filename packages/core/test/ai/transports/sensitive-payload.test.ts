import { describe, expect, it } from "vitest";
import {
  DRAFT_OWN_PREFIX, DRAFT_PREFIX, NO_LETTER, type ClassifierInput, type DraftInput,
} from "../../../src/mail.js";
import { buildDraftParams } from "../../../src/ai/draft.js";
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

describe("authentication mail reaches the provider, whichever transport carries it", () => {
  for (const [name, make] of TRANSPORTS) {
    for (const question of ["classify", "screen"] as const) {
      it(`${name} · ${question}: sends authentication mail to the provider`, async () => {
        const { calls, fetchImpl } = counting();
        await expect(make(fetchImpl)[question](credential())).rejects.toThrow();
        await expect(portsOf(make(fetchImpl)).classifier[question](credential()))
          .rejects.toThrow();
        expect(calls).toHaveLength(2);
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

/** A fetch that keeps each request's body and answers nothing usable. */
function capturing(): { bodies: string[]; fetchImpl: typeof fetch } {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}
/** A text as it stands inside a JSON request body, at whatever depth it was encoded. */
const inBody = (body: string, text: string): boolean => body.includes(JSON.stringify(text).slice(1, -1))
  || body.includes(JSON.stringify(JSON.stringify(text).slice(1, -1)).slice(1, -1));

describe.each(TRANSPORTS)("%s provider credential redaction", (_name, make) => {
  it.each(["classify", "screen", "draft"] as const)("%s sends useful mail without its credentials", async (feature) => {
    const { bodies, fetchImpl } = capturing();
    const provider = make(fetchImpl);
    const login = "https://account.example.test/magic-login?token=orchid-garnet";
    const reset = "https://account.example.test/password/reset?reset_token=cedar-amber";
    const article = "https://news.example.test/articles/784561";
    const unsubscribe = "https://news.example.test/unsubscribe?token=receipt-ABC12345";
    const mail = {
      ...credential(),
      snippet: `Use ${login} to sign in. Reset via ${reset}. Order 768145 on 2026-11-25 for €19,95. ${article} ${unsubscribe}`,
    };
    const draft: DraftInput = {
      incoming: { from: mail.from.address, subject: mail.subject, snippet: mail.snippet },
      context: {
        threadMessages: [{ from: mail.from.address, snippet: "Dein Anmeldecode lautet HG7QW." }],
        kbEntries: [{ title: "Bestätigungscode", content: "GZ8RP" }],
      },
    };
    const original = structuredClone({ mail, draft });
    await expect(feature === "draft" ? provider.draft(draft) : provider[feature](mail)).rejects.toThrow();
    expect({ mail, draft }).toEqual(original);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).toContain("Your one-time verification code is [code]");
    expect(body).toContain("Use https://account.example.test/[link] to sign in. Reset via https://account.example.test/[link].");
    expect(body).toContain("Order [code] on [code] for €19,95.");
    expect(body).toContain("https://news.example.test/[link] https://news.example.test/[link]");
    for (const value of [login, reset, article, unsubscribe, "402913", "768145", "HG" + "7QW", "GZ" + "8RP"]) {
      expect(body).not.toContain(value);
    }
    if (feature === "draft") {
      expect(body).toContain("Dein Anmeldecode lautet [code].");
      expect(body).toContain("Bestätigungscode");
    }
  });
});

describe("a draft from the person's own words, whichever drafter writes it", () => {
  const words = "tell Ann the budget review moves to Friday at nine";
  const fromWords = (): DraftInput => ({ incoming: { ...NO_LETTER }, context: { kbEntries: [], threadMessages: [] }, own: { text: words, replying: false } });

  for (const [name, make] of TRANSPORTS) {
    it(`${name}: asks with the own-words prefix and the words, and sends no letter`, async () => {
      const { bodies, fetchImpl } = capturing();
      await expect(make(fetchImpl).draft(fromWords())).rejects.toThrow();
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(inBody(body, DRAFT_OWN_PREFIX), `${name}: the own-words prefix`).toBe(true);
        expect(inBody(body, DRAFT_PREFIX), `${name}: not the reply prefix`).toBe(false);
        expect(body).toContain(words);
        expect(body).not.toContain("incoming");
      }
    });

    it(`${name}: a reply drafted from the letter alone asks as it always did`, async () => {
      const { bodies, fetchImpl } = capturing();
      await expect(make(fetchImpl).draft(redacted())).rejects.toThrow();
      for (const body of bodies) {
        expect(inBody(body, DRAFT_PREFIX), `${name}: the reply prefix`).toBe(true);
        expect(inBody(body, DRAFT_OWN_PREFIX)).toBe(false);
      }
    });

    it(`${name}: own words with a field outside the list, or a letter they do not answer, never reach the fetch`, async () => {
      const { bodies, fetchImpl } = capturing();
      const extra = { ...fromWords(), own: { text: words, replying: false, body: "the whole message" } as DraftInput["own"] };
      const letter = { ...redacted(), own: { text: words, replying: false } };
      await expect(make(fetchImpl).draft(extra)).rejects.toThrow(/redaction violation/);
      await expect(make(fetchImpl).draft(letter)).rejects.toThrow(/redaction violation/);
      expect(bodies).toEqual([]);
    });
  }

  it.each([["Reply", DRAFT_PREFIX], ["Write from words", DRAFT_OWN_PREFIX]])("%s tells the drafter when credentials may appear in a reply", (_mode, prefix) => {
    expect(prefix).toContain("codes, passwords, or links with tokens");
    expect(prefix).toContain("thread, message previews, or knowledge base");
    expect(prefix).toContain("explicitly asks for them in their own words");
  });

  it("the Sonnet drafter's request: the own-words prefix, the words, and a letter only when answering one", () => {
    const own = buildDraftParams(fromWords());
    expect(JSON.stringify(own.system)).toContain(JSON.stringify(DRAFT_OWN_PREFIX).slice(1, -1));
    expect(JSON.parse((own.messages as Array<{ content: string }>)[0]!.content)).toEqual({
      context: { kbEntries: [], threadMessages: [] }, own: { text: words },
    });
    const answering = buildDraftParams({ ...redacted(), own: { text: words, replying: true, subject: "Friday" } });
    expect(JSON.parse((answering.messages as Array<{ content: string }>)[0]!.content)).toEqual({
      incoming: redacted().incoming, context: { kbEntries: [], threadMessages: [] }, own: { text: words, subject: "Friday" },
    });
  });

  it("a reply from the letter alone serialises byte for byte as before: the reply prefix, and incoming then context", () => {
    const params = buildDraftParams(redacted());
    expect((params.system as Array<{ text: string }>)[0]!.text).toBe(DRAFT_PREFIX);
    expect((params.messages as Array<{ content: string }>)[0]!.content).toBe(JSON.stringify({
      incoming: { from: "her@example.test", subject: "Question", snippet: "when are you free?" },
      context: { kbEntries: [], threadMessages: [] },
    }));
  });
});
