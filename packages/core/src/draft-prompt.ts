import type { DraftInput, DraftResult } from "./draft-port.js";

/**
 * The drafting question — what is asked, what may travel with it, and how an answer is read. The
 * companion to `classify-prompt.ts`, for the same reason: `draft-port.ts` declares the seam with
 * no prompt behind it, the implementations under `ai/` carry a model id and a vendor client, and
 * what sits between — the voice and reply policy, the response schema, the redaction allow-list
 * and the coercion — must stay the same for every implementation. More than one thing can reach a
 * model now, and a second copy of the reply policy is how two deployments write in two voices
 * from one mailbox. It names no model and imports only the port's own shapes: mail-half code.
 */

/**
 * The FIXED voice/reply-policy prefix. Stable across every draft call so it can be
 * cached (a `system` block with `cache_control:{type:"ephemeral"}`); the volatile
 * per-message incoming + retrieved context go in the user turn, after the cache
 * breakpoint.
 */
export const DRAFT_PREFIX = [
  "You are the reply drafter for ohmail. You write a grounded, ready-to-review",
  "email reply on the owner's behalf. You are given the incoming message (sender, subject,",
  "and a short redacted snippet) plus retrieved context: knowledge-base entries and the",
  "prior messages of this thread (as redacted snippets).",
  "",
  "Rules:",
  "- Reply ONLY from the incoming message and the provided context. Do NOT invent facts,",
  "  commitments, figures, or links that are not grounded in what you were given.",
  "- Write in the owner's voice: concise, direct, warm-professional. No filler.",
  "- If the context is insufficient to answer confidently, draft a brief holding reply",
  "  that asks for the missing detail rather than fabricating one.",
  "- NEVER echo secrets, one-time codes, or credentials — the snippets are already redacted;",
  "  keep them redacted.",
  "- The draft is STORED for the owner to review and send; it is never sent automatically.",
  "",
  "Return a subject (an appropriate `Re:` line), the reply body, and a one-line rationale",
  "explaining what you grounded the reply on. Respond ONLY with the structured JSON object.",
].join("\n");

/** The drafting response schema, mirroring the classifier's. */
export const DRAFT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "rationale"],
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
    rationale: { type: "string" },
  },
} as const;

/**
 * The COMPLETE set of keys each half of a {@link DraftInput} may carry — the redaction
 * allowlist that keeps a raw body out of the request. `incoming` and each thread message are
 * previews the caller has already redacted (subject/sender/snippet only); a KB entry is content
 * the account holder wrote for grounding. A raw `body`, `html`, or any other field is not on any
 * of these lists.
 */
const ALLOWED_INCOMING_KEYS: ReadonlySet<string> = new Set(["subject", "from", "snippet"]);
const ALLOWED_THREAD_MESSAGE_KEYS: ReadonlySet<string> = new Set(["from", "snippet"]);
const ALLOWED_KB_ENTRY_KEYS: ReadonlySet<string> = new Set(["title", "content"]);

/**
 * The redaction sink. Throws if any half of the input carries a key outside its allowlist — if a
 * body or any raw field ever reaches this function — BEFORE anything is serialized into a model
 * request, so a leak is a hard failure and never a silent transmission. It was a private function
 * beside one drafter, protected only by that drafter's two callers choosing to pass a redacted
 * shape — a property of the callers, not the sink; a third caller or a future {@link DraftInput}
 * field would carry a raw body straight into a request. There is more than one drafter now, and
 * this is the one they share: "no raw content in a draft request" is a structural fact rather
 * than a habit.
 */
export function assertRedacted(input: DraftInput): void {
  const check = (obj: object, allowed: ReadonlySet<string>, where: string): void => {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        throw new Error(`drafter: ${where} carries a non-redacted field '${key}' (redaction violation)`);
      }
    }
  };
  check(input.incoming, ALLOWED_INCOMING_KEYS, "incoming");
  for (const m of input.context.threadMessages) check(m, ALLOWED_THREAD_MESSAGE_KEYS, "thread message");
  for (const e of input.context.kbEntries) check(e, ALLOWED_KB_ENTRY_KEYS, "kb entry");
}

/** What one drafting request serialises, once it has passed {@link assertRedacted}. */
export interface DraftUserPayload {
  incoming: { from: string; subject: string; snippet: string };
  context: {
    kbEntries: Array<{ title: string; content: string }>;
    threadMessages: Array<{ from: string; snippet: string }>;
  };
}

/**
 * ASSERT, THEN BUILD. Same ordering rule as the classifier's screen: the allow-list runs before
 * `payload` exists, so a violating input is never assembled into something that could be logged
 * or retried on the way out.
 */
export function draftUserPayload(input: DraftInput): DraftUserPayload {
  assertRedacted(input);
  return {
    incoming: {
      from: input.incoming.from,
      subject: input.incoming.subject,
      snippet: input.incoming.snippet,
    },
    context: {
      kbEntries: input.context.kbEntries,
      threadMessages: input.context.threadMessages,
    },
  };
}

export function coerceDraftResult(raw: unknown): DraftResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const subject = typeof o.subject === "string" ? o.subject : "";
  const body = typeof o.body === "string" ? o.body : "";
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  return { subject, body, rationale };
}
