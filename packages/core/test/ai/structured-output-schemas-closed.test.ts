import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClassifyParams, buildScreeningParams, type AnthropicLike } from "../../src/ai/classify.js";
import { buildDraftParams } from "../../src/ai/draft.js";
import { buildProposeParams, PROPOSE_RESULT_SCHEMA } from "../../src/ai/workflows/propose.js";
import { CLASSIFY_RESULT_SCHEMA, SCREENING_RESULT_SCHEMA } from "../../src/classify-prompt.js";
import { DRAFT_RESULT_SCHEMA } from "../../src/draft-prompt.js";

/* @reads: packages/core/src/ai/transports/ai-anthropic.ts packages/core/src/ai/transports/ai-openai.ts packages/core/src/ai/transports/ai-ollama.ts */

/**
 * EVERY STRUCTURED-OUTPUT SCHEMA IS CLOSED. The API answers `additionalProperties: true` with a 400,
 * and that is how the proposer's request was refused from the day it was written: nothing walked
 * its schema. The walk refuses an object that is not `additionalProperties: false` or whose
 * `required` is not exactly its properties, over the schema each builder ACTUALLY sends — and a
 * census of the source holds the set of schemas complete, both ways.
 */
type Node = Record<string, unknown>;

function openings(schema: unknown, path = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const n = schema as Node;
  const out: string[] = [];
  if (n.type === "object" || "properties" in n) {
    if (n.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    const props = Object.keys((n.properties ?? {}) as Node).sort();
    const req = Array.isArray(n.required) ? [...(n.required as string[])].sort() : [];
    if (JSON.stringify(req) !== JSON.stringify(props)) out.push(`${path}: required is not every property`);
    for (const [k, v] of Object.entries((n.properties ?? {}) as Node)) out.push(...openings(v, `${path}.${k}`));
  }
  if ("items" in n) out.push(...openings(n.items, `${path}[]`));
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(n[key])) (n[key] as unknown[]).forEach((s, i) => out.push(...openings(s, `${path}.${key}${i}`)));
  }
  return out;
}

const client = {} as AnthropicLike;
const CLASSIFY_INPUT = { from: { name: "N", address: "n@example.com" }, subject: "s", snippet: "x", headersDigest: "", fewShot: [] };
const BUILT: Record<string, { sent: unknown; constant: unknown }> = {
  CLASSIFY_RESULT_SCHEMA: {
    sent: (buildClassifyParams(CLASSIFY_INPUT, { client }) as any).output_config.format.schema,
    constant: CLASSIFY_RESULT_SCHEMA,
  },
  SCREENING_RESULT_SCHEMA: {
    sent: (buildScreeningParams(CLASSIFY_INPUT, { client }) as any).output_config.format.schema,
    constant: SCREENING_RESULT_SCHEMA,
  },
  DRAFT_RESULT_SCHEMA: {
    sent: (buildDraftParams({
      incoming: { subject: "s", from: "c@example.com", snippet: "x" }, context: { kbEntries: [], threadMessages: [] },
    }) as any).output_config.format.schema,
    constant: DRAFT_RESULT_SCHEMA,
  },
  PROPOSE_RESULT_SCHEMA: {
    sent: (buildProposeParams([{ kind: "domain", senderDomain: "x.test", destination: "INBOX", count: 3, provenance: "learning" }]) as any)
      .output_config.format.schema,
    constant: PROPOSE_RESULT_SCHEMA,
  },
};

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("every structured-output schema this repo sends is closed", () => {
  for (const [name, { sent, constant }] of Object.entries(BUILT)) {
    it(`${name}: the builder sends it, and it has no open object`, () => {
      expect(sent, `${name} is not what its builder sends`).toBe(constant);
      expect(openings(sent)).toEqual([]);
    });
  }

  it("the census: every *_RESULT_SCHEMA named in the model-calling source is walked above", () => {
    const named = new Set<string>();
    // The desktop's transports are under packages/core/src/ai/transports, so the walk reads them.
    const files = tsFiles(join(ROOT, "packages/core/src"));
    expect(files.some((f) => f.endsWith("ai/transports/ai-openai.ts")), "the transports left the walk").toBe(true);
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\b([A-Z][A-Z0-9_]*_RESULT_SCHEMA)\b/g)) named.add(m[1]!);
    expect(named.size, "the census read nothing").toBeGreaterThan(0);
    expect([...named].sort()).toEqual(Object.keys(BUILT).sort());
  });

  it("the walk refuses a reopened object and an optional property (its own controls)", () => {
    const reopened = structuredClone(PROPOSE_RESULT_SCHEMA) as any;
    reopened.properties.proposals.items.properties.steps.items.additionalProperties = true;
    expect(openings(reopened)).toEqual(["$.proposals[].steps[]: additionalProperties is not false"]);
    const optional = structuredClone(PROPOSE_RESULT_SCHEMA) as any;
    optional.properties.proposals.items.required = ["pattern", "name", "steps"];
    expect(openings(optional)).toEqual(["$.proposals[]: required is not every property"]);
    expect(openings({ type: "object", additionalProperties: true })).toHaveLength(1);
  });
});
