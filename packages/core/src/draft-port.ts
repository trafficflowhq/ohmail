import type { AiCallOptions } from "./ai-call-report.js";

/**
 * The drafting seam — the port and its shapes, no implementation behind it. A drafter is
 * optional: a deployment injecting none simply offers no drafts, so code that merely NAMES the
 * port needs these five shapes and nothing else. A leaf and not under `ai/`: declared beside the
 * implementation, mail-half modules depended on the model half just to say what shape they accept.
 * A draft carries previews and grounding. The prompt builder removes mail credentials before
 * assembling the provider request.
 */

/** The message being replied to — subject, sender and preview. */
export interface DraftIncoming {
  subject: string;
  from: string;
  /** Local credential context. */
  fromName?: string | null;
  snippet: string;
}

/**
 * The retrieved grounding context: knowledge-base entries plus the target thread's OTHER
 * messages as snippets. Raw message bodies stay outside the draft request.
 */
export interface DraftContext {
  kbEntries: Array<{ title: string; content: string }>;
  threadMessages: Array<{
    from: string;
    fromName?: string | null;
    snippet: string;
    /** Local context for detecting a bare credential in the preview. */
    subject?: string;
  }>;
}

/**
 * THE PERSON'S OWN WORDS, when the letter is written from them rather than as a reply: `text` says
 * what the letter should say, `replying` whether {@link DraftInput.incoming} is a real letter being
 * answered (otherwise it is `NO_LETTER` and travels to no model), `subject` the person's own.
 */
export interface DraftOwnWords {
  text: string;
  replying: boolean;
  subject?: string;
}

export interface DraftInput {
  incoming: DraftIncoming;
  context: DraftContext;
  /** Absent for a reply drafted from the letter alone; its request is then what it always was. */
  own?: DraftOwnWords;
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
export interface DraftCallOptions extends AiCallOptions {
  signal?: AbortSignal;
  /** The body written so far, before the final structured response is validated. */
  onPreview?: (body: string) => void;
}

/** Injected into the drafting dependencies; absent on a deployment that offers no drafts. */
export interface DraftPort {
  draft(input: DraftInput, opts?: DraftCallOptions): Promise<DraftResult>;
}
