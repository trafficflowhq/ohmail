import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildDraftParams, makeSonnetDrafter, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, draftUserPayload,
  type AnthropicLike, type DraftInput,
} from "../../src/ai/draft.js";
import { ModelRuleRefusal } from "../../src/model-rules.js";
import { ModelDeclinedError } from "../../src/model-declined.js";

const INPUT: DraftInput = {
  incoming: { subject: "Invoice question", from: "client@acme-com.example", snippet: "When is payment due?" },
  context: {
    kbEntries: [{ title: "Payment terms", content: "Net 30 from invoice date." }],
    threadMessages: [{ from: "me@lichtgrat.example", snippet: "Invoice attached, thanks." }],
  },
};

function fakeClient(text: string): AnthropicLike & { lastParams: unknown; calls: number } {
  const c = {
    lastParams: undefined as unknown,
    calls: 0,
    messages: {
      async create(params: unknown) {
        c.calls += 1;
        c.lastParams = params;
        return { content: [{ type: "text", text }] };
      },
    },
  };
  return c;
}

describe("ai/draft — lazy SDK import (mirrors the classifier seam)", () => {
  it("does not import @anthropic-ai/sdk at module load — the client is injected", () => {
    // The module compiles/loads offline (no SDK is even installed) precisely
    // because it never statically imports it: the concrete client is injected.
    const src = readFileSync(fileURLToPath(new URL("../../src/ai/draft.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(src).not.toMatch(/require\(\s*["']@anthropic-ai\/sdk["']\s*\)/);
    // makeSonnetDrafter is callable with a bare fake — no SDK, no network.
    expect(typeof makeSonnetDrafter({ messages: { create: async () => ({ content: [] }) } })).toBe("object");
  });
});

describe("buildDraftParams — request shape", () => {
  it("builds a claude-sonnet-5-5 request with a cached voice system prefix + json_schema output", () => {
    const params = buildDraftParams(INPUT) as any;
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(1024);
    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0].text).toMatch(/reply drafter for ohmail/);
    // structured output via output_config.format json_schema (NOT deprecated output_format)
    expect(params.output_config.format.type).toBe("json_schema");
    expect(Object.keys(params.output_config.format.schema.properties).sort())
      .toEqual(["body", "rationale", "subject"]);
    expect(params.output_format).toBeUndefined();
    // THINKING IS OFF, and this assertion is the guard on a live billing property. Sonnet 5.5
    // thinks when the field is omitted, and `max_tokens` caps thinking + text together — a
    // Sonnet 5 draft measured 259 thinking tokens of 1024. On Sonnet 5.5 `disabled` is a 400 and
    // `between_tools` is the thinking-off value, legal at the default effort (high): none is sent.
    expect(params.thinking).toEqual({ type: "between_tools" });
    expect(params.output_config.effort).toBeUndefined();
    // volatile incoming + context live in the user turn, AFTER the cache breakpoint
    const userContent = params.messages[0].content as string;
    expect(params.messages[0].role).toBe("user");
    expect(userContent).toContain("Invoice question");
    expect(userContent).toContain("Net 30 from invoice date.");
    expect(userContent).not.toContain("cache_control");
  });

  it("serializes ONLY the passed (redacted-safe) input — no sensitive marker leaks in", () => {
    // A marker that was never part of the input must never appear in the params:
    // buildDraftParams cannot invent content, so the request carries only what the
    // caller (which excludes sensitive/no_ai content) chose to pass.
    const params = buildDraftParams(INPUT);
    expect(JSON.stringify(params)).not.toContain("SENSITIVE-OTP-123456");
  });

  it("REJECTS a raw-content field on any half of the input — the redaction sink, not the callers", () => {
    // The sink is structural: a body planted on `incoming`, on a thread message, or on a KB
    // entry throws BEFORE serialization, so no future caller (or a new field on DraftInput) can
    // carry a raw body into the request the way only the two disciplined callers currently avoid.
    const withIncomingBody = {
      ...INPUT,
      incoming: { ...INPUT.incoming, body: "RAW-BODY-SHOULD-NOT-LEAK" } as DraftInput["incoming"],
    };
    expect(() => buildDraftParams(withIncomingBody)).toThrow(/non-redacted field 'body'/);

    const withThreadBody: DraftInput = {
      ...INPUT,
      context: {
        ...INPUT.context,
        threadMessages: [{ from: "x@y.example", snippet: "ok", body: "RAW" } as DraftInput["context"]["threadMessages"][number]],
      },
    };
    expect(() => buildDraftParams(withThreadBody)).toThrow(/thread message carries a non-redacted field 'body'/);

    const withKbExtra: DraftInput = {
      ...INPUT,
      context: {
        ...INPUT.context,
        kbEntries: [{ title: "t", content: "c", raw: "LEAK" } as DraftInput["context"]["kbEntries"][number]],
      },
    };
    expect(() => buildDraftParams(withKbExtra)).toThrow(/kb entry carries a non-redacted field 'raw'/);

    // The clean input still builds, so the sink rejects only the leak, never the legitimate shape.
    expect(() => buildDraftParams(INPUT)).not.toThrow();
  });

  it("passes inference_geo only when configured (EU residency) and honours a model override", () => {
    const withGeo = buildDraftParams(INPUT, { inferenceGeo: "eu" }) as any;
    expect(withGeo.inference_geo).toBe("eu");
    const without = buildDraftParams(INPUT) as any;
    expect("inference_geo" in without).toBe(false);
    const overridden = buildDraftParams(INPUT, { model: "claude-sonnet-5" }) as any;
    expect(overridden.model).toBe("claude-sonnet-5");
  });

  /**
   * `between_tools` is a 400 on every model but Sonnet 5.5. An override must not inherit it: the
   * builder reads the override's own row, so each of these is sent `disabled`, which it accepts.
   */
  it("an override to a model other than Sonnet 5.5 is NOT sent between_tools", () => {
    for (const model of ["claude-sonnet-5", "claude-haiku-5-5", "claude-opus-5", "claude-haiku-4-5-20251001"]) {
      const params = buildDraftParams(INPUT, { model }) as any;
      expect(params.model).toBe(model);
      expect(params.thinking, model).not.toEqual({ type: "between_tools" });
      expect(params.thinking, model).toEqual({ type: "disabled" });
    }
  });

  it("refuses by name a model that cannot turn thinking off or has no row, before any call", () => {
    const cases = [["claude-opus-5-5", "thinking_stays_on"], ["claude-sonnet-5-20260101", "no_rules"]] as const;
    for (const [model, reason] of cases) {
      let thrown: unknown;
      try { buildDraftParams(INPUT, { model }); } catch (e) { thrown = e; }
      expect(thrown, model).toBeInstanceOf(ModelRuleRefusal);
      expect((thrown as ModelRuleRefusal).reason).toBe(reason);
      expect((thrown as Error).message).toContain(model);
      const client = fakeClient("{}");
      expect(() => makeSonnetDrafter(client, { model })).toThrow(ModelRuleRefusal);
      expect(client.calls).toBe(0);
    }
  });
});

describe("the whole draft request body", () => {
  /** No sampling field (the review read one as a 400 on the 5.5 models) and no key beside these. */
  it("exactly these keys and values", () => {
    expect(buildDraftParams(INPUT)).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      thinking: { type: "between_tools" },
      system: [{ type: "text", text: DRAFT_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(draftUserPayload(INPUT)) }],
      output_config: { format: { type: "json_schema", schema: DRAFT_RESULT_SCHEMA } },
    });
  });
});

describe("a declined draft is thrown as its own class", () => {
  const answering = (resp: { content: unknown; stop_reason?: unknown; stop_details?: unknown }): AnthropicLike => ({
    messages: { async create() { return resp; } },
  });

  it("a refusal (no content) throws ModelDeclinedError, never 'no text content block'", async () => {
    const refusal = answering({ content: [], stop_reason: "refusal", stop_details: { category: "general_harms" } });
    const err = await makeSonnetDrafter(refusal).draft(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: "general_harms" });
  });

  it("a draft cut off at max_tokens is a decline too", async () => {
    const cut = answering({ content: [{ type: "text", text: "{\"subject\":\"Re" }], stop_reason: "max_tokens" });
    await expect(makeSonnetDrafter(cut).draft(INPUT)).rejects.toBeInstanceOf(ModelDeclinedError);
  });
});

describe("makeSonnetDrafter — response parsing", () => {
  it("keeps line breaks and at most one blank line between real paragraphs", async () => {
    const body = "Hello,\r\n\r\nFirst line.\r\n\r\nSecond line.\r\n\r\nThanks,\r\n\r\nSam";
    const loose = await makeSonnetDrafter(fakeClient(JSON.stringify({ body }))).draft(INPUT);
    expect(loose.body).toBe("Hello,\nFirst line.\nSecond line.\nThanks,\nSam");

    const grouped = await makeSonnetDrafter(fakeClient(JSON.stringify({
      body: "Hello,\nFirst line.\n\n \nNext paragraph.\nThanks,\nSam",
    }))).draft(INPUT);
    expect(grouped.body).toBe("Hello,\nFirst line.\n\nNext paragraph.\nThanks,\nSam");
  });

  it("preserves blank lines around one-line paragraphs", async () => {
    const body = [
      "Hi Anna,",
      "Thanks for sending the contract. I have read it and the proposed terms look right to me.",
      "I will sign it on Monday and send it back the same day.",
      "Best, Sam",
    ].join("\n\n");
    expect((await makeSonnetDrafter(fakeClient(JSON.stringify({ body }))).draft(INPUT)).body).toBe(body);
  });

  it("parses a structured-output text block into a DraftResult and issues one create", async () => {
    const client = fakeClient(JSON.stringify({
      subject: "Re: Invoice question", body: "Payment is due Net 30.", rationale: "grounded in KB payment terms",
    }));
    const res = await makeSonnetDrafter(client).draft(INPUT);
    expect(res).toEqual({
      subject: "Re: Invoice question", body: "Payment is due Net 30.", rationale: "grounded in KB payment terms",
    });
    expect(client.calls).toBe(1);
    expect((client.lastParams as any).model).toBe("claude-sonnet-5-5");
    expect((client.lastParams as any).thinking).toEqual({ type: "between_tools" });
  });

  it("coerces missing/non-string fields to empty strings (never throws on a partial object)", async () => {
    const client = fakeClient(JSON.stringify({ body: 42 }));
    const res = await makeSonnetDrafter(client).draft(INPUT);
    expect(res).toEqual({ subject: "", body: "", rationale: "" });
  });
});
