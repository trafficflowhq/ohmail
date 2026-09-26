/**
 * The drafting seam — the port and its shapes, no implementation behind it. A drafter is
 * optional: a deployment injecting none simply offers no drafts, so code that merely NAMES the
 * port needs these five shapes and nothing else. A leaf and not under `ai/`: declared beside the
 * implementation, mail-half modules depended on the model half just to say what shape they accept
 * — and a directory rule is the only kind that survives a new file. `ai/draft.ts` re-exports
 * these. The shapes guarantee the input carries ONLY sensitivity-safe previews — never a raw
 * body; the caller refuses AI-excluded messages and excludes them from context BEFORE building
 * the input — structural, because there is no field for a raw body to arrive in.
 */

/** The message being replied to — subject/from/snippet only, and the snippet is redaction-safe. */
export interface DraftIncoming {
  subject: string;
  from: string;
  snippet: string;
}

/**
 * The retrieved grounding context: knowledge-base entries plus the target thread's OTHER
 * messages as snippets. No raw bodies, and nothing the user has marked as excluded from AI or
 * from the knowledge base — the caller's retrieval excludes those at the boundary.
 */
export interface DraftContext {
  kbEntries: Array<{ title: string; content: string }>;
  threadMessages: Array<{ from: string; snippet: string }>;
}

export interface DraftInput {
  incoming: DraftIncoming;
  context: DraftContext;
}

export interface DraftResult {
  subject: string;
  body: string;
  rationale: string;
}

/**
 * One call's limits. `signal` ends the call: a host that a platform kills passes the time it has
 * left, so the call stops before the kill and the charge behind it can be returned. Optional — a
 * drafter that ignores it is still cut off by its caller, it only keeps its socket open longer.
 */
export interface DraftCallOptions {
  signal?: AbortSignal;
}

/** Injected into the drafting dependencies; absent on a deployment that offers no drafts. */
export interface DraftPort {
  draft(input: DraftInput, opts?: DraftCallOptions): Promise<DraftResult>;
}
