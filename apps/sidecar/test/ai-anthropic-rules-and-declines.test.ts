import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelDeclinedError, StaticKeyProvider } from "@trafficflow/core/mail";
import type { ClassifierInput, DraftInput } from "@trafficflow/core/mail";
import { ClassifierFaultError } from "@ohmail/organizer/classifier-fault";
import { createLocalAi, type LocalAi, type LocalAiOptions } from "../src/ai-provider.js";
import { createSidecarLog } from "../src/log.js";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";

/**
 * YOUR OWN ANTHROPIC KEY, ON A MODEL YOU PICKED — two facts the hosted path already has, measured
 * through the real provider over a recorded transport. (1) Each model is sent the thinking value its
 * own `MODEL_REQUEST_RULES` row states: Haiku 5.5 classifies with thinking off, Sonnet 5.5 drafts in
 * one request, Opus 5.5 (which cannot turn thinking off) is asked effort `low`, and a model the table
 * does not know keeps this client's old request. (2) A refusal or a cut-off answer is
 * `ModelDeclinedError`, read before the content: the message's answer, never a fault.
 */

const KEY = anthropicKey("ai-anthropic-rules");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Call { url: string; body: string | null }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A transport that verifies any model it is asked about and answers completions from `answer`. */
function transport(answer: (body: Record<string, unknown>, n: number) => Response, models: string[]): {
  calls: Call[]; fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  let completions = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body });
    if (/\/v1\/models\?/.test(url)) return json({ data: models.map((id) => ({ id })) });
    if (/\/v1\/models\//.test(url)) return json({ id: "ok" });
    if (/\/v1\/messages$/.test(url)) return answer(JSON.parse(body ?? "{}") as Record<string, unknown>, ++completions);
    return new Response("no route", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const completionBodies = (calls: Call[]): Array<Record<string, unknown>> =>
  calls.filter((c) => /\/v1\/messages$/.test(c.url)).map((c) => JSON.parse(c.body ?? "{}") as Record<string, unknown>);

/** A verdict both the routing and the screening schema accept, and a draft. */
const verdict = (): Response => json({
  content: [{ type: "text", text: JSON.stringify({ destination: "INBOX", confidence: 0.9, rationale: "a person", spam: false }) }],
  stop_reason: "end_turn",
});
const drafted = (): Response => json({
  content: [{ type: "text", text: JSON.stringify({ subject: "Re: Question", body: "Thursday works.", rationale: "asked a time" }) }],
  stop_reason: "end_turn",
});
/** Anthropic's documented refusal (its refusals page, read 2026-10-12): HTTP 200, no content. */
const refusal = (): Response => json({
  content: [], stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
  usage: { input_tokens: 900, output_tokens: 0 },
});
/** An answer cut off at `max_tokens`: half a JSON object. */
const cutOff = (): Response => json({
  content: [{ type: "text", text: "{\"destination\": \"INB" }], stop_reason: "max_tokens",
});

async function provider(
  fetchImpl: typeof fetch, models: { classifyModel?: string; draftModel?: string } = {},
  opts: Partial<LocalAiOptions> = {},
): Promise<LocalAi> {
  const d = mkdtempSync(join(tmpdir(), "ohmail-ai-rules-"));
  dirs.push(d);
  const ai = await createLocalAi({
    dataDir: d, fetchImpl,
    keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
    canStoreKey: true,
    log: createSidecarLog({ sink: () => undefined }),
    ...opts,
  });
  await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY, ...models } });
  return ai;
}

const anInput = (subject: string): ClassifierInput => ({
  from: { name: null, address: "news@example.test" }, subject, snippet: "the weekly roundup", headersDigest: "",
});
const aDraftInput = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});

const ALL = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-haiku-5-5", "claude-sonnet-5-5",
  "claude-opus-5-5", "claude-3-7-sonnet-20250219", "constructor"];

describe("each model is sent the thinking value its own row states", () => {
  it("Haiku 5.5 classifies and screens with thinking off, and no effort", async () => {
    const { calls, fetchImpl } = transport(verdict, ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5" });
    await ai.classifier()!.classify(anInput("hello"));
    await ai.classifier()!.screen!(anInput("a stranger"));
    const bodies = completionBodies(calls);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.model).toBe("claude-haiku-5-5");
      expect(b.thinking).toEqual({ type: "disabled" });
      expect(Object.keys(b.output_config as object)).toEqual(["format"]);
    }
  });

  it("the default classifier, Haiku 4.5, is sent its own row's `disabled`", async () => {
    const { calls, fetchImpl } = transport(verdict, ALL);
    const ai = await provider(fetchImpl);
    await ai.classifier()!.classify(anInput("hello"));
    const [b] = completionBodies(calls);
    expect(b!.model).toBe("claude-haiku-4-5-20251001");
    expect(b!.thinking).toEqual({ type: "disabled" });
    expect(Object.keys(b!.output_config as object)).toEqual(["format"]);
  });

  it("Sonnet 5.5 drafts with `between_tools`, in ONE request — no refused round trip", async () => {
    const { calls, fetchImpl } = transport((body) => ("thinking" in body && (body.thinking as { type: string }).type === "disabled"
      ? new Response("thinking.type: disabled is not supported for this model", { status: 400 })
      : drafted()), ALL);
    const ai = await provider(fetchImpl, { draftModel: "claude-sonnet-5-5" });
    await ai.drafter()!.draft(aDraftInput());
    const bodies = completionBodies(calls);
    expect(bodies, "a refused request was paid for before the draft").toHaveLength(1);
    expect(bodies[0]!.thinking).toEqual({ type: "between_tools" });
    expect(Object.keys(bodies[0]!.output_config as object)).toEqual(["format"]);
  });

  it("Opus 5.5 cannot turn thinking off: no field, effort `low`, one request", async () => {
    const { calls, fetchImpl } = transport(drafted, ALL);
    const ai = await provider(fetchImpl, { draftModel: "claude-opus-5-5" });
    await ai.drafter()!.draft(aDraftInput());
    const bodies = completionBodies(calls);
    expect(bodies).toHaveLength(1);
    expect("thinking" in bodies[0]!).toBe(false);
    expect((bodies[0]!.output_config as { effort?: string }).effort).toBe("low");
  });

  it("a model the table does not know keeps the request this client always made", async () => {
    const { calls, fetchImpl } = transport((body) => ("thinking" in body
      ? new Response("thinking: this model does not support extended thinking", { status: 400 })
      : (body.max_tokens === 2048 ? drafted() : verdict())), ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-3-7-sonnet-20250219", draftModel: "claude-3-7-sonnet-20250219" });
    await ai.classifier()!.classify(anInput("hello"));
    await ai.drafter()!.draft(aDraftInput());
    const bodies = completionBodies(calls);
    // Classify: no thinking field at all. Draft: `disabled`, refused, then remade once without it.
    expect(bodies.map((b) => b.thinking ?? null)).toEqual([null, { type: "disabled" }, null]);
    expect(bodies.every((b) => Object.keys(b.output_config as object).join() === "format")).toBe(true);
  });

  it("a prototype name is a model the table does not know, never a row", async () => {
    const { calls, fetchImpl } = transport(drafted, ALL);
    const ai = await provider(fetchImpl, { draftModel: "constructor" });
    await ai.drafter()!.draft(aDraftInput());
    expect(completionBodies(calls)[0]!.thinking).toEqual({ type: "disabled" });
  });
});

describe("a declined answer is the message's answer, never a fault", () => {
  it("a refusal reaches every request port as `ModelDeclinedError`, before its empty content is read", async () => {
    const { fetchImpl } = transport(refusal, ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5", draftModel: "claude-sonnet-5-5" });
    for (const ask of [
      () => ai.classifier()!.classify(anInput("hello")),
      () => ai.classifier()!.screen!(anInput("a stranger")),
      () => ai.drafter()!.draft(aDraftInput()),
    ]) {
      const err = await ask().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelDeclinedError);
      expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
    }
  });

  it("an answer cut off at `max_tokens` is a decline too, not a malformed reply", async () => {
    const { fetchImpl } = transport(cutOff, ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5" });
    const err = await ai.classifier()!.classify(anInput("hello")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "max_tokens", refusalCategory: null });
  });

  it("the background port passes a decline on unwrapped and never withholds routing for it", async () => {
    const { fetchImpl } = transport(refusal, ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5" }, { faultThreshold: 2 });
    for (let i = 0; i < 5; i++) {
      const port = ai.classifierForCycle();
      expect(port, `routing was withheld after ${i} declines`).toBeDefined();
      const err = await port!.classify(anInput("hello")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelDeclinedError);
      expect(err).not.toBeInstanceOf(ClassifierFaultError);
    }
    expect(ai.classifierForCycle()).toBeDefined();
  });

  it("a decline between two faults neither resets nor adds to the count", async () => {
    const script = ["fault", "decline", "fault"];
    const { fetchImpl } = transport((_b, n) => (script[n - 1] === "decline" ? refusal() : new Response("unwell", { status: 500 })), ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5" }, { faultThreshold: 2, cooldownMs: 60_000 });
    await expect(ai.classifierForCycle()!.classify(anInput("a"))).rejects.toBeInstanceOf(ClassifierFaultError);
    await expect(ai.classifierForCycle()!.classify(anInput("b"))).rejects.toBeInstanceOf(ModelDeclinedError);
    expect(ai.classifierForCycle(), "the decline was counted as a second fault").toBeDefined();
    await expect(ai.classifierForCycle()!.classify(anInput("c"))).rejects.toBeInstanceOf(ClassifierFaultError);
    expect(ai.classifierForCycle(), "the decline reset the count like a success").toBeUndefined();
  });

  it("CONTROL: an answer with no text and no stop reason is still a fault", async () => {
    const { fetchImpl } = transport(() => json({ content: [] }), ALL);
    const ai = await provider(fetchImpl, { classifyModel: "claude-haiku-5-5" });
    await expect(ai.classifierForCycle()!.classify(anInput("hello"))).rejects.toBeInstanceOf(ClassifierFaultError);
  });
});
