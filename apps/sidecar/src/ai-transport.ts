import type {
  ClassifierInput, ClassifierResult, DraftInput, DraftResult,
} from "@trafficflow/core/mail";

/**
 * What a provider has to be able to do, and nothing else. Four methods: the two features (routing is
 * TWO questions — see {@link AiTransport.screen}) plus "can you actually do them?", separate on
 * purpose because a capability is offered only once it has been asked, never because a form was
 * filled in. Everything about WHAT is asked — taxonomy, screening question, reply policy, response
 * schemas and the two refusing sinks — lives in `@trafficflow/core/mail` and is shared; a provider
 * here decides only how the request travels and how the answer is unwrapped. No SDK, on purpose:
 * both providers speak HTTP through the platform's `fetch`, because every package this shipped-in-app
 * engine pulls in is one a person downloading a binary is trusting, and two JSON endpoints do not justify one.
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
 * What a verification found. `detail` is a short sentence a person can act on, taken from the
 * endpoint's own error body — shown in the settings pane and deliberately NOT logged, because an
 * error body quotes the request that produced it and one of these paths carries an API key header.
 * `models` is what the endpoint said it has; it populates the model pickers, so a person chooses
 * from what is installed rather than typing a name and finding out later.
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
   * The screening question — "what should happen to this first-contact sender". A different question
   * over a different answer set, asked only when a person presses a button about senders waiting at
   * the gate; live mail routing never reaches it. Required here though OPTIONAL on `ClassifierPort`:
   * that port is implemented outside the package that declares it, so a required method would break
   * every implementation for a capability only the Screener uses, and callers fall back to {@link
   * classify} when it is absent — which made this method's absence invisible here for a release
   * (the fallback degrades the advice without endangering anything). `AiTransport` is INTERNAL with
   * both implementations here, so required means a third provider does not compile until taught it.
   */
  screen(input: ClassifierInput): Promise<ClassifierResult>;
  draft(input: DraftInput): Promise<DraftResult>;
  /** Never throws for anything the endpoint did. A refusal is an outcome, not an exception. */
  probe(): Promise<ProbeOutcome>;
}

/**
 * THE OPTION BAG A KEYED PROVIDER TAKES — Anthropic and OpenAI have always taken the same five,
 * and each declared them itself until 0.21. The local model server's bag is genuinely different
 * (a base URL where these have a key) and stays its own.
 */
export interface AiKeyTransportOptions {
  apiKey: string;
  classifyModel: string;
  draftModel: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/**
 * WHAT A NON-2XX ANSWER WAS ABOUT, without reading its prose — one reading for every provider.
 * This is the sentence a person is shown when their key does not work, so two copies drifting
 * means the same 403 reads "your key was refused" on one provider and "the model answered
 * something we could not read" on the other, and only one of those tells them what to do.
 */
export function statusFailure(status: number): ProbeFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "model_absent";
  if (status === 408 || status === 504) return "timeout";
  return "bad_response";
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
