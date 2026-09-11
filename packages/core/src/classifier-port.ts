import type { Destination, EmailAddress } from "./types.js";

/**
 * The classifier seam — the port only, no implementation behind it. The port is optional on
 * `PipelineDeps`: a deployment supplying none routes on rules alone, the product's floor. These
 * shapes used to come from `classify.ts`, where the model implementation lives — a type-only edge
 * is invisible in source and real in the module graph, so every pipeline consumer carried the
 * prompts. A leaf and not under `ai/`: that directory is the model half wholesale, kept private
 * by a rule about the DIRECTORY, and a port inside it made mail-half code cross the boundary on
 * every build. This names no model; `classify.ts` re-exports, so no outside import moves.
 */

export interface ClassifierInput {
  from: EmailAddress;
  subject: string;
  snippet: string;                                       // NEVER the full body of a sensitive message
  headersDigest: string;                                 // small, sensitivity-safe
  fewShot?: Array<{ from: string; destination: Destination }>;  // learned few-shot (spec §7, §11)
  /**
   * The account's plain-language "who belongs in my Ohbox" bar, in their own words. OPTIONAL,
   * and it reaches the model's USER turn only — never the cached taxonomy prefix, which is shared
   * across accounts. It refines the model's proposal for this one message; it is not routing
   * itself. Absent ⇒ the model classifies on the taxonomy alone, exactly as before.
   */
  ohboxBar?: string;
  /**
   * Who screened these bytes, and therefore what the sink does if they still look sensitive.
   * Absent (the default) means `"refuse"`: the outbound screen throws on credential material —
   * the automatic path, unchanged. `"prescreened"` means the CALLER already ran `redactForModel`
   * and asks on behalf of a person's press: what is withheld is the credential VALUE — that a
   * message concerns authentication is not a secret. The polarity makes absent safe: `!==
   * "prescreened"`, never `=== "refuse"` — almost no test file is typechecked, so every literal
   * omitting this field is `undefined` at runtime, and under `=== "refuse"` all of them would
   * silently exercise the permissive branch.
   */
  outbound?: "refuse" | "prescreened";
}

export interface ClassifierResult {
  destination: Destination;
  confidence: number;                                    // 0..1
  rationale: string;
  spam: boolean;
}

export interface ClassifierPort {                        // added to PipelineDeps (optional)
  classify(input: ClassifierInput): Promise<ClassifierResult>;
  /**
   * The screening question — "what should happen to this first-contact sender". A separate
   * method, not a flag on {@link classify}: a different question over a different answer set, and
   * live routing must never reach it — a boolean parameter is one mistaken argument away.
   * OPTIONAL as compatibility: ports are implemented outside this package, and a required method
   * would break each for a capability only the Screener uses. A caller finding it absent falls
   * back to {@link classify} — a DEGRADATION, never a hazard: routing's answer for a
   * first-contact sender is `ohmail/Screener`, "hold — the person decides". Worse advice, not
   * unsafe advice.
   */
  screen?(input: ClassifierInput): Promise<ClassifierResult>;
}
