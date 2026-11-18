import type { WorkflowPattern } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildProposeParams, deriveProposals, makeOpusProposer, unconfiguredProposer,
  MAX_PROPOSALS_PER_PASS, PROPOSAL_TOOLS, PROPOSE_RESULT_SCHEMA,
} from "../../../src/ai/workflows/propose.js";
import type { AnthropicLike } from "../../../src/ai/classify.js";
import { ModelRuleRefusal } from "../../../src/model-rules.js";
import { ModelDeclinedError } from "../../../src/model-declined.js";

const PATTERNS: WorkflowPattern[] = [
  { kind: "sender", senderAddress: "news@acme-com.example", senderDomain: "acme-com.example", destination: "ohmail/News", count: 7, provenance: "learning" },
  { kind: "domain", senderDomain: "billing.co", destination: "ohmail/Receipts", count: 4, provenance: "rule" },
];

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

describe("ai/workflows/propose — lazy SDK import (mirrors classify/draft)", () => {
  it("does not import @anthropic-ai/sdk at module load — the client is injected", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../src/ai/workflows/propose.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(src).not.toMatch(/require\(\s*["']@anthropic-ai\/sdk["']\s*\)/);
    expect(src).not.toMatch(/import\(\s*["']@anthropic-ai\/sdk["']\s*\)/);
    // Callable with a bare fake — no SDK, no network.
    expect(typeof makeOpusProposer({ messages: { create: async () => ({ content: [] }) } })).toBe("object");
  });
});

describe("buildProposeParams — request shape (claude-opus-5-5)", () => {
  it("builds a claude-opus-5-5 request with a cached prefix + json_schema structured output", () => {
    const params = buildProposeParams(PATTERNS) as any;
    expect(params.model).toBe("claude-opus-5-5");
    expect(Array.isArray(params.system)).toBe(true);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    // The offered tools — PROPOSAL_TOOLS, not the whole grammar — are named in the cached prefix,
    // and nothing asks the model for a trigger it no longer writes.
    expect(params.system[0].text).toMatch(/file_message/);
    expect(params.system[0].text).toMatch(/draft_reply/);
    expect(params.system[0].text).not.toMatch(/add_kb_entry/);
    expect(params.system[0].text).not.toMatch(/nextRunAt|`time` trigger/);
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema).toBe(PROPOSE_RESULT_SCHEMA);
    // NO THINKING FIELD, EFFORT LOW, 8192 TOKENS. Opus 5.5 is the most expensive model this
    // product calls and this pass costs ONE credit whatever it spends, cron-driven. It cannot
    // turn thinking off (`disabled` is a 400 at every effort), so the field is absent and effort
    // `low` is the lever, below its `medium` default; thinking shares the 8192 with the list.
    expect("thinking" in params).toBe(false);
    expect(params.output_config.effort).toBe("low");
    expect(params.max_tokens).toBe(8192);
    // Volatile patterns live in the user turn AFTER the cache breakpoint.
    expect(params.messages[0].role).toBe("user");
    const user = params.messages[0].content as string;
    expect(user).toContain("news@acme-com.example");
    expect(user).not.toContain("cache_control");
  });

  it("the USER turn (the patterns) carries NO raw body/snippet/subject marker — metadata only", () => {
    const params = buildProposeParams(PATTERNS) as any;
    // Only the volatile user turn carries data; the cached policy prefix legitimately
    // NAMES bodies/subjects/snippets as things the model never sees.
    const userTurn = (params.messages[0].content as string).toLowerCase();
    for (const forbidden of ["snippet", "body", "subject", "rawbody"]) {
      expect(userTurn).not.toContain(forbidden);
    }
  });

  it("THROWS if a pattern carries a non-metadata field (redaction violation)", () => {
    const leaky = [{ ...PATTERNS[0], snippet: "Your OTP is 900123" } as unknown as WorkflowPattern];
    expect(() => buildProposeParams(leaky)).toThrow(/redaction/i);
  });

  it("passes inference_geo only when configured; respects a model override", () => {
    expect((buildProposeParams(PATTERNS, { inferenceGeo: "eu" }) as any).inference_geo).toBe("eu");
    expect("inference_geo" in (buildProposeParams(PATTERNS) as any)).toBe(false);
    expect((buildProposeParams(PATTERNS, { model: "claude-opus-5" }) as any).model).toBe("claude-opus-5");
  });

  /**
   * An override is shaped by its own row: thinking off where the model can turn it off, `effort`
   * only where the model takes it (Haiku 4.5 does not), and no request at all for an unknown id.
   */
  it("an override takes its own model's row, and an id with no row is refused by name", () => {
    const opus5 = buildProposeParams(PATTERNS, { model: "claude-opus-5" }) as any;
    expect(opus5.thinking).toEqual({ type: "disabled" });
    expect(opus5.output_config.effort).toBe("low");
    expect((buildProposeParams(PATTERNS, { model: "claude-sonnet-5-5" }) as any).thinking)
      .toEqual({ type: "between_tools" });
    const haiku45 = buildProposeParams(PATTERNS, { model: "claude-haiku-4-5-20251001" }) as any;
    expect(haiku45.thinking).toEqual({ type: "disabled" });
    expect("effort" in haiku45.output_config).toBe(false);
    expect(() => buildProposeParams(PATTERNS, { model: "claude-opus-5-20260101" })).toThrow(ModelRuleRefusal);
    const client = fakeClient("{}");
    expect(() => makeOpusProposer(client, { model: "claude-opus-5-20260101" })).toThrow(ModelRuleRefusal);
    expect(client.calls).toBe(0);
  });
});

/**
 * THE WHOLE PROPOSE BODY, by exact key sets at every level: no sampling field (the review read one
 * as a 400 on the 5.5 models), nothing beside these. The alias row's `effort: false` is pinned
 * through the body it shapes: `claude-haiku-4-5` is sent no effort at all.
 */
describe("the whole propose request body", () => {
  it("Opus 5.5: exactly these keys, effort low, no thinking", () => {
    const params = buildProposeParams(PATTERNS) as any;
    expect(Object.keys(params).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(8192);
    expect(Object.keys(params.output_config).sort()).toEqual(["effort", "format"]);
    expect(params.output_config.effort).toBe("low");
    expect(Object.keys(params.output_config.format).sort()).toEqual(["schema", "type"]);
    expect(params.system).toHaveLength(1);
    expect(Object.keys(params.system[0]).sort()).toEqual(["cache_control", "text", "type"]);
    expect(params.messages).toEqual([{ role: "user", content: JSON.stringify({ patterns: PATTERNS }) }]);
  });

  it("the alias row `claude-haiku-4-5`: thinking disabled and NO effort key", () => {
    const params = buildProposeParams(PATTERNS, { model: "claude-haiku-4-5" }) as any;
    expect(Object.keys(params).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system", "thinking"]);
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(Object.keys(params.output_config)).toEqual(["format"]);
  });
});

/**
 * A DECLINE KEEPS THE OPEN SET. A refusal used to parse as "not JSON", the proposer answered `[]`,
 * and the pass replaced the account's open proposals with nothing — while keeping the credit.
 * Thrown instead, the pass never reaches the replacement and refunds (`proposal-cron.ts`).
 */
describe("a declined proposal pass is thrown, never an empty list", () => {
  const answering = (resp: { content: unknown; stop_reason?: unknown; stop_details?: unknown }): AnthropicLike => ({
    messages: { async create() { return resp; } },
  });

  it("a refusal rejects with ModelDeclinedError instead of resolving []", async () => {
    const refusal = answering({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } });
    const err = await makeOpusProposer(refusal).propose(PATTERNS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
  });

  it("a list cut off at max_tokens rejects too — a half list says nothing about the open set", async () => {
    const cut = answering({ content: [{ type: "text", text: "{\"proposals\":[{\"name\":\"Fi" }], stop_reason: "max_tokens" });
    await expect(makeOpusProposer(cut).propose(PATTERNS)).rejects.toBeInstanceOf(ModelDeclinedError);
  });
});

describe("makeOpusProposer — response parsing", () => {
  it("hands the answers on unread and issues exactly one create", async () => {
    const answer = { pattern: 0, name: "File acme newsletters", rationale: "acme-com.example, 7 times", steps: [{ tool: "file_message" }] };
    const client = fakeClient(JSON.stringify({ proposals: [answer] }));
    const out = await makeOpusProposer(client).propose(PATTERNS);
    expect(client.calls).toBe(1);
    expect((client.lastParams as any).model).toBe("claude-opus-5-5");
    expect(out).toEqual([answer]);
  });

  it("returns [] for an empty pattern list WITHOUT calling the model", async () => {
    const client = fakeClient("{}");
    expect(await makeOpusProposer(client).propose([])).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it("returns [] on a malformed (non-JSON) response rather than throwing", async () => {
    const out = await makeOpusProposer(fakeClient("not json")).propose(PATTERNS);
    expect(out).toEqual([]);
  });

  it("unconfiguredProposer proposes nothing (no live model)", async () => {
    expect(await unconfiguredProposer.propose(PATTERNS)).toEqual([]);
  });
});

/**
 * THE DERIVATION IS THE VALIDATION. The model names a pattern and tools; the server writes the
 * trigger and every step's args from that pattern. Each refusal below is DROPPED AND COUNTED by
 * class — never thrown, because a throw refunds the pass and stores nothing — and each sits beside
 * the ordinary case it must not swallow.
 */
describe("deriveProposals — the server derives, the model names", () => {
  const ok = (pattern: number, tools: string[] = ["file_message"]) =>
    ({ pattern, name: `p${pattern}`, rationale: "recurring", steps: tools.map((tool) => ({ tool })) });

  it("admits the ordinary case: trigger and args come from the NAMED pattern, which is stored as named", () => {
    const { proposals, dropped } = deriveProposals([ok(0, ["file_message", "draft_reply"])], PATTERNS);
    expect(dropped).toEqual({});
    expect(proposals).toEqual([{
      name: "p0", rationale: "recurring",
      trigger: { kind: "event", match: { senderAddress: "news@acme-com.example" } },
      steps: [{ tool: "file_message", args: { toFolder: "ohmail/News" } }, { tool: "draft_reply", args: {} }],
      sourcePattern: PATTERNS[0],
    }]);
    expect(proposals[0]!.sourcePattern).toBe(PATTERNS[0]);
  });

  it("aligns by the index the answer names, not by array position", () => {
    const { proposals } = deriveProposals([ok(1, ["file_message", "draft_reply"]), ok(0)], PATTERNS);
    expect(proposals.map((p) => p.sourcePattern)).toEqual([PATTERNS[1], PATTERNS[0]]);
    expect(proposals[0]!.trigger).toEqual({ kind: "event", match: { senderDomain: "billing.co" } });
    expect(proposals[0]!.steps[0]!.args).toEqual({ toFolder: "ohmail/Receipts" });
  });

  it("an out-of-range index is dropped and counted", () => {
    const answers = [ok(2), ok(-1), { ...ok(0), pattern: 0.5 }, { ...ok(0), pattern: "0" }, ok(0)];
    const { proposals, dropped } = deriveProposals(answers, PATTERNS);
    expect(dropped).toEqual({ pattern_out_of_range: 4 });
    expect(proposals.map((p) => p.name)).toEqual(["p0"]);
  });

  it("a duplicate pattern is dropped and counted; the first stands", () => {
    const { proposals, dropped } = deriveProposals([ok(0), { ...ok(0, ["draft_reply"]), name: "again" }], PATTERNS);
    expect(dropped).toEqual({ duplicate_pattern: 1 });
    expect(proposals.map((p) => p.name)).toEqual(["p0"]);
  });

  it("empty steps are dropped and counted", () => {
    const { proposals, dropped } = deriveProposals([ok(0, []), ok(0)], PATTERNS);
    expect(dropped).toEqual({ empty_steps: 1 });
    expect(proposals).toHaveLength(1);
  });

  it("add_kb_entry — and any tool outside the table — is dropped and counted", () => {
    expect(Object.keys(PROPOSAL_TOOLS)).toEqual(["file_message", "draft_reply"]);
    const { proposals, dropped } = deriveProposals(
      [ok(0, ["file_message", "add_kb_entry"]), ok(0, ["send"]), ok(0, ["constructor"]), ok(0)], PATTERNS);
    expect(dropped).toEqual({ tool_not_offered: 3 });
    expect(proposals).toHaveLength(1);
  });

  it("a model-supplied messageId or toFolder — the old open shape — is dropped, never stored", () => {
    const answers = [
      { ...ok(0), steps: [{ tool: "file_message", messageId: "m-1" }] },
      { ...ok(0), steps: [{ tool: "file_message", args: { toFolder: "Trash", messageId: "m-1" } }] },
      { ...ok(0), trigger: { kind: "time", nextRunAt: "2026-10-12T00:00:00Z" } },
      { ...ok(0), toFolder: "Trash" },
      ok(0),
    ];
    const { proposals, dropped } = deriveProposals(answers, PATTERNS);
    expect(dropped).toEqual({ foreign_key: 4 });
    expect(proposals).toHaveLength(1);
    expect(JSON.stringify(proposals)).not.toMatch(/messageId|Trash|"time"/);
  });

  it("a rule duplicate — a rule pattern filed where the rule already files it — is dropped; adding a step admits it", () => {
    expect(PATTERNS[1]!.provenance).toBe("rule");
    const { proposals, dropped } = deriveProposals([ok(1), ok(1, ["file_message", "draft_reply"])], PATTERNS);
    expect(dropped).toEqual({ rule_duplicate: 1 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.steps.map((s) => s.tool)).toEqual(["file_message", "draft_reply"]);
  });

  it("a destination outside the six is never a step's toFolder, even when a caller passes one", () => {
    const own: WorkflowPattern[] = [{ kind: "sender", senderAddress: "a@x.test", destination: "Junk", count: 5, provenance: "learning" }];
    const { proposals, dropped } = deriveProposals([ok(0), { ...ok(0, ["draft_reply"]), name: "d" }], own);
    expect(dropped).toEqual({ destination_not_canonical: 1 });
    expect(proposals.map((p) => p.steps)).toEqual([[{ tool: "draft_reply", args: {} }]]);
  });

  it("caps at MAX_PROPOSALS_PER_PASS, one per pattern", () => {
    const many: WorkflowPattern[] = Array.from({ length: MAX_PROPOSALS_PER_PASS + 2 }, (_, i) => ({
      kind: "sender", senderAddress: `s${i}@x.test`, destination: "ohmail/News", count: 4, provenance: "learning",
    }));
    const { proposals, dropped } = deriveProposals(many.map((_, i) => ok(i)), many);
    expect(proposals).toHaveLength(MAX_PROPOSALS_PER_PASS);
    expect(dropped).toEqual({ over_cap: 2 });
  });

  it("garbage is counted as malformed and never throws", () => {
    const answers = [null, 1, "x", [], {}, { ...ok(0), name: "  " }, { ...ok(0), steps: [null] }];
    const { proposals, dropped } = deriveProposals(answers, PATTERNS);
    expect(proposals).toEqual([]);
    expect(dropped).toEqual({ malformed: 7 });
  });

  it("through the real port: an old-shape answer is dropped by the derivation", async () => {
    const client = fakeClient(JSON.stringify({ proposals: [{
      pattern: 0, name: "Old", rationale: "", trigger: { kind: "manual" },
      steps: [{ tool: "file_message", args: { toFolder: "ohmail/News", messageId: "m-1" } }],
    }] }));
    const { proposals, dropped } = deriveProposals(await makeOpusProposer(client).propose(PATTERNS), PATTERNS);
    expect(proposals).toEqual([]);
    expect(dropped).toEqual({ foreign_key: 1 });
  });
});
