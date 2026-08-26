import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  mailboxes, mailboxCredentials, mailboxFolders, folderState, messages,
  isMailboxDisabledReason, isMailboxSyncBlockReason,
  type LedgerTx, type MailboxErrorCode, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
/* The DEFAULT policy is registered rather than imported. `mailbox-allowance.ts` reads the
 * subscription and the credit balance, so a static import of it from here puts billing and the
 * ledger into the desktop engine bundle — this module is mounted by the local API. The full
 * `@trafficflow/services` barrel, which only a hosted process imports, registers the paid gate
 * on load; `@trafficflow/services/mail` does not, and a local host passes its own policy. */
import { defaultMailboxAllowance } from "./mailbox-allowance-registry.js";
import type { KeyProvider } from "./auth/crypto.js";
import type { MailboxDTO, MailboxFolderSummary } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * What {@link MailboxService.takeover} found, and therefore what it did.
 *
 * A CLOSED SET RATHER THAN A BOOLEAN, because the three refusals want three different sentences
 * and a caller that only knows "it did not work" has to invent one. `already_organizing` is a
 * no-op and not an error — a second click, or a mailbox the worker picked back up in between.
 */
/**
 * What {@link MailboxService.list} is being asked for beyond the mailboxes themselves.
 *
 * One flag, defaulting to OFF, and the default is the contract: the polled callers of
 * `GET /mailboxes` pass nothing and must pay nothing. See `MailboxDTO.messageCount`.
 */
export interface ListMailboxesOptions {
  /** Compute {@link MailboxDTO.messageCount} — one grouped aggregate for the whole account. */
  counts?: boolean;
}

export type MailboxTakeoverResult =
  /** The stand-down was ended and one takeover is authorized. The worker decides on its next pass. */
  | { outcome: "authorized"; previousReason: string }
  /** Not stood down — this side already organizes it, or is already trying to. Nothing written. */
  | { outcome: "already_organizing" }
  /** Disconnected by the user, which is not a stand-down. Reconnect it instead. Nothing written. */
  | { outcome: "disconnected" };

/**
 * The stored form of a mailbox address — TRIMMED, and nothing else.
 *
 * THE BYPASS THIS CLOSES. Mail 0021's partial unique index canonicalizes with `lower()`, and
 * the service wrote `body.address` verbatim. So `"victim@example.com"` and
 * `" victim@example.com "` are different keys to the index and identical to every IMAP server
 * on earth: submit the second after the first and you get two rows, two allowance slots, and
 * two worker runtimes against one physical mailbox — the exact production failure 0021 was
 * written to stop, still reachable through the public API. An independent review caught it.
 *
 * TRIM ONLY, deliberately. Case is NOT folded here even though the index folds it: the local
 * part of an address is case-sensitive per RFC 5321, providers disagree about whether they
 * honour that, and this column is what the connect forms offer as the default IMAP username.
 * Rewriting somebody's stored identity to satisfy an index is how a login breaks against a
 * case-sensitive server. Trimming is the part the product can define without guessing —
 * leading and trailing whitespace is never meaningful in an address and is almost always a
 * copy-paste artefact.
 *
 * The residual gap is named rather than papered over: two genuinely distinct case variants on
 * one account still collide at the index and answer 409. That is a narrower wrong than
 * silently running two organizers, and the real fix for physical-mailbox exclusivity is the
 * IMAP-resident lease, not a uniqueness constraint on a text column.
 *
 * ── WHAT `lower(address)` IS NOT, STATED SO NOBODY MISTAKES IT FOR MORE ──
 *
 * The index key is `lower(address)`. That is a *deduplication heuristic for one account's own
 * connect form*, and it is neither an address canonicalizer nor a stable function:
 *
 *  · **It is collation-dependent.** `lower()` folds according to the collation of its argument
 *    — the column's, which defaults to the database's `LC_CTYPE`. Two deployments with
 *    different locales can fold the same non-ASCII address differently (the Turkish dotted/
 *    dotless I is the standard example), so the set of addresses the index treats as equal is
 *    a property of the SERVER, not of the schema. It also means the usual functional-index
 *    caveat applies: restoring this database under a different collation, or a glibc/ICU
 *    upgrade that changes case folding, requires `REINDEX` — an index built under one folding
 *    can silently stop enforcing uniqueness under another. Every address ohmail has seen is
 *    ASCII, where the folding is fixed, which is why this is a note and not a defect.
 *  · **It is not RFC canonicalization, in either direction.** RFC 5321 makes the LOCAL part
 *    case-SENSITIVE and only the domain case-insensitive, so folding the whole string is
 *    over-eager on the left of the `@` — two genuinely distinct mailboxes on a case-sensitive
 *    server collide. And it is under-eager everywhere else: no IDNA/punycode folding of the
 *    domain, no Unicode NFC normalization, no provider-specific equivalence (`a.b+tag@gmail`
 *    and `ab@gmail` are one physical mailbox and two keys here).
 *
 * Both directions are acceptable for what 0021 claims and only for that: it is narrow
 * duplicate-request defence for repeated submissions of the same connect form. Treating it as
 * "one organizer per physical mailbox" is the mistake — that invariant is the IMAP-resident
 * lease's, and **as of mail 0027 it is enforced**: the hosted sync worker runs `runLeaseGate`
 * at attach and again at the top of every sync cycle, and `apps/sidecar/src/engine.ts` does the
 * same before its first move, so a mailbox two organizers both believe they hold is stood down by
 * whichever loses the claim in `ohmail/_meta` (`status='disabled'`, `disabled_reason` =
 * `organized_elsewhere:*`).
 *
 * The distinction this note started as still holds and is the reason it stays: the index and the
 * lease guard DIFFERENT things, and neither substitutes for the other. `lower(address)` is one
 * account's own connect form, in one database. The lease is the physical mailbox, across two
 * databases that can never see each other — which is the only place the invariant can live,
 * because the mailbox is the master.
 */
export const canonicalAddress = (raw: string): string => raw.trim();

type MailboxRow = typeof mailboxes.$inferSelect;

/** A per-transport secret + its non-secret connection params (host/port/user/secure). */
export interface TransportInput {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}

export interface CreateMailboxBody {
  provider: string;
  address: string;
  displayName?: string;
  authKind?: "password" | "oauth";
  /**
   * `port`/`secure` are OPTIONAL, and their absence is a request: the probe walks the standard
   * ladder (993 implicit TLS, then 143 STARTTLS) and what gets STORED is the combination it
   * proved, not a guess. A caller that names a port is respected — the probe then only
   * negotiates the TLS mode of that port. `allowInsecure` is the consent flag for a server the
   * probe has proved offers no TLS at all; it is honored only after the probe re-proves that in
   * the same call, never on the client's word. See {@link MailboxProbeVerdict}.
   */
  imap: { host: string; port?: number; secure?: boolean; user: string; pass: string; allowInsecure?: boolean };
  /** `port`/`secure` optional for the same reason as the IMAP block: absence asks the probe's ladder. */
  smtp?: { host: string; port?: number; secure?: boolean; user?: string; pass?: string };
}

export interface UpdateMailboxBody {
  displayName?: string | null;
  /**
   * NO `'error'`. That state belongs to the worker's failure state machine, which writes it
   * together with its reason; see {@link MailboxService.update}. The runtime refusal is still
   * required — this body is `readBody<UpdateMailboxBody>` over untyped JSON — but the type is
   * where a NEW caller finds out.
   */
  status?: "connected" | "disabled";
  /** `allowInsecure` as on {@link CreateMailboxBody.imap} — a consent claim, re-proved server-side. */
  imap?: TransportInput & { pass: string; allowInsecure?: boolean };
  smtp?: TransportInput & { pass: string };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   TRYING THE CREDENTIALS BEFORE STORING THEM
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What the probe is asked to try. It carries the PLAINTEXT password by necessity — trying it is
 * the point — so the implementation may not log this object, any part of it, or a thrown error's
 * text. `packages/api/src/imap-probe.ts` is the one implementation and states how it holds that.
 */
export interface MailboxProbeInput {
  accountId: string;
  /** The CANONICAL address (post-{@link canonicalAddress}) — the probe's admission key, not a login. */
  address: string;
  /**
   * Exactly the connection this write is about to store. Not a normalised variant of it.
   *
   * A UNION, because there are two kinds of credential to try. `pass` is a typed password;
   * `accessToken` is an OAuth2 token the CALLER minted seconds ago, before anything is stored — the
   * oauth ceremony's equivalent of "try it before you keep it". Exactly one is present. See
   * `packages/api/src/imap-probe.ts`, the one implementation, for why the oauth arm carries a token
   * rather than the refresh token it was derived from.
   */
  imap:
    | { host: string; port?: number; secure?: boolean; user: string; pass: string; accessToken?: undefined; allowInsecure?: boolean }
    | { host: string; port?: number; secure?: boolean; user: string; accessToken: string; pass?: undefined; allowInsecure?: undefined };
}

/* ── WHAT A PROBE PROVES, IN DETAIL ─────────────────────────────────────────────────────── */

/**
 * Why a certificate (or the absence of one) stopped the dial — the taxonomy member `tls`
 * split into the sentences a user can act on. `hostname_mismatch` is the only kind that may
 * carry `suggestedHost`, and by construction it is also the only kind whose CHAIN validated:
 * Node checks the chain before the identity, so an untrusted or expired certificate never
 * reaches the hostname comparison. That ordering is what makes the suggestion safe to show —
 * it always names a host the presented, publicly-trusted certificate really covers.
 */
export type ProbeTlsFailureKind =
  | "hostname_mismatch"   // valid, trusted chain; wrong name — the vanity-CNAME shape
  | "expired"
  | "not_yet_valid"
  | "self_signed"
  | "untrusted"           // chain does not reach a public root
  | "tls_unavailable"     // no TLS on any rung and no STARTTLS — the ONLY kind the consent flow may follow
  | "generic";

export interface ProbeTlsDetail {
  kind: ProbeTlsFailureKind;
  /** The name the presented certificate is actually for (subject CN, or its first SAN). */
  certHost?: string;
  /** The host we validated against — what the user typed. */
  expectedHost?: string;
  /**
   * A host this same certificate DOES cover, worth suggesting: the DNS CNAME target of the
   * entered host when the certificate covers it, else the certificate's own subject. NEVER
   * auto-connected — the user confirms it, and the re-probe verifies strictly against it.
   */
  suggestedHost?: string;
}

/**
 * The connection the probe PROVED, which is what must be stored — a probe that succeeds on
 * `993/TLS` while the form said `143` would otherwise strand the worker on a config nobody
 * tried. One shape for both transports. `insecure` is present only when the user consented to
 * plaintext AND the same call re-proved the server offers no TLS (IMAP only); it becomes
 * `meta.insecureConsent` on the credential row.
 */
export interface ProvenEndpoint {
  host: string; port: number; secure: boolean; insecure?: true;
  /**
   * SMTP ONLY — the server's advertised `SIZE` ceiling in bytes, from the EHLO of the dial that
   * proved this endpoint, or `null`/absent when it declared none (see `SmtpLoginProof`).
   *
   * It rides on the PROVEN endpoint rather than on the verdict because it is a fact about the
   * combination that answered — a provider can advertise a different ceiling on submission than
   * on its legacy port — and because the two travel to the same writer. The IMAP probe never
   * sets it: there is no such announcement in an IMAP capability list.
   */
  maxMessageBytes?: number | null;
}

/**
 * THE THREE ANSWERS, AND WHY "STORE UNVERIFIED" IS ONE OF THEM.
 *
 * A two-value answer would force the decision this seam exists to avoid. "We reached the server
 * and it refused you" and "we could not reach the server" are both failures and must not be
 * stored — but a server that answers `NO [UNAVAILABLE]` or `NO [LIMIT]`, or sends `BYE` and hangs
 * up, has been REACHED: it parsed our LOGIN and declined to serve it right now. That is positive
 * evidence the host, the port and the TLS mode are right, and no evidence at all about the
 * password.
 *
 * Refusing that case would be its own defect, and a specific one for this product: iCloud caps
 * concurrent connections across ALL of an account's clients, so a user whose phone and Mac are
 * holding connections could not add their mailbox at all, from a form that offers no way to
 * clear the condition. Storing it costs the pre-probe behaviour for that one case only, and
 * `MailboxSection.statusKey` already renders a row that has never completed a cycle as
 * "connecting" rather than "connected".
 *
 * `code` is a {@link MailboxErrorCode} — the SAME closed taxonomy the worker's
 * `classifyMailboxError` emits and the same one `en.json`'s `err_*` copy is keyed on.
 * A parallel vocabulary here would mean two sets of sentences for one set of failures.
 */
export type MailboxProbeVerdict =
  | { verdict: "ok"; proven?: ProvenEndpoint }
  | { verdict: "store_unverified"; code: MailboxErrorCode; proven?: ProvenEndpoint }
  | { verdict: "refuse"; code: MailboxErrorCode; tls?: ProbeTlsDetail };

/**
 * The SMTP sibling of {@link MailboxProbeInput} — same discipline (plaintext password, so the
 * implementation may not log it or any thrown error's text), different transport. There is no
 * OAuth arm: an oauth mailbox stores no SMTP credential row at all.
 */
export interface SmtpProbeInput {
  accountId: string;
  address: string;
  smtp: { host: string; port?: number; secure?: boolean; user: string; pass: string };
}

/**
 * Try an SMTP login the way {@link MailboxProbe} tries an IMAP one: the standard ladder when no
 * port is named (465 implicit TLS, then 587 STARTTLS), TLS-mode negotiation on a named port, the
 * full certificate taxonomy — and NO consent arm: plaintext SMTP authentication is not offered
 * at all in this flow. Implemented in `packages/api` beside the IMAP probe.
 */
export type SmtpProbe = (input: SmtpProbeInput) => Promise<MailboxProbeVerdict>;

/**
 * Try an IMAP login. Implemented in `packages/api` — the layer that owns IMAP knowledge and the
 * connection budget — and injected per call, the same seam shape `AttachmentsService` takes its
 * `openAdapter` through.
 *
 * It MAY throw a {@link ServiceError} for OUR OWN faults (no connection slot, a broken counter).
 * Those are not verdicts about the mailbox and must not be rendered as one.
 */
export type MailboxProbe = (input: MailboxProbeInput) => Promise<MailboxProbeVerdict>;

/**
 * REQUIRED, not optional, and that is the whole enforcement.
 *
 * An optional probe is a probe that any caller can forget, and "credentials were stored without
 * being tried" is the defect. Making it part of the call signature means a new call site has to
 * decide out loud.
 */
export interface CreateMailboxOptions {
  probe: MailboxProbe;
  /**
   * OPTIONAL where `probe` is required, and the asymmetry is earned: an unprobed IMAP credential
   * strands a mailbox invisibly (the worker fails minutes later, on another screen), while an
   * unprobed SMTP credential fails VISIBLY at the first send, with the sender watching. The
   * hosted routes inject it; a host that cannot dial out may omit it and keep create working.
   */
  smtpProbe?: SmtpProbe;
}

/**
 * WHAT A COMPLETED OAuth CONSENT HANDS THE SERVICE. See {@link MailboxService.connectOAuth}.
 *
 * There is no `imap.pass`, no `authKind` and no `mailboxId` here, and each absence is load-bearing:
 * the credential is a refresh token, the auth kind is `'oauth'` by construction (this method has no
 * other mode), and WHICH mailbox row is written is resolved from the address rather than supplied.
 */
export interface ConnectOAuthMailboxInput {
  /** The mailbox PROVIDER id the UI picked (`"outlook"`), not the token provider. */
  provider: string;
  /** From the `id_token` claim. The user never typed it; this method canonicalizes it. */
  address: string;
  displayName?: string | null;
  oauth: {
    /** The TOKEN provider — `"microsoft"`. `buildImapAuth` refuses any other value. */
    provider: string;
    /** The Azure AD tenant SEGMENT, validated before it ever reaches a URL. */
    tenant: string;
    /** Stored as `secret_enc`. THE credential — an oauth mailbox has no other. */
    refreshToken: string;
    /**
     * The access token minted by the SAME exchange, for the probe and for nothing else. It is not
     * stored: it expires in an hour and `MicrosoftTokenProvider` mints its own.
     */
    accessToken: string;
    imap: { host: string; port: number; secure?: boolean };
    /** One refresh token covers both transports, so these coordinates live in `meta.smtp`. */
    smtp?: { host: string; port: number; secure?: boolean };
  };
}

/** Required for the same reason {@link CreateMailboxOptions}'s is: a credential is tried before it is stored. */
export interface ConnectOAuthOptions {
  probe: MailboxProbe;
}

/**
 * `created` distinguishes a FIRST connect from a RECONNECT, and the caller renders the difference:
 * "Outlook connected" and "Outlook reconnected" are different things to somebody who was trying to
 * fix a mailbox that had stopped. It is also the only signal that allowance was consumed.
 */
export interface ConnectOAuthResult {
  created: boolean;
  mailbox: MailboxDTO;
}

/**
 * The same, for the OTHER door into `mailbox_credentials`.
 *
 * `create` was made to require a probe and `update` was not, which left `PATCH /mailboxes/:id`
 * re-encrypting whatever it was sent with zero connection attempts — the identical defect, one
 * screen later, against a mailbox that was already working. It is not a backwater path: the
 * sidecar mounts `createApp(apiRoutes)`, and `apps/sidecar/src/engine.ts` names this PATCH as the
 * desktop's credential-recovery route for a sealed login the install's key can no longer open.
 *
 * ── REQUIRED IN THE SIGNATURE, ENFORCED AT RUN TIME, AND THE SECOND HALF IS THE REAL GUARD ──
 *
 * `create`'s docblock says a required parameter means "a new call site has to decide out loud".
 * That is true only where the signature is COMPILED, and here it largely is not: `packages/services`
 * compiles `src` only, so its ~17 `update` call sites are never typechecked — the same shape that
 * put `tsconfig.contract.json` in `packages/api`. A parameter that is required in a type nobody
 * compiles is a guard that does not guard.
 *
 * So the type says required AND {@link probeMissing} throws when a credential write arrives
 * without one. The throw is the half that executes, and it is the half a mutation test can watch
 * go red. Non-credential patches — a rename, a status flip — never reach it, which is why the
 * fourteen existing call sites that carry no secret keep working unchanged.
 */
export interface UpdateMailboxOptions {
  probe: MailboxProbe;
  /** As on {@link CreateMailboxOptions.smtpProbe}: optional, and injected by the hosted routes. */
  smtpProbe?: SmtpProbe;
}

/**
 * The refusal, per taxonomy member. FOUR DISTINCT SENTENCES, because a mistyped host and a wrong
 * password producing the same words is the failure the probe exists to end — it is the same
 * conflation the worker had to unpick, one screen earlier.
 *
 * Each names an OUTCOME the user can act on rather than a mechanism we would have to be right
 * about: "we could not reach that server" holds for a name that does not resolve, a port with
 * nothing behind it and a host that is simply down, and none of those is "the password is wrong".
 *
 * `status` splits on WHOSE input is at fault. The four the user typed are 400; a throw we cannot
 * name is 502, because "we could not tell" is a statement about us.
 */
const PROBE_REFUSAL: Record<MailboxErrorCode, { status: number; message: string; retryable?: boolean }> = {
  auth: {
    status: 400,
    message: "The mail server refused this password. If your provider requires an " +
      "app-specific password, generate one there and use it here instead of your account password.",
    retryable: false,
  },
  connect: {
    status: 400,
    message: "We could not reach that mail server. Check the IMAP host and port and try again.",
    retryable: true,
  },
  tls: {
    status: 400,
    message: "That mail server's certificate was refused, so we stopped before sending the password. " +
      "Check the IMAP host, and whether the port expects TLS.",
    retryable: false,
  },
  timeout: {
    // 502, unlike the three above: a server that accepted the connection and then went quiet is
    // an upstream that failed, not a field the user can obviously correct. Retryable, and it is
    // stated rather than inherited — the client's default heuristic would get this one right by
    // accident and the next status change would silently flip it.
    status: 502,
    message: "That mail server did not answer in time. Check the IMAP host and port, and try again.",
    retryable: true,
  },
  // Neither can arise from a dial — no SQLSTATE reaches an IMAP client, and there is no sync
  // phase here — but the taxonomy is closed and a `Record` that omits a member stops compiling
  // when one is added, which is the point of writing them out.
  storage: { status: 502, message: "We could not finish checking that mailbox. Please try again." },
  sync: { status: 502, message: "We could not finish checking that mailbox. Please try again." },
  unknown: {
    status: 502,
    message: "We could not finish checking that mailbox, and we could not tell why. Please try again.",
  },
};

/**
 * The `tls` refusal, split by WHY the certificate (or its absence) stopped the dial. Every
 * sentence keeps the guarantee the generic one made — the password was never sent — and adds
 * the one fact the user (or their server's admin) can act on.
 *
 * ── THE SERVER MESSAGE NAMES NO HOST FROM THE DIALED CERTIFICATE ──────────────────────────────
 *
 * The `hostname_mismatch` sentence USED to read "certificate is for {certHost}, not {expectedHost}
 * … use {suggestedHost}", echoing the CN/SAN of whatever answered at the dialed `host:port` and a
 * CNAME-derived suggestion. Behind a verified session that is a caller-driven disclosure of an
 * internal hostname — point the probe at an internal server and read its certificate identity back
 * out of the refusal. So this message names NEITHER `certHost` NOR `suggestedHost`; it states only
 * that the certificate did not match and how to act on it. The structured `details.tls` still
 * carries those fields for the client's own vanity-CNAME suggestion UX, and on the hosted
 * deployment the probe's SSRF host guard (`imap-probe.ts#makeProbeHostGuard`) means the dialed host
 * is public in the first place — but the server's own sentence leaks nothing regardless.
 */
const tlsRefusalMessage = (tls: ProbeTlsDetail, transport: ProbeTransport): string => {
  const server = transport === "smtp" ? "That outgoing (SMTP) mail server" : "That mail server";
  const proto = transport === "smtp" ? "SMTP" : "IMAP";
  const stopped = "so we stopped before sending the password";
  switch (tls.kind) {
    case "hostname_mismatch": {
      return `${server}'s certificate does not match the host you entered, ${stopped}. ` +
        `Check the ${proto} host with your provider.`;
    }
    case "expired":
      return `${server}'s certificate has expired, ${stopped}. Ask whoever runs the server to renew it.`;
    case "not_yet_valid":
      return `${server}'s certificate is not valid yet, ${stopped}. Check with whoever runs the server.`;
    case "self_signed":
      return `${server}'s certificate is self-signed, which we cannot verify, ${stopped}. ` +
        "Ask whoever runs the server to install a certificate from a public authority.";
    case "untrusted":
      return `${server}'s certificate is not issued by a trusted authority, ${stopped}. ` +
        "Ask whoever runs the server to install a certificate from a public authority.";
    case "tls_unavailable":
      return `${server} offers no encryption — no TLS and no STARTTLS — ${stopped}.`;
    case "generic":
      return transport === "smtp"
        ? `${server}'s certificate was refused, ${stopped}. Check the SMTP host, and whether the port expects TLS.`
        : PROBE_REFUSAL.tls.message;
  }
};

/**
 * The refusal a failed probe becomes. `details.reason` carries the taxonomy member so a client
 * can render its own copy; the message is the server's own sentence and is what `JoinScreen`
 * (which reads `messageOf(err)` verbatim) shows. A `tls` refusal may carry {@link ProbeTlsDetail},
 * which sharpens both the sentence and the details a client can build its own copy from.
 */
/** Which transport a probe refusal is about — the webapp uses it to blame the right field. */
export type ProbeTransport = "imap" | "smtp";

const probeRefused = (code: MailboxErrorCode, tls?: ProbeTlsDetail, transport: ProbeTransport = "imap"): ServiceError => {
  const r = PROBE_REFUSAL[code];
  let message = code === "tls" && tls ? tlsRefusalMessage(tls, transport) : r.message;
  // The base sentences were written for the connect (IMAP) flow; an SMTP refusal must not tell
  // the user to check an IMAP field that is fine.
  if (transport === "smtp" && !(code === "tls" && tls)) {
    message = message
      .replace(/That mail server|The mail server/, "That outgoing (SMTP) mail server")
      .replace(/\bIMAP\b/g, "SMTP");
  }
  return new ServiceError(
    "mailbox_probe_failed", r.status, message,
    { reason: code, transport, ...(tls ? { tls } : {}) },
    r.retryable,
  );
};

/**
 * A credential write reached a write path with no probe to try it with.
 *
 * 500, not 400: nothing the caller typed is wrong: the SERVER is misconfigured, because some
 * call site is about to store a password it cannot verify. Refusing is the only safe answer —
 * storing anyway is precisely the defect, and storing "just this once" is how it comes back.
 *
 * It carries no `reason` from the taxonomy, deliberately. The taxonomy describes what a mail
 * server said, and no mail server was ever contacted here.
 */
const probeMissing = (): ServiceError => new ServiceError(
  "internal", 500,
  "this mailbox credential could not be verified before storing, so it was not stored",
);

/**
 * THE ALLOWANCE GATE, AS A POLICY — because "how many mailboxes may this account have" is a
 * question about a PRICE, and one of the two tiers has no prices in it.
 *
 * The default reads the subscription table under a `FOR UPDATE` lock. That is exactly right for
 * the hosted service and it is unrunnable on a desktop install, which migrates the mail journal
 * alone and has no billing tables at all — nor should it: they belong to a service its owner has
 * no account with. Before this seam the local engine 500ed on every mailbox write with a
 * `relation … does not exist` error naming that missing table, and the only reason it had ever
 * worked was that the engine used to migrate the Cloud journal too. The green was produced by
 * the defect.
 *
 * ── WHY A POLICY AND NOT A FLAG ───────────────────────────────────────────────────────────
 *
 * `if (local) skip` puts the decision inside the money path, where every future reader has to
 * re-derive which branch a given deployment takes. A policy makes the tier a thing the HOST
 * states once, at construction, and makes the paid gate the value you get by saying nothing.
 */
export type MailboxAllowancePolicy = (
  tx: LedgerTx,
  accountId: string,
  now: Date,
  opts?: { excludeMailboxId?: string },
) => Promise<unknown>;

export interface MailboxServiceDeps {
  /** Envelope-encryption provider. REQUIRED for the write methods; the read
   *  methods (list/get/requestResync) never touch it — inject, don't reach global. */
  keyProvider?: KeyProvider;
  /**
   * Who may add a mailbox. **Absent means the PAID GATE, and that direction is the whole point.**
   *
   * A deployment that forgets to inject gets charged-plan behaviour — it refuses past the plan's
   * count and refuses without a subscription. The failure mode of the opposite default is an
   * account on the free tier of a paid product, silently, with no error anywhere and revenue
   * quietly not collected; the failure mode of this one is a desktop build that refuses to add a
   * mailbox, which is loud, immediate, and caught by the engine's own end-to-end tests.
   *
   * There is deliberately **no permissive policy exported from this package.** The only one that
   * exists is `UNMETERED_MAILBOX_ALLOWANCE` in `apps/sidecar`, which the hosted API does not and
   * cannot import — a bypass the Cloud host has no way to name is a bypass it cannot take by
   * accident. A test in this package holds that as an assertion.
   */
  allowance?: MailboxAllowancePolicy;
  /**
   * Runs INSIDE the create transaction, after the allowance gate and the insert — the hosted
   * composition's hook for per-mailbox onboarding state (today: the one-time screening-only
   * setup grant, `@trafficflow/db/cloud#grantSetupCredits`). Absent on the local tiers, which
   * meter nothing and grant nothing — the same asymmetry as `allowance`, in the same direction:
   * forgetting it costs a hosted customer a bonus, never money.
   */
  onCreated?: (tx: LedgerTx, accountId: string, mailboxId: string, now: Date) => Promise<unknown>;
}

/**
 * The partial unique index from mail migration 0021, as a refusal the UI can show.
 *
 * `POST /mailboxes` accepted the same address twice in a live deployment and left two rows — two
 * allowance slots, and two worker runtimes attached to one physical mailbox. The index makes
 * that impossible; this turns the driver's 23505 into the sentence the second attempt deserves
 * instead of a 500.
 *
 * CAUGHT AROUND THE TRANSACTION, NEVER INSIDE IT. By the time Postgres raises 23505 the
 * transaction is already aborted, so a `catch` within the callback could not commit anything
 * and would only mask the error. Same shape as `auth-service.ts`'s `isUniqueViolation`.
 */
const ACTIVE_ADDRESS_UQ = "mailboxes_active_address_uq";

function isActiveAddressConflict(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  if (err.code !== "23505") return false;
  // Postgres reports the INDEX name for a unique-index violation.
  const name = typeof err.constraint === "string" ? err.constraint
    : typeof err.constraint_name === "string" ? err.constraint_name : "";
  return name === ACTIVE_ADDRESS_UQ;
}

const addressTaken = (): ServiceError => new ServiceError(
  "mailbox_exists", 409,
  "This mailbox is already connected to your account.",
);

/**
 * A DISABLED MAILBOX NEVER HOLDS A CREDENTIAL — and this is the refusal that makes that true
 * rather than merely intended.
 *
 * `delete` establishes the invariant (disable the row, delete its credentials, so the worker
 * stops), mail 0021's prelude relies on it in as many words, and until an independent review
 * looked nothing enforced it: `update` would happily upsert a credential onto a tombstone.
 * The concrete sequence is a race with a dedup pass or a delete —
 *
 *   Thread 1  PATCH /mailboxes/:id { imap: { pass } }   reads the row: 'connected'
 *   Thread 2  the row is disabled and its credentials deleted (a `delete`, or the operator's
 *             dedup resolver, or 0021's prelude mid-migration)
 *   Thread 1  commits its credential upsert
 *
 * — and it ends with a disabled mailbox that owns a live IMAP secret. The lock in `update`
 * removes the window (Thread 1 now blocks on the row and re-reads 'disabled'); this is what it
 * does when it gets there. Re-enabling AND rotating in one PATCH stays legal, because the status
 * is applied before this is evaluated.
 */
const mailboxDisabled = (): ServiceError => new ServiceError(
  "mailbox_disabled", 409,
  "This mailbox is disconnected. Reconnect it before setting new credentials.",
);

/** A port a server could actually listen on. */
const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

/** Drop `undefined` values so an upsert never overwrites stored meta with them. */
function metaOf(o: TransportInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.host !== undefined) out.host = o.host;
  if (o.port !== undefined) out.port = o.port;
  if (o.secure !== undefined) out.secure = o.secure;
  if (o.user !== undefined) out.user = o.user;
  return out;
}

/**
 * Decrypt a stored `mailbox_credentials` secret back to its plaintext (the worker's
 * later use). Deliberately NOT wired to any DTO/route: credentials NEVER
 * leave the server. Exported so the worker can inject the same KeyProvider.
 */
export async function decryptCredential(
  keyProvider: KeyProvider,
  row: { secretEnc: string; keyVersion: number },
): Promise<string> {
  return keyProvider.decrypt(row.secretEnc, row.keyVersion);
}

/**
 * MailboxService. Reads (list/get) + resync stay credential-free;
 * the write methods (create/update/delete) envelope-encrypt per-transport
 * secrets into `mailbox_credentials` and NEVER surface them in any DTO. The
 * write path needs a `KeyProvider` (construct via `makeMailboxService`). Every
 * query is account-scoped: a cross-account id is a 404.
 */
export class MailboxService {
  constructor(private readonly deps: MailboxServiceDeps = {}) {}

  /**
   * The gate this instance runs. `??` and not a constructor default, so the paid gate is what an
   * explicit `undefined` resolves to as well — `makeMailboxService({ allowance: cfg.allowance })`
   * on a host whose config forgot the field must not become the free tier.
   */
  private get allowance(): MailboxAllowancePolicy {
    return this.deps.allowance ?? defaultMailboxAllowance();
  }

  /**
   * List the account's mailboxes.
   *
   * ── THE COUNTS VARIANT IS OPT-IN, AND THE DEFAULT PATH RUNS NO AGGREGATE OVER `messages` ──
   *
   * This route is POLLED. `MailStateProvider` reads it every 30 s in every open Cloud tab for
   * the shell's status strip, and Settings → Mailboxes reads it every 10 s while it is open.
   * `MailboxDTO.messageCount` is an aggregate over the account's whole message history, so it
   * is computed only when a caller asks for it — `GET /mailboxes?counts=1` — and the field is
   * absent from every other response rather than being sent as `0`.
   *
   * ONE STATEMENT for the whole account, taken BEFORE the per-mailbox loop. Reading the count
   * inside `toDTO` would be one aggregate per mailbox, which is the shape this method already
   * pays twice over for folders and pending moves and must not pay a third time over a table
   * whose size is the product's whole point.
   */
  async list(ctx: ServiceContext, opts: ListMailboxesOptions = {}): Promise<MailboxDTO[]> {
    const rows = await ctx.db.select().from(mailboxes)
      .where(eq(mailboxes.accountId, ctx.accountId)).orderBy(asc(mailboxes.id));
    const counts = opts.counts ? await this.messageCounts(ctx) : null;
    const out: MailboxDTO[] = [];
    for (const m of rows) {
      /* `?? 0` and not `map.get(id)` bare: a mailbox holding no mail produces NO GROUP ROW, so
         the map has no entry for it — and forwarding that `undefined` would emit an ABSENT
         field, which on this wire means "nobody asked" about a mailbox somebody did ask
         about. An empty mailbox has an answer and it is zero. */
      out.push(await this.toDTO(ctx, m, counts ? counts.get(m.id) ?? 0 : undefined));
    }
    return out;
  }

  /**
   * How many messages each of this account's mailboxes holds, in one grouped statement.
   *
   * ── INVARIANT #9 LIVES IN THE `WHERE`, NOT IN THE CALLER ────────────────────────────────
   *
   * `eq(messages.accountId, ctx.accountId)` is in the SAME statement as the `GROUP BY`, and it
   * is not redundant with `list` looking the result up by the ids it owns. `messages.account_id`
   * has no foreign key tying it to `mailboxes.account_id` — nothing in the schema makes the two
   * agree — so a row whose mailbox is ours and whose account is somebody else's is a state the
   * database permits. A mailbox moved between accounts by the operator dedup resolver leaves
   * exactly that behind, because it rewrites `mailboxes.account_id` and does not restamp the
   * mail. Grouping by `mailbox_id` alone would then count another account's messages into this
   * account's number, and every ordinary row would still be correct, so nothing else would show
   * it. A real-Postgres test seeds exactly that row and goes red when the predicate is removed.
   *
   * It is also what makes the query cheap: `messages_account_mailbox_unread_idx` is
   * `(account_id, mailbox_id, unread)`, so the scope predicate is served by the index's leading
   * column and the grouping key is the next one.
   *
   * `::int` because `count(*)` is `bigint` and postgres-js hands a bigint back as a STRING. A
   * DTO field that is `7` on one driver and `"7"` on another is a client bug waiting for a
   * mailbox big enough to notice.
   */
  private async messageCounts(ctx: ServiceContext): Promise<Map<string, number>> {
    const rows = await ctx.db
      .select({ mailboxId: messages.mailboxId, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.accountId, ctx.accountId))
      .groupBy(messages.mailboxId);
    return new Map(rows.map((r) => [r.mailboxId, r.n]));
  }

  async get(ctx: ServiceContext, id: string): Promise<MailboxDTO> {
    return this.toDTO(ctx, await this.ownedRow(ctx, id));
  }

  /**
   * Connect a mailbox: insert the `mailboxes` row, then envelope-encrypt the
   * IMAP (and, if given, SMTP) password into a `mailbox_credentials` row per
   * transport — `meta` carries only the NON-secret conn params. Returns a
   * credential-free DTO (201).
   *
   * **The plan gate and the insert are ONE transaction, in this order.**
   * `assertMayAddMailbox` takes `SELECT … FOR UPDATE` on the account's subscription row
   * before it counts, so two concurrent creates at limit−1 admit exactly one — the loser
   * blocks on that lock and then counts a world containing the winner's row. A check made
   * outside the transaction, or after the INSERT, would let both through; see
   * `mailbox-allowance.ts` for why the count alone cannot be the gate.
   *
   * The transaction also fixes something that was wrong before it: the mailbox row and its
   * credentials were separate autocommits, so a crash between them left a connected mailbox
   * with no way to log in. They now commit together or not at all.
   *
   * ── THE CREDENTIALS ARE TRIED FIRST, AND THE ORDER IS DELIBERATE ─────────────────────────
   *
   * This method used to encrypt whatever it was handed and answer 201. Before the fix: host
   * `nope.invalid`, password `wrong` → **201, `status: "connected"`, one `mailbox_credentials`
   * row, zero connection attempts.** `mailboxes.status` DEFAULTS to `'connected'`, so the row
   * asserted a working mailbox from the moment it existed, and the first word anybody got about
   * the typo was a worker sync error minutes later on another screen — the same class of failure
   * the worker had just finished making legible.
   *
   * BEFORE THE TRANSACTION, NEVER INSIDE IT. The probe is a network round trip to somebody
   * else's mail server; the API's runtime handle is `makePooledDb` at `max: 1`, so holding a
   * transaction across it would pin the instance's only connection for the length of a foreign
   * dial. That is the deadlock this repository already fixed once ("the console deadlocked
   * itself — parallel reads on a max:1 pool").
   *
   * THE COST, STATED: an account at its plan limit, or one submitting an address it already has,
   * pays one dial before the gate refuses it. Moving the probe after the gate is not free — the
   * gate is `assertMayAddMailbox`, which requires a transaction (`NotInTransactionError`), so a
   * pre-flight check would mean opening a transaction, taking `SELECT … FOR UPDATE` on the
   * subscription row, closing it, dialling, and then taking the same lock again. Two lock
   * acquisitions to save a dial the connection budget already bounds is the worse trade.
   *
   * ONLY WHEN A SECRET IS ABOUT TO BE STORED. An `oauth` create carries no password and has
   * nothing to try; the probe is skipped rather than fed an empty string it would then report
   * as a rejected password.
   *
   * WHAT IS PROBED IS WHAT IS STORED — `body.imap` verbatim, not a repaired copy of it. A probe
   * that silently substituted the address for a missing `user` would prove a login the worker
   * will never make.
   *
   * THE SMTP BLOCK IS PROBED TOO when the host injects `opts.smtpProbe` (the hosted routes do).
   * The old exemption — a different transport, sending is not the connect flow, a second dial
   * doubles latency — was retired after a real user's SMTP host failed certificate validation
   * at their first send, one screen and several minutes after a create that had promised them a
   * working mailbox. Where no `smtpProbe` is injected the old behaviour stands, stated by the
   * option's own docblock.
   */
  async create(
    ctx: ServiceContext, body: CreateMailboxBody, opts: CreateMailboxOptions,
  ): Promise<MailboxDTO> {
    const kp = this.requireKeyProvider();
    // Canonicalized BEFORE the emptiness check, so `"   "` is refused rather than stored as a
    // blank address that the index would then treat as a legitimate distinct key.
    const address = canonicalAddress(body.address ?? "");
    if (!body.provider || !address) {
      throw new ServiceError("validation_failed", 400, "provider and address are required");
    }
    const authKind = body.authKind ?? "password";
    if (authKind !== "oauth" && !body.imap?.pass) {
      throw new ServiceError("validation_failed", 400, "imap credentials are required");
    }

    let provenImap: ProvenEndpoint | undefined;
    if (body.imap?.pass) {
      // A configuration the adapter could never use is refused BEFORE the dial rather than
      // reported as a mail-server failure. `metaOf` drops undefined values, so a create with no
      // host used to store a credential the worker cannot log in with and could not say why —
      // and a probe fed the same body would answer "we could not reach that mail server", which
      // is a true sentence about the wrong thing. `imapFlowOptions`' note is explicit that this
      // refusal is owed here rather than re-derived from what the adapter happens to reject.
      // The PORT is no longer required: its absence asks the probe to walk the standard ladder
      // (993 implicit TLS, then 143 STARTTLS) and the proven combination is what gets stored.
      // A port that IS present still has to be one a server could listen on — `0` used to be
      // caught by the old requiredness check as a falsy value, and dropping that check must not
      // quietly turn an impossible port into a dial.
      if (!body.imap.host) {
        throw new ServiceError("validation_failed", 400, "imap host is required");
      }
      if (body.imap.port !== undefined && !isValidPort(body.imap.port)) {
        throw new ServiceError("validation_failed", 400, "imap port must be an integer between 1 and 65535");
      }
      if (body.smtp?.port !== undefined && !isValidPort(body.smtp.port)) {
        throw new ServiceError("validation_failed", 400, "smtp port must be an integer between 1 and 65535");
      }

      // NO DUPLICATE PRE-CHECK, AND THE REASON IS A GUARD IT WOULD HAVE BLINDED. An architecture
      // pass asked for one here, to avoid spending a provider connection on a submit mail 0021's
      // index is going to refuse anyway. It would answer BEFORE the index does — and the only
      // test that watches `isActiveAddressConflict` map 23505 to a 409 on this path drives it
      // by inserting a colliding row first, so a pre-check would keep that test green while the
      // mapping it exists for went unexercised.
      // It is also a second implementation of a partial unique index, which is the thing an
      // earlier change deliberately declined to write for this same refusal, and it has a race the
      // index does not: a row deleted between the read and the insert would let a create through
      // that had skipped its probe. The dial it saves is already bounded — one address gets at
      // most `MAX_PROBES_PER_ADDRESS` concurrent probes, which is the control the cap provides.
      const verdict = await opts.probe({
        accountId: ctx.accountId,
        address,
        imap: {
          host: body.imap.host ?? "",
          // Passed through UNDEFINED rather than defaulted: an absent port is the ladder
          // request, and a default here would silently withdraw it.
          port: body.imap.port,
          secure: body.imap.secure,
          user: body.imap.user ?? "",
          pass: body.imap.pass,
          // A CLAIM, not a permission: the probe honors it only after re-proving, in this same
          // call, that the server offers no TLS at all. See {@link ProvenEndpoint.insecure}.
          allowInsecure: body.imap.allowInsecure === true ? true : undefined,
        },
      });
      if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls);
      // WHAT IS STORED IS WHAT WAS PROVED. The ladder may have succeeded on a different
      // port/TLS mode than the body carried (or the body carried none), and storing the
      // body's guess would hand the worker a config nobody tried. A probe fake that answers
      // without `proven` (every pre-ladder test double) falls back to the body verbatim —
      // exactly the old contract.
      provenImap = verdict.proven;
    }

    // THE SMTP BLOCK IS NOW PROBED TOO, when the host injected a prober. The old exemption
    // ("sending is not the connect flow; a second dial doubles latency") was retired the day a
    // real user's vanity SMTP host (same CNAME shape as their IMAP one) sailed through create
    // and failed at their first send — the connect flow's whole promise is that a stored
    // credential has been tried. The latency cost is paid once, on an interactive submit whose
    // user is exactly the person who benefits.
    let provenSmtp: ProvenEndpoint | undefined;
    const smtpPass = body.smtp ? (body.smtp.pass ?? body.imap?.pass) : undefined;
    if (body.smtp?.host && smtpPass && opts.smtpProbe) {
      const verdict = await opts.smtpProbe({
        accountId: ctx.accountId,
        address,
        smtp: {
          host: body.smtp.host,
          port: body.smtp.port,
          secure: body.smtp.secure,
          user: body.smtp.user ?? body.imap?.user ?? "",
          pass: smtpPass,
        },
      });
      if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls, "smtp");
      provenSmtp = verdict.proven;
    }

    const mb = await asTx(ctx).transaction(async (tx) => {
      // The gate FIRST: it takes the lock every later statement is serialized behind.
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now());

      const [row] = await tx.insert(mailboxes).values({
        accountId: ctx.accountId,
        provider: body.provider,
        address,
        displayName: body.displayName ?? null,
        authKind,
        // WHAT THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT (mail 0055) — read out of the
        // EHLO the probe above already ran, so it costs no extra dial. `?? null` covers both "no
        // SMTP block was submitted" and "the server announced no ceiling", which are the same
        // answer to the send path's only question and are both read as "fall back to the strict
        // constant". Never a number this code chose: the column means the SERVER said so.
        smtpMaxSizeBytes: provenSmtp?.maxMessageBytes ?? null,
      }).returning();

      if (body.imap?.pass) {
        const meta = metaOf({
          host: body.imap.host,
          port: provenImap?.port ?? body.imap.port,
          secure: provenImap?.secure ?? body.imap.secure,
          user: body.imap.user,
        });
        // The consent marker, written ONLY from the verdict — never from the request body. It is
        // what every dialler reads back as `ImapConfig.allowInsecure`, so its absence on a secure
        // mailbox is as load-bearing as its presence on a consented one.
        if (provenImap?.insecure) meta.insecureConsent = true;
        await this.upsertCredOn(tx, ctx, kp, row!.id, "imap", body.imap.pass, meta);
      }
      if (body.smtp) {
        // A generic IMAP mailbox often shares creds with SMTP; fall back to the IMAP
        // secret/user when the SMTP block omits them (still its own transport row).
        const pass = body.smtp.pass ?? body.imap?.pass;
        if (pass) {
          await this.upsertCredOn(tx, ctx, kp, row!.id, "smtp", pass, metaOf({
            host: body.smtp.host,
            // Proven over guessed, as on the IMAP row above.
            port: provenSmtp?.port ?? body.smtp.port,
            secure: provenSmtp?.secure ?? body.smtp.secure,
            user: body.smtp.user ?? body.imap?.user,
          }));
        }
      }
      // Per-mailbox onboarding state, in the SAME transaction as the row: a create that fails
      // any later statement grants nothing, and a grant that fails aborts the create — the two
      // are one fact or neither is.
      if (this.deps.onCreated) await this.deps.onCreated(tx as LedgerTx, ctx.accountId, row!.id, ctx.now());
      return row!;
    }).catch((err: unknown) => {
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });

    return this.toDTO(ctx, mb);
  }

  /**
   * CONNECT OR RECONNECT AN OAuth2 MAILBOX — the write end of the consent ceremony.
   *
   * `POST /mailboxes` cannot serve this and neither can `PATCH /mailboxes/:id`, and the reason is
   * not the shape of the body:
   *
   *  · **Nobody typed the address.** It comes from the `id_token`'s `preferred_username` claim, so
   *    this method is handed an address rather than asked to trust one — and it therefore cannot be
   *    told WHICH mailbox row to write. It resolves that itself.
   *  · **A reconnect and a first connect are the same button.** A person whose consent expired
   *    presses "Reconnect Microsoft" and signs in again; the ceremony that comes back is
   *    indistinguishable from a first one. Two routes, or a `mailboxId` in the ceremony, would make
   *    the caller decide something it cannot know (see cloud 0009's header on why there is no
   *    `mailbox_id` column).
   *
   * ── THE ADDRESS RESOLVES THE ROW, AND mail 0021 IS WHAT MAKES THAT WELL-DEFINED ───────────
   *
   * `mailboxes_active_address_uq` is UNIQUE on (`account_id`, `lower(address)`) WHERE
   * `status <> 'disabled'`, so there is AT MOST ONE live mailbox for an address. That is the whole
   * basis of the lookup: the query cannot return two rows, so "update the existing one" has exactly
   * one meaning. The DISABLED rows are deliberately excluded from the match — a mailbox somebody
   * disconnected is a tombstone, and silently reviving it on a consent would resurrect a mailbox
   * they removed. A fresh consent for a disconnected address therefore CREATES, and the index
   * permits that (its predicate excludes the tombstone).
   *
   * ── AND THE INDEX IS STILL THE ENFORCER, NOT THIS LOOKUP ──────────────────────────────────
   *
   * The pre-read is inside the transaction and takes `FOR UPDATE` on whatever it finds, but a row
   * that appears BETWEEN this read and the insert is caught by the 23505 → 409 mapping `create`
   * relies on, not by the read. `create`'s own note explains why a pre-check is not the guard: it
   * has a race the index does not, and it would blind the only test that watches the mapping.
   *
   * ── PROBED BEFORE STORED, LIKE EVERY OTHER CREDENTIAL WRITE ───────────────────────────────
   *
   * `opts.probe` is REQUIRED and `input.oauth.accessToken` is what it tries — the token the code
   * exchange just returned. Before the transaction, for the two reasons `update` states: the API's
   * pooled handle is `max: 1`, so a foreign dial inside a transaction pins the instance's only
   * connection, and the transaction takes a row lock a mail server must never be able to hold.
   *
   * A refused probe writes NOTHING: no mailbox row, no credential, and — on the reconnect path — the
   * existing mailbox keeps the credential it has and keeps syncing on it. That is the same property
   * `update`'s probe buys, and it matters more here, because the thing being replaced is the only
   * credential an oauth mailbox has.
   */
  async connectOAuth(
    ctx: ServiceContext, input: ConnectOAuthMailboxInput, opts: ConnectOAuthOptions,
  ): Promise<ConnectOAuthResult> {
    const kp = this.requireKeyProvider();
    const address = canonicalAddress(input.address ?? "");
    if (!input.provider || !address) {
      throw new ServiceError("validation_failed", 400, "provider and address are required");
    }
    const o = input.oauth;
    if (!o?.refreshToken) {
      // The ceremony completed and returned no long-lived credential. Refusing loudly rather than
      // storing an access token that expires in an hour and can never be renewed — a mailbox that
      // works for exactly one sync cycle is worse than one that was never created.
      throw new ServiceError("validation_failed", 400, "an oauth mailbox requires a refresh token");
    }
    if (!o.imap?.host || !o.imap?.port) {
      throw new ServiceError("validation_failed", 400, "imap host and port are required");
    }

    // The IMAP LOGIN for XOAUTH2 is the address itself, and it is deliberately not a separate
    // field: Exchange authenticates the token's own subject, so a `user` that differed from the
    // claim would prove a login the worker will never make. Same argument as `create`'s refusal to
    // substitute the address for a missing `user`, reached from the other side.
    const user = address;

    const verdict = await opts.probe({
      accountId: ctx.accountId,
      address,
      imap: {
        host: o.imap.host, port: o.imap.port, secure: o.imap.secure ?? true,
        user, accessToken: o.accessToken,
      },
    });
    if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls);

    /**
     * The non-secret half of the credential, and every field here is read by a named consumer:
     * `host`/`port`/`secure`/`user` by `imapFlowOptions`; `authType`/`provider`/`tenant` by
     * `buildImapAuth` — the ONE interpreter of `authType`, which turns `secret_enc` into a token
     * callback instead of a password because of this bag; and `smtp` by `makeSendAdapter`'s oauth
     * branch, which is where an oauth mailbox's SMTP coordinates live because one refresh token
     * covers both transports and there is no second credential row to put them on.
     */
    const meta: Record<string, unknown> = {
      host: o.imap.host,
      port: o.imap.port,
      secure: o.imap.secure ?? true,
      user,
      authType: "oauth2",
      provider: o.provider,
      tenant: o.tenant,
      ...(o.smtp ? { smtp: { host: o.smtp.host, port: o.smtp.port, secure: o.smtp.secure } } : {}),
    };

    const out = await asTx(ctx).transaction(async (tx) => {
      const [existing] = await tx.select().from(mailboxes)
        .where(and(
          eq(mailboxes.accountId, ctx.accountId),
          sql`lower(${mailboxes.address}) = lower(${address})`,
          sql`${mailboxes.status} <> 'disabled'`,
        ))
        .limit(1)
        .for("update");

      if (existing) {
        const row = existing as MailboxRow;
        /*
         * A FRESH CONSENT ENDS THE OUTAGE EPISODE — the same four columns `update` clears, and for
         * the same reason: `markMailboxFailed` COALESCEs `failed_at`, so a value left behind here
         * is inherited by the NEXT, unrelated failure and reported as a multi-day outage on attempt
         * nine. The sync block goes with it (mail 0029) — reconnecting is a request to try again,
         * which makes the old reason unverified, and `reconcileSyncBlocks` re-writes it within one
         * roster pass if the mailbox is still unserved.
         *
         * `status` is NOT asserted to be `connected` by this write beyond leaving the error state:
         * only the worker's verified recovery says a mailbox works. What changed is that the row
         * starts a CLEAN episode on a credential this method has just dialled successfully.
         */
        await tx.update(mailboxes).set({
          status: "connected",
          authKind: "oauth",
          ...(input.displayName !== undefined ? { displayName: input.displayName ?? null } : {}),
          errorCode: null, errorDetail: null, failedAt: null, retryCount: 0,
          syncBlockedReason: null, syncBlockedSince: null,
        }).where(and(eq(mailboxes.id, row.id), eq(mailboxes.accountId, ctx.accountId)));

        await this.upsertCredOn(tx, ctx, kp, row.id, "imap", o.refreshToken, meta);
        /*
         * AND THE STALE PASSWORD SMTP ROW IS DROPPED, which is the one thing a naive reconnect gets
         * wrong. A mailbox that was previously connected with a password owns an `smtp` credential
         * row; `makeSendAdapter` prefers that row over `meta.smtp` on the PASSWORD branch only, so
         * leaving it would be harmless there — but the row also holds an encrypted password that is
         * now dead, and keeping a dead credential because it happens not to be read is how it gets
         * read later. The oauth branch takes its coordinates from `meta.smtp`.
         */
        await tx.delete(mailboxCredentials).where(and(
          eq(mailboxCredentials.mailboxId, row.id),
          eq(mailboxCredentials.transport, "smtp"),
        ));

        const [fresh] = await tx.select().from(mailboxes).where(eq(mailboxes.id, row.id)).limit(1);
        return { created: false, row: fresh as MailboxRow };
      }

      // The gate FIRST, exactly as `create` orders it: it takes the lock every later statement is
      // serialized behind. A reconnect does NOT reach here, so re-consenting a mailbox you already
      // have never spends allowance — only a new address does.
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now());

      const [created] = await tx.insert(mailboxes).values({
        accountId: ctx.accountId,
        provider: input.provider,
        address,
        displayName: input.displayName ?? null,
        authKind: "oauth",
      }).returning();
      await this.upsertCredOn(tx, ctx, kp, created!.id, "imap", o.refreshToken, meta);
      // Same hook, same transaction, as `create` — an OAuth connect of a NEW address is a
      // create in every sense that matters here (a reconnect returned above and grants nothing).
      if (this.deps.onCreated) await this.deps.onCreated(tx as LedgerTx, ctx.accountId, created!.id, ctx.now());
      return { created: true, row: created as MailboxRow };
    }).catch((err: unknown) => {
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });

    return { created: out.created, mailbox: await this.toDTO(ctx, out.row) };
  }

  /**
   * Patch mailbox fields (displayName/status) and, when new secrets are supplied,
   * re-encrypt + upsert the credential row(s) on `(mailboxId, transport)`. 404 if
   * not owned.
   *
   * **RE-ENABLING is a create.** `delete` is a soft delete to `status='disabled'`, so
   * without this gate the limit is trivially bypassed: at the limit, disconnect one (count
   * drops), connect a new one (count back at the limit), then `PATCH {status:'connected'}` the
   * old one (count = limit + 1). Only the disabled → not-disabled TRANSITION is gated; patching
   * an already-connected mailbox consumes no allowance, and moving to `'disabled'` never does.
   *
   * ── AND IT MAY NOT STEP AROUND THE WORKER'S FAILURE STATE MACHINE (mail 0023) ────────────
   *
   * Two ways it did. Both leave a row that says something nobody verified:
   *
   *  1. **`status: 'error'` was accepted from a client.** `error` is the worker's assertion
   *     that it tried to reach this mailbox and could not, and it is written by exactly two
   *     functions that carry the reason with it (`markMailboxFailed` / `markMailboxConnected`,
   *     both in the worker). A PATCH set the column alone, so an outage the product
   *     never observed appeared in Settings → Mailboxes AND — with `error_code` NULL, rendered
   *     as `"unknown"` — in the admin console's operator queue. Refused now: a client can
   *     connect a mailbox and disconnect it; it cannot declare it broken.
   *  2. **Leaving `error` did not clear the outage.** `error_code`, `error_detail`, `failed_at`
   *     and `retry_count` survived a `PATCH {status:'connected'}`, invisibly — `toDTO` projects
   *     them only while `status === 'error'`, so the wire looked clean while the row was not.
   *     `markMailboxFailed` then COALESCEs `failed_at`, so the NEXT failure inherited the old
   *     episode's start time and continued its `retry_count`: a mailbox reconnected today and
   *     failing tomorrow reports a three-day outage on attempt 9. The four columns are cleared
   *     in the same UPDATE that moves the status, exactly as the worker's recovery write does,
   *     which makes "not in error ⇒ no outage metadata" true of every writer instead of one.
   *
   * What this does NOT claim is that the mailbox works. A reconnect is a request to try again,
   * and only the worker's verified recovery (connect + folders + two cycles + IDLE) says
   * otherwise; the difference is now that the row starts a CLEAN episode rather than inheriting
   * a stale one.
   *
   * ── A ROTATED CREDENTIAL IS PROBED, AND `opts` IS OPTIONAL WHERE `create`'s IS NOT ──────────
   *
   * The asymmetry with {@link create} is DELIBERATE and must not be "harmonized" away:
   *
   *  · `create` ALWAYS carries a secret, so a required parameter costs its callers nothing and
   *    every one of them is in a compiled package.
   *  · `update` mostly does not. Fourteen of its seventeen call sites patch a display name or a
   *    status and have no password to try, and all but one live in the test suite,
   *    which is never typechecked (`include: src` only). Making the parameter
   *    required there would not make a single one of them "decide out loud" — it would emit a
   *    type error nothing compiles, while the calls kept running.
   *
   * So the enforcement here is the RUNTIME throw in {@link probedImapMeta}, not the signature:
   * a patch carrying `imap.pass` with no probe is refused before any dial and before any write.
   * That guard is the entire protection on this path, and it has its own mutation-checked test at
   * the API layer. Deleting it to "match `create`" would silently restore the defect.
   */
  async update(
    ctx: ServiceContext, id: string, patch: UpdateMailboxBody, opts?: UpdateMailboxOptions,
  ): Promise<MailboxDTO> {
    const kp = this.requireKeyProvider();

    // Widened deliberately: the type forbids it, the wire does not.
    if ((patch.status as string | undefined) === "error") {
      throw new ServiceError(
        "validation_failed", 400,
        "status 'error' is recorded by the sync worker, not by a client; " +
          "PATCH accepts 'connected' or 'disabled'",
      );
    }

    /**
     * ── THE ROTATED CREDENTIAL IS TRIED BEFORE IT REPLACES A WORKING ONE ────────────────────
     *
     * BEFORE THE TRANSACTION, for the reason `create` gives and one more. `create`'s: the API's
     * runtime handle is `makePooledDb` at `max: 1`, so a foreign dial inside a transaction pins
     * the instance's only connection — the deadlock this repository has already fixed once. The
     * one `create` does not have: this transaction holds `SELECT … FOR UPDATE` on the mailbox
     * row, so a probe inside it would hold a ROW LOCK across somebody else's mail server going
     * quiet, and `delete` and the dedup resolver both queue behind that lock.
     *
     * The pre-read is UNLOCKED and deliberately not trusted for anything but two decisions the
     * transaction makes again anyway:
     *
     *   · **404 before the dial.** Without it `PATCH /mailboxes/<guessed-uuid>` is a connect
     *     oracle for an arbitrary `host:port` against somebody else's mailbox id — strictly more
     *     than `POST /mailboxes` offers, since that one only ever dials on your own behalf.
     *   · **The stored transport config**, which is what makes the merge below possible.
     *
     * Neither is a security decision made outside the lock: the transaction re-reads the row
     * `FOR UPDATE` and re-checks ownership and the disabled rule before anything is written. A
     * row that changes in between costs at most one wasted dial, never a wrong write.
     */
    const merged = patch.imap?.pass
      ? await this.probedImapMeta(ctx, id, patch, opts)
      : undefined;

    // The SMTP sibling, before the transaction for the same two reasons — and only when the
    // host injected a prober; without one the write below stores the plain patch, as ever.
    const mergedSmtp = patch.smtp?.pass && opts?.smtpProbe
      ? await this.probedSmtpMeta(ctx, id, patch, opts.smtpProbe)
      : undefined;

    return asTx(ctx).transaction(async (tx) => {
      // `FOR UPDATE`, and it is the fix for a race an independent review found.
      // Without it a credentials-only PATCH took NO lock at all — it writes `mailbox_credentials`
      // and never touches the `mailboxes` row — so it could read a row as 'connected', have the
      // row disabled and stripped underneath it (by `delete`, by the dedup resolver, or by 0021's
      // prelude mid-migration), and then commit a live IMAP secret onto the tombstone. With the
      // lock the two serialize in either order: this transaction either wins and the other side's
      // credential delete runs after it, or it waits and then re-reads the LATEST COMMITTED row,
      // sees 'disabled', and refuses below. Both interleavings end at (disabled ⇒ no credential).
      const current = await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned

      const set: Partial<MailboxRow> = {};
      if ("displayName" in patch) set.displayName = patch.displayName ?? null;
      if (patch.status) set.status = patch.status;
      // Leaving `error` ENDS the episode — atomically, in the same statement as the status.
      // See the note on this method: `failed_at` is COALESCEd by the worker's failure write, so
      // a value left behind here is inherited by the next, unrelated outage.
      if (patch.status && current.status === "error") {
        set.errorCode = null;
        set.errorDetail = null;
        set.failedAt = null;
        set.retryCount = 0;
      }
      // ── AND THE SYNC BLOCK GOES WITH ANY STATUS MOVE (mail 0029) ──────────────────────────
      //
      // Not gated on `current.status === "error"`, and that difference from the four above is not
      // an inconsistency: a sync block happens while the status is `connected`, so an `error` gate
      // would never fire for it. The block is THIS PROCESS's report about the worker's relationship
      // to the mailbox, and both directions of a status move invalidate it — disconnecting the
      // mailbox ends it (a tombstone carries no explanation of why it was not syncing), and
      // reconnecting is a request to try again, which means the old reason is unverified.
      //
      // Clearing it is SAFE PRECISELY BECAUSE THE WORKER RE-WRITES IT: `reconcileSyncBlocks` writes
      // on every roster pass while the block lasts, so if the mailbox is still unserved the reason
      // is back within one interval. A clear here that were permanent would be worse than no clear.
      if (patch.status) {
        set.syncBlockedReason = null;
        set.syncBlockedSince = null;
      }
      // WHAT THE RE-PROBED SUBMISSION SERVER SAID IT WILL ACCEPT (mail 0055). Written only when
      // this PATCH actually dialled SMTP — a patch that touches nothing else leaves the recorded
      // announcement alone — and written as `null` when the dial learned nothing, so a stale
      // larger number cannot survive a re-probe that no longer proves it.
      if (mergedSmtp) set.smtpMaxSizeBytes = mergedSmtp.maxMessageBytes;

      // The gate BEFORE the write, and before the count it implies — same order as `create`.
      // The row itself is excluded: it does not yet hold the slot it is asking for.
      if (patch.status && patch.status !== "disabled" && current.status === "disabled") {
        await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { excludeMailboxId: id });
      }

      if (Object.keys(set).length > 0) {
        await tx.update(mailboxes).set(set)
          .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId)));
      }

      // The EFFECTIVE status, after this patch — so `{status:'connected', imap:{pass}}` is still
      // the one-call reconnect it has always been, and only a credential written onto a mailbox
      // that STAYS disabled is refused. Refused loudly rather than skipped: a silent skip would
      // answer 200 to a client that then believes a password is stored.
      const effectiveStatus = patch.status ?? current.status;
      if (effectiveStatus === "disabled" && (patch.imap?.pass || patch.smtp?.pass)) {
        throw mailboxDisabled();
      }

      // `merged`, NOT `metaOf(patch.imap)` — what is stored must be exactly what was dialled.
      // Passing the patch alone would store a config the probe never tried (and, before the
      // `upsertCredOn` fix below, would also erase the stored port/user/secure while doing it).
      if (patch.imap?.pass) await this.upsertCredOn(tx, ctx, kp, id, "imap", patch.imap.pass, merged ?? {});
      // PROBED when the host injects `smtpProbe`, like `create` — the same vanity-CNAME shape
      // reaches this door via the edit form. `mergedSmtp` was dialled before this transaction
      // opened; where no prober is injected it is the plain merge, the pre-probe behaviour.
      if (patch.smtp?.pass) await this.upsertCredOn(tx, ctx, kp, id, "smtp", patch.smtp.pass, mergedSmtp?.meta ?? metaOf(patch.smtp));

      const [row] = await tx.select().from(mailboxes)
        .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId))).limit(1);
      return this.toDTO({ ...ctx, db: tx as unknown as ServiceContext["db"] }, row!);
    }).catch((err: unknown) => {
      // The RE-ENABLE path hits the same index: `disabled → connected` inserts a new entry
      // into it, so reconnecting an address another live row already holds raises 23505 here
      // rather than in `create`. That is the constraint doing its job — without it, re-enable
      // is a second way past the rule, exactly as it was a second way past the allowance gate.
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });
  }

  /**
   * Disconnect a mailbox. SOFT-delete: set `status='disabled'` AND remove its
   * credential rows so the worker stops syncing it. We deliberately do NOT
   * hard-delete the `mailboxes` row — `messages.mailbox_id` FK-references it, so a
   * hard delete would orphan real message history. 404 if not owned.
   *
   * **ONE TRANSACTION, UNDER A ROW LOCK.** This used to be three separate
   * autocommits — an unlocked read, the status flip, the credential delete — which left two
   * windows a concurrent credential PATCH could commit into, and the second of them ends with a
   * disabled mailbox that still owns a live IMAP secret: exactly the state 0021's comment says
   * cannot happen. The lock is taken in the same order (`id`) as the dedup resolver's, and
   * `update` takes it too, so no two of the three can interleave into that state and none of
   * them can deadlock.
   */
  async delete(ctx: ServiceContext, id: string): Promise<void> {
    await asTx(ctx).transaction(async (tx) => {
      await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned
      await tx.update(mailboxes).set({
        status: "disabled",
        // ── AND THE LEASE COLUMNS GO WITH IT (mail 0027) ──────────────────────────────────
        //
        // `disabled_reason` is WHY the ORGANIZER stopped, and a user disconnecting the mailbox
        // makes that statement untrue in the only way that matters: they are not asking why it
        // is not syncing, they have said stop. Left behind, the reason survives on the tombstone
        // for ever, and the new disabled-row copy would tell somebody "another ohmail install has
        // claimed this mailbox" about a mailbox they deliberately removed — the same class of
        // false statement that copy exists to end, introduced by the fix for it.
        //
        // This is the rule `packages/db/src/mailbox-errors.ts` already states for
        // `sync_blocked_reason` — "every writer that makes the statement untrue clears it in the
        // same statement" — applied to the column beside it. The four worker writers hold it;
        // this was the one caller that did not, because until now nothing read the column.
        disabledReason: null,
        // §4, "No seize-back". An authorization is permission for ONE becoming, and disconnecting
        // ends the relationship it was granted inside. Left set, it would be spent by whatever
        // re-enabled the row months later — the standing right the one-shot rule forbids.
        takeoverAuthorizedAt: null,
        // ── AND THE SYNC BLOCK, FOR THE IDENTICAL REASON (mail 0029) ─────────────────────
        //
        // `mailbox-errors.ts` names the writers that hold "every writer that makes the statement
        // untrue clears it in the same statement" — `markMailboxConnected`, `markMailboxStoodDown`,
        // `markMailboxFailed`, `MailboxService.update`. This method is the one that was missing,
        // and `update` states the argument for both directions of a status move already: "a
        // tombstone carries no explanation of why it was not syncing". It went unnoticed because
        // nothing rendered a disabled row's block; the disabled-row rendering work is what would
        // have surfaced it.
        syncBlockedReason: null,
        syncBlockedSince: null,
      })
        .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId)));
      await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
    });
  }

  /**
   * Force a reconcile pass. Clearing each folder's CONDSTORE cursor + delta_token
   * makes the worker re-scan from scratch on its next cycle (durable marker).
   */
  async requestResync(ctx: ServiceContext, id: string): Promise<void> {
    await this.ownedRow(ctx, id); // 404 if not owned
    await asTx(ctx).update(mailboxFolders)
      .set({ highestmodseq: null, deltaToken: null, updatedAt: ctx.now() })
      .where(eq(mailboxFolders.mailboxId, id));
  }

  /**
   * RING THE WORKER'S DOORBELL for every connected mailbox of the caller's account — the
   * "Pull new mail" affordance's server half (mail 0049's `sync_requested_at`, the column the
   * Not-junk rescue and `finalizeSent` already stamp).
   *
   * NOT {@link requestResync}, and the difference is the whole reason this exists: a resync
   * clears every folder's CONDSTORE cursor and makes the worker re-walk the mailbox from
   * scratch — the heaviest single thing a POST can ask of it. This stamps one nullable column;
   * the worker's ~3 s kick scan notices, marks the runtime woken, and the cycle serves it one
   * ORDINARY bounded batch out of turn. The user-visible effect is "I pulled / the mail I was
   * told about is here" in seconds, at the cost of exactly the scan the next poll would have run
   * anyway — just now instead of at the rotation's leisure.
   *
   * ── THE RATE LIMIT LIVES IN THE UPDATE'S OWN PREDICATE ─────────────────────────────────────
   *
   * A stamp younger than {@link MailboxService.PULL_MIN_GAP_MS} is left standing (it is already
   * being answered — the kick clears it within seconds of acting on it), so a held-down refresh
   * gesture degrades to one worker visit per gap per mailbox, not one per tap. No token bucket,
   * no new table: the column IS the state, and the failure mode of the predicate being wrong is
   * one extra bounded visit, never an unbounded one.
   *
   * ── ONE TRANSACTION, ROW LOCKS FIRST, DB CLOCK THROUGHOUT — the settle contract ────────────
   *
   * The answer is the client's honest-settle baseline, and three review findings (2026-08-26,
   * round 1) shaped this exact form:
   *
   *  · PER MAILBOX, not one scalar. A mailbox holding a YOUNG standing stamp keeps it, and its
   *    request predates this call — a single `requestedAt: now` would set that mailbox a bar its
   *    already-owed visit can never have aimed at, and the spinner would run to its cap over a
   *    pull that had settled. Each row answers with ITS effective stamp.
   *  · ATOMIC against the worker's compare-and-clear. `FOR UPDATE` on the account's connected
   *    rows means the kick pass's clear either lands BEFORE this transaction (the row reads
   *    NULL and is freshly stamped) or queues BEHIND it (the standing stamp this returns is the
   *    one the clear then names) — the fallback-SELECT race that could answer `requested: 0`
   *    for a wake that had not yet been served is not representable.
   *  · THE DATABASE'S CLOCK, on both sides. The stamp is SQL `now()` and is returned as the
   *    column's own text; the worker's woken-visit `last_sync_at` stamp is SQL `now()` too
   *    (`stampMailboxSyncNow`). The client only ever compares the two DB instants with each
   *    other, so no API-host, worker-host or client wall clock enters the comparison — this
   *    machine's own clock being measurably skewed is what made that rule non-negotiable.
   *
   * Returns the per-mailbox effective stamps (`requested` is their count). An account with no
   * connected mailboxes gets `{ requested: 0, mailboxes: [] }` and nothing to wait for.
   */
  async requestPull(ctx: ServiceContext): Promise<{
    requested: number;
    /** The NEWEST effective stamp — a convenience for logging; the per-mailbox list is the contract. */
    requestedAt: string;
    mailboxes: Array<{ id: string; requestedAt: string }>;
  }> {
    const gapSeconds = MailboxService.PULL_MIN_GAP_MS / 1000;
    const rows = await asTx(ctx).transaction(async (tx) => {
      // Lock the account's connected rows so the kick pass's compare-and-clear serializes with
      // this stamp — see the header. The set is an account's mailboxes (single digits), and the
      // kick's clear is one row-keyed UPDATE, so the hold is microseconds.
      // The wire form is FIXED ISO-8601 UTC via to_char, never `::text`: the bare cast renders
      // at the server's DateStyle (space separator, `+00` offset), which `Date.parse` is not
      // required to accept — a rejected format is a NaN baseline and a spinner that always runs
      // to its cap (2026-08-26 review, round 2). Millisecond precision, matching the DTO's
      // `toISOString()` on the other side of the comparison; the sub-millisecond loss floors the
      // baseline, which is the conservative direction.
      const mine = await tx.select({
        id: mailboxes.id,
        standing: sql<string | null>`to_char(${mailboxes.syncRequestedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      }).from(mailboxes)
        .where(and(eq(mailboxes.accountId, ctx.accountId), eq(mailboxes.status, "connected")))
        .for("update");
      if (mine.length === 0) return [];
      // `now()` — the DATABASE's instant, at its own precision, so the returned baseline and
      // the worker's `stampMailboxSyncNow` write are the same clock. The age predicate is
      // DB-side too: no host clock decides anything here.
      const stamped = await tx.update(mailboxes)
        .set({ syncRequestedAt: sql`now()` })
        .where(and(
          inArray(mailboxes.id, mine.map((m) => m.id)),
          sql`(${mailboxes.syncRequestedAt} is null or ${mailboxes.syncRequestedAt} < now() - (${gapSeconds} * interval '1 second'))`,
        ))
        .returning({
          id: mailboxes.id,
          at: sql<string>`to_char(${mailboxes.syncRequestedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        });
      const freshly = new Map<string, string>(stamped.map((r) => [r.id, r.at]));
      return mine.map((m) => ({
        id: m.id,
        requestedAt: freshly.get(m.id) ?? m.standing,
      })).filter((m): m is { id: string; requestedAt: string } => m.requestedAt !== null);
    });
    const newest = rows.reduce<string | null>(
      (acc, r) => (acc === null || r.requestedAt > acc ? r.requestedAt : acc), null,
    );
    return {
      requested: rows.length,
      requestedAt: newest ?? ctx.now().toISOString(),
      mailboxes: rows,
    };
  }

  /**
   * The youngest a standing `sync_requested_at` may be before {@link requestPull} re-stamps it.
   * 5 s: comfortably past the worker's ~3 s kick scan, so a stamp older than this is one the
   * scan has plausibly missed (or a worker that is down), and re-stamping is signal rather than
   * hammering.
   */
  private static readonly PULL_MIN_GAP_MS = 5_000;

  /**
   * ASK TO BECOME THE ORGANIZER OF A MAILBOX THIS SIDE STOOD DOWN FROM.
   *
   * ── THE RULE THIS IMPLEMENTS, AND THE HALF PEOPLE GET WRONG ────────────────────────────────
   *
   * Exactly one active organizer per mailbox, ever. Ceasing to organize is always automatic;
   * BECOMING an organizer always requires an explicit human action — and that second half binds
   * the hosted service exactly as it binds a desktop install. There is no billing event, no
   * re-subscription and no deploy that may quietly make this side the organizer again of a mailbox
   * somebody deliberately moved to their own machine. This method is that human action, and it is
   * the mirror of the `organize here` command a local install already has.
   *
   * ── IT AUTHORIZES AN ASK. IT DOES NOT WIN ANYTHING ─────────────────────────────────────────
   *
   * Nothing here opens IMAP, and that is a hard boundary rather than an implementation detail:
   * organization lands in real folders on the user's server, and it is the WORKER that moves mail,
   * through desired state, so that a serverless function can never leave a mailbox half-organized.
   * All this writes is a stamp. The worker's next roster pass reads the claim in the mailbox and
   * decides — and if another organizer is still renewing and outranks us, this side stands down
   * again on that same pass and the stamp is voided with it.
   *
   * ── THREE COLUMNS, ONE STATEMENT, AND EACH OMISSION HAS ITS OWN FAILURE ────────────────────
   *
   * Learned on the local side and true verbatim here:
   *
   *  · The stamp alone is INERT. A row that still carries a stand-down reason is refused before
   *    the gate is ever consulted, so the mailbox never reaches the code the stamp is for.
   *  · Clearing the reason alone gets as far as consulting the claim, which then reports the
   *    mailbox merely *available* — nobody renewing, nobody authorized — and this side stands down
   *    again on the same pass. An action that appears to do nothing, at exactly the moment
   *    somebody chose to use it.
   *  · Restoring the status alone is the one that CORRUPTS. A stand-down and a user's
   *    disconnect share `status='disabled'` and are told apart ONLY by whether a reason is set, so
   *    clearing the reason without restoring the status converts a paused mailbox into a
   *    tombstone.
   *
   * ── AND WHY A DISCONNECTED MAILBOX IS REFUSED RATHER THAN REVIVED ──────────────────────────
   *
   * `disabled` with NO reason is a mailbox the user disconnected. Re-adding it is a different
   * action with different consequences — it needs credentials, it consumes an allowance slot as a
   * new connection, and it is reached through a different door. Quietly converting a takeover into
   * a resurrection would bring back a mailbox somebody deliberately removed, and would do it
   * without the credential it no longer has.
   */
  async takeover(ctx: ServiceContext, id: string): Promise<MailboxTakeoverResult> {
    return asTx(ctx).transaction(async (tx) => {
      // `FOR UPDATE`, in the same order and on the same row as `update` and `delete` take it, so
      // the three serialize instead of interleaving. Without it, a takeover and a `delete` can
      // both read `disabled` + reason and commit in either order, and the losing order leaves a
      // mailbox that is `connected`, authorized to organize, and has had its credentials deleted.
      const current = await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned

      if (current.status !== "disabled") return { outcome: "already_organizing" as const };
      // The tombstone. See the header — this is a refusal, never a revival.
      if (current.disabledReason === null) return { outcome: "disconnected" as const };

      // THE ALLOWANCE GATE, BEFORE THE WRITE, for the reason `update` states at its own re-enable:
      // `disabled → connected` IS a connection, whichever door it comes through. Omitting it here
      // would make this the cheapest way past a plan limit — and cheaper than the door `update`
      // guards, because a user can cause a stand-down at will simply by pointing another install
      // at their own mailbox, minting the free slot themselves. The row is excluded from the count
      // because it does not yet hold the slot it is asking for.
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { excludeMailboxId: id });

      const rows = await tx.update(mailboxes).set({
        status: "connected",
        disabledReason: null,
        takeoverAuthorizedAt: ctx.now(),
        // The block is this process's report about the worker's relationship to the mailbox, and a
        // status move invalidates it in both directions — the same rule `update` applies. The
        // worker re-writes it within one roster pass if it is still true.
        syncBlockedReason: null,
        syncBlockedSince: null,
      })
        // ── THIS PREDICATE IS UNREACHABLE TODAY, AND IT IS NOT THE CONCURRENCY CONTROL ─────
        //
        // Stated plainly because the tempting reading is the opposite one. MEASURED by mutation
        // against real Postgres: deleting these two clauses leaves the whole suite green,
        // including the two-concurrent-confirms case. What refuses the second confirm is the row
        // lock plus the re-read above it — the loser blocks, then reads a row that is now
        // `connected`, and returns `already_organizing` before reaching this statement.
        //
        // It stays for the reason `markMailboxStoodDown`'s reason-coercion stays: it is the guard
        // for the call site nobody has written yet. An UPDATE that is safe only in the presence of
        // a lock taken thirty lines earlier is one refactor away from being unsafe, and the
        // refactor would not fail anything. `rows.length === 0` below is the arm it feeds.
        .where(and(
          eq(mailboxes.id, id),
          eq(mailboxes.accountId, ctx.accountId),
          eq(mailboxes.status, "disabled"),
          isNotNull(mailboxes.disabledReason),
        ))
        .returning({ id: mailboxes.id });

      if (rows.length === 0) return { outcome: "already_organizing" as const };
      return { outcome: "authorized" as const, previousReason: current.disabledReason };
    }).catch((err: unknown) => {
      // `disabled → connected` inserts into the active-address index, so a takeover of an old row
      // whose address has since been re-added as a NEW mailbox raises 23505 here. Reachable in
      // order: stand down, add the same address again, then ask to take the old one over.
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });
  }

  /**
   * Envelope-encrypt `pass` and insert/update the `(mailboxId, transport)` row ON THE GIVEN
   * EXECUTOR. It takes `tx` rather than reaching for `ctx.db` because the write paths are
   * transactional now: a credential written on the ambient handle would commit
   * independently of the mailbox row it belongs to.
   */
  /**
   * Resolve the config a credential rotation will be STORED with, having just proved it
   * works. Returns the merged non-secret `meta`; throws rather than returning on any refusal.
   *
   * ── THE MERGE IS THE POINT, NOT A CONVENIENCE ───────────────────────────────────────────────
   *
   * `PATCH` bodies are partial by design — "here is my new password", or "my provider moved to a
   * new host, same everything else". So neither half is dialable alone: the patch alone has no
   * port (and `metaOf` drops the undefined rather than inventing one), and the stored config
   * alone ignores the correction the user just typed. Probing either would prove a login the
   * worker will never make, which is worse than not probing — it is a green light with a
   * different config's name on it.
   *
   * Patch WINS field by field, because the patch is the newer statement about the same mailbox.
   */
  private async probedImapMeta(
    ctx: ServiceContext, id: string, patch: UpdateMailboxBody, opts?: UpdateMailboxOptions,
  ): Promise<Record<string, unknown>> {
    // The guard the type cannot enforce in a package whose tests are not compiled. See
    // {@link UpdateMailboxOptions}: this throw is the half that runs.
    if (!opts?.probe) throw probeMissing();

    const current = await this.ownedRow(ctx, id); // 404 before anything is dialled

    /**
     * ── DISABLED IS REFUSED HERE TOO, AND IT IS NOT A REDUNDANT COPY ────────────────────────
     *
     * `delete` disables the row AND deletes its credential rows together. So for a disconnected
     * mailbox there is no stored `meta` left to merge against, and without this branch the merge
     * below produces a config with no host — and the caller is told **"imap host and port are
     * required"** about a mailbox whose real problem is that they disconnected it. A true
     * sentence about the wrong thing is the exact failure mode the probe exists to end, so getting
     * it right on the refusal path matters as much as on the dial path.
     *
     * IT DOES NOT COST THE IN-TRANSACTION CHECK ITS TEETH, which was the reason to hesitate.
     * That check is still the authority and is still exercised, because the case that exercises
     * it has REAL concurrency: a twelve-case storm against real Postgres starts a patch and a
     * delete 30 ms apart in both orders, so the unlocked read here legitimately sees `connected`
     * and only the locked re-read can refuse. That alternation is what keeps the
     * effective-status refusal honest. The two sequential
     * cases beside it ("DELETE first", "resolver first") await their first actor to completion,
     * so no lock ever blocks in them and they were never the guard on the locking.
     */
    const effectiveStatus = patch.status ?? current.status;
    if (effectiveStatus === "disabled") throw mailboxDisabled();

    const stored = (await asTx(ctx).select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")))
      .limit(1))[0]?.meta as Record<string, unknown> | null | undefined;

    const merged: Record<string, unknown> = { ...(stored ?? {}), ...metaOf(patch.imap ?? {}) };

    // Same refusal `create` owes and for the same reason: a configuration the adapter could never
    // use is rejected BEFORE the dial, rather than reported as a mail-server failure. Reachable
    // here when a mailbox has no stored `meta` at all and the patch supplies none either. The
    // PORT may legitimately be absent — the probe walks the ladder then, as it does on create.
    const host = typeof merged.host === "string" ? merged.host : "";
    if (!host) {
      throw new ServiceError("validation_failed", 400, "imap host is required");
    }

    const verdict = await opts.probe({
      accountId: ctx.accountId,
      address: current.address,
      imap: {
        host,
        port: typeof merged.port === "number" ? merged.port : undefined,
        secure: typeof merged.secure === "boolean" ? merged.secure : undefined,
        user: typeof merged.user === "string" ? merged.user : "",
        pass: patch.imap!.pass!,
        allowInsecure: patch.imap?.allowInsecure === true ? true : undefined,
      },
    });
    if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls);
    /**
     * The PROVEN combination overrides the merge, exactly as on create — and a STALE consent
     * marker is REWRITTEN, not deleted: `upsertCredOn` merges meta with jsonb `||` (right side
     * wins PER KEY, absent keys survive), so deleting the key would leave yesterday's consent on
     * a mailbox whose server now proves TLS — a consent that never expires on its own is the
     * exact downgrade this rewrite exists to prevent.
     * A mailbox that never carried the marker never gains the key, in either value.
     */
    if (verdict.proven) {
      merged.port = verdict.proven.port;
      merged.secure = verdict.proven.secure;
      if (verdict.proven.insecure === true) merged.insecureConsent = true;
      else if (merged.insecureConsent !== undefined) merged.insecureConsent = false;
    }
    return merged;
  }

  /**
   * The SMTP sibling of {@link probedImapMeta}: merge the patch over the stored `smtp` meta,
   * dial the merged config, and return the merge with the PROVEN port/TLS mode applied. Same
   * ordering rules (before the transaction, 404 and disabled-refusal first), no consent marker —
   * plaintext SMTP authentication is not offered at all.
   */
  private async probedSmtpMeta(
    ctx: ServiceContext, id: string, patch: UpdateMailboxBody, smtpProbe: SmtpProbe,
  ): Promise<{ meta: Record<string, unknown>; maxMessageBytes: number | null }> {
    const current = await this.ownedRow(ctx, id); // 404 before anything is dialled

    const effectiveStatus = patch.status ?? current.status;
    if (effectiveStatus === "disabled") throw mailboxDisabled();

    const stored = (await asTx(ctx).select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "smtp")))
      .limit(1))[0]?.meta as Record<string, unknown> | null | undefined;

    const merged: Record<string, unknown> = { ...(stored ?? {}), ...metaOf(patch.smtp ?? {}) };

    const host = typeof merged.host === "string" ? merged.host : "";
    if (!host) {
      throw new ServiceError("validation_failed", 400, "smtp host is required");
    }

    const verdict = await smtpProbe({
      accountId: ctx.accountId,
      address: current.address,
      smtp: {
        host,
        port: typeof merged.port === "number" ? merged.port : undefined,
        secure: typeof merged.secure === "boolean" ? merged.secure : undefined,
        user: typeof merged.user === "string" ? merged.user : "",
        pass: patch.smtp!.pass!,
      },
    });
    if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls, "smtp");
    if (verdict.proven) {
      merged.port = verdict.proven.port;
      merged.secure = verdict.proven.secure;
    }
    /**
     * The `SIZE` announcement rides OUT OF THIS METHOD rather than into `merged`, and the split is
     * deliberate: `merged` becomes the credential row's `meta`, which is per-TRANSPORT config the
     * dialler reads back, while this is a fact about the mailbox that the SEND path and the mailbox
     * DTO read. Putting it in `meta` would hide it behind a credential row the send path does not
     * open.
     *
     * `null` when the re-probe learned nothing, and it OVERWRITES a previously stored number rather
     * than leaving it — a server that has stopped announcing a ceiling, or that answered on a
     * different port, has not silently kept yesterday's. Falling back to the strict constant is the
     * safe direction; keeping a stale larger number is not.
     */
    return { meta: merged, maxMessageBytes: verdict.proven?.maxMessageBytes ?? null };
  }

  private async upsertCredOn(
    tx: Tx, ctx: ServiceContext, kp: KeyProvider, mailboxId: string,
    transport: "imap" | "smtp" | "graph", pass: string, metaIn: Record<string, unknown>,
  ): Promise<void> {
    const { ciphertext, keyVersion } = await kp.encrypt(pass);
    const meta = Object.keys(metaIn).length > 0 ? metaIn : undefined;
    const now = ctx.now();
    await tx.insert(mailboxCredentials).values({
      mailboxId, transport, secretEnc: ciphertext, keyVersion,
      ...(meta ? { meta } : {}), updatedAt: now,
    }).onConflictDoUpdate({
      target: [mailboxCredentials.mailboxId, mailboxCredentials.transport],
      set: {
        secretEnc: ciphertext, keyVersion, updatedAt: now,
        // ── MERGED, NOT REPLACED ──────────────────────────────────────────────────────────
        //
        // This assigned `meta` wholesale, so a partial patch DESTROYED the stored fields it
        // did not mention: `PATCH {imap:{pass, host}}` left a row whose port, user and TLS mode
        // were gone, and `loadMailboxCreds` then handed the worker a config that had never been
        // tried — a mailbox that was working before somebody corrected its hostname.
        //
        // `||` is jsonb concatenation, right-hand side wins, so the patch's fields overwrite and
        // the rest survive. Done in SQL rather than by read-modify-write because this runs inside
        // the transaction that already holds the row lock, and a second round trip to merge in
        // application code would be both slower and a place for two writers to interleave.
        // `coalesce` covers the row whose meta is NULL.
        ...(meta
          ? { meta: sql`coalesce(${mailboxCredentials.meta}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb` }
          : {}),
      },
    });
  }

  private requireKeyProvider(): KeyProvider {
    if (!this.deps.keyProvider) {
      throw new ServiceError("internal", 500, "mailbox service not configured with a key provider");
    }
    return this.deps.keyProvider;
  }

  /** Load a mailbox row scoped to the account, or 404. */
  private async ownedRow(ctx: ServiceContext, id: string): Promise<MailboxRow> {
    return this.ownedRowOn(asTx(ctx), ctx, id);
  }

  /**
   * {@link ownedRow} on an explicit db handle — the transactional read the write paths need.
   *
   * `forUpdate` is OPT-IN, on the `liveSubscriptionOf` pattern, and only `update` and `delete`
   * pass it. The read paths (`get`, `list`, `requestResync`, the DTO build) must not take write
   * locks on every request — a lock on the read path would serialize the mailbox panel behind
   * whatever mutation happens to be in flight. When it IS passed the handle must be a real
   * transaction: a row lock taken outside one is released immediately and serializes
   * nothing, which is worse than not taking it because it reads as protection.
   */
  private async ownedRowOn(
    tx: Tx, ctx: ServiceContext, id: string, opts: { forUpdate?: boolean } = {},
  ): Promise<MailboxRow> {
    const base = tx.select().from(mailboxes)
      .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId))).limit(1);
    const [m] = await (opts.forUpdate ? base.for("update") : base);
    if (!m) throw new ServiceError("not_found", 404, "mailbox not found");
    return m as MailboxRow;
  }

  /**
   * MailboxDTO — identity + lifecycle + a per-folder sync summary. NEVER credentials.
   *
   * `messageCount` is PASSED IN rather than read here, and `undefined` means the caller did not
   * ask. The aggregate behind it is per-ACCOUNT, so computing it inside this per-mailbox
   * projection would be one full scan per row; `list` takes it once and hands each row its
   * share. Every other caller (`get`, `create`, `update`) omits the argument and the field is
   * absent from their DTOs — a single mailbox read is not a surface that asks "how many".
   */
  private async toDTO(
    ctx: ServiceContext, m: MailboxRow, messageCount?: number,
  ): Promise<MailboxDTO> {
    const fRows = await ctx.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, m.id)).orderBy(asc(mailboxFolders.folder));
    const folders: MailboxFolderSummary[] = fRows.map((f) => ({
      folder: f.folder,
      hasSyncCursor: f.highestmodseq != null,
      updatedAt: f.updatedAt.toISOString(),
    }));
    // ── OUR OWN FILINGS THIS MAILBOX HAS NOT APPLIED YET (see `MailboxDTO.pendingMoves`) ──
    //
    // A COUNT and never the rows: this DTO is read on the mailbox panel and by the shell strip,
    // and the only question either of them asks is "is there a backlog, and how big". Shipping
    // the message ids would put a list of the user's mail into a lifecycle payload for no
    // surface that wants one.
    //
    // Joined through `messages` because `folder_state` is keyed by message and carries no
    // mailbox column — the same join `listPendingFolderStates` uses, and the same three
    // predicates, so the number here and the work the reconciler will actually do are one set.
    // Written as a filtered aggregate rather than a second SELECT so it costs one round trip.
    const [pending] = await ctx.db.select({ n: sql<number>`count(*)::int` })
      .from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(
        eq(messages.mailboxId, m.id),
        eq(folderState.reconcileStatus, "pending"),
        eq(folderState.lastSetBy, "us"),
        sql`${folderState.desiredFolder} <> ${folderState.observedFolder}`,
      ));
    return {
      id: m.id,
      provider: m.provider,
      address: m.address,
      displayName: m.displayName,
      status: m.status as MailboxDTO["status"],
      authKind: m.authKind as MailboxDTO["authKind"],
      lastSyncAt: m.lastSyncAt ? m.lastSyncAt.toISOString() : null,
      // Projected only while the mailbox IS in error. The columns are already cleared on
      // recovery, so this is belt-and-braces — but the wire contract ("null unless error") is
      // one a client should not have to trust a background job to have honoured.
      errorCode: m.status === "error" ? (m.errorCode as MailboxDTO["errorCode"]) ?? "unknown" : null,
      errorDetail: m.status === "error" ? m.errorDetail : null,
      failedAt: m.status === "error" && m.failedAt ? m.failedAt.toISOString() : null,
      retryCount: m.status === "error" ? m.retryCount : 0,
      // ── NOT GATED ON `status`, UNLIKE THE FOUR ABOVE (mail 0029) ────────────────────────
      //
      // The asymmetry is the entire reason this column exists. Every state it describes — an
      // unreadable organizer lease, credentials not yet provisioned, this deployment's mailbox cap
      // — happens while `status` IS `connected`, because an infrastructure fault must never
      // quarantine a mailbox. Gating these two the way the failure four are gated would make them
      // permanently NULL on the wire, reproducing the silent not-syncing failure this column
      // exists to end, one column over. A reviewer reaching for consistency here should read this
      // paragraph first:
      // the failure four are gated because the wire contract is "null unless error"; these two ARE
      // the contract for "connected but not syncing".
      //
      // Safe to project verbatim: a closed set of three with a CHECK behind it, so no value a mail
      // server chose can reach this field — which is exactly what `errorDetail` needed an
      // allowlist at the write site to achieve.
      syncBlockedReason: isMailboxSyncBlockReason(m.syncBlockedReason) ? m.syncBlockedReason : null,
      syncBlockedSince: m.syncBlockedSince ? m.syncBlockedSince.toISOString() : null,
      // ── WHY A DISABLED MAILBOX IS DISABLED (mail 0027) ─────────────────────────────────
      //
      // Until this line the organizer lease's verdict was invisible to every client. A mailbox
      // stood down because another install holds it has `error_code` NULL and
      // `sync_blocked_reason` NULL — `markMailboxStoodDown` clears both, CORRECTLY, because a
      // stand-down is neither a failure nor an infrastructure block — so this column was the only
      // one carrying the fact, and it never left the server. Measured consequence in the field's
      // doc in `dto/types.ts`.
      //
      // GATED, and read that doc before "fixing" it into agreement with the two lines above: the
      // gate is what stops a re-enabled mailbox shipping `connected` and "somebody else holds
      // this" in one row, because the clear belongs to the worker's gate and not to `update`.
      //
      // AND AN UNRECOGNISED NON-NULL VALUE BECOMES `:unknown`, NEVER `null`. Under `disabled`,
      // `null` is the ordinary user disconnect — a different state with different copy — so
      // narrowing a fourth member to `null` the way `syncBlockedReason` may would tell an older
      // client "the user disconnected this" about a mailbox a newer worker stood down. The closed
      // set carries its own catch-all for precisely this, and `markMailboxStoodDown` applies the
      // same rule at the write site.
      disabledReason: m.status !== "disabled" ? null
        : m.disabledReason === null ? null
          : isMailboxDisabledReason(m.disabledReason) ? m.disabledReason : "organized_elsewhere:unknown",
      // WHEN the first import finished (mail 0038). Projected UNCONDITIONALLY and as `=== null` the
      // client reads it: the worker writes it once a cycle drains with no backlog, and a NULL is
      // the floor `mail-state.ts` holds under "still importing". Gating it on a status would hide
      // the partial-import case it exists to disclose.
      initialImportCompletedAt: m.initialImportCompletedAt ? m.initialImportCompletedAt.toISOString() : null,
      // UNCONDITIONAL, for the reason the sync-block pair above is: every state this number
      // describes happens while the row says `connected`. `?? 0` because `count(*)` cannot
      // return no row here, but a driver that answered `undefined` must degrade to "nothing
      // outstanding" rather than to `NaN` on somebody's strip.
      pendingMoves: pending?.n ?? 0,
      // WHAT THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT (mail 0055). UNCONDITIONAL, for
      // the reason the two lines above are: it is meaningful in every lifecycle state, and it is
      // read by the compose surface rather than by any error copy. `null` is "not known" — no
      // announcement, or never probed — and the client resolves that to the product constant, the
      // same strict fallback `effectiveAttachmentCap` applies on the send itself.
      smtpMaxSizeBytes: m.smtpMaxSizeBytes ?? null,
      /* SPREAD, not `messageCount: messageCount`. The key must be genuinely ABSENT when nobody
         asked, because absent and `0` are different answers here and a client tells them apart
         with a `typeof` guard. `JSON.stringify` would drop an explicitly-undefined property on
         the way out, so the wire would be right either way — but the in-process DTO would carry
         a key whose presence says the opposite of what it means, and `packages/api` hands these
         objects to a local host as well as to a serializer. */
      ...(messageCount === undefined ? {} : { messageCount }),
      folders,
      createdAt: m.createdAt.toISOString(),
    };
  }
}

/** Construct a write-capable MailboxService with an injected KeyProvider. */
export function makeMailboxService(deps: MailboxServiceDeps = {}): MailboxService {
  return new MailboxService(deps);
}

/** Read-only singleton (no KeyProvider) — the write methods require `makeMailboxService`. */
export const mailboxService = new MailboxService();
