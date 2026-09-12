import type {
  ClassifierInput, ClassifierResult, DraftInput, DraftResult,
} from "@trafficflow/core/mail";

/**
 * WHAT A PROVIDER HAS TO BE ABLE TO DO, AND NOTHING ELSE.
 *
 * Four methods. The two features — and routing is TWO QUESTIONS rather than one, see
 * {@link AiTransport.screen} — plus the question "can you actually do them?", which is separate on
 * purpose: a capability is offered only once it has been asked, never because a settings form was
 * filled in. Everything about WHAT is asked — the taxonomy, the screening question, the reply
 * policy, the response schemas and the two sinks that refuse — lives in `@trafficflow/core/mail`
 * and is shared with every other implementation; a provider here decides only how the request
 * travels and how the answer is unwrapped.
 *
 * ── NO SDK, ON PURPOSE ───────────────────────────────────────────────────────────────────────
 *
 * Both providers speak their endpoint's HTTP API through the platform's own `fetch`. This is the
 * engine that ships inside the app, so every package it pulls in is a package a person
 * downloading a binary is trusting; two well-documented JSON endpoints do not justify a
 * dependency, and not having one means there is no vendor client sitting between a message and
 * the wire deciding what to retry, buffer or log.
 */

/** The failure classes a verification can report. Rendered by the interface; never free text. */
export type ProbeFailure =
  /** No answer at all — wrong address, nothing listening, DNS, TLS, a dropped connection. */
  | "unreachable"
  /** An answer, but not within the time allowed. */
  | "timeout"
  /** The endpoint rejected the credential. For Anthropic: a wrong, revoked or empty key. */
  | "unauthorized"
  /** The endpoint answered and does not have one of the configured models. */
  | "model_absent"
  /** The endpoint answered with something this app cannot read. */
  | "bad_response"
  /** The credential could not be produced at all — see the provider's own states. */
  | "credential"
  /** A fault on this side. Reported rather than swallowed, so it is never read as "unreachable". */
  | "internal";

/**
 * What a verification found.
 *
 * `detail` is a short sentence a person can act on, taken from the endpoint's own error body
 * where it has one. It is shown in the settings pane and is deliberately NOT logged: an error
 * body quotes the request that produced it, and on one of these two paths the request carries an
 * API key header.
 *
 * `models` is what the endpoint said it has. It populates the model pickers, so a person chooses
 * from what is actually installed rather than typing a name and finding out later.
 */
export interface ProbeOutcome {
  ok: boolean;
  reason: ProbeFailure | null;
  detail: string | null;
  models: string[];
}

export interface AiTransport {
  /** THE ROUTING QUESTION — "which folder does this belong in". Asked of live mail, per message. */
  classify(input: ClassifierInput): Promise<ClassifierResult>;
  /**
   * THE SCREENING QUESTION — "what should happen to this first-contact sender".
   *
   * A different question over a different answer set, asked only when a person presses a button
   * about senders already waiting at the gate. Live mail routing never reaches it.
   *
   * ── REQUIRED HERE, THOUGH IT IS OPTIONAL ON `ClassifierPort` ────────────────────────────────
   *
   * The port in `@trafficflow/core` declares `screen?` optional, and has to: a `ClassifierPort` is
   * implemented outside the package that declares it, so a required method would have been a
   * compile break in every implementation for a capability only the Screener uses. Callers
   * therefore fall back to {@link classify} when it is absent.
   *
   * That fallback is what made this method's absence invisible here for a release. It degrades the
   * advice without endangering anything — the routing question's answer for a first-contact sender
   * is the gate itself, which every consumer reads as "hold" — so a standalone install went on
   * answering the wrong question, correctly, and nothing failed. The person just got told, at high
   * confidence, that the mail was where it already was.
   *
   * `AiTransport` is an INTERNAL interface with both of its implementations in this directory, so
   * there is no compatibility to buy and nothing to be gained by making it optional. Required means
   * a third provider added here does not compile until it has been taught the second question —
   * which is the guarantee the optional port cannot offer.
   */
  screen(input: ClassifierInput): Promise<ClassifierResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  /** Never throws for anything the endpoint did. A refusal is an outcome, not an exception. */
  probe(): Promise<ProbeOutcome>;
}

/** Classify a thrown fetch failure without reading its message. */
export function failureOf(err: unknown): ProbeFailure {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "unreachable";
}

/**
 * Control characters, as ESCAPES rather than as literal bytes in the class.
 *
 * Writing the range literally works and is a trap: one raw control byte makes the whole file
 * read as binary, after which `grep` skips it silently and `git` shows it as `Bin 0 -> N bytes`
 * in a diff nobody can review. A source file that tooling refuses to read is a source file that
 * quietly leaves every text-based guard in this repository.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/**
 * A bounded sentence for a person, from an endpoint's error body.
 *
 * Capped and stripped of control characters because it is rendered in the settings pane: an
 * endpoint that answers with a megabyte of HTML must not become the interface.
 */
export function shortDetail(text: string): string | null {
  const cleaned = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}…` : cleaned;
}

/**
 * `fetch` with a deadline, as one place rather than four.
 *
 * `AbortSignal.timeout` and not a manual timer: a manual one leaks when the request settles
 * first, and four copies of that across two providers is four chances to get it wrong.
 */
export async function fetchWithDeadline(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
