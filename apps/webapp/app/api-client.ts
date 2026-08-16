/**
 * The webapp's HTTP client for everything that is NOT delta-sync.
 *
 * The sync path has its own client (`@ohmail/client-engine`'s `HttpAdapter`, contract-tested
 * against the real in-process API). This is the rest of the wire: auth + 2FA enrollment,
 * mailboxes, billing. Onboarding needs all three and had none of them — `LoginScreen.tsx`
 * was a visual with a toast.
 *
 * ── THE THREE FACTS THAT MAKE THIS SMALL ────────────────────────────────────────────────
 *
 * **1. Same-origin.** The topology put the API behind this app's own `/api` rewrite, so there is no
 * CORS, no preflight, and no `credentials: "include"` (the default `same-origin` already
 * sends first-party cookies). If `NEXT_PUBLIC_API_BASE` is ever an absolute origin, that is
 * a build failure in `next.config.mjs` — not something this file has to defend against.
 *
 * **2. The session lives in cookies.** `tf_session` and `tf_refresh` are `HttpOnly`; nothing
 * here can read or store them, which is the point. The one cookie JS *can* read is
 * `tf_csrf`, and that is its whole job: the double-submit token every cookie-authenticated
 * mutation must echo in `X-CSRF-Token`. So this client holds NO credential state at all —
 * "am I signed in?" is answered by `GET /auth/session`, never by a variable.
 *
 * **3. `Content-Type: application/json` on every body.** Not a convention: `withRequestGuard`
 * rejects any bodied unsafe request that is not JSON with 415, because
 * that is what kills the cross-site `<form enctype="text/plain">`.
 *
 * ── ERRORS ARE VALUES, AND THEY CARRY THE SERVER'S SENTENCE ─────────────────────────────
 *
 * Every refusal in this flow — a bad invite, a used invite, a mailbox limit, an inactive
 * subscription — already has a true, actionable message written by the service that made
 * the decision (`invites.ts`, `mailbox-allowance.ts`). {@link ApiError} carries it through
 * verbatim, along with `code` and `details`. The UI's job is to display it, not to
 * re-derive it: a second copy of the taxonomy in the client is how a user ends up being
 * told they are out of mailbox slots when the real problem is an unpaid subscription.
 * `test/onboarding.test.ts` forbids those sentences appearing in webapp source at all.
 */

import { csrfToken as readCsrfToken } from "./csrf";
import { isRecoverable, mayRefreshFor, resumeSession } from "./session-refresh";

/** The `/api` prefix the same-origin rewrite serves, or `null` on a build with no API armed. */
export const API_BASE: string | null = process.env.NEXT_PUBLIC_API_BASE ?? null;

/** Is this build wired to a server at all? `false` ⇒ demo/gate only. */
export const apiConfigured = (): boolean => typeof API_BASE === "string" && API_BASE.length > 0;

/**
 * A refusal from the API, with the SERVER's own message.
 *
 * `code` is the stable machine name (`invite_used`, `mailbox_limit_reached`,
 * `subscription_inactive`, `step_up_required`, …). `message` is the sentence the service
 * wrote for a human. `details` is whatever the service attached — for the mailbox gate that
 * is `{mailboxLimit, mailboxCount, plan, entitlementReason}`, which is what lets the UI say
 * "2 of 2 connected on Solo".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The one network failure that is not a refusal: we never reached the server. */
export const OFFLINE_CODE = "network_unreachable";

interface RequestOptions {
  // `PUT` joined the union for `/away-responder`, the one endpoint in the contract whose write is a
  // FULL REPLACE rather than a partial update. The verb is part of that meaning, so it is spelled
  // rather than folded into `PATCH`: the route reads an omitted field as "reset it", and a client
  // that called it with PATCH would be describing the opposite of what happens.
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Extra headers (`Idempotency-Key`). `Content-Type` and CSRF are handled here. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The token reader, kept on this module's public surface — one line of forwarding, not a
 * re-export, and the difference is load-bearing for the DESKTOP build.
 *
 * The implementation is in `app/csrf.ts` because `session-refresh.ts` needs the same reader and
 * this module already imports that one, so defining it here would close a cycle (the reasoning is
 * written out in `csrf.ts`). The obvious way to keep the surface unchanged is `export { csrfToken }`
 * — and that is what this was, until the generated desktop stand-in showed why it cannot be.
 *
 * `apps/desktop/src/no-api-client.ts` mirrors this module's exported surface, and every Cloud
 * symbol in it becomes a refusal, because the desktop tier has no server and no cookies. (It was
 * once generated from this module's emitted declarations; it is hand-kept now, pinned by the
 * desktop suite.) A bare `export { csrfToken }` emits, in the `.d.ts`, an
 * `import { csrfToken } from "./csrf"` alongside it — so the stand-in faithfully reproduced an
 * import of `./csrf` RELATIVE TO `apps/desktop/src`, where no such module exists. The stub stopped
 * compiling, and the pre-push payload gate caught it.
 *
 * A `function` declaration cannot do that: its `.d.ts` form is
 * `export declare function csrfToken(): string | null`, which names no other module, and turns
 * into the refusal it should be. So the forwarding is explicit and this comment is the reason it
 * is not written the shorter way.
 */
export function csrfToken(): string | null {
  return readCsrfToken();
}

/**
 * One request. Returns the parsed body, or throws {@link ApiError}.
 *
 * 204 answers `undefined` — `/auth/logout` and `/auth/refresh` (cookie branch) both use it,
 * and `res.json()` on an empty body throws.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await attempt<T>(path, opts);
  } catch (err) {
    // ONE refresh, ONE retry. The access cookie lives fifteen minutes and nothing renewed it,
    // so this is the ordinary state of any tab left open — see `session-refresh.ts`, and note
    // that a stale `tf_csrf` surfaces as 403 `csrf_failed` rather than 401.
    if (!(err instanceof ApiError)) throw err;
    if (!isRecoverable(err.status, err.code) || !mayRefreshFor(path)) throw err;
    if (!(await resumeSession())) throw err;
    // A second failure is the real answer: the caller sees the refused request, not a loop.
    return attempt<T>(path, opts);
  }
}

async function attempt<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(0, "api_unconfigured", "This build is not connected to an ohmail server.");
  }
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const csrf = csrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, OFFLINE_CODE, "We could not reach ohmail. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const env = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(
      res.status,
      env?.code ?? "internal",
      // The fallback is deliberately vague: reaching it means the server answered something
      // this client does not understand, and inventing a specific explanation would be worse
      // than admitting we do not have one.
      env?.message ?? "Something went wrong. Please try again.",
      env?.details,
    );
  }
  return parsed as T;
}

// ── The shapes this flow actually exchanges ──────────────────────────────────────────────

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  twofaEnrolled: { webauthn: boolean; totp: boolean; recoveryCodes: boolean };
  /**
   * Has this address been proven? `withVerifiedEmail` refuses `POST /billing/checkout`
   * and `POST /mailboxes` while this is false, so `JoinScreen`'s `bootstrap()` reads it to
   * decide whether the `verify` step is still ahead — from SERVER state, like every other step.
   */
  emailVerified: boolean;
}

/** `POST /auth/register`, and `POST /auth/login` for a user with no factor yet (the re-entry path). */
export interface EnrollmentSession {
  status: "enrollment";
  user: SessionUser;
  next: "enroll_2fa";
  enrollmentToken: string;
  expiresIn: number;
}

/**
 * `POST /auth/register` on the PUBLIC path (202). Deliberately carries nothing: no
 * session, no user, and no field that differs between a fresh address and one that already has
 * an account. The client shows "check your mail" and cannot say more than that, which is the
 * point rather than a limitation.
 */
export interface RegistrationPending {
  status: "ok";
}

/** `POST /auth/login` for a user who HAS a second factor. */
export interface TwofaChallenge {
  status: "twofa_required";
  loginToken: string;
  methods: Array<"webauthn" | "totp" | "recovery_code">;
}

export type LoginResult = EnrollmentSession | TwofaChallenge;

/** A completed sign-in. The cookie client never sees `tokens` — they are stripped by design. */
export interface AuthenticatedSession {
  status: "authenticated";
  user: SessionUser;
}

export interface MailboxDTO {
  id: string;
  provider: string;
  address: string;
  displayName: string | null;
  status: string;
  /**
   * Last successful worker cycle, ISO-8601, or `null` for a mailbox that has never synced.
   *
   * The server has always sent this (the server's own mailbox DTO);
   * this client simply did not declare it, so the one fact that answers "is my mail actually
   * coming down?" was on the wire and unreachable. Settings → Mailboxes and the (i) panel
   * both read it. `null` is a real state and is rendered as one — a mailbox connected
   * seconds ago has not synced yet, and saying "never" is true while "just now" would not be.
   */
  lastSyncAt: string | null;
  /**
   * HOW THIS MAILBOX SIGNS IN — `"password"` or `"oauth"` (cloud 0009).
   *
   * The server has always projected it (`MailboxService.toDTO`); this client did not declare it, and
   * without it the reconnect control for an oauth mailbox is unrepresentable. That matters more than
   * a missing field usually does: an oauth mailbox's only credential is a refresh token, so the
   * password/host form is meaningless for it, and offering "Edit" would let somebody store a typed
   * password beside an `authType: "oauth2"` credential that the dialler then refuses to use.
   *
   * OPTIONAL, because a client build may be talking to an older API. Absent is read as `"password"`
   * — the historical behaviour, and the one that offers the form rather than withholding it.
   */
  authKind?: "password" | "oauth";
  /**
   * WHY a mailbox is in `error` (mail 0023). Null unless `status === "error"`.
   *
   * A stable KEY, not a sentence — the server never ships English, so the copy stays in
   * `messages/*.json` where it can be translated and edited without a deploy of the API.
   * `errorDetail` is an allowlisted token (an IMAP response code, a Node errno, an SQLSTATE)
   * and never an error message; it is diagnostic filler for a tooltip, not the label.
   */
  errorCode?: "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown" | null;
  errorDetail?: string | null;
  failedAt?: string | null;
  retryCount?: number;
  /**
   * WHY a `connected` mailbox is not being synced (mail 0029) — and this is the SECOND time
   * this exact gap has bitten.
   *
   * `lastSyncAt`'s comment above records the first: the server had always sent it and this
   * client simply did not declare it, so the one fact that answers "is my mail coming down?"
   * was on the wire and unreachable. A later repair then migrated, wrote and unconditionally PROJECTED
   * these two (the server's mailbox DTO, whose own comment explains the asymmetry
   * with the four `error*` fields above is the whole design), and they were undeclared here
   * for the same reason: nothing makes a client declare a field it is not yet reading.
   *
   * `syncBlockedReason` is a CLOSED set of three with a CHECK constraint behind it, so unlike
   * `errorCode` no value a mail server chose can reach it. It is typed as `string` rather than
   * as the union because the union's owner is `app/shell/mail-state.ts`, which the Desktop
   * mirror publishes and which may not import this file — one declaration of the set, in the
   * place that renders it.
   */
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  /**
   * HOW MANY OF THE USER'S OWN FILINGS THIS MAILBOX HAS NOT APPLIED YET.
   *
   * The API never opens IMAP — a decision writes `folder_state` and the worker performs the
   * move on its next cycle — so between the press and that cycle the mail is filed in ohmail
   * and not on the server. With the mail host refusing connections the gap simply does not
   * close, and every other field on this row says the mailbox is fine: `status` is
   * `connected`, `errorCode` is null, `syncBlockedSince` is null. This is the only field that
   * carries the fact, which is the FOURTH time that sentence has had to be written on this
   * type — see the three above it.
   *
   * OPTIONAL, and the optionality is the contract: a server that predates the column omits it
   * entirely, and `app/shell/mail-state.ts` gates on `typeof === "number"` so an absent field
   * says nothing rather than saying zero. A `?? 0` at any seam between here and there would
   * turn "we do not know" into "nothing is outstanding", which is the wrong answer in exactly
   * the case the field exists for.
   */
  pendingMoves?: number;
  /**
   * WHY a `disabled` mailbox is disabled, when the lease decided it and not a person (mail
   * 0027) — the THIRD time this gap has bitten, and the most expensive of the three.
   *
   * `lastSyncAt` was on the wire and undeclared; so were `syncBlockedReason`/`syncBlockedSince`.
   * This one was worse: the field did not exist on the server DTO either, so a mailbox the
   * organizer gate stood down had `errorCode` null, `syncBlockedSince` null and NOTHING at all
   * to say why — observed live as a card calling a minutes-old mailbox "disconnected" under a
   * headline saying no mailbox was connected at all.
   *
   * `string` rather than the union, exactly as `syncBlockedReason` above: the set's client-side
   * owner is `app/shell/mail-state.ts`, which the Desktop mirror publishes and which may not
   * import this file. One declaration, in the place that renders it.
   */
  disabledReason?: string | null;
  /**
   * When this mailbox was connected.
   *
   * The ONE per-mailbox clock that is not shared. `lastSyncAt` is stamped for every mailbox a
   * worker cycle served in a single `UPDATE … WHERE id IN (…)`
   * (the sync worker), which is why two rows can report an identical
   * age to the second; `createdAt` is per row and immutable, so "connected 12 minutes ago and
   * nothing has arrived" is a sentence the client can actually stand behind.
   */
  createdAt?: string;
  /**
   * WHEN this mailbox's FIRST import actually finished (mail 0038). NULL until a worker cycle
   * completes with no backlog remaining.
   *
   * The end-of-import signal `lastSyncAt` cannot be: that column is shared across the pass and
   * lands after the first cycle whatever the backlog, so it says nothing about whether the import
   * is DONE. This one is per-mailbox and late, and `app/shell/mail-state.ts` reads it as a FLOOR —
   * a NULL keeps the strip saying "still importing" even when this client's own mirror has stopped
   * growing, which is what stops a partial mailbox reading as complete. Optional here so a stale
   * bundle that predates it degrades to the prior growth-only behaviour rather than crashing.
   */
  initialImportCompletedAt?: string | null;
  /**
   * THE BIGGEST MESSAGE THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT, in bytes (mail
   * 0055) — the server's own `SIZE` announcement, read out of the EHLO the connect-time SMTP
   * probe already ran, or `null` when it announced none.
   *
   * The compose surface states an attachment ceiling before the user picks a file, and it used to
   * state a CONSTANT — the hosted API's request-body limit, which is a true fact about one
   * deployment and about no mail server anywhere. This is the number that lets that promise be
   * kept: `composeAttachCap` takes the SMALLER of the two, so a provider capping submission below
   * the request pipeline's limit binds the form to the provider's number instead of ending in a
   * bounce after the user has waited for the send.
   *
   * Optional so an API that predates the column degrades to the constant, and nullable because
   * "the server announced nothing" is a real, common answer that resolves the same way.
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * HOW MUCH MAIL IS IN THIS MAILBOX — present only on a response to `?counts=1`.
   *
   * OPTIONAL FOR A DIFFERENT REASON FROM EVERY OTHER OPTIONAL FIELD ON THIS TYPE. The ones
   * above are optional because an older server might not send them; this one is optional
   * because THIS client decides, per request, whether to ask. `mailboxes.list()` omits it,
   * `mailboxes.list({ counts: true })` gets it, and both are correct answers about the same
   * mailbox at the same moment.
   *
   * So absent means "nobody asked" and `0` means "this mailbox is empty" — two different
   * facts, and a renderer that collapses them shows "0 messages" about a full mailbox every
   * time a countless poll lands. Read it with `typeof === "number"`; never `?? 0`.
   */
  messageCount?: number;
}

export interface SubscriptionStatus {
  subscription: {
    plan: "solo" | "plus" | "pro";
    status: string;
    mailboxLimit: number;
    monthlyCredits: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
  } | null;
  balance: number;
  entitlements: {
    mailboxLimit: number;
    canAddMailbox: boolean;
    aiEnabled: boolean;
    syncEnabled: boolean;
    reason: string;
  };
  /**
   * The plan CARD, straight from `PLAN_LIMITS` in `packages/db`. The onboarding plan step
   * renders these numbers rather than restating them: the tiers moved from 2/5/10 to
   * 5/10/50 while this was being written, and hard-coded copy is how a signup page
   * ends up advertising a plan the database will not sell.
   */
  plans: Record<string, { priceUsd: number; mailboxes: number; monthlyCredits: number }>;
  /**
   * What a TRIAL is granted — the same constant for every account, straight from the policy
   * module, for the same reason `plans` is shipped rather than restated.
   *
   * Optional: a bundle newer than the server it is talking to must not render `undefined` into a
   * sentence, and every reader treats an absent value as "say nothing about the figure" rather
   * than substituting one. It is NOT this account's remaining balance — that is `balance`.
   */
  trialCredits?: number;
  /**
   * Whether an `invoice_grant` has EVER landed on this account — credits revenue paid for.
   *
   * Read by exactly one decision (`ai-credit-state.ts`): whether a `trialing` subscription row
   * may present `balance` as the trial's non-refilling pot. In the trial→paid window,
   * `invoice.paid` grants the plan's allowance before `customer.subscription.updated` — a
   * separate delivery — moves the row off `trialing`, so the status alone would label PAID
   * credits a trial bounty: a provenance that is false while the number is real.
   *
   * Optional for the same reason `trialCredits` is: an older server omits it, and the reader
   * accepts the brief mislabel window rather than suppressing every true trial label.
   */
  invoiceGranted?: boolean;
}

// ── Auth ─────────────────────────────────────────────────────────────────────────────────

export const auth = {
  // `inviteCode` is OPTIONAL on the wire. A deployment with `TF_PUBLIC_SIGNUP=1`
  // accepts a body without it; one without still answers `validation_failed`, which is the
  // server's call and not this client's. Omitting the key is not the same as sending `""`
  // and the caller decides which it means.
  // TWO possible shapes, discriminated on `status`, because the two paths are different
  // in kind. The INVITE path returns an enrollment session (201) exactly as before. The PUBLIC
  // path returns `{status:"ok"}` (202) and NO session, byte-identically whether or not the
  // address already had an account — the continuation is the mail, which is the only place the
  // difference can be told to the one person entitled to know it.
  register: (b: { email: string; password: string; displayName: string; inviteCode?: string }) =>
    api<EnrollmentSession | RegistrationPending>("/auth/register", { method: "POST", body: b }),

  /**
   * `POST /auth/verify-email`. The password is REQUIRED alongside the token and is not a
   * convenience: a mailed link on its own would let whoever registered an address wait for its
   * real owner to click and thereby verify the REGISTRANT's account. See
   * `AuthService.verifyEmail` for the full chain.
   */
  verifyEmail: (b: { token: string; password: string }) =>
    api<EnrollmentSession | { status: "verified" }>("/auth/verify-email", { method: "POST", body: b }),

  /** Another link for the SESSION's own address. Takes no recipient, by design. */
  resendVerification: () =>
    api<{ ok: true }>("/auth/verify-email/resend", { method: "POST", body: {} }),

  login: (b: { email: string; password: string }) =>
    api<LoginResult>("/auth/login", { method: "POST", body: b }),

  session: () => api<{ user: SessionUser; scope: "full" | "enrollment" }>("/auth/session"),

  logout: () => api<void>("/auth/logout", { method: "POST", body: {} }),

  // ── 2FA enrollment (the enrollment-session surface: the seven `enrollmentOk` routes) ──

  webauthnRegisterOptions: () =>
    api<{ options: PublicKeyCredentialCreationOptionsJSON }>("/auth/2fa/webauthn/register/options", {
      method: "POST", body: {},
    }),

  /**
   * `session` is present ONLY when this was the FIRST factor: enrolling it EXCHANGES the
   * enrollment session for a full one, which is what makes the passkey step the
   * moment onboarding stops being password-only.
   */
  webauthnRegisterVerify: (b: { credential: unknown; label: string }) =>
    api<{ credentialId: string; twofaEnrolled: SessionUser["twofaEnrolled"]; session?: AuthenticatedSession }>(
      "/auth/2fa/webauthn/register/verify", { method: "POST", body: b },
    ),

  totpEnroll: () => api<{ secret: string; otpauthUrl: string }>("/auth/2fa/totp/enroll", {
    method: "POST", body: {},
  }),

  totpActivate: (b: { code: string }) =>
    api<{ twofaEnrolled: SessionUser["twofaEnrolled"]; session?: AuthenticatedSession }>(
      "/auth/2fa/totp/activate", { method: "POST", body: b },
    ),

  /**
   * Recovery codes. Double-gated on purpose: `enrollmentOk` AND `stepUp`, and the
   * two are independent — which is what makes "passkey first, then codes" a structural
   * order rather than client discipline. Calling this before a factor lands 403s.
   */
  recoveryCodes: () => api<{ codes: string[] }>("/auth/2fa/recovery-codes", { method: "POST", body: {} }),

  /**
   * Remove the authenticator. `DELETE /auth/2fa/totp` shipped with the rest of the 2FA surface and had NO
   * client until Settings → Security existed to call it, which is a large part of why 2FA read
   * as one-way: enrol once during signup, then no route back.
   *
   * Step-up gated at the route AND re-checked in `AuthService.requireStepUp` — deliberately
   * double-gated, because it is the one destructive call in this group. The server also refuses
   * to remove the last surviving factor, so the UI's decision to hide the button unless a
   * passkey remains is a courtesy, not the enforcement.
   */
  totpRemove: () => api<void>("/auth/2fa/totp", { method: "DELETE" }),

  // ── Sign-in completion ────────────────────────────────────────────────────────────────

  webauthnAssertOptions: (b: { loginToken: string }) =>
    api<{ options: PublicKeyCredentialRequestOptionsJSON }>("/auth/2fa/webauthn/assert/options", {
      method: "POST", body: b,
    }),

  webauthnAssertVerify: (b: { loginToken: string; credential: unknown }) =>
    api<AuthenticatedSession>("/auth/2fa/webauthn/assert/verify", { method: "POST", body: b }),

  totpVerify: (b: { loginToken: string; code: string }) =>
    api<AuthenticatedSession>("/auth/2fa/totp/verify", { method: "POST", body: b }),

  /**
   * Mint the one-use code the desktop app exchanges for a session of its own (`/link-desktop`).
   *
   * Step-up gated at the route, and this client does nothing about that beyond letting the
   * refusal through: `403 step_up_required` is a fact the page has to say out loud, exactly as
   * `SecuritySection` says it for recovery codes. Swallowing it would turn "your step-up expired"
   * into "linking the desktop app does not work".
   *
   * `expiresIn` is SECONDS, and the page counts down with it rather than hard-coding two minutes:
   * the TTL is the server's decision (`desktopLinkTtlMs`) and a second copy of it here would
   * drift silently the first time it changed.
   *
   * `challenge` is the public half of a PKCE pair the desktop install invented before it opened
   * this page, and it arrives in the page's own URL. Sending it binds the minted code to whoever
   * holds the verifier, which is what makes it safe to hand the code back over a URL scheme.
   * OMITTING it is not a lesser call — it is the browser flow, where nobody is holding a verifier
   * and the code is meant to be retyped.
   */
  desktopLink: (b: { challenge?: string } = {}) =>
    api<{ code: string; expiresIn: number }>("/auth/desktop-link", {
      method: "POST",
      body: b.challenge ? { challenge: b.challenge } : {},
    }),

  recoveryVerify: (b: { loginToken: string; code: string }) =>
    api<AuthenticatedSession & { remainingCodes: number }>("/auth/2fa/recovery-codes/verify", {
      method: "POST", body: b,
    }),
};

// ── Mailboxes ────────────────────────────────────────────────────────────────────────────

export interface CreateMailboxBody {
  provider: string;
  address: string;
  displayName?: string;
  /**
   * `port`/`secure` OMITTED asks the server's probe to auto-detect: 993 implicit TLS first,
   * then 143 STARTTLS, storing whichever it proved. Presets keep sending their known pair.
   * `allowInsecure` is the explicit plaintext consent for a server the probe reported as
   * having no TLS at all — sent only after the user checked the opt-in, and re-verified
   * server-side before it is honored.
   */
  imap: { host: string; port?: number; secure?: boolean; user: string; pass: string; allowInsecure?: boolean };
  smtp?: { host: string; port?: number; secure?: boolean; user?: string; pass?: string };
}

/**
 * A PATCH of an existing mailbox. Partial by design — the server MERGES a transport block over
 * the stored connection params, so `{ imap: { pass } }` rotates only the password and keeps the
 * host/port/user that are already stored.
 *
 * `pass` is required whenever an `imap` block is present: it is the presence of a secret that
 * makes the server re-try the login before storing anything. A block with a corrected host and no
 * password would rewrite nothing and prove nothing, so the type forbids it — to change a host you
 * re-enter the password, which is the credential that gets tried and re-encrypted.
 *
 * The connection params (host/port/user) are never echoed by `GET /mailboxes`, so a form cannot
 * pre-fill them; an omitted field means "keep what is stored", not "clear it".
 */
export interface UpdateMailboxBody {
  displayName?: string | null;
  status?: "connected" | "disabled";
  /** `allowInsecure` as on {@link CreateMailboxBody.imap} — consent, re-verified server-side. */
  imap?: { host?: string; port?: number; secure?: boolean; user?: string; pass: string; allowInsecure?: boolean };
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass: string };
}

export const mailboxes = {
  /**
   * The account's mailboxes.
   *
   * `counts` asks the server to add `MailboxDTO.messageCount` to every row — one grouped
   * aggregate over the account's mail. It is OFF by default and every polled caller leaves it
   * off: `MailStateProvider` reads this route every 30 s in every open tab for the status
   * strip, and the Settings pane reads it every 10 s while it is on screen. Ask for the count
   * when a screen that shows it opens, not on a heartbeat.
   *
   * An older server ignores the parameter and answers the bare list, which is why the field is
   * optional on the DTO and why a renderer must read it with a `typeof === "number"` guard
   * rather than treating an absent field as zero.
   */
  list: (opts: { counts?: boolean } = {}) =>
    api<{ items: MailboxDTO[] }>(opts.counts ? "/mailboxes?counts=1" : "/mailboxes"),
  /**
   * Ask the worker to re-scan this mailbox from scratch. 202 — it clears each folder's
   * CONDSTORE cursor and the worker picks it up on its next cycle, so nothing is synced by
   * the time this returns. The UI must say "queued", never "synced".
   */
  resync: (id: string) => api<{ status: string }>(`/mailboxes/${id}/resync`, { method: "POST", body: {} }),
  /**
   * `POST /mailboxes` is `stepUp`-gated — it writes envelope-encrypted credentials. During
   * onboarding the passkey/TOTP enrollment that just happened IS the fresh second factor, so
   * the step-up window is open; a user who wanders off and comes back gets `step_up_required`
   * and has to re-authenticate, which is the correct outcome and not an error to paper over.
   */
  create: (b: CreateMailboxBody) => api<MailboxDTO>("/mailboxes", { method: "POST", body: b }),

  /**
   * Change a connected mailbox's settings — the reconnect/rotate path.
   *
   * `stepUp`-gated exactly like `create`, because it writes an envelope-encrypted credential, and
   * for the same reason it tries the login before it stores it: a rotated password the mail server
   * refuses is answered `mailbox_probe_failed` and the OLD credential is left in place, so a typo
   * here cannot take a working mailbox offline. The caller shows the `details.reason` sentence and
   * lets the user correct the field they just typed — nothing is stood down.
   */
  update: (id: string, b: UpdateMailboxBody) =>
    api<MailboxDTO>(`/mailboxes/${id}`, { method: "PATCH", body: b }),

  /**
   * WHO IS ORGANIZING THIS MAILBOX RIGHT NOW, read from the mailbox itself.
   *
   * Exactly one ohmail organizes a mailbox at a time, and the claim lives in an unsubscribed
   * `ohmail/_meta` folder because that is the only thing a desktop install and Cloud both see. When
   * Cloud loses a mailbox it records why and stops — and from then on nothing re-reads the claim,
   * so the stored reason is a snapshot of the moment it stood down and not an answer to "is that
   * install still running?". This asks the mailbox.
   *
   * A short-lived IMAP connection, so it is not free and is not polled. It is read once, when
   * somebody is about to decide something.
   */
  organizer: (id: string) => api<OrganizerPeek>(`/mailboxes/${id}/organizer`),

  /**
   * Ask Cloud to organize a mailbox it stood down from.
   *
   * It authorizes ONE attempt and does not win anything: the worker reads the claim on its next
   * pass and decides. If another install is still renewing and outranks us, this side stands back
   * down and the authorization is spent with it. Step-up-gated — it decides who moves somebody's
   * mail.
   */
  takeover: (id: string) =>
    api<MailboxTakeover>(`/mailboxes/${id}/takeover`, { method: "POST", body: {} }),

  /**
   * BEGIN the Microsoft consent ceremony. Returns the URL to navigate to at TOP LEVEL.
   *
   * It is a URL and not a redirect this call follows, and that is not a style choice: a `fetch`
   * cannot follow a cross-origin redirect AND change the document, and Microsoft's consent screen
   * sets `X-Frame-Options`, so an iframe is impossible and a popup is blocked in the common case.
   * The caller does `window.location.assign(authorizeUrl)`.
   *
   * `mailboxId` is optional and buys ONE thing: a `login_hint`, so somebody reconnecting an expired
   * mailbox is offered the right Microsoft account first. It does NOT decide which mailbox row the
   * ceremony writes — the address in Microsoft's `id_token` does — so a person who ignores the hint
   * and signs in as somebody else gets that other mailbox rather than this row repointed.
   *
   * 503 `oauth_unconfigured` is a first-class answer: the deployment has not finished setting the
   * Entra application up. The caller renders the server's sentence, as everywhere else.
   */
  oauthStart: (b: { mailboxId?: string; returnTo?: string } = {}) =>
    api<{ authorizeUrl: string; state: string }>("/mailboxes/oauth/microsoft/start", { method: "POST", body: b }),

  /**
   * IS THE OUTLOOK DOOR ARMED ON THIS DEPLOYMENT — a boolean, and NOTHING about the registration.
   *
   * The pane reads this before it renders "Connect Outlook" (and the per-row "Reconnect Microsoft"),
   * so a deployment whose operator has not finished setting the Entra application up shows no button
   * that would then answer 503. The server resolves availability from the SAME `resolveOAuthProviderConfig`
   * the admin console and `…/start` use — but returns only `available`: the client id, the tenant and
   * the secret never cross to the browser. Read once on mount, not polled; it changes only when an
   * operator saves the console form.
   */
  oauthAvailability: () =>
    api<{ available: boolean }>("/mailboxes/oauth/microsoft/availability"),

  /**
   * FINISH it — the SAME-SITE half, and the reason the ceremony is three steps rather than two.
   *
   * `tf_session` is `SameSite=Strict`, so the browser withholds it on the cross-site top-level
   * navigation back from Microsoft: the API's `GET …/callback` cannot see a session and does not try
   * to. It bounces the browser here instead, and THIS call — same-origin, cookie and CSRF header
   * both present — is where the ceremony is spent, the session's account is checked against the one
   * that started it, and the mailbox is stored.
   *
   * Single-use: a second call with the same `state` is 400, which is what makes a replayed redirect
   * (a refresh, a shared link) harmless rather than a second mailbox.
   */
  oauthComplete: (b: { state: string; code: string }) =>
    api<{ mailbox: MailboxDTO; created: boolean; returnTo: string | null }>(
      "/mailboxes/oauth/microsoft/complete", { method: "POST", body: b },
    ),
};

/** One organizer holding a claim, as `GET /mailboxes/:id/organizer` reports it. */
export interface OrganizerHolder {
  kind: "local" | "cloud" | "unknown";
  /** The machine, as its own install named itself. `null` when the claim carried no name. */
  displayName: string | null;
  heartbeatAt: string;
  /** Still renewing. `false` means it stopped and left the claim behind. */
  active: boolean;
}

export interface OrganizerPeek {
  state: "none" | "held" | "stopped";
  /** Freshest first. */
  holders: OrganizerHolder[];
  /** Claims present but unreadable — evidence somebody claimed, which is why `state` is not `none`. */
  unreadable: number;
}

export type MailboxTakeover =
  | { outcome: "authorized"; previousReason: string }
  | { outcome: "already_organizing" }
  | { outcome: "disconnected" };

// ── Billing ──────────────────────────────────────────────────────────────────────────────

export const billing = {
  subscription: () => api<SubscriptionStatus>("/billing/subscription"),
  /**
   * Stripe's hosted Billing Portal. `stepUp`-gated — it exposes the payment method and the
   * cancel control, so it demands a fresh second factor exactly as `DELETE /account` does.
   *
   * This is also the INVOICE surface, and deliberately not a thing we rebuild: the portal
   * already lists every invoice with a downloadable PDF receipt, keeps them after
   * cancellation, and is the record Stripe itself considers authoritative. Re-implementing
   * receipts would mean holding a second copy of billing history that can disagree with the
   * one the customer's accountant will ask for.
   */
  portal: () => api<{ url: string }>("/billing/portal", { method: "POST", body: {} }),
  /** Answers a Stripe-hosted Checkout URL; the caller navigates. */
  checkout: (plan: "solo" | "plus" | "pro") =>
    api<{ url: string }>("/billing/checkout", { method: "POST", body: { plan } }),
};

// ── The account itself ───────────────────────────────────────────────────────────────────

/** What `DELETE /account` answers. Every field is stated on the confirmation screen. */
export interface ErasureResult {
  erased: true;
  usersErased: number;
  /** Rows removed per table — the operator's audit line, not something the UI enumerates. */
  tables: Record<string, number>;
  /** The server's own sentence about what survives. Shown verbatim, never paraphrased. */
  retained: string;
  /**
   * What happened to a paid subscription. `cancel_failed` is the one value the screen must
   * shout about: the account is erased either way, and the customer no longer has a session
   * with which to discover that Stripe refused.
   */
  subscription: "none" | "cancelled" | "cancel_failed";
}

/** `GET`/`PATCH /account/ai` — the managed-AI switch, stored on `accounts.ai_enabled`. */
export const aiSettings = {
  get: () => api<{ aiEnabled: boolean }>("/account/ai"),
  set: (aiEnabled: boolean) =>
    api<{ aiEnabled: boolean }>("/account/ai", { method: "PATCH", body: { aiEnabled } }),
};

/** The wire shape of `GET/PATCH /account/screening` — the editable Ohbox preference. */
export interface ScreeningPreferenceWire {
  /** The stored posture, or `null` while the account has never set one (reads as lenient). */
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  /** The stored bar text, or `null` while the account has never set one (show `defaultBar`). */
  ohboxBar: string | null;
  /** The product-default bar, for the textarea placeholder when `ohboxBar` is null. */
  defaultBar: string;
  /**
   * Whether auto-apply is on. When on, obvious newsletters and receipts are filed out of the
   * Screener for you using the deterministic rules — no AI, no spend — and every move stays
   * reversible. Absent/failed reads resolve to `false`, so the default is off.
   */
  screenerAutoApply: boolean;
}

/**
 * `GET`/`PATCH /account/screening` — "what deserves my Ohbox". The PATCH sends only the axes the
 * caller changed: an omitted key is left untouched, an explicit `null` reverts that axis to default.
 */
export const screeningSettings = {
  get: () => api<ScreeningPreferenceWire>("/account/screening"),
  set: (body: {
    ohboxPolicy?: ScreeningPreferenceWire["ohboxPolicy"];
    ohboxBar?: string | null;
    screenerAutoApply?: boolean;
  }) => api<ScreeningPreferenceWire>("/account/screening", { method: "PATCH", body }),
};

/** What `GET /consent` answers: where an account stands in onboarding, and the dial it counts with. */
export interface ConsentStateWire {
  /** ISO timestamp, or null while the seed review has never been confirmed. */
  seedConfirmedAt: string | null;
  screeningResetAt: string | null;
  /**
   * The dormancy window in days. ALWAYS a number — the server substitutes the product default
   * for an account that has never moved it, because a client cannot partition with a null.
   */
  dormancyDays: number;
  /**
   * WHEN this account finished screening its backlog — the instant the dormancy window is
   * measured back from — or null for "never decided anything, measure from now" (mail 0056).
   *
   * Optional in the type, and the three states collapse the way {@link autoSuggestAt}'s do rather
   * than the way `blockRemoteImagesAt`'s do NOT: `null` (a server that read the row and found no
   * baseline) and `undefined` (an API deployed before mail 0056) both mean the client partitions
   * with the sliding window, which is what it did before this field existed. Nothing here is a
   * safety branch — the worst case of not knowing is the old churn, not somebody's mail being
   * hidden. The one thing a reader must not do is invent a baseline for either state.
   *
   * It is the SECOND half of the cutline arithmetic and must be read together with
   * {@link dormancyDays}: cutoff = `(screeningBaselineAt ?? now) - dormancyDays`.
   */
  screeningBaselineAt?: string | null;
  /**
   * WHEN auto-suggest was turned on, or null for off — and `undefined` from an API deployed
   * before mail 0040, which must read the same as null.
   *
   * Optional in the type on purpose. The three states a client can be in are "off", "on since
   * T", and "this deployment does not have the field", and only the second of them may spend
   * money, so the other two collapse safely into one branch. Typing it as required would make
   * the pre-0040 deployment a type lie the reader has to remember to handle.
   */
  autoSuggestAt?: string | null;
  /**
   * WHEN this account opted OUT of loading remote images automatically, or null for the product
   * default — which is that they load, through the proxy.
   *
   * Optional in the type, and the three states are NOT interchangeable here the way
   * {@link autoSuggestAt}'s are. `null` is a server that read the row and found no opt-out ⇒ auto.
   * `undefined` is an API deployed before mail 0048, which cannot have read the row at all ⇒
   * MANUAL, the same answer a failed fetch gets. Collapsing them would load remote content on
   * behalf of somebody whose stored preference this build never saw.
   */
  blockRemoteImagesAt?: string | null;
  /**
   * WHEN this account turned OFF auto-unsubscribe on screen-out, or null for the product default —
   * which is that screening a sender out, or marking them spam, also sends the sender's one-click
   * unsubscribe request.
   *
   * Optional, and here `null` and `undefined` ARE the same answer, unlike
   * {@link blockRemoteImagesAt} one field up. Both mean "no stored opt-out has reached this
   * build", and both must resolve to the SAME branch — ON — because what the client does with
   * this value is decide whether to TELL somebody, before they click, that a screen-out will also
   * leave the sender's list. The server has its own copy and will act on it regardless, so a
   * client that resolved "I do not know" to OFF would drop the disclosure of an irreversible
   * request that is still going out. Collapsing them is the correct direction, not the convenient
   * one.
   */
  blockAutoUnsubscribeAt?: string | null;
  /**
   * THE ACCOUNT'S INTERFACE LANGUAGE — `'de'`, or `null` for "this account has no preference".
   *
   * Optional, and here `null` and `undefined` genuinely ARE the same answer, unlike
   * {@link blockRemoteImagesAt} one field up: both mean "nothing from the account, so keep whatever
   * language this device remembered". An API too old to carry the field and an account that never
   * opened the selector leave the reader in exactly the same place, and neither may override a
   * device — so collapsing them is correct rather than convenient.
   *
   * A string that is not a supported locale cannot arrive: the column's CHECK closes the set and
   * `consentSettings` refuses an unsupported value on the read side as well. The client normalises
   * anyway (`normalizeLocale`), because a boot path that trusts a wire string is one deploy skew
   * away from asking for a catalogue that does not exist.
   */
  locale?: string | null;
  counts: {
    decidedSenders: number;
    activeUndecidedSenders: number;
    dormantUndecidedSenders: number;
  };
}

export interface SeedCandidateWire {
  address: string;
  name: string | null;
  messages: number;
  lastWrittenAt: string | null;
  alreadyDecided: boolean;
}

export interface SeedReviewWire {
  candidates: SeedCandidateWire[];
  excluded: Array<{ address: string; reason: "robot-recipient" | "machine-sent" | "own-address" }>;
  scannedMessages: number;
  truncated: boolean;
}

/**
 * Onboarding consent — the sent-mail seed, the dormancy dial and the screening reset.
 *
 * `dormancyDays` reaches the client HERE rather than through the sync feed, and deliberately:
 * it is one integer per account that moves about as often as somebody changes their mind
 * about what "recent" means. Growing the delta vocabulary for it would mean a new entity type
 * in every change-log writer, in the wire union and in the mirror, for a value with no
 * history worth replaying and no delete to represent. The precedent is the one the schema
 * already documents for per-account settings tables: served over REST, refetched.
 *
 * The dial IS writable, through {@link consent.setDormancyDays} → `PATCH /consent/settings`, which
 * shares one route with {@link consent.setAutoSuggest}: two independent knobs, field-present ⇒
 * acted-on. The write echoes the EFFECTIVE window back (always a number), and the caller sets its
 * hook state from that echo so the open tab re-partitions with the value the server actually stored.
 * It is a settings write only — the dial changes what the Screener SHOWS, never where mail lives.
 */
export const consent = {
  state: () => api<ConsentStateWire>("/consent"),
  /**
   * TURN AUTO-SUGGEST ON OR OFF. The only account setting this client can write.
   *
   * `enabled` is sent as a real boolean because the route refuses anything else — an absent or
   * non-boolean field is a 400 rather than a silent opt-out, so a bug here surfaces as a refusal
   * instead of as suggestions that quietly stopped.
   *
   * No `Idempotency-Key`: setting a flag to the same value twice is the same state, and the only
   * thing a replay moves is the recorded instant. The response echoes what the DATABASE holds,
   * so the caller updates from that rather than from what it asked for.
   */
  setAutoSuggest: (enabled: boolean) =>
    api<{ autoSuggestAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { autoSuggest: enabled },
    }),
  /**
   * SET THE DORMANCY WINDOW — the cutline dial, on the SAME route as {@link consent.setAutoSuggest}
   * with `dormancyDays` in the body instead of `autoSuggest` (field-present ⇒ acted-on, so the two
   * never touch each other's column).
   *
   * `days` is an integer 1–365, or `null` to revert to the product default. The server refuses
   * anything outside the band with a 400 rather than storing a value that would later crash the
   * `GET /consent` read, and it NEVER stores the default itself — so the response's `dormancyDays`
   * is the EFFECTIVE window (a null store reads back as the default). The caller updates its hook
   * from that echo, which is what re-partitions the open tab.
   */
  setDormancyDays: (days: number | null) =>
    api<{ dormancyDays: number }>("/consent/settings", {
      method: "PATCH",
      body: { dormancyDays: days },
    }),
  /**
   * KEEP THE PER-MESSAGE "SHOW IMAGES" FLOW, OR LET IMAGES LOAD — the third knob on the same
   * route (field-present ⇒ acted-on, so it never touches the other two columns).
   *
   * `blocked: true` stores the OPT-OUT; `false` clears it and returns the account to the product
   * default. The response echoes the stored instant (`null` when images load), and the caller sets
   * its state from that echo — a refused write must not be drawn as a move, and here a write drawn
   * as a move in the wrong direction would start loading remote content.
   *
   * The route refuses anything that is not a real boolean, so a malformed body is a 400 rather
   * than a silently cleared opt-out.
   */
  setBlockRemoteImages: (blocked: boolean) =>
    api<{ blockRemoteImagesAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { blockRemoteImages: blocked },
    }),
  /**
   * KEEP AUTO-UNSUBSCRIBE ON SCREEN-OUT, OR STOP IT — the fifth knob on the same route
   * (field-present ⇒ acted-on, so it never touches the other four columns).
   *
   * `blocked: true` stores the OPT-OUT; `false` clears it and returns the account to the product
   * default. The response echoes the stored instant (`null` when the pass runs), and the caller
   * sets its state from that echo: a refused write drawn as a move would tell somebody their lists
   * are being left alone while the server goes on leaving them, which is the one direction of this
   * control that matters.
   *
   * The route refuses anything that is not a real boolean, so a malformed body is a 400 rather
   * than a silently cleared opt-out.
   */
  setBlockAutoUnsubscribe: (blocked: boolean) =>
    api<{ blockAutoUnsubscribeAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { blockAutoUnsubscribe: blocked },
    }),
  /**
   * SET THE INTERFACE LANGUAGE — the fourth knob on the same route (field-present ⇒ acted-on).
   *
   * Resolves to the STORED value, which is not always the one that was asked for: the service never
   * stores the default, so `setLocale("en")` answers `null`. The caller must apply the ECHO —
   * `AccountLocale` does — because `null` is what tells this and every other device that the account
   * has stopped overriding their remembered language. Applying the argument instead would leave one
   * tab believing the account still says English while the row says nothing.
   *
   * `null` is a legal argument and means "back to the default"; it is NOT the same as omitting the
   * field, which would leave the stored value untouched.
   */
  setLocale: (locale: string | null) =>
    api<{ locale: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { locale },
    }).then((r) => r.locale),
  /** The review list. Reads, and writes nothing — the list is an offer. */
  seedReview: () => api<SeedReviewWire>("/consent/seed"),
  /**
   * THE CONSENT EVENT. One press, one key: the server refuses a second confirm outright
   * (409), so an `Idempotency-Key` is what separates "the user clicked twice" from "the
   * first response never arrived".
   */
  confirmSeed: (addresses: string[], opts: { idempotencyKey?: string } = {}) =>
    api<{ rulesCreated: number; contactsCreated: number; declined: number; skipped: number }>(
      "/consent/seed",
      {
        method: "POST",
        body: { addresses },
        ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
      },
    ),
  /** What a reset would leave physically moved. Safe to call before deciding to reset. */
  resetPreview: () =>
    api<{ unmoved: Array<{ folder: string; messages: number; observed: number }> }>("/consent/reset"),
  /** Step-up gated. The caller runs the second factor first, as `account.erase` does. */
  reset: () =>
    api<{
      rulesDeleted: number; contactsDeleted: number; screenerSuggestionsDeleted: number;
      learningSignalsDeleted: number;
      unmoved: Array<{ folder: string; messages: number; observed: number }>;
    }>("/consent/reset", { method: "POST" }),
};

/** The single per-account autoresponder row, as `GET/PUT /away-responder` serve it. */
export interface AwayResponderWire {
  enabled: boolean;
  subject: string | null;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Who gets an automatic reply. `screened_in` restricts it to senders past the Screener. */
  audience: "screened_in" | "everyone";
  updatedAt: string | null;
}

/**
 * The away responder. REST-only, like the consent settings above and for the same reason:
 * one row per account that changes when somebody goes on holiday.
 *
 * `PUT` IS A FULL REPLACE, and every caller has to treat it as one. The route stores exactly the
 * fields in the body and defaults the ones that are absent — an omitted `audience` becomes
 * `screened_in`, the narrow member — so a partial write is a silent reset of whatever it left out,
 * never a merge. `AwayResponderRow` therefore sends the whole row back and never a single field.
 *
 * No `Idempotency-Key`: the upsert is keyed on the account, so a replay stores the same row twice
 * and the only thing that moves is `updatedAt`. That is not free — `updatedAt` is the away
 * responder's ENABLEMENT EPISODE, so a replay lets each correspondent be answered once more — which
 * is why this client never retries the call automatically and why the row's control is a deliberate
 * press rather than a debounced autosave.
 */
export const away = {
  state: () => api<AwayResponderWire>("/away-responder"),
  save: (next: Omit<AwayResponderWire, "updatedAt">) =>
    api<AwayResponderWire>("/away-responder", { method: "PUT", body: next }),
};

export const account = {
  /**
   * `DELETE /account` — Art. 17 erasure.
   *
   * `stepUp`-gated, and unlike `POST /mailboxes` there is no window in which a caller is
   * already fresh: nothing but a completed second factor sets `sessions.last_twofa_at`, and
   * the window is five minutes. So `AccountSection` runs the sign-in ceremony immediately
   * before calling this, rather than calling it optimistically and translating the 403.
   *
   * No body: `withRequestGuard` only demands `application/json` of a request that HAS one, and
   * this call's whole payload is the session it is authenticated by.
   */
  erase: () => api<ErasureResult>("/account", { method: "DELETE" }),
};

/**
 * The spy-pixel blocker's consent write.
 *
 * The blocker's other two surfaces are NOT here on purpose. `GET /img` is never `fetch`ed by
 * this client at all: it is a url the sanitizer puts in an `<img src>`, so the browser issues
 * it as a subresource of the message frame and the host-only session cookie authenticates it
 * — see `app/shell/remote-images.ts`. And the tracker-event feeds are read through the sync
 * engine's own mirror rather than through this client.
 */
export const privacy = {
  /**
   * "Load anyway" for one message. Idempotent-safe server-side (a second call is a no-op), so
   * a retry costs a row update and never a wrong answer.
   *
   * No body, for `account.erase`'s reason: `withRequestGuard` only demands `application/json`
   * of a request that has one, and the whole payload is the message id in the path.
   */
  loadRemote: (messageId: string) =>
    api<{ remoteContent: string }>(`/messages/${encodeURIComponent(messageId)}/load-remote`, {
      method: "POST",
      body: {},
    }),
};

// ── Screener suggestions ─────────────────────────────────────────────────────────────────

/**
 * WHY THE SCREENER HAS A CLIENT HERE AT ALL, WHEN ITS ROWS COME FROM `/sync`.
 *
 * The waiting queue this app renders is DERIVED from the message mirror
 * (`@ohmail/client-engine`'s `screenerSegments`), not from `GET /screener`, and the delta
 * stream carries no suggestion — a suggestion is advice about mail, not a change to it, so
 * nothing puts one in `/sync`. That is the whole reason every waiting row used to show
 * "no suggestion": there was no path by which one could arrive.
 *
 * These two calls are that path, and they are deliberately the only ones. `GET /screener`
 * reads what has already been bought (it spends nothing) and `POST /screener/suggest` buys
 * more, for a sender set the client names explicitly. Neither replaces the mirror as the
 * source of the rows; both are joined onto it by sender address.
 */
export interface ScreenerWireItem {
  id: string;
  messageId: string;
  sender: { name: string | null; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  aiSuggestion: { decision: "yes" | "no" | "hold"; confidence: number; rationale: string } | null;
}

export interface ScreenerWirePage {
  items: ScreenerWireItem[];
  nextCursor: string | null;
  /**
   * The price of suggesting for THIS PAGE — not for what is on screen.
   *
   * Read for `maxPerRequest` alone, and that asymmetry is deliberate: the page is a server-side
   * window over the held set while the rows this app shows come from the mirror, so the two
   * sender lists are not the same list and `credits` here would price senders the user may not
   * be looking at. The number that IS quoted to the user comes from a dry run over the exact
   * set about to be posted.
   */
  suggestable: { senders: string[]; credits: number; maxPerRequest: number };
}

/**
 * Why one requested sender produced nothing. Mirrors `ScreenerSuggestSkip` on the server.
 *
 * `"withheld"` was a member and is not one now: under the AI-OPEN ruling every held sender is
 * suggestable, so no server can emit it. It is dropped rather than kept-and-never-matched because
 * a mirrored union that carries a value the server cannot send is how a dead UI branch survives a
 * policy change — and this one had copy attached to it that made a promise the product stopped
 * making.
 */
export type ScreenerSkipReason =
  | "not_held" | "out_of_credits" | "spend_unavailable" | "model_unavailable";

export interface ScreenerSuggestWire {
  dryRun: boolean;
  requested: number;
  /** Senders that would be bought. `quotedCredits` is what they COST — never re-derive it. */
  quoted: number;
  quotedCredits: number;
  /** Credits actually moved. Lower than the quote when a sender's answer was already bought. */
  charged: number;
  /** Set when the spend gate stopped the run PART-WAY; absent on a run that served everything. */
  stopped?: "out_of_credits" | "spend_unavailable";
  /**
   * WHAT IS LEFT ON THE ACCOUNT after this request — the server's ledger read, never ours.
   *
   * The one number a person wants after being told what a run cost, and the one this client is
   * categorically not allowed to compute. Subtracting `charged` from a remembered figure is a
   * shadow ledger: wrong after a renewal, a refund, an expiry or a second tab, and wrong in the
   * direction that tells somebody they have credits they do not. Invariant #10 — the side that
   * moves the money is the side that names it.
   *
   * OPTIONAL, and absent means NO ANSWER, never zero: an unmetered deployment has no ledger to
   * read and a courtesy read that failed is not a balance of nothing. `summarize` omits the
   * clause entirely rather than rendering a number it had to invent.
   */
  remainingCredits?: number;
  suggestions: Array<{
    sender: string;
    messageId: string;
    /** `hold` ⇒ the model declined to place this sender; no bulk control may act on it. */
    decision: "yes" | "no" | "hold";
    /**
     * Which pile the model actually named. OPTIONAL because an older server does not send it, and
     * a client that guessed a folder from `decision` alone would be inventing an answer — see
     * `toSuggestion`, which falls back to the two-way reading rather than to a default folder.
     */
    destination?: string;
    /** The model's own "this is junk". Optional for the same deploy-skew reason. */
    spam?: boolean;
    confidence: number;
    rationale: string;
  }>;
  skipped: Array<{ sender: string; reason: ScreenerSkipReason }>;
}

export const screener = {
  /** One page of the held queue, with whatever suggestions are already on record. `cost: read`. */
  list: (opts: { limit?: number; cursor?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return api<ScreenerWirePage>(`/screener${qs ? `?${qs}` : ""}`);
  },

  /**
   * Buy suggestions for an EXPLICIT sender set — or, with `dryRun`, price it and stop.
   *
   * `dryRun` reaches no model, moves no credits and stores nothing, which is what makes it
   * safe to call on every change of the batch size. The real run carries an `Idempotency-Key`
   * so a retry after a lost response replays the answer instead of buying twice; the caller
   * owns the key, because the thing being made idempotent is one press of one button.
   */
  suggest: (senders: string[], opts: { dryRun?: boolean; idempotencyKey?: string } = {}) =>
    api<ScreenerSuggestWire>("/screener/suggest", {
      method: "POST",
      body: opts.dryRun ? { senders, dryRun: true } : { senders },
      ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
    }),
};

// ── WebAuthn browser glue ────────────────────────────────────────────────────────────────

/**
 * The JSON shapes `@simplewebauthn/server` produces. Declared structurally rather than
 * imported: the webapp must not pull a server package into the browser bundle, and these
 * are the two objects the ceremony passes through untouched.
 */
export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  userVerification?: string;
}

/** Is a platform passkey even possible here? Drives whether TOTP is offered as the primary. */
export function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/**
 * `ArrayBuffer`, not `Uint8Array`. The DOM's `BufferSource` is `ArrayBufferView<ArrayBuffer>
 * | ArrayBuffer`, and a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>` — which admits
 * `SharedArrayBuffer` and therefore does not satisfy it under TS 5.7's stricter typed-array
 * generics. Returning the buffer itself is both assignable and what WebAuthn wants anyway.
 */
const b64urlToBytes = (v: string): ArrayBuffer => {
  const pad = v.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
};

const bytesToB64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Run the CREATE ceremony and return the credential in the JSON shape the server verifies.
 *
 * Hand-rolled rather than `@simplewebauthn/browser`, for one reason: adding a dependency to
 * the client bundle for ~40 lines of base64url conversion is a cost paid on every page load
 * by every user, including the ones who never sign in. The shapes are fixed by the WebAuthn
 * spec and by what `verifyRegistration` reads, and `enrollment-flow.test.ts` already drives
 * the same wire format from a software authenticator.
 */
export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown> {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rp: options.rp,
      user: {
        id: b64urlToBytes(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        id: b64urlToBytes(c.id), type: "public-key" as const,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
      attestation: options.attestation as AttestationConveyancePreference | undefined,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new ApiError(0, "passkey_cancelled", "The passkey was not created.");
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/** The GET ceremony — signing in with a passkey already enrolled. */
export async function assertPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<unknown> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      timeout: options.timeout,
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        id: b64urlToBytes(c.id), type: "public-key" as const,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      userVerification: options.userVerification as UserVerificationRequirement | undefined,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new ApiError(0, "passkey_cancelled", "The passkey prompt was dismissed.");
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      authenticatorData: bytesToB64url(response.authenticatorData),
      signature: bytesToB64url(response.signature),
      userHandle: response.userHandle ? bytesToB64url(response.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/**
 * Turn any thrown value into the sentence to show.
 *
 * An {@link ApiError} already carries the server's own message — the whole point of the
 * refusal taxonomy — so it is used verbatim. A `NotAllowedError` from the WebAuthn API means
 * the user dismissed the prompt (or it timed out), which is not a failure to apologise for.
 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return "The passkey prompt was dismissed. You can try again, or use an authenticator app instead.";
  }
  if (err instanceof DOMException && err.name === "InvalidStateError") {
    return "This device already has a passkey for this account. Sign in with it instead.";
  }
  return "Something went wrong. Please try again.";
}

/** The machine code, for the few places the UI branches rather than just displays. */
export function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : "unknown";
}
