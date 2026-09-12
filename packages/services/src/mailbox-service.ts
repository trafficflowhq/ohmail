import { and, asc, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole,
  mailboxes, mailboxCredentials, mailboxFolders, folderState, messages, accountSettings,
  isMailboxDisabledReason, isMailboxSyncBlockReason,
  isOrganizerRole, isOrganizerKind, isOrganizerState,
  hasCapability, CAPABILITY_REQUESTS,
  standDownMemory,
  closeRemovedMailboxAppointments,
  filingDue, filingDeferred, ourOutstandingFiling, isFilingRefusalClass,
  ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS,
  type AccessVerdict, type LedgerTx, type MailboxErrorCode, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { fenceErasedAccount } from "./erasure-fence.js";
import { sweepMailboxData, type MailboxSweepResult } from "./mailbox-erasure.js";
/* The DEFAULT policy is registered rather than imported, so the paid gate is not an import edge
 * out of a module the desktop engine bundles — this one is mounted by the local API too. The
 * full `@trafficflow/services` barrel, which only a hosted process imports, registers the gate
 * on load; `@trafficflow/services/mail` does not, and a local host passes its own policy. */
import { defaultMailboxAllowance } from "./mailbox-allowance-registry.js";
import type { KeyProvider } from "./auth/crypto.js";
import type { MailboxDTO, MailboxFolderSummary } from "./dto/types.js";
// The window's vocabulary, from the one place it is defined (core), so the ceremony that writes
// `dormancy_days` and `screening_scope` cannot disagree with the two cutlines that read them.
import { DEFAULT_DORMANCY_DAYS, type ScreeningScope } from "@trafficflow/core/mail";

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

/**
 * What {@link MailboxService.delete} was asked to do beyond disconnecting.
 *
 * `erase` ABSENT is the ordinary removal: a tombstone, the credentials deleted, the mail kept, and
 * reconnecting restores the mailbox. Present, it also erases ohmail's copy of that mailbox's mail
 * and is irreversible, so it carries its own confirmation rather than a flag.
 */
export interface MailboxDeleteOptions {
  erase?: { confirmAddress: string | null };
}

/** What a removal did. `erased` is absent unless {@link MailboxDeleteOptions.erase} was given. */
export interface MailboxDeleteResult {
  seq: bigint | null;
  erased?: MailboxSweepResult;
}

export type MailboxTakeoverResult =
  /**
   * One organizing is authorized. The worker decides on its next pass.
   *
   * `previousReason` is the stand-down reason the row carried — DERIVED, since mail 0083, by
   * `standDownMemory`: a reader row written by this build carries no `disabled_reason` at all,
   * because the ROLE is the record now, and reading the column returned `null` for every one of
   * them. A consent-less mailbox genuinely has none, and answers `null` here for a reason rather
   * than by omission. Nothing decides on it; it is the sentence the person is shown.
   */
  | { outcome: "authorized"; previousReason: string | null }
  /**
   * This install already organizes it, and consent is already recorded — no stamp is written and
   * none may be: a second press is not a second becoming. NOT "nothing written", which is what
   * this line once said and what every caller reasoned from: a `screening` block on this outcome
   * IS applied — the window and the scope are the answer the person just gave, and a re-run of
   * setup is the ordinary way to reach this branch. It can also throw a 400 from that write, on
   * the same bounds as the first-consent path. See the branch in {@link
   * MailboxService.organizeHere} for why the refusal and the write are separable.
   */
  | { outcome: "already_organizing" }
  /** Disconnected by the user, which is not a stand-down. Reconnect it instead. Nothing written. */
  | { outcome: "disconnected" };

/**
 * What {@link MailboxService.release} found, and therefore what it did (mail 0088).
 *
 * A CLOSED SET for {@link MailboxTakeoverResult}'s reason: the two non-events want two different
 * sentences and a caller that only knows "nothing happened" has to invent one. Neither is an
 * error, and that is the design — a request to stop organizing a mailbox that is not being
 * organized here has already got what it asked for.
 */
export type MailboxReleaseResult =
  /**
   * The request is recorded. The organizer honours it on its next pass — which is at most one
   * poll interval away and is what the copy has to say ("within a minute"), because the claim
   * lives in the mailbox and only the process holding that connection can expunge it.
   */
  | { outcome: "requested" }
  /**
   * This install does not organize this mailbox, so there is nothing to stop. A no-op and NOT a
   * refusal: the person's intent is already true, and it is also where a second press lands, since
   * the first one's gate demotes the row within a cycle.
   */
  | { outcome: "not_organizing" }
  /** Disconnected by the user. A removed mailbox has no organizing to stop. Nothing written. */
  | { outcome: "disconnected" };

/**
 * The optional credential half of {@link MailboxService.organizeHere} — a password re-entered
 * inside the claim ceremony. The defect: a takeover wrote a stamp saying nothing about whether
 * the mailbox still had a credential the worker could USE — claim back on a machine whose stored
 * password the provider has since invalidated: the stamp landed, the login failed, the mailbox
 * quarantined — an action that looked like it worked and left the mailbox worse. So the ceremony
 * takes a password when the caller has one, PROVES it against the real server, and stores it in
 * the SAME transaction as the stamp; a wrong password is refused before anything is written.
 * Omitted means the stored credential stands — the ordinary Cloud case.
 */
export interface OrganizeHereInput {
  imap?: { pass: string };
  /**
   * The screening window, chosen in the same breath as consent — it must ride the same
   * transaction. The defect is not the window: `screening_baseline_at` is written by THE FIRST
   * SCREENER DECIDE and nothing else, so between consenting and a first decision there is no
   * baseline and no cutoff — on a mailbox with years of history, the entire backlog moved into
   * `ohmail/Screener` physically before the person answered a single card. So consent WRITES THE
   * BASELINE, `COALESCE`d so an account that already has one keeps it — re-running onboarding
   * does not slide a live cutline forward. Absent means nothing is written at all: a claim-back
   * carries no window — the person pressed "organize here", not "reconsider my history depth".
   */
  screening?: {
    /**
     * `account_settings.dormancy_days`, 1-365. Onboarding writes **365 explicitly** for its
     * default — it does NOT change `DEFAULT_DORMANCY_DAYS`, which is 60 and pinned in three
     * places for the accounts already on it.
     */
    dormancyDays?: number;
    /** `'all_time'` is a MODE: no cutoff and no dormancy anywhere. See `ScreeningScope`. */
    scope?: ScreeningScope;
  };
}

/**
 * The stored form of a mailbox address — TRIMMED, and nothing else. Mail 0021's partial unique
 * index canonicalizes with `lower()` while the service wrote the address verbatim, so a leading
 * space made a second key identical to every IMAP server on earth — two rows, two slots, two
 * organizers on one physical mailbox. TRIM ONLY: the local part is case-sensitive per RFC 5321
 * and this column is the connect form's default IMAP username. `lower(address)` is a
 * deduplication heuristic for one account's connect form, NOT a canonicalizer. "One organizer per
 * physical mailbox" is the LEASE's invariant (mail 0027): `runLeaseGate` stands the loser down.
 * The index and the lease guard different things.
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
  /**
   * The submission host this password is being SEALED for — recorded, never dialled. Nothing
   * recorded WHICH outgoing server the password was stored for, so a configuration that moves the
   * outgoing server alone offered the password to a server the person never named. This is that
   * missing left-hand side: the caller states the outgoing host at the moment it seals; nothing
   * reads it as coordinates. Honoured on the INCOMING block only ({@link mergedTransportMeta}
   * drops it for `smtp`). Absent leaves what is stored alone. THE EMPTY STRING IS STRONGER: it
   * records a pair with NO outgoing server — "none authorized", never "unknown"; collapsing the
   * two lets an install acquire a submission server the password was never saved for.
   */
  smtpHost?: string;
  /**
   * Why the submission server is not settled — a reason code, or `""` to say it now is. An
   * outgoing server is not a reason to stop receiving: a refused submission dial used to abort
   * the whole write. Now the incoming credential is stored and the outgoing half is recorded
   * UNSETTLED with the probe's own reason; nothing is written to the `smtp` transport — an
   * unproven submission credential is what this service refuses to store — and the send path
   * reads this key to refuse honestly instead of guessing at `imap host:587`. `""` SETTLES it:
   * `undefined` leaves what is stored alone, so a repair must say so positively or a mailbox
   * carries its first refusal for ever. Incoming transport only, on {@link smtpHost}'s rule.
   */
  smtpUnsettled?: string;
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
  imap: {
    host: string; port?: number; secure?: boolean; user: string; pass: string;
    allowInsecure?: boolean;
    /** See {@link TransportInput.smtpHost} — the pair witness, carried onto the meta. */
    smtpHost?: string;
    /** See {@link TransportInput.smtpUnsettled} — why sending is not set up, or `""`. */
    smtpUnsettled?: string;
  };
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
 * The three answers, and why "store unverified" is one of them. A server answering `NO
 * [UNAVAILABLE]`/`NO [LIMIT]`, or sending `BYE`, has been REACHED — positive evidence the host,
 * port and TLS mode are right, and none about the password. Refusing that case is its own defect:
 * iCloud caps concurrent connections across ALL of an account's clients, so a user whose phone
 * and Mac hold connections could not add their mailbox at all, from a form with no way to clear
 * the condition. The client renders a row that has never completed a cycle as "connecting".
 * `code` is a {@link MailboxErrorCode} — the SAME closed taxonomy the worker emits and
 * `en.json`'s `err_*` copy is keyed on.
 */
export type MailboxProbeVerdict =
  | {
    verdict: "ok"; proven?: ProvenEndpoint;
    /**
     * HOW MANY FOLDERS the account can see, counted on the rung that answered — present only when
     * the probe was built to ask for it (the TEST action; never the create path, which has no use
     * for the number and should not pay a LIST for it).
     *
     * It is the CHECKABLE half of a success sentence. "Connected" is a claim a person cannot
     * verify; "signed in as you, 14 folders" is one they can recognise as their mailbox or not,
     * which is the same job the model count does in the AI pane's verdict. Absent means nobody
     * counted, and no reader may substitute a zero for that.
     */
    folders?: number;
  }
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
    /**
     * Which application registration issued this token — `"public"` or `"confidential"`. Omitted
     * means confidential, the redirect ceremony's door and the only one that existed before the
     * device-code flow. Stored in the credential meta because a refresh token is bound to the
     * client that obtained it, and one install can legitimately hold both kinds: a mailbox
     * connected through the operator's own confidential registration and one through the shared
     * public client. A host-wide setting would be right for one and silently kill the other —
     * Microsoft's refusal of a mismatched client renews nothing and quarantines nothing, so the
     * mailbox would simply stop receiving mail an hour after it was connected.
     */
    clientKind?: "public" | "confidential";
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
 * The same, for the OTHER door into `mailbox_credentials`. `create` required a probe and `update`
 * did not, leaving `PATCH /mailboxes/:id` re-encrypting whatever it was sent with zero connection
 * attempts — the identical defect one screen later; the sidecar names this PATCH as the desktop's
 * credential-recovery route. Required in the signature AND enforced at run time — the second half
 * is the real guard: `packages/services` compiles `src` only, so the `update` call sites are
 * never typechecked, and a parameter required in a type nobody compiles is a guard that does not
 * guard. {@link probeMissing} throws when a credential write arrives without one — the half a
 * mutation test can watch go red. Non-credential patches never reach it.
 */
export interface UpdateMailboxOptions {
  probe: MailboxProbe;
  /** As on {@link CreateMailboxOptions.smtpProbe}: optional, and injected by the hosted routes. */
  smtpProbe?: SmtpProbe;
}

/**
 * The refusal, per taxonomy member. FOUR DISTINCT SENTENCES, because a mistyped host and a wrong
 * password producing the same words is the failure the probe exists to end — the same conflation
 * the worker had to unpick, one screen earlier. Each names an OUTCOME the user can act on rather
 * than a mechanism we would have to be right about: "we could not reach that server" holds for a
 * name that does not resolve, a dead port and a host that is down, and none of those is "the
 * password is wrong". `status` splits on WHOSE input is at fault: the four the user typed are
 * 400; a throw we cannot name is 502, because "we could not tell" is a statement about us.
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
 * The `tls` refusal, split by WHY the certificate stopped the dial. Every sentence keeps the
 * guarantee — the password was never sent — and adds the one fact the user can act on. The server
 * message names NO host from the dialed certificate: the `hostname_mismatch` sentence used to
 * echo the CN/SAN of whatever answered and a CNAME-derived suggestion — behind a verified
 * session, a caller-driven disclosure of an internal hostname. The message now states only that
 * the certificate did not match; the structured `details.tls` still carries the fields for the
 * client's own vanity-CNAME UX, and the hosted probe's SSRF host guard means the dialed host is
 * public anyway — but the server's own sentence leaks nothing regardless.
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
 * The allowance gate, as a POLICY — "how many mailboxes may this account have" is a question for
 * whoever operates the service, and one of the two tiers has nobody operating it. The default
 * counts under a `FOR UPDATE` lock and refuses past the limit — right for a hosted deployment,
 * the wrong question on a desktop install with no verdict and no program to ask: before this seam
 * the local engine 500ed on every mailbox write, and it had only worked because the engine used
 * to migrate the hosted journal too — the green was produced by the defect. A policy, not a flag:
 * `if (local) skip` puts the decision inside the money path; a policy makes the tier a thing the
 * HOST states once, and makes the paid gate the value you get by saying nothing.
 */
export type MailboxAllowancePolicy = (
  tx: LedgerTx,
  accountId: string,
  now: Date,
  /**
   * The account's access verdict, read BEFORE the transaction opened, plus the re-enable
   * exclusion. Answering `access` may be a network hop, so it is never read inside this
   * transaction — see `MailboxAllowanceInput`. An unmetered policy ignores it; the paid gate
   * refuses a `null`, which means this host wired no reader at all.
   */
  input: { access: AccessVerdict | null; excludeMailboxId?: string },
) => Promise<unknown>;

export interface MailboxServiceDeps {
  /**
   * Who this deployment is to a mailbox — the id it writes into a claim. The release asks "is the
   * claim OURS", an identity question, and it was answered with `organized_by_kind === "cloud"` —
   * a CATEGORY: a second Cloud deployment is also `cloud`, and two of them over one mailbox is a
   * designed-for state. So the API cleared rows over claims it could not remove — the removal has
   * always matched on the install id. Resolved through the same function the worker uses, so the
   * halves cannot drift. Absent means this deployment does not know who it is, and every
   * comparison is then false — the safe direction: a refused hand-back costs a sentence, a silent
   * one costs the trust of every sentence beside it.
   */
  installId?: string;
  /** Envelope-encryption provider. REQUIRED for the write methods; the read
   *  methods (list/get/requestResync) never touch it — inject, don't reach global. */
  keyProvider?: KeyProvider;
  /**
   * Who may add a mailbox. Absent means the PAID GATE, and that direction is the point: a
   * deployment that forgets to inject gets METERED behaviour. The opposite default's failure mode
   * is an account with no limit on a service that meters, silently; this one's is a desktop build
   * that refuses to add a mailbox — loud, immediate, caught by the engine's own end-to-end tests.
   * There is deliberately NO permissive policy exported from this package: the only one is
   * `UNMETERED_MAILBOX_ALLOWANCE` in `apps/sidecar`, which the hosted API cannot import — a
   * bypass the Cloud host has no way to name is one it cannot take by accident. A test holds that
   * as an assertion.
   */
  allowance?: MailboxAllowancePolicy;
  /**
   * The account's access verdict, read once per write BEFORE the transaction opens. Injected for
   * the reason {@link MailboxServiceDeps.allowance} is: on the hosted tier the answer may be a
   * network hop, and this module is inside the desktop engine's import graph. ABSENT IS NOT
   * UNMETERED: a host that means unmetered supplies a reader answering `UNMETERED_ACCESS`; absent
   * means nobody wired one, and the paid gate refuses rather than admitting an unbounded create.
   * See {@link MailboxService.access}.
   */
  accessOf?: (accountId: string) => Promise<AccessVerdict>;
  /**
   * When the organizer's last pass finished, for {@link MailboxDTO.filing}'s `lastCycleAt` —
   * hosted only, injected: the fact is in `worker_heartbeats`, a CLOUD table this module may not
   * import (`packages/services` is in the desktop engine's import closure). Worth a dependency
   * because it separates a TURN from a STALL: one outstanding move is unremarkable while passes
   * land, alarming while none do. ABSENT resolves to `null`, rendered as SILENCE, never "no pass
   * has ever run" — a local install keeps no heartbeat and must not be told its organizer is
   * dead. A throw resolves to `null` too: half a status sentence beats a heartbeat read failing
   * `GET /mailboxes`.
   */
  lastOrganizerCycleAt?: (ctx: ServiceContext) => Promise<string | null>;
}

/**
 * The partial unique index from mail migration 0021, as a refusal the UI can show. `POST
 * /mailboxes` accepted the same address twice in a live deployment and left two rows — two
 * allowance slots, two worker runtimes on one physical mailbox. The index makes that impossible;
 * this turns the driver's 23505 into the sentence the second attempt deserves instead of a 500.
 * Caught AROUND the transaction, never inside it: by the time Postgres raises 23505 the
 * transaction is aborted, so a `catch` within the callback could not commit anything and would
 * only mask the error. Same shape as `auth-service.ts`'s `isUniqueViolation`.
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
 * A disabled mailbox never holds a credential — and this refusal is what makes that true rather
 * than merely intended. `delete` establishes the invariant (disable the row, delete its
 * credentials, so the worker stops), and nothing enforced it: `update` would happily upsert a
 * credential onto a tombstone. The race: thread 1 reads the row `connected` for a PATCH; thread 2
 * disables it and deletes its credentials; thread 1 commits its credential upsert — a disabled
 * mailbox owning a live IMAP secret. The lock in `update` removes the window (thread 1 blocks on
 * the row and re-reads `disabled`); this is what it does when it gets there. Re-enabling AND
 * rotating in one PATCH stays legal: the status is applied before this is evaluated.
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
 * The config a probed credential rotation is stored with, as a PURE function of the three things
 * that decide it: what is stored, what the patch says, and what the dial proved. It was inline,
 * and it is a function for one reason: `update` computes it TWICE — once outside the transaction
 * to decide what to dial, and again INSIDE it, under the row lock, to check the answer is still
 * about this mailbox. Two copies of the arithmetic would drift, and the check is worth nothing
 * unless the recomputation is bit-for-bit the same. Patch WINS field by field (the newer
 * statement about the same mailbox); the PROVEN endpoint then wins over both, because it is the
 * only one of the three that was tried.
 */
function mergedTransportMeta(
  stored: Record<string, unknown> | null | undefined,
  patch: TransportInput | undefined,
  proven: ProvenEndpoint | undefined,
  transport: ProbeTransport,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(stored ?? {}), ...metaOf(patch ?? {}) };
  /**
   * The submission host the credential is sealed for — see {@link TransportInput.smtpHost}.
   * Incoming transport only, kept OUT of {@link metaOf} because that helper is per-transport and
   * this key is not. INSIDE this function rather than added afterwards: `update` recomputes this
   * merge under the row lock — a STALE value is caught either way, and what the placement decides
   * is whether the patch's NEW statement is visible to the comparison: applied after the merge,
   * two patches that AGREE would be refused as a conflict they are not. Measured: moving this
   * line reddens the agreeing case. `undefined` is left alone; `""` is written through —
   * "authorized for none".
   */
  if (transport === "imap" && patch?.smtpHost !== undefined) merged.smtpHost = patch.smtpHost;
  /* THE UNSETTLED MARKER, on the line above's rule and inside this function for its reason: a
     repair states `""` and that statement has to be visible to `update`'s compare-and-set, or two
     patches that agree about settling the server would be refused as a conflict they are not. */
  if (transport === "imap" && patch?.smtpUnsettled !== undefined) {
    merged.smtpUnsettled = patch.smtpUnsettled;
  }
  if (proven) {
    merged.port = proven.port;
    merged.secure = proven.secure;
    /**
     * IMAP ONLY, and a STALE consent marker is REWRITTEN rather than deleted: `upsertCredOn`
     * merges meta with jsonb `||` (right side wins PER KEY, absent keys survive), so deleting the
     * key would leave yesterday's consent on a mailbox whose server now proves TLS — a consent
     * that never expires on its own is the exact downgrade this rewrite exists to prevent. A
     * mailbox that never carried the marker never gains the key, in either value. Plaintext SMTP
     * authentication is not offered at all, so there is no marker on that side to keep honest.
     */
    if (transport === "imap") {
      if (proven.insecure === true) merged.insecureConsent = true;
      else if (merged.insecureConsent !== undefined) merged.insecureConsent = false;
    }
  }
  return merged;
}

/**
 * What a pre-transaction probe hands back to `update`: the config it dialled and the endpoint the
 * dial proved. Both halves are needed to rebuild the merge under the row lock — the second because
 * a proven port/TLS mode is part of what would be written, so a rebuild without it would compare
 * two different things and pass for the wrong reason.
 */
interface ProbedMeta {
  meta: Record<string, unknown>;
  proven: ProvenEndpoint | undefined;
}

/**
 * Key-order-independent JSON, so two `meta` objects that say the same thing compare equal.
 *
 * Written out rather than `JSON.stringify(a) === JSON.stringify(b)` because the two sides reach
 * this from different places — one built by spreading a driver-parsed jsonb over a request body,
 * the other by spreading a second driver-parsed jsonb — and insertion order is not part of what
 * either of them means. RECURSIVE because `meta` is not always flat: an OAuth mailbox stores its
 * submission coordinates as a nested `meta.smtp` object.
 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/**
 * A rotation whose merge went stale while it was being verified. 409 — not a silent skip, not a
 * 200: the caller asked for a password to be stored, and the only honest answers are "stored" and
 * "not stored"; a skip would answer 200 to a client that then believes a secret is in place. NOT
 * flagged `retryable`: retrying is exactly right for a HUMAN and the sentence says so, but the
 * flag is read by transports that retry on their own (`HttpAdapter.rejectionOf`), and an
 * automatic retry would re-dial somebody's mail server without being asked — a connection cost,
 * and a way to walk into a provider's lockout.
 */
/**
 * A probe whose middle verdict is a refusal — see {@link MailboxService.organizeHere}.
 *
 * A WRAPPER rather than a flag on `probedImapMeta`, so the policy travels with the CALL that
 * needs it and no other caller can be moved onto it by editing a default. It changes no sentence:
 * `probeRefused` maps the same `MailboxErrorCode` the permissive path would have stored, so the
 * person is told the same true thing about their provider and is simply not authorized on it.
 */
const proveOrRefuse = (probe: MailboxProbe): MailboxProbe => async (input) => {
  const v = await probe(input);
  return v.verdict === "store_unverified" ? { verdict: "refuse", code: v.code } : v;
};

/**
 * A claim on a mailbox with no stored IMAP credential — see the check inside `organizeHere`.
 *
 * `422` and not `409`: nothing is in conflict, the request is simply missing the one thing it
 * needs. `retryable: false`, because retrying the identical request changes nothing — what
 * changes it is the person typing a password, which is what the sentence asks for.
 */
const credentialNeeded = (): ServiceError => new ServiceError(
  "credential_needed", 422,
  "This mailbox has no password stored on this install, so organizing it would fail at the first "
  + "connection. Enter the mailbox password to organize it here.",
  undefined, false,
);

const configMoved = (transport: ProbeTransport): ServiceError => new ServiceError(
  "mailbox_config_changed", 409,
  transport === "smtp"
    ? "This mailbox's outgoing (SMTP) server settings changed while this password was being " +
      "checked, so it was not stored. Try again."
    : "This mailbox's server settings changed while this password was being checked, so it was " +
      "not stored. Try again.",
  { transport },
);

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
/**
 * One instant, in the fixed wire form the pull baseline is compared in —
 * `YYYY-MM-DDTHH:MM:SS.mmmZ`. This used to be rendered in SQL, not because SQL had to do it but
 * because the bare cast renders at the SERVER's configured date style — a space separator and a
 * `+00` offset — which `Date.parse` is not required to accept: a rejected format is a NaN
 * baseline and a spinner that runs to its cap. `toISOString()` produces exactly the format SQL
 * was asked for, asserted against the old SQL output rather than assumed. Doing it here also
 * means the statement carries nothing only one store can render — what let this projection stop
 * being Postgres-only.
 */
export function wireInstant(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

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
   * The account's access verdict, read OUTSIDE any transaction — the allowance gate needs it and
   * may not ask for it under a row lock.
   *
   * `null` when this host declared no reader, and that is NOT unmetered: an unmetered host says so
   * with a verdict carrying null limits. Defaulting to unmetered here would have silently removed
   * the plan limit from any host that wired the paid gate and forgot this — the exact failure
   * `mailbox-allowance-registry.ts` refuses by name one seam over, reintroduced one seam up. The
   * paid gate refuses a `null`; the unmetered policy ignores it.
   */
  private async access(accountId: string): Promise<AccessVerdict | null> {
    return this.deps.accessOf ? this.deps.accessOf(accountId) : null;
  }

  /**
   * List the account's mailboxes. The counts variant is OPT-IN, and the default path runs no
   * aggregate over `messages`: this route is POLLED — the shell reads it every 30 s in every open
   * tab, Settings every 10 s — and `messageCount` is an aggregate over the account's whole
   * message history, so it is computed only for `GET /mailboxes?counts=1` and ABSENT otherwise,
   * never sent as `0`. ONE statement for the whole account, taken BEFORE the per-mailbox loop:
   * reading the count inside `toDTO` would be one aggregate per mailbox, the shape this method
   * already pays twice for folders and pending moves and must not pay a third time over a table
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
   * How many messages each mailbox holds, in one grouped statement. Invariant #9 lives in the
   * WHERE: `eq(messages.accountId, ctx.accountId)` is in the SAME statement as the `GROUP BY` —
   * not redundant, because `messages.account_id` has no foreign key tying it to
   * `mailboxes.account_id`, so a row whose mailbox is ours and whose account is somebody else's
   * is a state the database permits (the operator dedup resolver leaves exactly that). A
   * real-Postgres test seeds that row and goes red when the predicate is removed. The index leads
   * on the scope predicate. `::int` because `count(*)` is `bigint` and postgres-js hands bigint
   * back as a STRING.
   */
  private async messageCounts(ctx: ServiceContext): Promise<Map<string, number>> {
    const rows = await ctx.db
      .select({
        mailboxId: messages.mailboxId,
        n: dialect(ctx.db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number>,
      })
      .from(messages)
      .where(eq(messages.accountId, ctx.accountId))
      .groupBy(messages.mailboxId);
    return new Map(rows.map((r) => [r.mailboxId, r.n]));
  }

  async get(ctx: ServiceContext, id: string): Promise<MailboxDTO> {
    return this.toDTO(ctx, await this.ownedRow(ctx, id));
  }

  /**
   * Connect a mailbox: insert the row, envelope-encrypt the password(s) per transport; `meta`
   * carries only non-secret params. The limit gate and the insert are ONE transaction, in this
   * order: `assertMayAddMailbox` takes `FOR UPDATE` on the account row before counting, so two
   * creates at limit−1 admit exactly one. Row and credentials commit together (separate
   * autocommits once left a connected mailbox with no login). The credentials are TRIED FIRST —
   * this used to answer 201 `connected` for host `nope.invalid`. Probed BEFORE the transaction:
   * the runtime handle is `max: 1`. Oauth skips; what is probed is what is stored. SMTP is probed
   * too when `opts.smtpProbe` is injected.
   */
  /**
   * Try a login and say what happened. Writes nothing, stores nothing, creates no mailbox. The
   * only way to learn whether details worked used to be submitting them — the affirmative half of
   * the verdict had never been written. It shares `create`'s refusal BY CONSTRUCTION: a failure
   * throws exactly what a failing `create` throws ({@link probeRefused}, same code, taxonomy,
   * {@link ProbeTlsDetail}), so every client renders a test failure with no new copy; only
   * SUCCESS needed a new sentence. "Ok" includes the FOLDER COUNT: an accepted LOGIN does not
   * prove the account can READ anything. No ownership check (a PRE-create action); the injected
   * probe closure bounds it: the SSRF/port guard, the admission counter, the deadline.
   */
  async probeConnection(
    ctx: ServiceContext,
    input: { address: string; imap: { host: string; port?: number; secure?: boolean; user?: string; pass: string } },
    opts: { probe: MailboxProbe },
  ): Promise<{ ok: true; host: string; user: string; folders: number | null }> {
    const address = canonicalAddress(input.address ?? "");
    if (!address) throw new ServiceError("validation_failed", 400, "address is required");
    const host = (input.imap?.host ?? "").trim();
    if (!host) throw new ServiceError("validation_failed", 400, "imap.host is required");
    if (!input.imap?.pass) throw new ServiceError("validation_failed", 400, "imap.pass is required");
    // The username defaults to the address, which is what every provider preset does and what the
    // connect form fills in. Defaulted HERE rather than at the route so the test and the create
    // that follows it dial the same identity — a test that quietly proved a different username
    // than the create would use is worse than no test.
    const user = (input.imap.user ?? "").trim() || address;

    const verdict = await opts.probe({
      accountId: ctx.accountId,
      address,
      imap: { host, port: input.imap.port, secure: input.imap.secure, user, pass: input.imap.pass },
    });

    if (verdict.verdict === "refuse") throw probeRefused(verdict.code, verdict.tls);
    // `store_unverified` is reported as a FAILURE here — the one place this method parts company
    // with `create`. There, the verdict means "the server was reached and declined to serve right
    // now" — positive evidence about host, port and TLS, none about the password — so the
    // credential is stored and the mailbox reads "connecting": right when the goal is to ADD the
    // mailbox. The goal here is the opposite: the question is "did this work", and the honest
    // answer when the server said `NO [UNAVAILABLE]` is no — reporting ok would put a green
    // verdict naming a folder count it never read on screen. It carries `connect`, whose sentence
    // already says the server could not be reached properly and to try again.
    if (verdict.verdict === "store_unverified") throw probeRefused(verdict.code);

    return {
      ok: true,
      // The PROVEN host, not the typed one where they differ — the verdict names the rung that
      // actually answered, and the sentence on screen should name what answered.
      host: verdict.proven?.host ?? host,
      user,
      // `null` when the ok verdict carries no count: a probe built without the folder-listing
      // option, or an adapter that cannot list. The COPY decides what to do with that; inventing a
      // zero here would render "0 folders" over a mailbox nobody counted.
      folders: verdict.folders ?? null,
    };
  }

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
      // host used to store a credential the worker cannot log in with — and a probe fed the same
      // body answered "we could not reach that mail server", a true sentence about the wrong
      // thing. The PORT is no longer required: its absence asks the probe to walk the standard
      // ladder (993 implicit TLS, then 143 STARTTLS) and the proven combination is what gets
      // stored. A present port still has to be one a server could listen on — `0` used to be
      // caught by the old requiredness check as falsy, and dropping that check must not quietly
      // turn an impossible port into a dial.
      if (!body.imap.host) {
        throw new ServiceError("validation_failed", 400, "imap host is required");
      }
      if (body.imap.port !== undefined && !isValidPort(body.imap.port)) {
        throw new ServiceError("validation_failed", 400, "imap port must be an integer between 1 and 65535");
      }
      if (body.smtp?.port !== undefined && !isValidPort(body.smtp.port)) {
        throw new ServiceError("validation_failed", 400, "smtp port must be an integer between 1 and 65535");
      }

      // No duplicate pre-check, and the reason is a guard it would have blinded. A pre-check
      // would answer BEFORE mail 0021's index does — and the only test that watches
      // `isActiveAddressConflict` map 23505 to a 409 on this path drives it by inserting a
      // colliding row first, so a pre-check would keep that test green while the mapping it
      // exists for went unexercised. It is also a second implementation of a partial unique
      // index, and it has a race the index does not: a row deleted between the read and the
      // insert would let a create through that had skipped its probe. The dial it saves is
      // already bounded — one address gets at most `MAX_PROBES_PER_ADDRESS` concurrent probes.
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

    // Read the access verdict BEFORE the transaction: answering it may be a network hop, and a
    // remote call under the account's row lock is the deadlock the send pass already records.
    const access = await this.access(ctx.accountId);

    const mb = await asTx(ctx).transaction(async (tx) => {
      // The gate FIRST: it takes the lock every later statement is serialized behind.
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { access });

      const [row] = await tx.insert(mailboxes).values({
        accountId: ctx.accountId,
        provider: body.provider,
        address,
        displayName: body.displayName ?? null,
        authKind,
        // A new mailbox is a CONSENT-LESS READER (mail 0083). Connecting is not consenting to be
        // organized, and until this line the two were the same act: the row was born an
        // organizer, the worker's first cycle claimed the empty `ohmail/_meta`, created the tree
        // and filed the backlog — before the person had seen a consent screen. A fresh mailbox
        // READS: its mirror builds at once, nothing moves, `ohmail/*` never appears;
        // `organizeHere` is the one door that changes that. BOTH columns, not one:
        // `organizerRole` alone would still be promoted by the gate (which reads consent), and
        // `organizeConsentedAt` alone would leave the DTO claiming this install organizes a
        // mailbox it was not asked to. The column's DEFAULT stays `'organizer'` so an un-updated
        // writer behaves as it always did.
        organizerRole: "reader",
        organizeConsentedAt: null,
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
        /**
         * The two witnesses `metaOf` does not carry. `metaOf` is PER TRANSPORT and both of these
         * are statements about the PAIR, so they are applied here exactly as
         * `mergedTransportMeta` applies them on the update path — and they have to be, because a
         * CREATE is the only way a mailbox added through a door ever gets them: without this, the
         * add route's unsettled marker was written into a body that reached a meta builder which
         * drops it, and the DTO reported `null` — a mailbox whose submission server had just been
         * refused claiming sending was fine. Both are `!== undefined` rather than truthy: `""` is
         * a positive statement on each, and a falsy test would silently discard it.
         */
        if (body.imap.smtpHost !== undefined) meta.smtpHost = body.imap.smtpHost;
        if (body.imap.smtpUnsettled !== undefined) meta.smtpUnsettled = body.imap.smtpUnsettled;
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
      return row!;
    }).catch((err: unknown) => {
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });

    return this.toDTO(ctx, mb);
  }

  /**
   * Connect or reconnect an OAuth2 mailbox — the write end of the consent ceremony. Neither `POST
   * /mailboxes` nor `PATCH` can serve this: nobody typed the address (it comes from the
   * `id_token`'s `preferred_username`, so this method resolves the row itself), and a reconnect
   * and a first connect are the same button. `mailboxes_active_address_uq` guarantees at most one
   * live mailbox per address; DISABLED rows are excluded — reviving a tombstone would resurrect a
   * mailbox somebody removed, so a fresh consent for a disconnected address CREATES. A racing row
   * is caught by the 23505 → 409 mapping. Probed BEFORE stored; a refused probe writes NOTHING —
   * the existing mailbox keeps the only credential an oauth mailbox has.
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
      /*
       * WRITTEN ONLY WHEN IT IS THE PUBLIC DOOR, so no existing row's meta changes shape and the
       * absent value keeps its established meaning (`wantedClientKind` reads absent as
       * confidential). A field written unconditionally would have been the same behaviour and a
       * larger diff against every stored credential, for no reader's benefit.
       */
      ...(o.clientKind === "public" ? { clientKind: "public" } : {}),
      ...(o.smtp ? { smtp: { host: o.smtp.host, port: o.smtp.port, secure: o.smtp.secure } } : {}),
    };

    // The access verdict, read BEFORE the transaction: answering it may be a network hop, and a
    // remote call under the account's row lock is the deadlock the send pass already records.
    const access = await this.access(ctx.accountId);

    const out = await asTx(ctx).transaction(async (tx) => {
      const [existing] = await dialect(ctx.db).forUpdate(tx.select().from(mailboxes)
        .where(and(
          eq(mailboxes.accountId, ctx.accountId),
          sql`lower(${mailboxes.address}) = lower(${address})`,
          sql`${mailboxes.status} <> 'disabled'`,
        ))
        .limit(1));

      if (existing) {
        const row = existing as MailboxRow;
        /**
         * A fresh consent ends the outage episode — the same four columns `update` clears, for
         * the same reason: `markMailboxFailed` COALESCEs `failed_at`, so a value left behind is
         * inherited by the NEXT, unrelated failure and reported as a multi-day outage on attempt
         * nine. The sync block goes with it (mail 0029) — reconnecting is a request to try again,
         * and `reconcileSyncBlocks` re-writes it within one roster pass if the mailbox is still
         * unserved. `status` is NOT asserted `connected` beyond leaving the error state: only the
         * worker's verified recovery says a mailbox works. What changed is that the row starts a
         * CLEAN episode on a credential this method just dialled successfully.
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
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { access });

      const [created] = await tx.insert(mailboxes).values({
        accountId: ctx.accountId,
        provider: input.provider,
        address,
        displayName: input.displayName ?? null,
        authKind: "oauth",
        // A consent-less reader, exactly as the password `create` above — see its note. An OAuth
        // connect is a connect: the door differs, the meaning does not.
        organizerRole: "reader",
        organizeConsentedAt: null,
      }).returning();
      await this.upsertCredOn(tx, ctx, kp, created!.id, "imap", o.refreshToken, meta);
      // Same hook, same transaction, as `create` — an OAuth connect of a NEW address is a
      // create in every sense that matters here (a reconnect returned above and grants nothing).
      return { created: true, row: created as MailboxRow };
    }).catch((err: unknown) => {
      if (isActiveAddressConflict(err)) throw addressTaken();
      throw err;
    });

    return { created: out.created, mailbox: await this.toDTO(ctx, out.row) };
  }

  /**
   * Patch mailbox fields and, with new secrets, re-encrypt + upsert the credential row(s); 404 if
   * not owned. RE-ENABLING IS A CREATE: `delete` is a soft delete, so without this gate the limit
   * is trivially bypassed; only the disabled → not-disabled TRANSITION is gated. It may not step
   * around the worker's failure state machine (mail 0023): `status: 'error'` from a client is
   * refused, and leaving `error` clears the four outage columns in the same UPDATE — `failed_at`
   * is COALESCEd, so a stale episode would be inherited by the next failure. A rotated credential
   * is probed; `opts` is optional where `create`'s is not — the enforcement is the runtime throw
   * in {@link probedImapMeta}, mutation-checked at the API layer.
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
     * The rotated credential is tried BEFORE it replaces a working one — before the transaction,
     * for `create`'s reason plus one more: this transaction holds `FOR UPDATE` on the mailbox
     * row, so a probe inside it would hold a ROW LOCK across somebody else's mail server going
     * quiet. The pre-read is UNLOCKED and trusted for only two decisions the transaction makes
     * again: the 404 before the dial (without it, `PATCH /mailboxes/<guessed-uuid>` is a connect
     * oracle for arbitrary `host:port`), and the stored transport config the merge needs. The
     * transaction re-reads `FOR UPDATE`; a row that changes in between costs one wasted dial,
     * never a wrong write.
     */
    const merged = patch.imap?.pass
      ? await this.probedImapMeta(ctx, id, patch, opts)
      : undefined;

    // The SMTP sibling, before the transaction for the same two reasons — and only when the
    // host injected a prober; without one the write below stores the plain patch, as ever.
    const mergedSmtp = patch.smtp?.pass && opts?.smtpProbe
      ? await this.probedSmtpMeta(ctx, id, patch, opts.smtpProbe)
      : undefined;

    // The access verdict, read BEFORE the transaction: answering it may be a network hop, and a
    // remote call under the account's row lock is the deadlock the send pass already records.
    const access = await this.access(ctx.accountId);

    return asTx(ctx).transaction(async (tx) => {
      // `FOR UPDATE`, and it is the fix for a race between two concurrent PATCHes.
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
      // The sync block goes with ANY status move (mail 0029). Not gated on `current.status ===
      // "error"`, and the difference from the four above is not an inconsistency: a sync block
      // happens while the status is `connected`, so an `error` gate would never fire. The block
      // is THIS PROCESS's report about the worker's relationship to the mailbox, and both
      // directions of a status move invalidate it — disconnecting ends it (a tombstone carries no
      // explanation), reconnecting makes the old reason unverified. Clearing is SAFE precisely
      // because the worker re-writes it: `reconcileSyncBlocks` writes on every roster pass while
      // the block lasts.
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
        await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { access, excludeMailboxId: id });
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

      /**
       * The merge is RE-DERIVED under the lock before it is written. The probe ran outside this
       * transaction, so its merge came from an UNLOCKED read — a concurrent patch committing in
       * between is silently undone by every key the stale read carried (a password-only patch
       * that read host A commits A over the host the user just moved to B). The `FOR UPDATE` does
       * not cover it: the lost value is in `mailbox_credentials.meta`, not the locked row. The
       * check is a COMPARE-AND-SET, not a re-merge — re-merging would store a combination no
       * probe ever tried. A REBUILD, so two patches that AGREE are not a false conflict. Both
       * writers take the row lock first, so this read is serialized.
       */
      if (merged) await this.assertMergeCurrent(tx, id, "imap", patch.imap, merged);
      if (mergedSmtp) await this.assertMergeCurrent(tx, id, "smtp", patch.smtp, mergedSmtp);

      // `merged`, NOT `metaOf(patch.imap)` — what is stored must be exactly what was dialled.
      // Passing the patch alone would store a config the probe never tried (and, before the
      // `upsertCredOn` fix below, would also erase the stored port/user/secure while doing it).
      if (patch.imap?.pass) await this.upsertCredOn(tx, ctx, kp, id, "imap", patch.imap.pass, merged?.meta ?? {});
      // PROBED when the host injects `smtpProbe`, like `create` — the same vanity-CNAME shape
      // reaches this door via the edit form. `mergedSmtp` was dialled before this transaction
      // opened; where no prober is injected it is the plain merge, the pre-probe behaviour — and
      // that arm needs no staleness check, because it reads nothing to go stale.
      if (patch.smtp?.pass) await this.upsertCredOn(tx, ctx, kp, id, "smtp", patch.smtp.pass, mergedSmtp?.meta ?? metaOf(patch.smtp));

      const [row] = await tx.select().from(mailboxes)
        .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId))).limit(1);
      // NO-CREDENTIAL-REPORT: a context derived onto the transaction's handle, and it is safe
      // because `toDTO` is a projection — it reads a row and shapes a DTO, it never mints or
      // rotates a session and so can never reach `noteCredentialAccount`. If that ever stops
      // being true this must move to `runInTransaction`, whose buffer holds a report until the
      // commit. `credential-report-commit-side.test.ts` requires this marker on every derivation
      // outside `context.ts`, so the next one cannot arrive silently.
      return this.toDTO({
        ...ctx, db: carryDialect(ctx.db, tx as object) as unknown as ServiceContext["db"],
      }, row!);
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
   * Disconnect a mailbox. SOFT delete: `status='disabled'` AND remove its credential rows so the
   * worker stops. Deliberately no hard delete — `messages.mailbox_id` FK-references the row, and
   * a hard delete would orphan real message history. 404 if not owned. ONE TRANSACTION, UNDER A
   * ROW LOCK: this used to be three autocommits (an unlocked read, the status flip, the
   * credential delete), leaving two windows a concurrent credential PATCH could commit into — the
   * second ends with a disabled mailbox that still owns a live IMAP secret. The lock is taken in
   * the same order as the dedup resolver's, and `update` takes it too, so no two of the three can
   * interleave into that state and none can deadlock.
   */
  /**
   * @returns the `change_log` seq this removal emitted, or null when it closed no appointment.
   *   The route echoes it as `X-Sync-Seq` — see the close below.
   */
  async delete(
    ctx: ServiceContext, id: string, opts: MailboxDeleteOptions = {},
  ): Promise<MailboxDeleteResult> {
    return asTx(ctx).transaction(async (tx) => {
      /* ── THE ERASURE FENCE, FIRST IN THE TRANSACTION ────────────────────────────────────
       *
       * This transaction writes `mailboxes` — a table the account sweep empties and that has no
       * foreign key to any row erasure deletes — so a removal in flight across an Art. 17 erasure
       * could otherwise commit a tombstone after the sweep counted zero. `erasure-fence.ts` holds
       * the two-sided argument and states why the account row is read FIRST: it is the head of
       * the global lock order, and a fence in the middle of a writer would be the deadlock pair.
       */
      await fenceErasedAccount(tx as unknown as Tx, dialect(ctx.db), ctx.accountId);
      /* The account's thread-structure lock, BEFORE the mailbox row and only when erasing.
       * `deleteAccount` takes it before `mailboxes` too, so both sweeps acquire in one order and
       * neither can be the other's deadlock partner; the disconnect path touches no message or
       * thread row and pays nothing.
       *
       * THROUGH THE SEAM, like the fence above, because this file runs on the device store too:
       * raw, it is not a statement that store refuses but a METHOD its handle does not have, so
       * an erasing removal on a phone threw and rolled back. The device arm is a no-op — one
       * serialized writer is the ordering this lock buys on the server. */
      if (opts.erase) {
        await dialect(ctx.db).advisoryLock(tx, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, ctx.accountId);
      }
      const row = await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned
      /* ── THE SECOND CONFIRMATION, CHECKED AGAINST THE ROW AND NOT AGAINST A FLAG ────────
       *
       * An erase is irreversible: it removes ohmail's copy of the mailbox's mail. A boolean the
       * caller sets is not a confirmation of anything, so the caller echoes the mailbox's own
       * address and the server compares it to the row it is about to erase — which also refuses
       * an erase aimed at the wrong id. Case and surrounding space are not part of the answer.
       */
      if (opts.erase) {
        const given = (opts.erase.confirmAddress ?? "").trim().toLowerCase();
        if (given === "" || given !== row.address.trim().toLowerCase()) {
          throw new ServiceError("erase_not_confirmed", 400,
            "confirm the erasure by repeating this mailbox's address");
        }
      }
      await tx.update(mailboxes).set({
        status: "disabled",
        // And the lease columns go with it (mail 0027). `disabled_reason` is WHY the ORGANIZER
        // stopped, and a user disconnecting makes that statement untrue in the only way that
        // matters: they are not asking why it is not syncing, they said stop. Left behind, the
        // tombstone would tell somebody "another ohmail install has claimed this mailbox" about a
        // mailbox they deliberately removed — the class of false statement that copy exists to
        // end, introduced by the fix for it. The rule is `packages/db/src/mailbox-errors.ts`'s:
        // every writer that makes the statement untrue clears it in the same statement. The four
        // worker writers hold it; this was the one caller that did not, because until now nothing
        // read the column.
        disabledReason: null,
        // §4, "No seize-back". An authorization is permission for ONE becoming, and disconnecting
        // ends the relationship it was granted inside. Left set, it would be spent by whatever
        // re-enabled the row months later — the standing right the one-shot rule forbids.
        takeoverAuthorizedAt: null,
        /**
         * And the release request, for the mirror reason (mail 0088). Worse to leave standing
         * than the stamp above: a release is honoured by a BACKGROUND pass, so a tombstone
         * carrying one is a request a worker would act on, minutes later, against a mailbox the
         * person removed. Caught by the race in `mailbox-takeover.concurrency.pg.test.ts`: a
         * release committing first and a disconnect second leave exactly this row, and the two
         * doors serialize on the same `FOR UPDATE`. `organizer_released_at` goes with it: a
         * removal is not a release — the row is a tombstone; nobody organizes it and nobody
         * stopped organizing it.
         */
        releaseRequestedAt: null,
        organizerReleasedAt: null,
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
      // And the appointments this removal orphans, in the same transaction. A removal deletes the
      // credentials, so there is no longer a submission server — and until now nothing closed the
      // row: `send_at` stayed in the future and Drafts said "Sends Tue 14:50" for a time that had
      // gone. The stand-down's close cannot cover it BY CONSTRUCTION: its precondition requires a
      // `disabled_reason`, which the statement above clears because a removal is not a handover.
      // AFTER the tombstone write (the close reads the row), inside the same transaction (between
      // them: no credentials, a live appointment). THROWS: a half-happened removal is worse than
      // one that can be retried. ITS SEQ IS THE ANSWER: dropping it left a bare 204 with no
      // `X-Sync-Seq` to wait for — every write advances the sequence it echoes.
      const { seq } = await closeRemovedMailboxAppointments(tx, {
        accountId: ctx.accountId, mailboxId: id, now: ctx.now(),
      });
      if (!opts.erase) return { seq };
      /* The sweep runs LAST and inside this transaction: the tombstone above has to be visible to
       * it, and both halves commit together — a mailbox whose mail is gone while its credentials
       * remain is worse than an erasure that failed and can be retried. */
      const erased = await sweepMailboxData(tx, { accountId: ctx.accountId, mailboxId: id });
      /* The sweep's seq wins where it allocated one: it is the LATER change and the per-account
       * seq is gap-free, so a mirror that waits for it has seen the appointment closures too. */
      return { seq: erased.seq ?? seq, erased };
    });
  }

  /**
   * Force a reconcile pass. Clearing each folder's CONDSTORE cursor + delta_token
   * makes the worker re-scan from scratch on its next cycle (durable marker).
   */
  async requestResync(ctx: ServiceContext, id: string): Promise<void> {
    await this.ownedRow(ctx, id); // 404 if not owned
    /**
     * A reader does not re-sync a mailbox it does not organize (mail 0083). This nulls every
     * folder's `highestmodseq` and delta token, making the next cycle walk the mailbox from
     * scratch. On an ORGANIZER that is a repair; on a reader it is a full re-read of somebody
     * else's mailbox — every folder, every UID — with no decision at the end, paid for in the
     * customer's provider rate limits and ours. It is also the one door on this list whose damage
     * is not to the mail: a reader can re-read its own mirror by other means, and the honest
     * answer to "the mirror looks wrong" on a reader is that the ORGANIZER owns the repair.
     */
    await assertOrganizerRole(asTx(ctx), dialect(ctx.db), ctx.accountId, id);
    await asTx(ctx).update(mailboxFolders)
      .set({ highestmodseq: null, deltaToken: null, updatedAt: ctx.now() })
      .where(eq(mailboxFolders.mailboxId, id));
  }

  /**
   * Dismiss the forwarding-detection notice (mail 0078) — "this mailbox is quiet and I know it".
   * One timestamp, stamped over whatever stood (a repeat press only makes it MORE durable; the
   * client compares `dismissedAt < since`). The worker never clears it; the notice returns only
   * when a NEW episode's `since` postdates it — "state changes re-notify, sameness holds", two
   * instants instead of a state machine. Deliberately legal with NO episode standing: refusing a
   * dismissal because the episode cleared a second ago would 409 a person agreeing with us. No
   * change_log row; the panel polls `GET /mailboxes`.
   */
  async dismissInboundQuiet(ctx: ServiceContext, id: string): Promise<MailboxDTO> {
    await this.ownedRow(ctx, id); // 404 if not owned
    await asTx(ctx).update(mailboxes)
      .set({ inboundQuietDismissedAt: ctx.now() })
      .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId)));
    return this.toDTO(ctx, await this.ownedRow(ctx, id));
  }

  /**
   * Dismiss the organizer notice (mail 0088) — "yes, I know who organizes this". The same
   * two-instant shape as `dismissInboundQuiet`: the notice is `organizer_event_at >
   * coalesce(seen_at, -infinity)`, so a dismissal is one timestamp; it suppresses only an event
   * that PREDATES the press. Deliberately legal with no event standing: the gate stamps on a
   * sixty-second cycle while a person is looking at the notice, and refusing because the row
   * moved a second ago would 409 somebody agreeing with us. No step-up, and that is an argument:
   * this decides whether a line is on a screen — a second factor would teach people that
   * dismissing a notice is dangerous. No `change_log` row; the panel polls.
   */
  async dismissOrganizerNotice(ctx: ServiceContext, id: string): Promise<MailboxDTO> {
    await this.ownedRow(ctx, id); // 404 if not owned
    await asTx(ctx).update(mailboxes)
      .set({ organizerEventSeenAt: ctx.now() })
      .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId)));
    return this.toDTO(ctx, await this.ownedRow(ctx, id));
  }

  /**
   * Stop organizing this mailbox here, and keep my mail (mail 0088) — the mirror of {@link
   * organizeHere}. IT AUTHORIZES A CEASING, IT DOES NOT PERFORM ONE: the claim lives in the
   * customer's IMAP folder, and IMAP writes belong to the process holding the connection — this
   * writes one timestamp; the organizer's next pass honours it FIRST, releases the claim, writes
   * the reader role, closes the appointments, clears the column. The `FOR UPDATE` is the same
   * lock the other three doors take, so the four serialize — a release and a claim-back are
   * opposite instructions. A tombstone is refused, never revived. A mailbox this install does NOT
   * organize is a no-op that answers honestly: the person's intent is already true.
   */
  async release(ctx: ServiceContext, id: string): Promise<MailboxReleaseResult> {
    return asTx(ctx).transaction(async (tx) => {
      const current = await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned
      // The tombstone, checked before the role for `organizeHere`'s reason: a removed mailbox's
      // role says nothing about it.
      if (current.status === "disabled") return { outcome: "disconnected" as const };
      /**
       * The question is who HOLDS the claim, not whether this row is organizing. An install can
       * stop organizing WITHOUT its claim leaving the mailbox (only the holding process can
       * remove the record); in that state every install reads it and stands down — nothing files
       * the mailbox and every row says something else does. The row is `reader` BY DEFINITION
       * there, so the old `organizerRole !== "organizer"` test refused precisely the request that
       * fixes it. What stays refused, and must not widen: a claim whose install id is not this
       * one is ANOTHER install's — whatever its KIND — and a row with no holder has nothing to
       * give up. Both answer `not_organizing`, a success: the person's intent is already true.
       */
      const organizing = current.organizerRole === "organizer";
      /**
       * The IDENTITY, not the category. `organized_by_kind === "cloud"` was the first spelling
       * and wrong where it matters: `cloud` is what ANOTHER Cloud deployment is too, and their
       * ids differ by design. Against a foreign Cloud claim that comparison said "ours", the row
       * was cleared, and the removal — which matches on the install id — found nothing: the row
       * read released while the claim stayed in the folder. A NULL stored id, or a deployment
       * that does not know its own, compares false — the safe and honest direction; such a row
       * keeps the takeover ceremony, the remedy that works on a claim somebody else holds.
       */
      const ourStrandedClaim = current.organizerRole === "reader"
        && this.deps.installId !== undefined
        && current.organizedByInstallId !== null
        && current.organizedByInstallId === this.deps.installId;
      if (!organizing && !ourStrandedClaim) return { outcome: "not_organizing" as const };
      await tx.update(mailboxes)
        .set({
          // NOT the role, and not the holder columns. **The GATE demotes**, exactly as it promotes,
          // and for the same reason: flipping the role here would make a button in a browser the
          // thing that decides who organizes a mailbox, with no reference to what the mailbox
          // itself says — and it would leave a live claim standing in `ohmail/_meta` under a row
          // that denies it.
          releaseRequestedAt: ctx.now(),
          // The block is this process's report about the worker's relationship to the mailbox, and
          // this request invalidates it in both directions — `update` and `organizeHere` apply the
          // same rule. The worker re-writes it within one pass if it is still true.
          syncBlockedReason: null,
          syncBlockedSince: null,
        })
        .where(and(
          eq(mailboxes.id, id),
          eq(mailboxes.accountId, ctx.accountId),
          // Never revive a tombstone. Unreachable past the guard above — the row lock plus the
          // re-read is what actually orders this against `delete` — and it stays for
          // `organizeHere`'s stated reason: an UPDATE that is safe only because of a lock taken
          // thirty lines earlier is one refactor away from being unsafe, and the refactor would
          // fail nothing.
          ne(mailboxes.status, "disabled"),
        ));
      return { outcome: "requested" as const };
    });
  }

  /**
   * Ring the worker's doorbell for every connected mailbox — the "Pull new mail" server half
   * (mail 0049). NOT {@link requestResync}: a resync clears every CONDSTORE cursor and re-walks
   * the mailbox — the heaviest thing a POST can ask; this stamps one nullable column and the kick
   * scan serves one ORDINARY bounded batch out of turn. The rate limit lives in the UPDATE's
   * predicate: a stamp younger than {@link MailboxService.PULL_MIN_GAP_MS} is left standing — the
   * column IS the state. One transaction, row locks first, DB clock throughout: PER MAILBOX (a
   * young stamp keeps its own bar); ATOMIC against the kick's compare-and-clear; the DATABASE's
   * clock on both sides, so no host or client wall clock enters the comparison.
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
      // this stamp — the set is single digits and the clear is one row-keyed UPDATE, so the hold
      // is microseconds. The wire form is fixed ISO-8601 UTC, made HERE from the instant itself:
      // the bare SQL cast renders at the server's own DateStyle (space separator, `+00` offset),
      // which `Date.parse` is not required to accept — a rejected format is a NaN baseline and a
      // spinner that runs to its cap. `toISOString()` produces exactly the format SQL was asked
      // for; `wireInstant` is the one place it is written, with a byte-for-byte comparison
      // against the old SQL output. It also keeps the statement free of anything only one store
      // can render.
      const mine = await dialect(ctx.db).forUpdate(tx.select({
        id: mailboxes.id,
        standing: mailboxes.syncRequestedAt,
      }).from(mailboxes)
        .where(and(eq(mailboxes.accountId, ctx.accountId), eq(mailboxes.status, "connected"))));
      if (mine.length === 0) return [];
      // `now()` — the DATABASE's instant, at its own precision, so the returned baseline and
      // the worker's `stampMailboxSyncNow` write are the same clock. The age predicate is
      // DB-side too: no host clock decides anything here.
      const stamped = await tx.update(mailboxes)
        .set({ syncRequestedAt: dialect(ctx.db).now() })
        .where(and(
          inArray(mailboxes.id, mine.map((m) => m.id)),
          sql`(${mailboxes.syncRequestedAt} is null or ${mailboxes.syncRequestedAt} < ${dialect(ctx.db).now()} - ${dialect(ctx.db).interval(gapSeconds * 1000)})`,
        ))
        .returning({
          id: mailboxes.id,
          at: mailboxes.syncRequestedAt,
        });
      const freshly = new Map<string, string>(
        stamped.map((r) => [r.id, wireInstant(r.at)!]).filter((e): e is [string, string] => e[1] !== null),
      );
      return mine.map((m) => ({
        id: m.id,
        requestedAt: freshly.get(m.id) ?? wireInstant(m.standing),
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
   * The account's screening state — the consent's non-mailbox half. Three columns, one upsert;
   * the baseline is the one that matters: without it the chosen window has nothing to be measured
   * from and the whole backlog moves. `COALESCE` on the baseline so a live account keeps its
   * instant; the dials are overwritten because they ARE the answer just given. Settings before
   * the mailbox row — one lock chain, one direction. A method because it has TWO callers in
   * {@link organizeHere}: the first consent, and a re-run of setup — which wrote nothing for a
   * while, so the window control was decorative on every re-run. The bounds throw before anything
   * is written, on both paths.
   */
  /**
   * CONSENT IS THE BASELINE — stamped once per account, never moved.
   *
   * Separate from {@link writeScreeningAnswer} because the dials are the answer a person just
   * gave and this is a fact about when they first agreed: a door that sends no window still
   * establishes one, and a re-run must not slide a live account's cutline (the `coalesce`).
   */
  private async stampScreeningBaseline(tx: Tx, ctx: ServiceContext): Promise<void> {
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, screeningBaselineAt: ctx.now(), updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: {
          // Through the seam, exactly as `writeScreeningAnswer`'s own upsert does: the phone runs
          // this engine on a store with no `::timestamptz`, and a bare cast here would be a
          // server-only construct in a file the device bundle loads.
          screeningBaselineAt: sql`coalesce(${accountSettings.screeningBaselineAt}, ${dialect(ctx.db).ts(ctx.now())})`,
          updatedAt: ctx.now(),
        },
      });
  }

  private async writeScreeningAnswer(
    tx: Tx, ctx: ServiceContext, screening: NonNullable<OrganizeHereInput["screening"]>,
  ): Promise<void> {
    const days = screening.dormancyDays;
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new ServiceError(
        "validation_failed", 400,
        "dormancyDays must be an integer between 1 and 365",
      );
    }
    const scope = screening.scope ?? "window";
    if (scope !== "window" && scope !== "all_time") {
      throw new ServiceError("validation_failed", 400, "screeningScope must be window or all_time");
    }
    // NEVER STORE THE DEFAULT for the dial — `setDormancyDays`' rule verbatim, so the product
    // default can move without rewriting every account that never chose.
    const stored = days === undefined || days === DEFAULT_DORMANCY_DAYS ? null : days;
    await tx.insert(accountSettings)
      .values({
        accountId: ctx.accountId,
        dormancyDays: stored,
        screeningScope: scope,
        screeningBaselineAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: {
          dormancyDays: stored,
          screeningScope: scope,
          // The column's own guard, in SQL so two consents racing produce ONE baseline
          // without this transaction having to read the row first.
          // Same cast, same reason as the mailbox row's consent — see its note.
          screeningBaselineAt: sql`coalesce(${accountSettings.screeningBaselineAt}, ${dialect(ctx.db).ts(ctx.now())})`,
          updatedAt: ctx.now(),
        },
      });
  }

  /**
   * The one claim ceremony, for every door. The rule: exactly one active organizer per mailbox;
   * ceasing is always automatic, BECOMING always requires an explicit human action — binding the
   * hosted service exactly as a desktop install. It authorizes an ASK: nothing here opens IMAP —
   * the WORKER moves mail through desired state; all this writes is a stamp, and the next roster
   * pass decides. Three columns, one statement, each omission its own failure: the stamp alone is
   * INERT; clearing the reason alone reports the mailbox merely available; restoring the status
   * alone CORRUPTS — a stand-down and a disconnect share `status='disabled'`, told apart only by
   * the reason. A disconnected mailbox is refused, never revived.
   */
  async organizeHere(
    ctx: ServiceContext, id: string, input: OrganizeHereInput = {},
    opts?: UpdateMailboxOptions,
  ): Promise<MailboxTakeoverResult> {
    /**
     * The probe runs BEFORE the transaction, and must: it opens a socket to the customer's
     * provider, and a network round trip inside a transaction holding `FOR UPDATE` on the mailbox
     * row would hold that lock for the length of a provider's timeout, with every other writer
     * blocked behind it. The ceremony PROVES first and WRITES second, and what makes that sound
     * is `assertMergeCurrent`: the stored config is re-read inside the transaction and compared
     * against what was actually dialled, so a config that moved mid-probe is refused rather than
     * stored under a proof of a different endpoint. A refusal here throws the probe's own honest
     * sentence and NOTHING is written: no stamp, no consent, no allowance spent.
     */
    const kp = input.imap ? this.requireKeyProvider() : null;
    /**
     * This door needs a STRICTER verdict than `create`. `store_unverified` is deliberately
     * permissive at CONNECT time: `UNAVAILABLE` is not evidence the password is wrong, and
     * refusing would strand somebody behind their provider's bad afternoon. That policy is wrong
     * HERE: a stamp on a mailbox whose login does not work is an action that looks like it worked
     * and leaves the mailbox quarantined — accepting an UNVERIFIED password and committing the
     * authorization reproduces the exact defect, atomically. A supplied password must be PROVED:
     * `store_unverified` is refused with the probe's own honest sentence. `create`'s policy is
     * untouched: a connect with no organizing attached can stay optimistic.
     */
    const probed = input.imap
      ? await this.probedImapMeta(
        ctx, id, { imap: { pass: input.imap.pass } },
        opts === undefined ? undefined : { ...opts, probe: proveOrRefuse(opts.probe) },
      )
      : null;

    // The access verdict, read BEFORE the transaction: answering it may be a network hop, and a
    // remote call under the account's row lock is the deadlock the send pass already records.
    const access = await this.access(ctx.accountId);

    return asTx(ctx).transaction(async (tx) => {
      // `FOR UPDATE`, in the same order and on the same row as `update` and `delete` take it, so
      // the three serialize instead of interleaving. Without it, an organize and a `delete` can
      // both read the row and commit in either order, and the losing order leaves a mailbox that
      // is authorized to organize and has had its credentials deleted.
      const current = await this.ownedRowOn(tx, ctx, id, { forUpdate: true }); // 404 if not owned

      /**
       * The precondition, restated for the ROLE (mail 0083). There are TWO states this ceremony
       * is for — the two in which this install is not organizing: `organizer_role = 'reader'`
       * (somebody else holds it, or no promotion yet — the claim-back), and `organizer` with
       * `organize_consented_at IS NULL` (the row this install would organize that nobody has
       * asked it to — the FIRST consent, the ordinary onboarding path). Anything else is already
       * organizing with consent recorded, and the answer is a no-op rather than a re-stamp:
       * re-authorizing a becoming that has happened would put a spendable takeover stamp on a
       * healthy mailbox — precisely what lets a gate seize a mailbox past a live foreign claim.
       */
      if (current.status === "disabled") {
        // The tombstone. See the header — this is a refusal, never a revival. It is checked
        // BEFORE the role, because a removed mailbox's role says nothing about it and answering
        // `already_organizing` for a row the user deleted would be a lie in the reassuring
        // direction.
        return { outcome: "disconnected" as const };
      }
      /**
       * And a pending release is a THIRD state this ceremony is for (mail 0088). `release`
       * deliberately leaves the row an `organizer` with consent intact — the GATE demotes —
       * exactly the shape the precondition reads as "already organizing": press "Stop organizing
       * here", change your mind, press "Organize here" — 200 `already_organizing`, no stamp
       * written, and the gate releases the mailbox a minute later anyway. A lock orders WRITES;
       * the failure here is a press that writes nothing. So a release-pending row is
       * claim-back-eligible and the update cancels the request: the LATER press is the one a
       * person meant.
       */
      const releasePending = current.releaseRequestedAt !== null;
      if (!releasePending && current.organizerRole !== "reader" && current.organizeConsentedAt !== null) {
        /**
         * Already organizing — and the window still has to land. This used to return here and
         * write nothing, making "How far back" DECORATIVE on every re-run of setup: a person who
         * came back to widen their history pressed "Agree and start organizing", got a 200, and
         * the account kept the window it already had. The precondition above is about the MAILBOX
         * ROW — a re-authorisation would put a spendable takeover stamp on a healthy mailbox;
         * none of that is an argument about `account_settings`. So the stamp is still refused and
         * the dials are still written; the baseline is untouched by construction — its upsert is
         * a `COALESCE`, so a re-run cannot slide a live account's cutline forward.
         */
        /* NO BASELINE STAMP HERE, and it was tried. A press on this branch may have said nothing
         * about the window, and a press that asks nothing must write nothing — the rule this
         * branch is already held to. A mailbox this install already organizes and that carries no
         * baseline is its own question, and not one to answer silently from here. */
        if (input.screening) await this.writeScreeningAnswer(tx, ctx, input.screening);
        return { outcome: "already_organizing" as const };
      }

      // THE ALLOWANCE GATE, BEFORE THE WRITE, for the reason `update` states at its own re-enable:
      // becoming the organizer of a mailbox IS a connection, whichever door it comes through.
      // Omitting it here would make this the cheapest way past a plan limit — and cheaper than the
      // door `update` guards, because a user can cause a demotion at will simply by pointing
      // another install at their own mailbox, minting the free slot themselves. The row is
      // excluded from the count because it does not yet hold the slot it is asking for.
      await this.allowance(tx as LedgerTx, ctx.accountId, ctx.now(), { access, excludeMailboxId: id });

      /**
       * With no password supplied, there must still be one STORED. "The stored credential stands"
       * was doing unexamined work: the provider revokes the saved password, the reader's cycle
       * records `error` with the dead credential still stored, the person presses "Organize here
       * instead" (no password field), the worker cannot log in and quarantines the mailbox — the
       * takeover-needs-a-readable-credential defect through the door built to close it. So a
       * claim with no password requires a stored one, and the refusal ASKS FOR THE PASSWORD. It
       * checks the ROW, no decrypt, no dial: decrypting proves the envelope opens, not that the
       * provider accepts what is inside.
       */
      if (!input.imap) {
        const [cred] = await tx.select({ transport: mailboxCredentials.transport })
          .from(mailboxCredentials)
          // `'imap'` for BOTH auth kinds: an oauth mailbox stores its refresh token under the
          // same transport (`connectOAuth` writes it there), so one predicate covers both and a
          // branch would be two spellings of one row.
          .where(and(
            eq(mailboxCredentials.mailboxId, id),
            eq(mailboxCredentials.transport, "imap"),
          ))
          .limit(1);
        if (!cred) throw credentialNeeded();
      }
      // The credential, in THIS transaction, so the stamp and the password the worker will use to
      // spend it commit together. See {@link OrganizeHereInput}: a stamp without a usable login is
      // an action that looks like it worked and leaves the mailbox quarantined.
      if (probed && input.imap) {
        await this.assertMergeCurrent(tx, id, "imap", { pass: input.imap.pass }, probed);
        await this.upsertCredOn(tx, ctx, kp!, id, "imap", input.imap.pass, probed.meta);
      }

      /**
       * The account's screening state, in the SAME transaction as the consent. See {@link
       * OrganizeHereInput.screening}: three columns, one upsert, and the baseline is the one that
       * matters — without it the window the person chose has nothing to be measured from and the
       * whole backlog moves. `COALESCE` on the baseline so a live account keeps its instant; the
       * two dials are overwritten because they ARE the answer just given. Settings before the
       * mailbox row — one lock chain, always the same direction, matching every other writer of
       * this table.
       */
      /* -- THE BASELINE IS STAMPED WHETHER OR NOT A WINDOW CAME WITH THE CONSENT ---------
       *
       * `if (input.screening)` guarded BOTH the dials and the baseline, so a door that consents
       * without sending a window left `screening_baseline_at` NULL — and NULL is "no cutoff", so
       * the gate holds every unruled sender's mail whatever its age, which on a long-established
       * mailbox is its whole history. `schema-mail.ts` states this write as the column's own
       * contract, in the consent transaction; only the guard disagreed.
       */
      await this.stampScreeningBaseline(tx, ctx);
      if (input.screening) await this.writeScreeningAnswer(tx, ctx, input.screening);

      const rows = await tx.update(mailboxes).set({
        // NOT the role. **The GATE promotes, and this is the whole reason the ceremony is safe to
        // expose on every door.** All this writes is a request; the worker's next pass reads the
        // claim in the mailbox and decides, and if another organizer is still renewing and
        // outranks us, this side stays a reader on that same pass and the stamp is voided with it.
        // Flipping the role here would make a button in a browser the thing that decides who
        // organizes a mailbox, with no reference to what the mailbox itself says.
        takeoverAuthorizedAt: ctx.now(),
        // Consent, written once and never moved. `COALESCE` because consent is the FIRST time
        // somebody agreed: re-running onboarding, or claiming back after a handover, must not
        // rewrite the record of when the person originally said yes — it also makes this
        // idempotent where it matters: two presses produce one consent and one spendable stamp.
        // `.toISOString()` PLUS an explicit cast — the idiom `markMailboxFailed` records as
        // having bitten twice: inside a raw `sql` fragment there is no column type to coerce a
        // bare `Date` against, so postgres-js binds it as TEXT and throws; PGlite accepts it
        // happily, so the unit suite stays green while production throws — caught by the
        // real-Postgres run and nothing else.
        organizeConsentedAt: sql`coalesce(${mailboxes.organizeConsentedAt}, ${dialect(ctx.db).ts(ctx.now())})`,
        // Rows written before mail 0083 still carry a stand-down reason; clear it with the rest so
        // a mailbox being organized here does not also claim somebody else organizes it.
        disabledReason: null,
        /**
         * And the release request is cancelled (mail 0088). The two stamps are contradictory
         * instructions and the gate honours the release FIRST, so leaving this standing would let
         * a request the person changed their mind about win over the press they made second.
         * Cleared unconditionally: the row lock orders this against `release` itself, so
         * whichever commits last is the answer — what a person means by pressing a button.
         * `organizer_released_at` goes with it: the marker describes the CURRENT state, and a
         * mailbox somebody just asked to organize here is not a released one.
         */
        releaseRequestedAt: null,
        organizerReleasedAt: null,
        // The block is this process's report about the worker's relationship to the mailbox, and
        // this request invalidates it in both directions — the same rule `update` applies. The
        // worker re-writes it within one roster pass if it is still true.
        syncBlockedReason: null,
        syncBlockedSince: null,
      })
        // This predicate is unreachable today, and it is NOT the concurrency control — stated
        // plainly because the tempting reading is the opposite. MEASURED by mutation against real
        // Postgres: deleting these two clauses leaves the whole suite green, including the
        // two-concurrent-confirms case. What refuses the second confirm is the row lock plus the
        // re-read above it — the loser blocks, reads a row that is now `connected`, and returns
        // `already_organizing` before reaching this statement. It stays as the guard for the call
        // site nobody has written yet: an UPDATE that is safe only in the presence of a lock
        // taken thirty lines earlier is one refactor away from unsafe, and the refactor would not
        // fail anything. `rows.length === 0` below is the arm it feeds.
        .where(and(
          eq(mailboxes.id, id),
          eq(mailboxes.accountId, ctx.accountId),
          // NOT `status = 'disabled'` any more — a reader is CONNECTED, so the old predicate
          // matched nothing this method is now for. `<> 'disabled'` is the honest restatement:
          // never revive a tombstone, and the two states this ceremony serves are both live.
          ne(mailboxes.status, "disabled"),
        ))
        .returning({ id: mailboxes.id });

      if (rows.length === 0) return { outcome: "already_organizing" as const };
      /**
       * Derived from the ROLE, because the column has had no writer since mail 0083. This read
       * `current.disabledReason`, which is now `null` for every reader row this build writes — so
       * the one sentence the takeover gives the person (what they claimed this mailbox back FROM)
       * was blank on exactly the door that exists to tell them. `standDownMemory` recomposes it
       * from `organizer_role` and `organized_by_kind` — where migration 0083 put the same two
       * facts — and still answers the legacy column for a row that carries one. The same
       * derivation the desktop's two arms use, in the same module, so Cloud and a standalone
       * install cannot drift into two answers.
       */
      return { outcome: "authorized" as const, previousReason: standDownMemory(current) };
    }).catch((err: unknown) => {
      // Kept from the `disabled → connected` era: this statement no longer moves `status`, so it
      // no longer inserts into the active-address index and 23505 is unreachable from here. It
      // stays because the honest answer to an address conflict on this door is still
      // `addressTaken()` rather than a 500, and a future edit that restores a status move must not
      // have to rediscover that.
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
   * Resolve the config a credential rotation will be STORED with, having just proved it works.
   * Returns the merged non-secret `meta`; throws on any refusal. The MERGE is the point, not a
   * convenience: `PATCH` bodies are partial by design — "here is my new password", or "my
   * provider moved hosts, same everything else" — so neither half is dialable alone: the patch
   * has no port (`metaOf` drops the undefined rather than inventing one), and the stored config
   * ignores the correction the user just typed. Probing either alone would prove a login the
   * worker will never make — a green light with a different config's name on it. Patch WINS field
   * by field, because the patch is the newer statement about the same mailbox.
   */
  private async probedImapMeta(
    ctx: ServiceContext, id: string, patch: UpdateMailboxBody, opts?: UpdateMailboxOptions,
  ): Promise<ProbedMeta> {
    // The guard the type cannot enforce in a package whose tests are not compiled. See
    // {@link UpdateMailboxOptions}: this throw is the half that runs.
    if (!opts?.probe) throw probeMissing();

    const current = await this.ownedRow(ctx, id); // 404 before anything is dialled

    /**
     * Disabled is refused here too, and it is not a redundant copy. `delete` disables the row AND
     * deletes its credential rows, so for a disconnected mailbox there is no stored `meta` to
     * merge against — without this branch the caller is told "imap host and port are required"
     * about a mailbox whose real problem is that they disconnected it: a true sentence about the
     * wrong thing. It does not cost the in-transaction check its teeth: that check is still the
     * authority, exercised by a twelve-case storm starting a patch and a delete 30 ms apart in
     * both orders — the unlocked read here legitimately sees `connected` and only the locked
     * re-read can refuse.
     */
    const effectiveStatus = patch.status ?? current.status;
    if (effectiveStatus === "disabled") throw mailboxDisabled();

    const stored = (await asTx(ctx).select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")))
      .limit(1))[0]?.meta as Record<string, unknown> | null | undefined;

    const merged = mergedTransportMeta(stored, patch.imap, undefined, "imap");

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
     * The PROVEN combination overrides the merge, exactly as on create — see
     * {@link mergedTransportMeta}, which is where that arithmetic lives now so the in-transaction
     * recomputation can run the identical thing. Recomputed from the SAME `stored` snapshot, so
     * this is the pre-dial merge plus the verdict and nothing else has moved.
     */
    // `proven` rides out so `update` can rebuild this exact merge against the meta it reads under
    // the row lock: if that rebuild differs, the verdict above is about a configuration that is no
    // longer this mailbox's, and writing it would restore whatever the other writer just changed.
    return { meta: mergedTransportMeta(stored, patch.imap, verdict.proven, "imap"), proven: verdict.proven };
  }

  /**
   * The SMTP sibling of {@link probedImapMeta}: merge the patch over the stored `smtp` meta,
   * dial the merged config, and return the merge with the PROVEN port/TLS mode applied. Same
   * ordering rules (before the transaction, 404 and disabled-refusal first), no consent marker —
   * plaintext SMTP authentication is not offered at all.
   */
  private async probedSmtpMeta(
    ctx: ServiceContext, id: string, patch: UpdateMailboxBody, smtpProbe: SmtpProbe,
  ): Promise<ProbedMeta & { maxMessageBytes: number | null }> {
    const current = await this.ownedRow(ctx, id); // 404 before anything is dialled

    const effectiveStatus = patch.status ?? current.status;
    if (effectiveStatus === "disabled") throw mailboxDisabled();

    const stored = (await asTx(ctx).select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "smtp")))
      .limit(1))[0]?.meta as Record<string, unknown> | null | undefined;

    const merged = mergedTransportMeta(stored, patch.smtp, undefined, "smtp");

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
    /**
     * The `SIZE` announcement rides OUT of this method rather than into `merged`, and the split
     * is deliberate: `merged` becomes the credential row's `meta` — per-TRANSPORT config the
     * dialler reads back — while this is a fact about the MAILBOX that the send path and the DTO
     * read. Putting it in `meta` would hide it behind a credential row the send path does not
     * open. `null` when the re-probe learned nothing, and it OVERWRITES a previously stored
     * number rather than leaving it: a server that stopped announcing a ceiling has not silently
     * kept yesterday's. Falling back to the strict constant is the safe direction; keeping a
     * stale larger number is not.
     */
    return {
      meta: mergedTransportMeta(stored, patch.smtp, verdict.proven, "smtp"),
      proven: verdict.proven,
      maxMessageBytes: verdict.proven?.maxMessageBytes ?? null,
    };
  }

  /**
   * Compare-and-set for a merge computed OUTSIDE the transaction that is written INSIDE it.
   * Throws {@link configMoved}; returns nothing — the only legal continuation is "the merge is
   * still the answer". MUST be called on `tx`, after `ownedRowOn(..., { forUpdate: true })`: on
   * the ambient handle the read is a fresh snapshot with no ordering against the other writer —
   * reads as protection, is not. The rebuild runs {@link mergedTransportMeta} with the same patch
   * and proven endpoint, so the ONLY input that can differ is the stored meta: would this patch,
   * re-decided now, still store what it just verified?
   */
  private async assertMergeCurrent(
    tx: Tx, mailboxId: string, transport: ProbeTransport,
    patch: TransportInput | undefined, dialled: ProbedMeta,
  ): Promise<void> {
    const [row] = await tx.select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(
        eq(mailboxCredentials.mailboxId, mailboxId),
        eq(mailboxCredentials.transport, transport),
      ))
      .limit(1);
    const fresh = row?.meta as Record<string, unknown> | null | undefined;
    const rebuilt = mergedTransportMeta(fresh, patch, dialled.proven, transport);
    if (stableJson(rebuilt) !== stableJson(dialled.meta)) throw configMoved(transport);
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
        // MERGED, not replaced. This assigned `meta` wholesale, so a partial patch DESTROYED the
        // stored fields it did not mention: `PATCH {imap:{pass, host}}` left a row whose port,
        // user and TLS mode were gone, and `loadMailboxCreds` handed the worker a config that had
        // never been tried — a mailbox that was working before somebody corrected its hostname. A
        // SHALLOW merge, patch's fields winning; in SQL rather than read-modify-write, because
        // this runs inside the transaction already holding the row lock. THROUGH THE SEAM, and
        // this was the defect: the server's `||` is the merge and on the device store `||` is
        // string CONCATENATION — the same spelling would have written two JSON documents stuck
        // end to end, a row that parses as nothing, with no error at the write. A NULL meta reads
        // as `{}` inside the member.
        ...(meta
          ? { meta: dialect(ctx.db).jsonMergeShallow(mailboxCredentials.meta, sql`${JSON.stringify(meta)}`) }
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
    const [m] = await (opts.forUpdate ? dialect(ctx.db).forUpdate(base) : base);
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
  /**
   * When the organizer's last pass finished — one read per REQUEST, whichever door asked.
   * Memoized on the `ServiceContext` OBJECT, not the service: the service is a singleton across
   * requests, and a cached heartbeat would serve one tab's poll the figure from another tab's
   * poll minutes earlier — a stale "last pass" is exactly the lie this field replaces. The
   * context is minted per request, so a WeakMap keyed on it is per-request by construction and
   * collects itself. It sits here rather than in `list`'s pre-loop so EVERY door answers the same
   * way — hoisting it would leave the write doors' DTOs reporting `null` for a deployment that
   * can tell. A throw resolves to `null`.
   */
  private async lastCycleAtFor(ctx: ServiceContext): Promise<string | null> {
    const read = this.deps.lastOrganizerCycleAt;
    if (!read) return null;
    const memo = MailboxService.lastCycleMemo.get(ctx);
    if (memo) return memo;
    const pending = read(ctx).catch(() => null);
    MailboxService.lastCycleMemo.set(ctx, pending);
    return pending;
  }

  private static readonly lastCycleMemo =
    new WeakMap<ServiceContext, Promise<string | null>>();

  private async toDTO(
    ctx: ServiceContext, m: MailboxRow, messageCount?: number,
  ): Promise<MailboxDTO> {
    const lastCycleAt = await this.lastCycleAtFor(ctx);
    const fRows = await ctx.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, m.id)).orderBy(asc(mailboxFolders.folder));
    /**
     * Is sending set up — off the INCOMING credential's meta, where the unsettled marker lives.
     * An unproven submission credential is never stored, so there is no `smtp` row to ask; the
     * marker rides the imap row beside `smtpHost`. One indexed point-read per mailbox rather than
     * a column on `mailboxes`: the fact belongs to the credential and must be rewritten by the
     * same patch that stores a proven `smtp` row, or the two could disagree. A mailbox with no
     * credential reports `null` — the same answer as "settled", and the right one: nothing is
     * unsettled about a mailbox that has not been given a password yet.
     */
    const [imapCred] = await ctx.db.select({ meta: mailboxCredentials.meta })
      .from(mailboxCredentials)
      .where(and(
        eq(mailboxCredentials.mailboxId, m.id),
        eq(mailboxCredentials.transport, "imap"),
      ))
      .limit(1);
    const unsettledRaw = (imapCred?.meta as { smtpUnsettled?: unknown } | null | undefined)
      ?.smtpUnsettled;
    /* `""` IS SETTLED, not unsettled-with-no-reason. That spelling is what a repair writes, and
       reading it as a truthy marker would leave a fixed mailbox reporting a problem for ever. */
    const sendingUnsettled = typeof unsettledRaw === "string" && unsettledRaw !== ""
      ? unsettledRaw
      : null;
    const folders: MailboxFolderSummary[] = fRows.map((f) => ({
      folder: f.folder,
      hasSyncCursor: f.highestmodseq != null,
      updatedAt: f.updatedAt.toISOString(),
    }));
    /**
     * The first pull's DENOMINATOR: Σ `server_exists` over the rows just read. Mail 0083 added
     * the column; until this line NOTHING read it back — a number written on a heartbeat no
     * surface could show. NO `?? 0` in either direction: a NULL row is a folder no cycle has
     * opened, and treating it as zero would understate the total; a mailbox where EVERY row is
     * NULL has no answer at all, and `seen` keeps that case ABSENT rather than shipping a `0`
     * that reads as "the server holds no mail". A sum over OPENED folders, so it grows as the
     * first cycle walks the tree — stated on the DTO field.
     */
    let serverExistsSum = 0;
    let serverExistsSeen = false;
    for (const f of fRows) {
      if (typeof f.serverExists === "number") {
        serverExistsSum += f.serverExists;
        serverExistsSeen = true;
      }
    }
    // Our own filings this mailbox has not applied yet (see `MailboxDTO.pendingMoves`). A COUNT,
    // never the rows. Joined through `messages` because `folder_state` carries no mailbox column.
    // The predicates are NOT `listPendingFolderStates`' — this comment used to claim they were,
    // and both halves were false: this counts `pending` ∧ `last_set_by = 'us'` ∧ `desired <>
    // observed`; the queue filters `pending` ∧ `dueNow(next_attempt_at)`. So a DEFERRED row is IN
    // this number and ABSENT from that queue — the reported defect: the strip said "Filing 1
    // message…" about a row nothing was touching. `folder-state-pending.ts` owns every predicate.
    // The COUNT is unchanged, byte for byte; {@link MailboxDTO.filing} sits beside it, the same
    // rows split by the operand that decides. ONE statement; the label is built in TypeScript
    // (`toISOString()`), not `to_char`, which the device store does not have.
    const now = ctx.now();
    const d = dialect(ctx.db);
    const [pending] = await ctx.db.select({
      n: d.castInt(sql`count(*) filter (where ${ourOutstandingFiling()})`).mapWith(Number) as unknown as SQL<number>,
      due: d.castInt(sql`count(*) filter (where ${filingDue(now)})`).mapWith(Number) as unknown as SQL<number>,
      deferred: d.castInt(sql`count(*) filter (where ${filingDeferred(now)})`).mapWith(Number) as unknown as SQL<number>,
      // MIN over `updated_at`, which is the reconciler's OWN queue order (`listPendingFolderStates`
      // orders by it) and the honest "waiting since": the intent writers stamp it and
      // `deferFolderReconcile` deliberately does not, because "a refusal is not a re-filing".
      // A `created_at` would have been wrong here — `folder_state` is upserted per message, so a
      // creation stamp dates the message's FIRST filing and would report weeks of waiting over a
      // decision made a second ago.
      oldestPendingAt: sql<Date | null>`
        min(${folderState.updatedAt}) filter (where ${ourOutstandingFiling()})`
        .mapWith(folderState.updatedAt) as unknown as SQL<Date | null>,
      // MIN, not max: the SOONEST is when something will next happen, which is what a sentence
      // promising a retry has to name. Over the deferred rows alone — a due row's NULL means "now"
      // and has no instant to quote.
      nextAttemptAt: sql<Date | null>`
        min(${folderState.nextAttemptAt}) filter (where ${filingDeferred(now)})`
        .mapWith(folderState.nextAttemptAt) as unknown as SQL<Date | null>,
      attempts: d.castInt(sql`
        coalesce(max(${folderState.attempts}) filter (where ${ourOutstandingFiling()}), 0)`)
        .mapWith(Number) as unknown as SQL<number>,
      // THE CLASS OF THE ROW `attempts` CAME FROM, so the two halves of one sentence are about
      // one message. Ordered by `attempts` (then by the widest schedule) rather than by
      // `updated_at`: the deferral does not stamp `updated_at`, so ordering by it would pair the
      // reported attempt count with a different row's reason.
      // THE ORDERED PICK, as a subquery rather than as the first element of an ordered
      // `array_agg` — which is a Postgres aggregate with no counterpart on the device store, and
      // which sorted EVERY outstanding row to read one of them. Same predicate, same order, same
      // value, and uncorrelated, so it is one round trip and one evaluation on both stores.
      lastRefusalClass: sql<string | null>`(${ctx.db
        .select({ c: folderState.lastErrorClass })
        .from(folderState)
        .innerJoin(messages, eq(messages.id, folderState.messageId))
        .where(and(
          eq(messages.mailboxId, m.id),
          ourOutstandingFiling(),
          isNotNull(folderState.lastErrorClass),
        ))
        .orderBy(desc(folderState.attempts), desc(folderState.nextAttemptAt))
        .limit(1)})`,
    })
      .from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(eq(messages.mailboxId, m.id));
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
      // NOT gated on `status`, unlike the four above (mail 0029). The asymmetry is the entire
      // reason this column exists: every state it describes — an unreadable organizer lease,
      // unprovisioned credentials, the mailbox cap — happens while `status` IS `connected`,
      // because an infrastructure fault must never quarantine a mailbox. Gating these two the way
      // the failure four are gated would make them permanently NULL on the wire, reproducing the
      // silent not-syncing failure this column ends, one column over. A reviewer reaching for
      // consistency should read this first: the failure four are gated because the wire contract
      // is "null unless error"; these two ARE the contract for "connected but not syncing". Safe
      // to project verbatim: a closed set of three with a CHECK, so no server-chosen value can
      // reach this field.
      syncBlockedReason: isMailboxSyncBlockReason(m.syncBlockedReason) ? m.syncBlockedReason : null,
      syncBlockedSince: m.syncBlockedSince ? m.syncBlockedSince.toISOString() : null,
      // Why a disabled mailbox is disabled (mail 0027). Until this line the lease's verdict was
      // invisible to every client: a stand-down clears `error_code` and `sync_blocked_reason` —
      // correctly, it is neither — so this column was the only one carrying the fact. GATED, and
      // read the DTO doc before "fixing" it into agreement with the two lines above: the gate
      // stops a re-enabled mailbox shipping `connected` and "somebody else holds this" in one row
      // — the clear belongs to the worker's gate. An unrecognised non-null value becomes
      // `:unknown`, NEVER `null`: under `disabled`, `null` is the ordinary user disconnect — a
      // different state with different copy. The closed set carries its own catch-all.
      disabledReason: m.status !== "disabled" ? null
        : m.disabledReason === null ? null
          : isMailboxDisabledReason(m.disabledReason) ? m.disabledReason : "organized_elsewhere:unknown",
      // WHEN the first import finished (mail 0038). Projected UNCONDITIONALLY and as `=== null` the
      // client reads it: the worker writes it once a cycle drains with no backlog, and a NULL is
      // the floor `mail-state.ts` holds under "still importing". Gating it on a status would hide
      // the partial-import case it exists to disclose.
      initialImportCompletedAt: m.initialImportCompletedAt ? m.initialImportCompletedAt.toISOString() : null,
      // THE FORWARDING-DETECTION pair (mail 0078). UNCONDITIONAL, the sync-block pair's rule:
      // every state these describe happens while `status` IS `connected` — a status gate would
      // be the incident's invisibility, restored one column over. The dismissal projects even
      // while no episode stands, deliberately: the CLIENT owns the `dismissedAt < since`
      // comparison, and withholding one operand would make that comparison unwritable.
      inboundQuietSince: m.inboundQuietSince ? m.inboundQuietSince.toISOString() : null,
      inboundQuietDismissedAt: m.inboundQuietDismissedAt ? m.inboundQuietDismissedAt.toISOString() : null,
      // UNCONDITIONAL, for the reason the sync-block pair above is: every state this number
      // describes happens while the row says `connected`. `?? 0` because `count(*)` cannot
      // return no row here, but a driver that answered `undefined` must degrade to "nothing
      // outstanding" rather than to `NaN` on somebody's strip.
      pendingMoves: pending?.n ?? 0,
      // ── THE SAME ROWS, SPLIT BY THE OPERAND THAT DECIDES (mail 0097) ───────────────────
      //
      // UNCONDITIONAL and never absent, on `pendingMoves`' own rule: absent means "this server
      // predates the field" and the client renders the legacy count alone, so emitting it
      // conditionally would make a deployment that CAN tell indistinguishable from one that
      // cannot. Every member is present; the nullable ones are null when no row supplies them,
      // which is a different statement from the object being missing.
      filing: {
        due: pending?.due ?? 0,
        deferred: pending?.deferred ?? 0,
        oldestPendingAt: pending?.oldestPendingAt?.toISOString() ?? null,
        nextAttemptAt: pending?.nextAttemptAt?.toISOString() ?? null,
        attempts: pending?.attempts ?? 0,
        lastRefusalClass: isFilingRefusalClass(pending?.lastRefusalClass)
          ? pending!.lastRefusalClass!
          : null,
        // THE READ'S OWN INSTANT, so a client can say when it last looked instead of running a
        // clock over a figure it has not re-fetched. `MailStateProvider` polls this route every
        // 30 s and re-fetches on nothing else, so a strip with a live clock and no `asOf` was
        // animating a number up to thirty seconds stale.
        asOf: now.toISOString(),
        lastCycleAt,
      },
      // The organizing role and its holder (mail 0083). UNCONDITIONAL, on the sync-block pair's
      // rule: a reader is `connected`, so a status gate would make the three fields permanently
      // absent on exactly the rows they describe — the DTO half of the same argument
      // `disabledReason` makes. COERCED, never projected verbatim: `organizerRole` falls back to
      // `reader` (the safe direction — a reader banner on an organizer is wrong and harmless; the
      // reverse offers a button that will not work), and `organizedBy.kind` narrows to null
      // outside the closed set. `organizedBy` is NULL as a whole when nothing is named, rather
      // than an object of three nulls, so the copy layer has ONE thing to test: a reader with no
      // holder is a mailbox nobody has consented to organize, and its banner says something
      // different.
      organizerRole: isOrganizerRole(m.organizerRole) ? m.organizerRole : "reader",
      organizedBy: (m.organizedByKind !== null || m.organizedByName !== null || m.organizedSince !== null)
        ? {
          kind: isOrganizerKind(m.organizedByKind) ? m.organizedByKind : null,
          name: m.organizedByName,
          since: m.organizedSince ? m.organizedSince.toISOString() : null,
        }
        : null,
      organizerState: isOrganizerState(m.organizerState) ? m.organizerState : null,
      /* THE SAME COMPARISON THE RELEASE MAKES, sent as its answer so the two cannot drift. The
         client used to re-derive this from the holder's kind and got `cloud` for another Cloud
         deployment's claim — the defect this column closes, reproduced one tier up. */
      organizedByThisInstall: this.deps.installId !== undefined
        && m.organizedByInstallId !== null
        && m.organizedByInstallId === this.deps.installId,
      // THE CONSENT STAMP, beside the role rather than derived from it — the two are independent
      // and the DTO's own doc carries the argument. Projected UNCONDITIONALLY like its three
      // neighbours, and as a plain instant: no coercion is possible or needed, since the only
      // writer is `organizeHere`'s COALESCE.
      organizeConsentedAt: m.organizeConsentedAt ? m.organizeConsentedAt.toISOString() : null,
      /**
       * The notice's two instants (mail 0088), projected RAW and compared by the client. The
       * comparison is deliberately not done here: a server-computed boolean would settle it once
       * for every door — wrong the moment two doors are open, because a dismissal on one changes
       * the answer for the other. Sending both instants means every client computes the same
       * predicate from the same facts and a dismissal converges on the next poll. UNCONDITIONAL:
       * every state they describe happens while `status` IS `connected`. No coercion needed —
       * plain instants written by this build's own writers.
       */
      organizerEventAt: m.organizerEventAt ? m.organizerEventAt.toISOString() : null,
      organizerEventSeenAt: m.organizerEventSeenAt ? m.organizerEventSeenAt.toISOString() : null,
      /**
       * Would a reader's decision be accepted here — the request door's rule, projected so a
       * client can withhold a control before the press. `state === "held" && hasCapability(...)`,
       * NOT the capability alone: a claim left by an install that stopped renewing still
       * advertises whatever it advertised on its last pass, and a decision handed to it would sit
       * in the mailbox until it expired. An ORGANIZER row answers false — not a refusal: the
       * question does not arise. The false direction is the safe one on every axis: an older API
       * omits the field, an unrecognised capability string is not the token, and an unreadable
       * row degrades to the state that offers nothing and says why.
       */
      organizerAcceptsRequests:
        m.organizerRole === "reader"
        && m.organizerState === "held"
        && hasCapability(m.organizedByCapabilities, CAPABILITY_REQUESTS),
      /* WHEN THIS INSTALL LET THE MAILBOX GO — projected raw, on the same unconditional rule as
       * its four neighbours. The pane needs the instant, not a flag: "you stopped organizing this
       * here" without a date is a sentence about an event nobody can place. */
      organizerReleasedAt: m.organizerReleasedAt ? m.organizerReleasedAt.toISOString() : null,
      /* THE TWO PENDING ASKS, projected raw on the release stamp's rule: each is meaningful only
         while it stands, each is cleared by the pass or press that answers it, and a pane that
         cannot see them renders a button-press as nothing having happened — measured on a real
         provider, where the release retried for a whole session with the row reading as an
         ordinary organized mailbox. */
      releaseRequestedAt: m.releaseRequestedAt ? m.releaseRequestedAt.toISOString() : null,
      takeoverAuthorizedAt: m.takeoverAuthorizedAt ? m.takeoverAuthorizedAt.toISOString() : null,
      // WHAT THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT (mail 0055). UNCONDITIONAL, for
      // the reason the two lines above are: it is meaningful in every lifecycle state, and it is
      // read by the compose surface rather than by any error copy. `null` is "not known" — no
      // announcement, or never probed — and the client resolves that to the product constant, the
      // same strict fallback `effectiveAttachmentCap` applies on the send itself.
      smtpMaxSizeBytes: m.smtpMaxSizeBytes ?? null,
      /* WHETHER SENDING IS SET UP — read off the incoming credential's own meta, because that is
         where the unsettled marker lives (an unproven submission credential is never stored, so
         there is no `smtp` row to carry it). `null` is "sending is settled", which is what every
         mailbox connected before this existed reports and what a mailbox with a proven submission
         server reports after a repair. */
      sendingUnsettledReason: sendingUnsettled,
      /* SPREAD, not `messageCount: messageCount`. The key must be genuinely ABSENT when nobody
         asked, because absent and `0` are different answers here and a client tells them apart
         with a `typeof` guard. `JSON.stringify` would drop an explicitly-undefined property on
         the way out, so the wire would be right either way — but the in-process DTO would carry
         a key whose presence says the opposite of what it means, and `packages/api` hands these
         objects to a local host as well as to a serializer. */
      ...(messageCount === undefined ? {} : { messageCount }),
      /* SPREAD, on the line above's rule and for the sharper of the two reasons it gives: here
         ABSENT means "no folder of this mailbox has been counted", and a `0` in its place is the
         sentence "your mail server holds nothing". That is the one number on this DTO whose
         wrong value is a claim about somebody's mailbox rather than about this build. */
      ...(serverExistsSeen ? { serverMessageCount: serverExistsSum } : {}),
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
