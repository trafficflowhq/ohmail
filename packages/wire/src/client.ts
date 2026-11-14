/**
 * WHO IS ASKING, WHAT A SERVER SAYS IT IS, AND THE TWO ANSWERS ABOUT THE APP ITSELF.
 *
 * Every ohmail client names its kind and its release on every request it makes to an ohmail
 * server, in one header. A server says what it is, before any credential exists, on `GET /hello`.
 * And every client understands two answers that are about the app and its server, never about
 * the request: this app is too old for this server, and the server is being updated.
 */
import type { ErrorEnvelope, UpdateAnswerCode } from "./reasons.js";

/**
 * The header a client names itself in: `x-ohmail-client: <kind>/<release>`. A header of its own
 * and not `User-Agent`, which a browser's `fetch` may not set. It carries nothing else: no
 * install, no account. A server may count it and may choose an answer's shape by it; it is never
 * a credential.
 */
export type ClientHeaderName = "x-ohmail-client";

/** THE CLOSED SET of clients. A relayed request is the relaying client's: one hop, one name. */
export type ClientKind = "web" | "desktop-window" | "desktop-engine" | "phone" | "paired-page";

/**
 * A release as the version bump writes it: three numbers and nothing after them. A build that
 * states no release says `dev` in its place, so the value keeps one form.
 */
export type ClientRelease = `${number}.${number}.${number}` | "dev";

/** The header's value. Anything that is not a release reads as unstated, never as text of its own. */
export type ClientHeaderValue = `${ClientKind}/${ClientRelease}`;

/**
 * THE TWO ANSWERS EVERY CLIENT UNDERSTANDS, as they travel: `426 client_too_old` (this app is too
 * old for this server) and `503 server_updating` (the server is being updated), each in the
 * standard error envelope ({@link UpdateAnswerEnvelope}). An answer is one only by STATUS AND
 * CODE TOGETHER: an edge's own 503 and a stray 426 without ohmail's envelope stay the failures
 * they always were. A write that meets either waits and is asked again under its key; it is never
 * dropped as refused.
 */
export type UpdateAnswer =
  | { status: 426; code: "client_too_old" }
  | { status: 503; code: "server_updating" };

/** The body either answer carries: the error envelope, its word one of the two. */
export interface UpdateAnswerEnvelope {
  error: Omit<ErrorEnvelope["error"], "code"> & { code: UpdateAnswerCode };
}

/**
 * `GET /hello` — server identity and capability negotiation, before any credential exists. It
 * makes not-mounting a surface safe: an absent route is announced here, not discovered by a 404
 * mid-ceremony. Every field is a capability, never a configuration echo; nothing here is
 * per-account or secret. The wire shape is frozen: a contract test pins the keys.
 */
export interface HelloAnswer {
  product: "ohmail";
  /**
   * Which composition is serving: the hosted service, an operator-run standalone server, a
   * desktop install's own engine (its window's private door), or that same engine's desktop-host
   * door, the surface a paired phone reaches. A fixed string per composition, never derived per
   * request.
   */
  flavor: "managed" | "selfhost" | "local" | "desktop-host";
  /**
   * The release this server is a build of (`1.0.12`), what a client compares itself with. Each
   * composition states its own; `0.0.0` only where none did. Not a version of the routes.
   */
  apiVersion: string;
  /** Whether this server still has to run its first-account ceremony. */
  needsSetup: boolean;
  /**
   * The sign-in ceremonies this server offers, each a flag. `password`: password sign-in
   * (`POST /auth/login`) is mounted and answered here. `totp`: TOTP second-factor enrollment and
   * verification is available. `webauthn`: WebAuthn (passkey) second-factor is available.
   * `publicSignup`: registration without an invite code is open.
   */
  auth: Record<"password" | "totp" | "webauthn" | "publicSignup", boolean>;
  /** The optional surfaces a client may rely on here. */
  features: {
    /** `GET /events` streams (SSE enabled server-side); off, clients poll `/sync`. */
    sse: boolean;
    /** `POST /attachments/staging` mints upload grants (object storage is armed). */
    staging: boolean;
    /** A model is configured, so the AI surfaces can answer. */
    ai: boolean;
    /** The pairing-token ceremony (`/pair*`) is mounted here. */
    pairing: boolean;
    /** `GET /img` will actually fetch: the image proxy has an egress and a resolver behind it. */
    remoteImages: boolean;
    /**
     * Send later keeps a letter's files here until it goes, with no horizon of its own: true on
     * the desktop's own engine alone. A server says false and names its horizon in
     * {@link scheduleFilesDays} instead.
     */
    scheduleFiles: boolean;
    /** How many days ahead a server that keeps a scheduled letter's files sealed takes one. Absent: none named. */
    scheduleFilesDays?: number;
    /**
     * This composition sets the account header on every answer. A constant, a fact about the
     * build; its absence on an older server IS the negotiation.
     */
    accountHeader: true;
    /** The send route takes `forwardParts`; a fact of the build, as `accountHeader` is. */
    forwardParts: true;
  };
}

/**
 * `GET /hello` when it cannot state what it is: a host that injected no descriptor, or one whose
 * setup state could not be determined. A 503 with this body, never a guessed answer. Not the
 * error envelope: this route answers before the pipeline that builds one.
 */
export interface HelloUnavailable {
  error: "hello_unconfigured" | "hello_unavailable";
  detail: string;
}
