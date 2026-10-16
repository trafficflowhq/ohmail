import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import {
  CLASSIFY_RESULT_SCHEMA, SCREEN_DESTINATIONS, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA,
  SensitivePayloadRefusal, StaticKeyProvider, TAXONOMY_PREFIX, classifyUserPayload,
} from "@trafficflow/core/mail";
import type { ClassifierInput, DraftInput } from "@trafficflow/core/mail";
import { ClassifierFaultError } from "@trafficflow/worker/classifier-fault";
import { ANTHROPIC_BASE } from "@trafficflow/core/ai-transports";
import { hasInstalledModel } from "@trafficflow/core/model-name";
import {
  AI_STORE_FILE, createLocalAi, type AiStatus, type LocalAi, type LocalAiOptions,
} from "../src/ai-provider.js";
import { refusingKeyProvider } from "../src/engine.js";
import { createSidecarLog } from "../src/log.js";

/**
 * THIS INSTALL'S OWN AI — what it does, what it refuses, and what it never sends.
 *
 * The subject is a standalone install that has no account and no allowance, running against a
 * model its owner supplies. Four things have to be true and none of them is provable by reading
 * the code, so every one of them is asserted against a recorded transport:
 *
 *  1. **Nothing configured makes NO request.** Not "makes a request that fails" — none at all.
 *     The counter is the evidence; a comment saying so would not be.
 *  2. **The API key is never written in the clear and never read back.** The bytes are grepped
 *     out of the file on disk, and the status surface is searched for them.
 *  3. **A capability is not claimed until it has been probed**, and changing the settings takes
 *     the claim away again.
 *  4. **A failing model degrades to rules-only and never wedges the mailbox.** The background
 *     port disappears; it does not start throwing.
 *
 * The transport is injected rather than mocked at the module boundary, so the assertions are
 * about the bytes that would leave this machine — the URL, the method, the headers — rather than
 * about which function was called.
 */

const KEY = anthropicKey("ai-provider");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ohmail-ai-"));
  dirs.push(d);
  return d;
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }

/** A transport that records everything and answers from a table of URL substrings. */
function recorder(routes: Array<[RegExp, () => Response]>): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    for (const [re, make] of routes) if (re.test(url)) return make();
    return new Response("no route", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An Anthropic transport that verifies cleanly and answers both features. */
function anthropicOk(): Array<[RegExp, () => Response]> {
  return [
    [/\/v1\/models\?/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }, { id: "claude-sonnet-5" }] })],
    [/\/v1\/models\//, () => json({ id: "ok" })],
    [/\/v1\/messages$/, () => json({
      content: [{
        type: "text",
        text: JSON.stringify({
          destination: "ohmail/News", confidence: 0.9, rationale: "a newsletter", spam: false,
        }),
      }],
    })],
  ];
}

async function make(opts: Partial<LocalAiOptions> & { dataDir: string }): Promise<LocalAi> {
  return createLocalAi({
    keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
    canStoreKey: true,
    log: createSidecarLog({ sink: () => undefined }),
    ...opts,
  });
}

const anInput = (subject: string): ClassifierInput => ({
  from: { name: null, address: "news@example.test" },
  subject,
  snippet: "the weekly roundup",
  headersDigest: "list-id present",
});

const aDraftInput = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});

describe("nothing configured — the state that must cost nothing", () => {
  it("offers neither feature, says why, and makes no outbound request at all", async () => {
    const { calls, fetchImpl } = recorder([]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });

    const status = ai.status();
    expect(status.provider).toBeNull();
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("not_configured");
    expect(status.contentGoesTo).toBeNull();

    // ABSENCE, not a port that throws — this is what the route table reads as
    // `drafter_unconfigured` and what the pipeline reads as "route on rules".
    expect(ai.drafter()).toBeUndefined();
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();

    // The whole point, and the only form of it that is evidence.
    expect(calls).toHaveLength(0);
  });

  it("writes no settings file until something is saved", async () => {
    const dir = dataDir();
    await make({ dataDir: dir, fetchImpl: recorder([]).fetchImpl });
    expect(readdirSync(dir)).not.toContain(AI_STORE_FILE);
  });
});

describe("the API key — sealed, never in the clear, never read back", () => {
  it("stores the key encrypted: the bytes are nowhere in the file on disk", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dir, fetchImpl });

    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    const onDisk = readFileSync(join(dir, AI_STORE_FILE), "utf8");
    expect(onDisk).not.toContain(KEY);
    // …and not a fragment of it either, which is what a partial-write or a debug field looks like.
    expect(onDisk).not.toContain(KEY.slice(0, 20));
    expect(JSON.parse(onDisk)).toMatchObject({ anthropic: { keyVersion: 1 } });
  });

  it("never returns the key from any surface — only that one is stored", async () => {
    const { fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    expect(status.settings.anthropic.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(ai.status())).not.toContain(KEY);
  });

  it("survives a relaunch: a second engine on the same directory can still call the model", async () => {
    const dir = dataDir();
    const first = recorder(anthropicOk());
    const a = await make({ dataDir: dir, fetchImpl: first.fetchImpl });
    await a.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    const second = recorder(anthropicOk());
    const b = await make({ dataDir: dir, fetchImpl: second.fetchImpl });
    expect(b.status().available).toBe(true);

    await b.classifier()!.classify(anInput("This week in email"));
    const call = second.calls.find((c) => c.url.endsWith("/v1/messages"))!;
    // The key came back out of the envelope the FIRST launch sealed, under the same install key.
    expect(call.headers["x-api-key"]).toBe(KEY);
  });

  it("REFUSES to store a key when the install has no durable key, and writes nothing", async () => {
    const dir = dataDir();
    const { calls, fetchImpl } = recorder(anthropicOk());
    const ai = await make({
      dataDir: dir, fetchImpl, keyProvider: refusingKeyProvider(), canStoreKey: false,
    });

    await expect(ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } }))
      .rejects.toMatchObject({ code: "install_key_absent", httpStatus: 503 });

    expect(readdirSync(dir)).not.toContain(AI_STORE_FILE);
    expect(calls).toHaveLength(0);
    expect(ai.status().canStoreKey).toBe(false);
  });

  it("still lets the machine-local provider be configured without a durable key", async () => {
    // The refusal is about SECRETS. A model on this machine needs none, so an install with no
    // keystore is not an install with no AI.
    const { fetchImpl } = recorder([
      [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
    ]);
    const ai = await make({
      dataDir: dataDir(), fetchImpl, keyProvider: refusingKeyProvider(), canStoreKey: false,
    });
    const status = await ai.save({ provider: "ollama", ollama: { classifyModel: "llama3.2", draftModel: "llama3.2" } });
    expect(status.available).toBe(true);
    expect(status.contentGoesTo).toBe("this_machine");
  });
});

describe("a capability is not claimed until it has been probed", () => {
  it("an endpoint that does not answer leaves the features unavailable, with the reason", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models/, () => { throw new TypeError("fetch failed"); }],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("unreachable");
    expect(status.probe?.reason).toBe("unreachable");
    expect(ai.drafter()).toBeUndefined();
  });

  it("a rejected key is reported as a rejected key, not as an outage", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models/, () => new Response("invalid x-api-key", { status: 401 })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    expect(status.probe?.reason).toBe("unauthorized");
    expect(status.probe?.detail).toContain("invalid x-api-key");
  });

  it("a running model server WITHOUT the model is a distinct, actionable state", async () => {
    const { fetchImpl } = recorder([
      [/\/api\/tags$/, () => json({ models: [{ name: "mistral:latest" }] })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({ provider: "ollama", ollama: { classifyModel: "llama3.2", draftModel: "llama3.2" } });
    expect(status.probe?.reason).toBe("model_absent");
    expect(status.probe?.models).toEqual(["mistral:latest"]);
  });

  it("changing the settings DISCARDS the verification — a new configuration is unproven", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dir, fetchImpl });
    expect((await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } })).available).toBe(true);

    // A save whose verification cannot run leaves the features off rather than inheriting the
    // previous configuration's success.
    const dead = recorder([]);
    const b = await make({ dataDir: dir, fetchImpl: dead.fetchImpl });
    const after = await b.save({ provider: "anthropic", anthropic: { classifyModel: "claude-sonnet-5" } });
    expect(after.available).toBe(false);
    expect(after.probe?.ok).toBe(false);
  });

  it("verification costs nothing: it lists models and asks for one, and never runs a completion", async () => {
    const { calls, fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/v1/messages"))).toBe(false);
  });
});

describe("provider selection", () => {
  it("the Anthropic endpoint is a literal that no setting can move", async () => {
    const { calls, fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    // A base URL is offered by the OTHER provider and is accepted on the same body; it must have
    // no effect on where a stored key travels.
    await ai.save({
      provider: "anthropic",
      anthropic: { apiKey: KEY },
      ollama: { baseUrl: "http://attacker.test:1234" },
    });
    await ai.classifier()!.classify(anInput("This week in email"));

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url.startsWith(ANTHROPIC_BASE)).toBe(true);
  });

  it("the machine-local provider carries no credential to the address it is pointed at", async () => {
    const { calls, fetchImpl } = recorder([
      [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
      [/\/api\/chat$/, () => json({
        message: { content: JSON.stringify({ destination: "INBOX", confidence: 0.5, rationale: "", spam: false }) },
      })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    // A key is stored, and the provider in force is the local one: nothing about it may travel.
    await ai.save({
      provider: "ollama",
      anthropic: { apiKey: KEY },
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });
    await ai.classifier()!.classify(anInput("This week in email"));

    for (const c of calls) {
      expect(c.url.startsWith("http://127.0.0.1:11434")).toBe(true);
      expect(JSON.stringify(c)).not.toContain(KEY);
      expect(c.headers["x-api-key"]).toBeUndefined();
    }
  });

  it("refuses an address that is not an http(s) origin", async () => {
    const ai = await make({ dataDir: dataDir(), fetchImpl: recorder([]).fetchImpl });
    await expect(ai.save({ provider: "ollama", ollama: { baseUrl: "file:///etc/passwd" } }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(ai.save({ provider: "ollama", ollama: { baseUrl: "not a url" } }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("matches a model family to its tag without matching a different family", () => {
    expect(hasInstalledModel(["llama3.2:latest"], "llama3.2")).toBe(true);
    expect(hasInstalledModel(["llama3.2:1b"], "llama3.2:1b")).toBe(true);
    expect(hasInstalledModel(["llama3.2:1b"], "llama3.2:3b")).toBe(false);
    // The one a prefix test gets wrong.
    expect(hasInstalledModel(["llama3.2-vision:latest"], "llama3.2")).toBe(false);
  });
});

describe("what is never sent, whichever provider is chosen", () => {
  it("mail carrying authentication material is refused at the sink and nothing goes out", async () => {
    const { calls, fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    const before = calls.length;

    await expect(ai.classifier()!.classify(anInput("Your one-time verification code is 402913")))
      .rejects.toBeInstanceOf(SensitivePayloadRefusal);

    // Not "a request that was rejected" — no request.
    expect(calls.length).toBe(before);
  });

  it("a drafting input carrying a raw field is refused before a request is built", async () => {
    const { calls, fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    const before = calls.length;

    const smuggled = aDraftInput() as DraftInput & { incoming: { body?: string } };
    smuggled.incoming.body = "the entire message, unredacted";

    await expect(ai.drafter()!.draft(smuggled)).rejects.toThrow(/non-redacted field 'body'/);
    expect(calls.length).toBe(before);
  });
});

describe("a failing model degrades to rules-only and never wedges the mailbox", () => {
  /** A transport that verifies fine and then fails every model call. */
  const brokenAfterVerify = (): { calls: Call[]; fetchImpl: typeof fetch } => recorder([
    [/\/v1\/models\?/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }] })],
    [/\/v1\/models\//, () => json({ id: "ok" })],
    [/\/v1\/messages$/, () => new Response("upstream is unwell", { status: 500 })],
  ]);

  it("withholds the background port after repeated faults, and keeps offering the request path", async () => {
    const { fetchImpl } = brokenAfterVerify();
    const ai = await make({ dataDir: dataDir(), fetchImpl, faultThreshold: 2, cooldownMs: 60_000 });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    for (let i = 0; i < 2; i++) {
      const port = ai.classifierForCycle();
      expect(port, `the port was withheld too early, on attempt ${i + 1}`).toBeDefined();
      await expect(port!.classify(anInput("hello"))).rejects.toBeInstanceOf(ClassifierFaultError);
    }

    // The cycle port is gone — `planChange` short-circuits and the message files on rules.
    expect(ai.classifierForCycle()).toBeUndefined();
    // The REQUEST path is untouched: somebody who asks for a suggestion still gets an answer,
    // and the answer is the failure rather than silence.
    expect(ai.classifier()).toBeDefined();
  });

  it("tags a background fault as a MODEL fault, so a bad model cannot mark a mailbox broken", async () => {
    const { fetchImpl } = brokenAfterVerify();
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    await expect(ai.classifierForCycle()!.classify(anInput("hello")))
      .rejects.toBeInstanceOf(ClassifierFaultError);
  });

  it("a sensitivity refusal is NOT a model fault: it never withholds routing", async () => {
    const { fetchImpl } = recorder(anthropicOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl, faultThreshold: 2 });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    for (let i = 0; i < 5; i++) {
      await expect(ai.classifierForCycle()!.classify(anInput("Your login code is 991823")))
        .rejects.toBeInstanceOf(SensitivePayloadRefusal);
    }
    // Five refusals in a row, and routing is still on. Counting them would let one kind of mail
    // arriving turn the model off for every other kind.
    expect(ai.classifierForCycle()).toBeDefined();
  });

  it("the cooldown expires and the model is asked again", async () => {
    let clock = 1_000_000;
    const { fetchImpl } = brokenAfterVerify();
    const ai = await make({
      dataDir: dataDir(), fetchImpl, faultThreshold: 1, cooldownMs: 30_000,
      now: () => new Date(clock),
      monotonic: () => clock,
    });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await expect(ai.classifierForCycle()!.classify(anInput("hello"))).rejects.toThrow();
    expect(ai.classifierForCycle()).toBeUndefined();
    clock += 30_001;
    expect(ai.classifierForCycle()).toBeDefined();
  });

  it("the cooldown expires on time though the wall clock stepped back an hour inside it", async () => {
    let wall = 1_000_000_000;
    let mono = 5_000;
    const { fetchImpl } = brokenAfterVerify();
    const ai = await make({
      dataDir: dataDir(), fetchImpl, faultThreshold: 1, cooldownMs: 30_000,
      now: () => new Date(wall), monotonic: () => mono,
    });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await expect(ai.classifierForCycle()!.classify(anInput("hello"))).rejects.toThrow();
    expect(ai.classifierForCycle()).toBeUndefined();
    wall += 30_001 - 60 * 60_000;
    mono += 30_001;
    expect(ai.classifierForCycle(), "the model stayed withheld for the clock's step").toBeDefined();
  });

  it("the cooldown is over after a suspend: the wall clock moved, the monotonic one did not", async () => {
    let wall = 1_000_000_000;
    let mono = 5_000;
    const { fetchImpl } = brokenAfterVerify();
    const ai = await make({
      dataDir: dataDir(), fetchImpl, faultThreshold: 1, cooldownMs: 30_000,
      now: () => new Date(wall), monotonic: () => mono,
    });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await expect(ai.classifierForCycle()!.classify(anInput("hello"))).rejects.toThrow();
    expect(ai.classifierForCycle()).toBeUndefined();
    mono += 1_000;
    expect(ai.classifierForCycle(), "CONTROL: inside the cooldown on both clocks").toBeUndefined();
    wall += 8 * 60 * 60_000;
    expect(ai.classifierForCycle(), "the model stayed withheld for an awake cooldown after the sleep").toBeDefined();
  });
});

describe("the SCREENING question — one question, however this install reaches a model", () => {
  /**
   * WHAT IS ON THE WIRE WHEN A PERSON PRESSES "SUGGEST", AND WHY IT IS ASSERTED HERE.
   *
   * The Screener's suggestion path asks a DIFFERENT question from the one live routing asks. It has
   * to: `ohmail/Screener` is what the routing taxonomy defines as the answer for a first-contact
   * sender, and every row that path can reach is a first-contact sender — so the routing question
   * had its answer built in, and the model gave it most of the time.
   *
   * `ClassifierPort.screen` is OPTIONAL, and callers fall back to `classify` without it. That
   * fallback degrades advice without endangering anything, which is precisely what let a standalone
   * install go on asking the wrong question for a release with every test green. So these assert
   * the REQUEST, through `createLocalAi` rather than against a transport directly — the port wiring
   * is the layer that silently fell back, and a guard that skipped it would prove the transports can
   * do something nobody calls.
   *
   * The prefix is compared BYTE FOR BYTE against core's export rather than searched for a phrase.
   * Two hosts asking one question in two slightly different wordings is a defect neither host's
   * suite can see, because each passes its own; comparing against the shared source is the only
   * check that catches it.
   */
  const bodyOf = (call: Call): Record<string, unknown> =>
    JSON.parse(call.body ?? "{}") as Record<string, unknown>;

  /** The system prefix a recorded completion carried, whichever provider shaped the request. */
  function prefixOf(call: Call): string {
    const b = bodyOf(call) as {
      system?: Array<{ text?: string }>;
      messages?: Array<{ role?: string; content?: string }>;
    };
    // Anthropic puts it in a cacheable `system` block; Ollama sends it as the first chat message.
    if (Array.isArray(b.system)) return b.system[0]?.text ?? "";
    return b.messages?.find((m) => m.role === "system")?.content ?? "";
  }

  /** The raw user turn, as a string — what the shared sink produced, serialised. */
  function userTurnOf(call: Call): string {
    const b = bodyOf(call) as { messages?: Array<{ role?: string; content?: string }> };
    return b.messages?.find((m) => m.role === "user")?.content ?? "";
  }

  const completions = (calls: Call[]): Call[] =>
    calls.filter((c) => /\/v1\/messages$|\/api\/chat$/.test(c.url));

  /** A screening answer the five-pile schema accepts. */
  const aScreeningVerdict = (): Response => json({
    content: [{
      type: "text",
      text: JSON.stringify({ destination: "INBOX", confidence: 0.8, rationale: "a person", spam: false }),
    }],
    message: {
      content: JSON.stringify({ destination: "INBOX", confidence: 0.8, rationale: "a person", spam: false }),
    },
  });

  const ollamaOk = (): Array<[RegExp, () => Response]> => [
    [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
    [/\/api\/chat$/, aScreeningVerdict],
  ];

  const anthropicScreening = (): Array<[RegExp, () => Response]> => [
    [/\/v1\/models\?/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }] })],
    [/\/v1\/models\//, () => json({ id: "ok" })],
    [/\/v1\/messages$/, aScreeningVerdict],
  ];

  it("Anthropic is sent core's screening prefix, byte for byte, in a cacheable block", async () => {
    const { calls, fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await ai.classifier()!.screen!(anInput("A note from a stranger"));

    const [call] = completions(calls);
    expect(call, "no completion was made for the screening question").toBeDefined();
    expect(call!.url).toBe(`${ANTHROPIC_BASE}/v1/messages`);
    // THE DRIFT GUARD. A local copy of the words, or one appended sentence, goes red here.
    expect(prefixOf(call!), "the local screening prefix has drifted from the shared one").toBe(SCREENING_PREFIX);
    // And it is the SCREENING question, not the routing one — the two must never be crossed.
    expect(prefixOf(call!)).not.toBe(TAXONOMY_PREFIX);

    const body = bodyOf(call!) as {
      system?: Array<{ cache_control?: unknown }>;
      output_config?: { format?: { schema?: unknown } };
    };
    // Account-independent, so it is cached — which is also why one account's words may never be in it.
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.output_config?.format?.schema).toEqual(SCREENING_RESULT_SCHEMA);
  });

  it("a model on this machine is sent the SAME prefix and the same schema", async () => {
    const { calls, fetchImpl } = recorder(ollamaOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });

    await ai.classifier()!.screen!(anInput("A note from a stranger"));

    const [call] = completions(calls);
    expect(call, "no completion was made for the screening question").toBeDefined();
    expect(call!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(
      prefixOf(call!),
      "the model on this machine was asked a different question from the one Anthropic is asked",
    ).toBe(SCREENING_PREFIX);
    expect(prefixOf(call!)).not.toBe(TAXONOMY_PREFIX);
    expect((bodyOf(call!) as { format?: unknown }).format).toEqual(SCREENING_RESULT_SCHEMA);
  });

  /**
   * EVERY LOCAL CALL CARRIES A TOKEN CEILING — the bound whose absence was a hang.
   *
   * The two hosted providers have always bounded their answers with `max_tokens`; this one sent
   * nothing, and Ollama generates until the context window runs out. Against a real daemon that
   * turned a small model's repetition loop into a call that never returned — invisible to every
   * recorded test in this file, because a fake transport always answers.
   *
   * So the ceiling is asserted on the REQUEST, which is the only thing a recorded transport can
   * prove, and the live file next door proves the behaviour it buys.
   */
  it("bounds what a model on this machine may generate, on all three calls", async () => {
    const { calls, fetchImpl } = recorder(ollamaOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });
    calls.length = 0;

    await ai.classifier()!.classify(anInput("The weekly"));
    await ai.classifier()!.screen!(anInput("A note from a stranger"));
    await ai.drafter()!.draft(aDraftInput());

    const sent = completions(calls);
    expect(sent).toHaveLength(3);
    for (const call of sent) {
      const options = (bodyOf(call) as { options?: { num_predict?: unknown } }).options;
      expect(options?.num_predict, `${call.url} carried no token ceiling`).toEqual(expect.any(Number));
      expect(options!.num_predict as number).toBeGreaterThan(0);
    }
    // The same budgets the hosted providers use: a verdict is small, a draft is not.
    const budgets = sent.map((c) => (bodyOf(c) as { options: { num_predict: number } }).options.num_predict);
    expect(budgets).toEqual([512, 512, 2048]);
  });

  /**
   * A TRUNCATED ANSWER IS DIAGNOSED, not reported as a broken model server.
   *
   * Hitting the ceiling leaves the JSON cut mid-string, so the parse below it would fail and say
   * "not valid JSON" — true, and it sends somebody debugging their daemon when the actual problem
   * is that their model would not stop. `done_reason` is the only place that distinction survives.
   */
  it("says a local model ran out of room, rather than blaming its JSON", async () => {
    const { fetchImpl } = recorder([
      [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
      [/\/api\/chat$/, () => json({
        message: { content: '{"destination":"ohmail/Rea' },
        done_reason: "length",
      })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });
    await expect(ai.classifier()!.classify(anInput("The weekly")))
      .rejects.toThrow(/did not finish within 512 tokens/);
  });

  /**
   * A CAPPED ANSWER THAT IS NEVERTHELESS COMPLETE IS USED, not thrown away.
   *
   * `done_reason: "length"` says the model was still going when the budget ran out — which is NOT
   * the same as "the answer is unusable". When the last allowed token happens to close the object,
   * the content is complete and schema-valid and the model simply had not emitted its stop token.
   * Refusing on the flag alone discarded a good verdict, and it would have done so most often on
   * the small models this provider exists for, where the budget is likeliest to be reached.
   */
  it("uses a local answer that is complete even though the budget ran out", async () => {
    const { fetchImpl } = recorder([
      [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
      [/\/api\/chat$/, () => json({
        message: {
          content: JSON.stringify({
            destination: "ohmail/News", confidence: 0.7, rationale: "a newsletter", spam: false,
          }),
        },
        // Still going when the ceiling arrived — and yet the object closed.
        done_reason: "length",
      })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });
    const result = await ai.classifier()!.classify(anInput("The weekly"));
    expect(result.destination).toBe("ohmail/News");
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it("the gate is the question, so it is not offered as an answer", async () => {
    const { calls, fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await ai.classifier()!.screen!(anInput("A note from a stranger"));
    const schema = (bodyOf(completions(calls)[0]!) as {
      output_config?: { format?: { schema?: { properties?: { destination?: { enum?: string[] } } } } };
    }).output_config?.format?.schema;

    // The mechanical difference between the two questions, and the whole of the fix for the
    // tautology: five piles, with the gate's own name removed.
    expect(schema?.properties?.destination?.enum).toEqual(SCREEN_DESTINATIONS);
    expect(schema?.properties?.destination?.enum).not.toContain("ohmail/Screener");
    // The routing question still offers it, which is what makes the removal meaningful rather than
    // a taxonomy change nobody chose.
    expect(CLASSIFY_RESULT_SCHEMA.properties.destination.enum).toContain("ohmail/Screener");
  });

  it("the account's own words go in the USER turn and never in the shared prefix", async () => {
    const bar = "Only real people writing to me, and anything from my accountant.";
    const { calls, fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    await ai.classifier()!.screen!({ ...anInput("A note from a stranger"), ohboxBar: bar });

    const [call] = completions(calls);
    expect(userTurnOf(call!)).toContain(bar);
    // THE PROMPT CACHE IS SHARED ACROSS ACCOUNTS. One account's sentence in the cached prefix
    // would be served on another account's request, so this is a disclosure guard and not a
    // tidiness one.
    expect(prefixOf(call!), "one account's words are in the cached, shared prefix").not.toContain(bar);
    // The INSTRUCTION about the field belongs there; the field's value does not.
    expect(prefixOf(call!)).toContain("ohboxBar");
  });

  it("the user turn is exactly what the shared sink produced, never a payload built beside it", async () => {
    const { calls, fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    const input = { ...anInput("A note from a stranger"), ohboxBar: "people only" };
    await ai.classifier()!.screen!(input);

    // `classifyUserPayload` is the outbound sensitivity sink as well as the serialiser, and it is
    // shared with the routing question and with the hosted classifier deliberately: what leaves
    // this process is a property of the process, not of which question it was attached to. A
    // second builder here is how one of the two questions eventually ships without the sink.
    expect(userTurnOf(calls.find((c) => c.url.endsWith("/v1/messages"))!))
      .toBe(JSON.stringify(classifyUserPayload(input)));
  });

  it("refuses credential material on this path too, unless the caller says it redacted", async () => {
    const { calls, fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    const before = completions(calls).length;

    // No `outbound` field ⇒ the sink refuses, exactly as it does for routing. Absent means safe.
    await expect(ai.classifier()!.screen!(anInput("Your one-time verification code is 402913")))
      .rejects.toBeInstanceOf(SensitivePayloadRefusal);
    expect(completions(calls).length, "a refused payload still reached the wire").toBe(before);

    // And a caller that redacted and SAYS so is served — which is the whole of the AI-OPEN change.
    await ai.classifier()!.screen!({
      ...anInput("Your sign-in code"),
      snippet: "Use [REDACTED] to sign in.",
      outbound: "prescreened",
    });
    expect(completions(calls).length).toBe(before + 1);
  });

  it("the BACKGROUND port cannot ask it at all — the method is not on the object", async () => {
    const { fetchImpl } = recorder(anthropicScreening());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });

    // Live mail files on the ROUTING question, whose answer set keeps the gate in it. A background
    // pass that could not answer "hold" would have to file every stranger somewhere. Absence is the
    // guarantee: there is no argument and no flag that reaches the screening question from a sync
    // cycle, because the method does not exist there.
    expect(ai.classifierForCycle()!.screen).toBeUndefined();
    // While the path a person pressed carries it.
    expect(ai.classifier()!.screen).toBeDefined();
  });
});

describe("the source census — outbound requests live at the seam and nowhere else", () => {
  /**
   * The other half of "an unconfigured install makes no request".
   *
   * The counting tests prove it for the paths they walk; a census proves there is no OTHER path,
   * because network egress from a module nothing handed a transport to is egress this package
   * never decided on. Two rules, and the second is the one that would actually catch a mistake:
   *
   *  · **Nothing calls the platform's global `fetch` directly** — not even the provider modules.
   *    They use what they were handed, which is what makes "no provider configured ⇒ no request"
   *    checkable by counting rather than by reading.
   *  · **The one wrapper that carries a deadline is called only by the providers.** Any other
   *    caller would be another place where a timeout could be forgotten.
   *
   * {@link PROVIDERS} is the census's whole point and is written out by hand on purpose: it is the
   * list a new provider has to be ADDED to, deliberately, by somebody who has read the two rules
   * above. Deriving it from the directory (every `ai-*.ts`, say) would make it match whatever is
   * there — and a census that cannot disagree with the tree is not a census. The providers live in
   * `packages/core/src/ai/transports` beside the seam, so both rules read that directory too.
   */
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));
  const TRANSPORTS = fileURLToPath(new URL("../../../packages/core/src/ai/transports/", import.meta.url));
  const PROVIDERS = new Set([
    "ai-anthropic.ts", "ai-ollama.ts", "ai-openai.ts", "ai-opencode-go.ts", "ai-opencode-go-chat.ts",
  ]);
  /**
   * A CALL of the global `fetch`. The two lookbehinds are both load-bearing: `[\w$.]` keeps
   * `doFetch(` and `opts.fetchImpl(` out, and `async\s+` keeps a METHOD NAMED `fetch` out —
   * the local engine defines one for its image proxy, and a definition is not egress.
   */
  const CALLS_GLOBAL_FETCH = /(?<![\w$.])(?<!async\s{1,4})fetch\s*\(/;
  const filesIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const files = (): string[] => filesIn(SRC);
  const read = (f: string): string => readFileSync(join(SRC, f), "utf8");
  const transports = (): string[] => filesIn(TRANSPORTS);
  const readTransport = (f: string): string => readFileSync(join(TRANSPORTS, f), "utf8");

  it("scans the package at all", () => {
    expect(files().length).toBeGreaterThanOrEqual(10);
    expect(transports().filter((f) => PROVIDERS.has(f)).sort()).toEqual([...PROVIDERS].sort());
  });

  it("no module calls the global fetch — every request goes through an injected transport", () => {
    expect(files().filter((f) => CALLS_GLOBAL_FETCH.test(read(f)))).toEqual([]);
    expect(transports().filter((f) => CALLS_GLOBAL_FETCH.test(readTransport(f)))).toEqual([]);
  });

  /** A CALL of the deadline wrapper — its own `export async function` line is not one. */
  const CALLS_WRAPPER = /(?<!function\s{1,4})fetchWithDeadline\s*\(/;

  /**
   * The SEAM calls the wrapper too, since the two key-carrying providers' verification became one
   * function here: that request is the seam's own and carries the deadline its caller handed it,
   * which is the rule rather than an exception to it. Named apart from {@link PROVIDERS} so the
   * list a new provider must be added to stays the list of providers, and so a FOURTH caller —
   * a module that could forget a timeout — is still a red.
   */
  const SEAM = "ai-transport.ts";

  it("only the providers and the seam that declares it reach the deadline wrapper", () => {
    expect(files().filter((f) => CALLS_WRAPPER.test(read(f)))).toEqual([]);
    const callers = transports().filter((f) => CALLS_WRAPPER.test(readTransport(f)));
    expect(callers.sort()).toEqual([...PROVIDERS, SEAM].sort());
  });

  it("and the detector actually detects — the positive controls", () => {
    // Without these, a regex that matches nothing passes both cases above forever.
    expect(CALLS_GLOBAL_FETCH.test("const r = await fetch(url);")).toBe(true);
    expect(CALLS_GLOBAL_FETCH.test("fetch(url)")).toBe(true);
    expect(CALLS_GLOBAL_FETCH.test("await doFetch(url)")).toBe(false);
    expect(CALLS_GLOBAL_FETCH.test("opts.fetchImpl(url)")).toBe(false);
    expect(CALLS_GLOBAL_FETCH.test("const x = { async fetch() { return null; } };")).toBe(false);
    // …and the wrapper really is used, so the second rule is not asserting an empty set,
    // while its own declaration is correctly not counted as a call.
    expect(CALLS_WRAPPER.test("await fetchWithDeadline(doFetch, url, {}, 1)")).toBe(true);
    expect(CALLS_WRAPPER.test("export async function fetchWithDeadline(")).toBe(false);
    expect(transports().filter((f) => CALLS_WRAPPER.test(readTransport(f))).length).toBeGreaterThan(0);
  });
});

/* ── where message content goes ────────────────────────────────────────────────────────────── */

/**
 * WHERE CONTENT GOES IS STATED FROM THE STORED ORIGIN, NEVER FROM THE PROVIDER NAME.
 *
 * `contentGoesTo` exists so a settings window does not have to infer the destination from a word.
 * Mapping the provider NAME straight to a destination is that same inference moved one process to
 * the left, and Ollama is where the name and the fact come apart: the address beside it takes any
 * http(s) origin, so "this machine" is true of a loopback origin and false of every other one.
 *
 * THREE STATES, NAMED APART — an optional member whose `null` also means something:
 *  · a value  — the engine states where content goes.
 *  · `null`   — nothing is configured, so nothing is sent anywhere. That is a CLAIM.
 *  · ABSENT   — the engine does not state it, and a consumer may not turn that into a claim. It
 *               is the only honest answer for a model server somewhere else: the engine has no
 *               value for "a machine you named", and `this_machine` there is simply false.
 *
 * HOW TO WATCH IT FAIL: in `ai-provider.ts`, give `destinationOf`'s ollama arm an unconditional
 * `{ contentGoesTo: "this_machine" }` — the four not-this-machine origins and the key census both
 * go red. Restore it and both go green.
 */
describe("contentGoesTo — stated from the stored origin, absent when it cannot be", () => {
  const tagsOnly = (): Array<[RegExp, () => Response]> => [
    [/\/api\/tags$/, () => json({ models: [{ name: "llama3.2:latest" }] })],
  ];

  const savedOllamaAt = async (baseUrl: string): Promise<AiStatus> => {
    const ai = await make({ dataDir: dataDir(), fetchImpl: recorder(tagsOnly()).fetchImpl });
    return ai.save({
      provider: "ollama",
      ollama: { baseUrl, classifyModel: "llama3.2", draftModel: "llama3.2" },
    });
  };

  /**
   * The origin table the engine decides on. `AiProviderForm.ollamaIsLocal` answers the SAME table
   * for the other question — what choosing Ollama at this address would mean — and the copy of it
   * in `desktop-ai-verdict.test.tsx` is kept equal to this one by hand, because the renderer takes
   * no workspace dependency the engine could hand it.
   */
  it.each([
    ["http://127.0.0.1:11434", true],
    ["http://127.1.2.3:11434", true],
    ["http://localhost:11434", true],
    ["http://[::1]:11434", true],
    ["http://box.lan:11434", false],
    ["https://ollama.example.test", false],
    ["http://192.168.1.20:11434", false],
    ["http://LOCALHOST.evil.test:11434", false],
  ])("%s is on this machine: %s", async (baseUrl, onThisMachine) => {
    const status = await savedOllamaAt(baseUrl);
    // The probe answered for every origin, so `available` is not what separates these cases.
    expect(status.available).toBe(true);
    if (onThisMachine) expect(status.contentGoesTo).toBe("this_machine");
    else expect("contentGoesTo" in status, `${baseUrl} was described as this machine`).toBe(false);
  });

  it("keeps `null` and ABSENT apart: nothing configured CLAIMS that nothing is sent", async () => {
    const ai = await make({ dataDir: dataDir(), fetchImpl: recorder([]).fetchImpl });
    const status = ai.status();
    expect("contentGoesTo" in status).toBe(true);
    expect(status.contentGoesTo).toBeNull();
  });

  it("names the vendor for a hosted provider, which is where content really does go", async () => {
    const ai = await make({ dataDir: dataDir(), fetchImpl: recorder(anthropicOk()).fetchImpl });
    const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
    expect(status.contentGoesTo).toBe("anthropic");
  });

  /* ── the key census, over the bytes rather than the type ──────────────────────────────── */

  /**
   * The keys `/local/ai` may serve. A wire format has three homes — the admitted key list, the
   * serializer and the parser — and they have to agree; this is the list, asserted against what
   * the engine actually emits so the two cannot drift apart in silence. A key not on it is a
   * smuggled column; a required key missing is a client left to guess.
   */
  const ADMITTED = [
    "provider", "available", "unavailableReason", "contentGoesTo", "settings", "probe", "canStoreKey",
  ];
  /** Every admitted key except the one whose ABSENCE is a state. */
  const REQUIRED = ADMITTED.filter((k) => k !== "contentGoesTo");

  /** Exactly what `jsonResponse(ai.status())` puts on the wire — `undefined` members included. */
  const onTheWire = (status: AiStatus): string[] =>
    Object.keys(JSON.parse(JSON.stringify(status)) as Record<string, unknown>);

  it("serves no key the spec does not admit, and every key it requires, in all four states", async () => {
    const nothing = await make({ dataDir: dataDir(), fetchImpl: recorder([]).fetchImpl });
    const hostedAi = await make({ dataDir: dataDir(), fetchImpl: recorder(anthropicOk()).fetchImpl });
    const states: Array<[string, AiStatus]> = [
      ["nothing configured", nothing.status()],
      ["a hosted vendor", await hostedAi.save({ provider: "anthropic", anthropic: { apiKey: KEY } })],
      ["Ollama on this machine", await savedOllamaAt("http://127.0.0.1:11434")],
      ["Ollama somewhere else", await savedOllamaAt("https://ollama.example.test")],
    ];

    for (const [name, status] of states) {
      const keys = onTheWire(status);
      expect(keys.filter((k) => !ADMITTED.includes(k)), `${name} served a key the spec does not admit`)
        .toEqual([]);
      expect(REQUIRED.filter((k) => !keys.includes(k)), `${name} dropped a required key`).toEqual([]);
    }

    // …and the optional one is optional in the direction that matters: it is on the wire when the
    // engine has something to say and OFF it when it has not. A member serialized as `null` there
    // would read as "nothing is sent anywhere" at every consumer.
    expect(onTheWire(states[3]![1])).not.toContain("contentGoesTo");
    for (const [name, status] of states.slice(0, 3)) {
      expect(onTheWire(status), `${name} should state a destination`).toContain("contentGoesTo");
    }
  });
});
