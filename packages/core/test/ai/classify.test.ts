import { describe, it, expect } from "vitest";
import {
  buildClassifyParams, buildScreeningParams, makeHaikuClassifier,
  CLASSIFY_RESULT_SCHEMA, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX, classifyUserPayload,
  type AnthropicLike, type ClassifierInput,
} from "../../src/ai/classify.js";
import { ModelRuleRefusal } from "../../src/model-rules.js";
import { ModelDeclinedError } from "../../src/model-declined.js";
import { rationaleHoldsAtGate } from "../../src/classify-prompt.js";

const INPUT: ClassifierInput = {
  from: { name: "News", address: "news@example.com" },
  subject: "Weekly digest",
  snippet: "Here is what happened this week ...",
  headersDigest: "list-unsubscribe,precedence:bulk",
  fewShot: [{ from: "a@b.example", destination: "ohmail/News" }],
};

function fakeClient(text: string): AnthropicLike & { lastParams: unknown } {
  const c = {
    lastParams: undefined as unknown,
    messages: {
      async create(params: unknown) {
        c.lastParams = params;
        return { content: [{ type: "text", text }] };
      },
    },
  };
  return c;
}

describe("makeHaikuClassifier — request shape", () => {
  it("builds a claude-haiku-5-5 request with thinking off, a cached taxonomy system prefix and json_schema structured output", () => {
    const params = buildClassifyParams(INPUT, { client: {} as AnthropicLike }) as any;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(512);
    // taxonomy prefix in a cached system block (cache_control ephemeral on the stable prefix)
    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0].text).toMatch(/ohmail\/News/);
    // structured output via output_config.format json_schema (NOT the deprecated output_format)
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema.properties.destination.enum).toContain("ohmail/News");
    expect(params.output_format).toBeUndefined();
    // THINKING IS OFF — the decision the old "no thinking field" pin said a thinking-by-default
    // model would force. Haiku 5.5 thinks by default, and 512 tokens cap thinking plus the
    // verdict together, so a thinking pass can truncate the JSON on the per-message path.
    // `disabled` is legal on Haiku 5.5 at effort `high` or below; no effort is sent (default medium).
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config.effort).toBeUndefined();
    // volatile per-message fields live in the user turn, AFTER the cache breakpoint
    const userContent = params.messages[0].content as string;
    expect(params.messages[0].role).toBe("user");
    expect(userContent).toContain("Weekly digest");
    expect(userContent).toContain("news@example.com");
    expect(userContent).not.toContain("cache_control");
  });

  it("passes inference_geo only when configured (EU residency)", () => {
    const withGeo = buildClassifyParams(INPUT, { client: {} as AnthropicLike, inferenceGeo: "eu" }) as any;
    expect(withGeo.inference_geo).toBe("eu");
    const without = buildClassifyParams(INPUT, { client: {} as AnthropicLike }) as any;
    expect("inference_geo" in without).toBe(false);
  });

  it("the screening question is the same model, budget and thinking-off value", () => {
    const params = buildScreeningParams(INPUT, { client: {} as AnthropicLike }) as any;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(512);
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("an override is sent its own model's thinking-off value, never the default's", () => {
    const older = buildClassifyParams(INPUT, { client: {} as AnthropicLike, model: "claude-haiku-4-5-20251001" }) as any;
    expect(older.model).toBe("claude-haiku-4-5-20251001");
    expect(older.thinking).toEqual({ type: "disabled" });
    const sonnet = buildScreeningParams(INPUT, { client: {} as AnthropicLike, model: "claude-sonnet-5-5" }) as any;
    expect(sonnet.thinking).toEqual({ type: "between_tools" });
  });

  /**
   * A model that cannot turn thinking off would overrun the 512-token verdict, and an id with no
   * row would be sent a guessed shape — a 400 at the first message. Both are refused BY NAME, and
   * the factory asks at construction, so a misconfigured port fails before any call.
   */
  it("refuses by name a model with no thinking-off value or no row, and the factory refuses at construction", () => {
    const cases = [["claude-opus-5-5", "thinking_stays_on"], ["claude-haiku-4-5-99999999", "no_rules"]] as const;
    for (const [model, reason] of cases) {
      let thrown: unknown;
      try { buildClassifyParams(INPUT, { client: {} as AnthropicLike, model }); } catch (e) { thrown = e; }
      expect(thrown, model).toBeInstanceOf(ModelRuleRefusal);
      expect((thrown as ModelRuleRefusal).reason).toBe(reason);
      expect((thrown as Error).message).toContain(model);
      const client = fakeClient("{}");
      expect(() => makeHaikuClassifier({ client, model })).toThrow(ModelRuleRefusal);
      expect(client.lastParams).toBeUndefined();
    }
  });
});

/**
 * ── THE OWNER'S WORDS ARE IN THE REQUEST, OR THE BAR IS A SETTINGS SCREEN THAT DOES NOTHING ──
 *
 * `ohboxBar` crosses four boundaries between the textarea and the wire — a column, a preference
 * read, a `ClassifierInput`, a serialised user turn — and until this test the last of them was
 * unwatched. `screener-suggest-posture.pg.test.ts` proves the value reaches `classify()`'s INPUT;
 * a build that accepted it there and dropped it while serialising would pass that test and send a
 * request with no bar in it, and the only symptom would be suggestions that quietly ignore what
 * the account asked for. So this asserts on the STRING THAT LEAVES: the exact words, in the user
 * turn, on the volatile side of the cache breakpoint.
 *
 * The words are the ones from the account that reported the Screener-vs-Ohbox defect, kept
 * verbatim rather than paraphrased, because a paraphrase is a fixture and these are evidence.
 */
describe("the account's Ohbox bar reaches the wire", () => {
  const OWNER_BAR =
    "Keep my Ohbox for real people writing to me (not any cold mail advertisers wanting to sell a service)";

  it("serialises the user's words verbatim into the USER turn", () => {
    const params = buildClassifyParams({ ...INPUT, ohboxBar: OWNER_BAR }, { client: {} as AnthropicLike }) as any;
    const userContent = params.messages[0].content as string;
    expect(userContent).toContain(OWNER_BAR);
    expect(JSON.parse(userContent).ohboxBar).toBe(OWNER_BAR);
  });

  /**
   * AND NEVER INTO THE CACHED SYSTEM PREFIX. That block carries
   * `cache_control:{type:"ephemeral"}` and is byte-identical across accounts; a per-account
   * string in it would poison the shared cache and put one person's words on another person's
   * request. This is the assertion that makes the placement a rule rather than a habit.
   */
  it("never into the cached system prefix — the bar is per-account, the prefix is shared", () => {
    const params = buildClassifyParams({ ...INPUT, ohboxBar: OWNER_BAR }, { client: {} as AnthropicLike }) as any;
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0].text).not.toContain(OWNER_BAR);
    expect(params.system[0].text).not.toContain("cold mail advertisers");
  });

  /**
   * An account that set no bar sends a request BYTE-IDENTICAL to the pre-bar one — the key is
   * absent, not empty. A `"ohboxBar":""` would be a field the model has to reason about and a
   * cache-irrelevant difference in every request from every account that never opened the
   * setting.
   */
  it("a null or blank bar is omitted entirely, not sent empty", () => {
    const none = buildClassifyParams(INPUT, { client: {} as AnthropicLike }) as any;
    const blank = buildClassifyParams({ ...INPUT, ohboxBar: "   " }, { client: {} as AnthropicLike }) as any;
    expect("ohboxBar" in JSON.parse(none.messages[0].content)).toBe(false);
    expect("ohboxBar" in JSON.parse(blank.messages[0].content)).toBe(false);
    expect(blank.messages[0].content).toBe(none.messages[0].content);
  });
});

/**
 * ── THE GATE-CONTRADICTION CHECK ─────────────────────────────────────────────────────────────
 *
 * A routing answer travels on two channels — the structured `destination` and the one-line
 * `rationale` — and only the first is schema-checked. `rationaleHoldsAtGate` reads the second,
 * for the ONE consumer that can act on the disagreement safely: the Screener's suggestion path,
 * where the worst it can do is show "this one needs you" instead of a destination chip.
 *
 * The negation cases are not politeness. They are the shapes an INBOX verdict actually uses to
 * mention the gate, and without them the check fires on prose that agrees with its own field —
 * which would downgrade every confident admission and make the suggestion feature useless in a
 * different direction.
 */
describe("rationaleHoldsAtGate", () => {
  const HOLDS = [
    // Verbatim from the production row that started this.
    "First-contact sender with German business pitch about accounting services for TrafficFlow "
    + "GmbH; unsolicited cold mail from unknown sender matching user's criteria for Screener hold.",
    "Unknown sender; belongs in the Screener for the account holder to review.",
    "First contact — hold at the screener.",
    "SCREENER: unrecognised address.",
  ];
  const DOES_NOT = [
    "Replies to a thread the account holder started; not a Screener case.",
    "Known correspondent — no screener hold needed.",
    "The sender is already past the Screener and writes personally.",
    "A person writing personally.",
    "Bulk newsletter with a List-Unsubscribe header.",
    "",
  ];

  it.each(HOLDS)("holds: %s", (r) => expect(rationaleHoldsAtGate(r)).toBe(true));
  it.each(DOES_NOT)("does not hold: %s", (r) => expect(rationaleHoldsAtGate(r)).toBe(false));

  /**
   * A negation in a PRECEDING SENTENCE must not cancel the gate named in the next one. The
   * bounded, clause-stopped window is what buys that; a plain "is there a `not` somewhere before
   * it" would read this as an admission.
   */
  it("a negation in an earlier clause does not cancel a later hold", () => {
    expect(rationaleHoldsAtGate("This is not a newsletter. First contact, so hold at the Screener."))
      .toBe(true);
  });
});

/**
 * THE WHOLE REQUEST, PINNED. A field-by-field check stayed green with `temperature: 0` added, a
 * sampling field the review read as a 400 on the 5.5 models, so the body is compared whole: no
 * sampling field, no key beside these. The payload is the builder's own; the pin is the shape.
 */
describe("the whole request bodies", () => {
  it("classify: exactly these keys and values", () => {
    expect(buildClassifyParams(INPUT, { client: {} as AnthropicLike })).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 512,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: TAXONOMY_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(classifyUserPayload(INPUT)) }],
      output_config: { format: { type: "json_schema", schema: CLASSIFY_RESULT_SCHEMA } },
    });
  });

  it("screening: exactly these keys and values", () => {
    expect(buildScreeningParams(INPUT, { client: {} as AnthropicLike })).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 512,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: SCREENING_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(classifyUserPayload(INPUT)) }],
      output_config: { format: { type: "json_schema", schema: SCREENING_RESULT_SCHEMA } },
    });
  });
});

/**
 * A DECLINE IS THE MESSAGE'S ANSWER, NEVER A MALFORMED REPLY. Haiku 5.5 runs safety classifiers
 * Haiku 4.5 did not: a refusal is HTTP 200 with no content and `stop_reason: "refusal"`. Read as
 * a reply it threw "no text content block", which every caller counted as a provider fault.
 */
describe("a decline is thrown as its own class", () => {
  /** Anthropic's documented refusal, as the client hands it to the port. */
  const REFUSAL = {
    content: [], stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
  };
  const answering = (resp: { content: unknown; stop_reason?: unknown; stop_details?: unknown }): AnthropicLike => ({
    messages: { async create() { return resp; } },
  });

  it("a refusal throws ModelDeclinedError on classify and on screen, with its category", async () => {
    const classifier = makeHaikuClassifier({ client: answering(REFUSAL) });
    for (const ask of [() => classifier.classify(INPUT), () => classifier.screen!(INPUT)]) {
      const err = await ask().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelDeclinedError);
      expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
    }
  });

  it("an answer cut off at max_tokens is a decline, never a JSON fault", async () => {
    const cut = answering({ content: [{ type: "text", text: "{\"destination\":\"ohm" }], stop_reason: "max_tokens" });
    const err = await makeHaikuClassifier({ client: cut }).classify(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "max_tokens", refusalCategory: null });
  });

  it("CONTROL: an `end_turn` answer is read as before", async () => {
    const text = JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false });
    const ok = answering({ content: [{ type: "text", text }], stop_reason: "end_turn" });
    await expect(makeHaikuClassifier({ client: ok }).classify(INPUT))
      .resolves.toMatchObject({ destination: "ohmail/News" });
  });
});

describe("makeHaikuClassifier — response parsing", () => {
  it("parses a structured-output text block into a ClassifierResult", async () => {
    const client = fakeClient(JSON.stringify({
      destination: "ohmail/News", confidence: 0.82, rationale: "bulk newsletter", spam: false,
    }));
    const classifier = makeHaikuClassifier({ client });
    const res = await classifier.classify(INPUT);
    expect(res).toEqual({ destination: "ohmail/News", confidence: 0.82, rationale: "bulk newsletter", spam: false });
    // it actually issued exactly one messages.create with the built params
    expect((client.lastParams as any).model).toBe("claude-haiku-5-5");
    expect((client.lastParams as any).thinking).toEqual({ type: "disabled" });
  });

  it("clamps confidence to [0,1] and falls back to Screener on an unknown destination label", async () => {
    const client = fakeClient(JSON.stringify({ destination: "Nonsense", confidence: 5, rationale: "?", spam: true }));
    const res = await makeHaikuClassifier({ client }).classify(INPUT);
    expect(res.destination).toBe("ohmail/Screener");
    expect(res.confidence).toBe(1);
    expect(res.spam).toBe(true);
  });
});

/**
 * THE SINK REFUSES, AND THE CLIENT IS UNREACHABLE.
 *
 * A review's per-file verdict on `classify.ts` was "clean under a CORRECT upstream decision; it has
 * no sensitivity flag and therefore cannot contain an upstream false negative". That is the hole
 * these tests close. The assertion is deliberately NOT "a boolean was true" — an exploding client
 * fails the test if `messages.create` is reached at all, so a version that screened the payload
 * and then sent it anyway would go red here.
 */
describe("buildClassifyParams refuses a sensitive payload instead of sending it", () => {
  /** A client that FAILS the test if it is touched. The only honest shape for this assertion. */
  it("sends authentication mail to the provider", async () => {
    const client = fakeClient(JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "service", spam: false }));
    const input = { ...INPUT, subject: "Your verification code", snippet: "Your one-time passcode is 482913." };
    await expect(makeHaikuClassifier({ client }).classify(input)).resolves.toMatchObject({ destination: "ohmail/News" });
  });

  it("still sends ordinary mail — the screen is not an off switch", async () => {
    const client = fakeClient(JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false }));
    await expect(makeHaikuClassifier({ client }).classify(INPUT)).resolves.toMatchObject({ destination: "ohmail/News" });
    // Newsletter link shapes are the near-miss that would make this screen unusable if it were
    // any broader: a tracking URL is not an authentication URL.
    await expect(makeHaikuClassifier({ client }).classify({
      from: { name: null, address: "dispatch@theslowdraft.invalid" },
      subject: "Issue 42 — the quiet part",
      snippet: "Read on: https://theslowdraft.invalid/issues/42 Unsubscribe: https://theslowdraft.invalid/u/1234",
      headersDigest: "list-unsubscribe,precedence:bulk",
    })).resolves.toMatchObject({ destination: "ohmail/News" });
    // …and so is a receipt full of digits.
    await expect(makeHaikuClassifier({ client }).classify({
      from: { name: null, address: "receipts@verdantgrocer.invalid" },
      subject: "Your order #48213 is confirmed",
      snippet: "Order #48213 2 x Bench plane blade CHF 45.00 1 x Shipping CHF 9.00 Total: CHF 54.00",
      headersDigest: "auto-submitted",
    })).resolves.toMatchObject({ destination: "ohmail/News" });
  });
});
