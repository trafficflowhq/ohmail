import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BASE, DEFAULT_ANTHROPIC_MODELS, anthropicTransport,
  DEFAULT_OPENAI_MODELS, OPENAI_BASE, openaiTransport,
} from "@trafficflow/core/ai-transports";
import type { AiTransport, ProbeOutcome } from "@trafficflow/core/ai-transports";
import { FIXTURE_SHAPES, anthropicKey, openAiKey } from "../../../test/support/fixture-credentials.js";

/**
 * THE TWO KEY-CARRYING PROVIDERS VERIFY A KEY THE SAME WAY, AND THIS FILE READS IT THROUGH BOTH.
 *
 * Anthropic and OpenAI differ in their request envelopes — that is real and adapted at the edge.
 * What they must NOT differ in is the VERIFICATION: what a status means, that the catalogue is
 * listed once, that each distinct configured model is then asked for by name, and what a refusal
 * says. Every case below runs the same fixture through both and asserts the same outcome, so the
 * day one provider's verification drifts it is a red here. The one stated difference is OpenAI's
 * name test for models that cannot answer a chat request, which Anthropic's catalogue does not need.
 */

/** Shaped like the real thing and belonging to nobody. Never a live credential in a test. */
const ANTHROPIC_KEY = anthropicKey("ai-key-provider-shared");
const OPENAI_KEY = openAiKey("ai-key-provider-shared");

it("the fixture keys have the vendors' key shapes", () => {
  expect(ANTHROPIC_KEY).toMatch(FIXTURE_SHAPES.anthropic);
  expect(OPENAI_KEY).toMatch(FIXTURE_SHAPES.openai);
});

interface Wire { urls: string[]; fetchImpl: typeof fetch }

/** A fetch that answers the catalogue with `list` and every per-model GET with `model`. */
function wire(list: () => Response, model: () => Response): Wire {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    return /\/models\/[^/]+$/.test(url) ? model() : list();
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The two providers under one name, each already carrying its own key and models. */
function providers(classifyModel: string, draftModel: string, w: Wire): Array<[string, AiTransport]> {
  return [
    ["anthropic", anthropicTransport({
      apiKey: ANTHROPIC_KEY, classifyModel, draftModel, fetchImpl: w.fetchImpl, timeoutMs: 5_000,
    })],
    ["openai", openaiTransport({
      apiKey: OPENAI_KEY, classifyModel, draftModel, fetchImpl: w.fetchImpl, timeoutMs: 5_000,
    })],
  ];
}

/** The outcome as a comparable tuple. `models` is compared apart where the two lists differ. */
const shapeOf = (o: ProbeOutcome): [boolean, string | null, string | null] =>
  [o.ok, o.reason, o.detail];

describe("what a status means, read through both key-carrying providers", () => {
  it("maps the same catalogue statuses to the same refusal", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"], [403, "unauthorized"], [404, "model_absent"],
      [408, "timeout"], [504, "timeout"], [500, "bad_response"], [429, "bad_response"],
    ];
    for (const [status, reason] of cases) {
      const w = wire(() => new Response("refused", { status }), () => json({}));
      for (const [name, t] of providers("m-classify", "m-draft", w)) {
        const out = await t.probe();
        expect([name, out.ok, out.reason, out.models]).toEqual([name, false, reason, []]);
        // The endpoint's own sentence reaches the settings pane, bounded, from both.
        expect(out.detail).toBe("refused");
      }
    }
  });

  it("reports a thrown dial as the same class from both, with no catalogue", async () => {
    const thrower = (name: string) => {
      const err = new Error("nope");
      err.name = name;
      return () => { throw err; };
    };
    for (const [errName, reason] of [["TimeoutError", "timeout"], ["TypeError", "unreachable"]]) {
      const w = wire(thrower(errName!), () => json({}));
      for (const [name, t] of providers("m-classify", "m-draft", w)) {
        expect([name, ...shapeOf(await t.probe())]).toEqual([name, false, reason, null]);
      }
    }
  });
});

describe("the catalogue, then each distinct model by name", () => {
  it("lists once and asks for each DISTINCT model, from both", async () => {
    for (const [classify, draft, modelGets] of [["a", "b", 2], ["same", "same", 1]] as const) {
      const w = wire(() => json({ data: [{ id: classify }, { id: draft }] }), () => json({}));
      for (const [, t] of providers(classify, draft, w)) {
        const before = w.urls.length;
        const out = await t.probe();
        const mine = w.urls.slice(before);
        expect(out.ok).toBe(true);
        expect(mine.filter((u) => /\/models\/[^/]+$/.test(u)).length).toBe(modelGets);
        expect(mine.filter((u) => !/\/models\/[^/]+$/.test(u)).length).toBe(1);
      }
    }
  });

  it("dials only its own literal base, never an address anybody configured", async () => {
    const w = wire(() => json({ data: [{ id: "m" }] }), () => json({}));
    for (const [name, t] of providers("m", "m", w)) {
      const before = w.urls.length;
      await t.probe();
      const base = name === "anthropic" ? ANTHROPIC_BASE : OPENAI_BASE;
      for (const u of w.urls.slice(before)) expect(u.startsWith(`${base}/`)).toBe(true);
    }
  });

  it("refuses an unreachable model with the same sentence, keeping the catalogue", async () => {
    const w = wire(
      () => json({ data: [{ id: "listed" }] }),
      () => new Response("no", { status: 404 }),
    );
    for (const [name, t] of providers("gone", "gone", w)) {
      const out = await t.probe();
      expect([name, ...shapeOf(out)])
        .toEqual([name, false, "model_absent", 'the key cannot reach the model "gone"']);
      expect(out.models).toEqual(["listed"]);
    }
  });

  /**
   * A DEFAULT THIS APP SHIPPED IS NOT A MISTAKE THE PERSON MADE.
   *
   * The two shipped ids are ids at a vendor, and nothing in this repository can tell whether they
   * still resolve: retire one and every new install choosing that provider fails its first Save.
   * The plain sentence reads as "you named a model your key cannot reach", which is false and
   * points at the wrong repair — so a refusal over an id nobody typed says whose it is and that
   * the list beside it is the way out. Watched fail by dropping the `shipped?.includes` arm in
   * `ai-transport.ts`: this case goes red and the one above it stays green.
   */
  it("names a SHIPPED default as ours, and says what to do instead", async () => {
    for (const [name, defaults] of [
      ["anthropic", DEFAULT_ANTHROPIC_MODELS], ["openai", DEFAULT_OPENAI_MODELS],
    ] as const) {
      const w = wire(
        () => json({ data: [{ id: "listed" }] }),
        () => new Response("no such model", { status: 404 }),
      );
      const t = providers(defaults.classify, defaults.draft, w).find(([n]) => n === name)![1];
      const out = await t.probe();
      expect(out.reason).toBe("model_absent");
      expect(out.detail).toBe(
        `"${defaults.classify}" is this app's default model and this key cannot reach it — `
        + "choose one from the list",
      );
      // The list the sentence points at is on the outcome, or the remedy names nothing.
      expect(out.models).toEqual(["listed"]);
    }
  });

  it("answers ok with the catalogue and no sentence, from both", async () => {
    const w = wire(() => json({ data: [{ id: "one" }, { id: 7 }, { id: "two" }] }), () => json({}));
    for (const [name, t] of providers("one", "two", w)) {
      const out = await t.probe();
      // A non-string id is dropped rather than rendered — the picker offers names.
      expect([name, ...shapeOf(out), out.models]).toEqual([name, true, null, null, ["one", "two"]]);
    }
  });

  it("answers an unreadable catalogue as bad_response from both", async () => {
    const w = wire(() => json({ data: "not an array" }), () => json({}));
    for (const [name, t] of providers("m", "m", w)) {
      const out = await t.probe();
      // No list is not a refusal: the models are still asked for by name, which is the exact test.
      expect([name, out.ok, out.models]).toEqual([name, true, []]);
    }
  });
});
