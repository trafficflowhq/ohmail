/**
 * A REFUSED CONNECT, READ ONCE. One reader takes a refusal off a transport ({@link refusalOf}: typed fields, copied
 * one by one), and one table takes it to the sentence the shipped forms said for it ({@link saidOf}): the catalogue's
 * key with its values, or the server's own sentence where no key words it. A reason this build does not know says
 * the server's sentence, never a generic apology.
 */
import { asAuthHint, type AuthHint } from "@ohmail/client-engine/providers";
import { probeCopyKey } from "../../doors/local-server-host.js";
import { noPortProbeKey, type NoPortProbeKey } from "../../doors/no-port-sentence.js";
import { STANDALONE_UNKNOWN, standaloneSaid } from "./standalone-said.js";
import {
  PROBE_REASONS,
  PROBE_TLS_KINDS,
  SIGN_IN_FAILURES,
  type ConnectPurposeKind,
  type Leg,
  type ProbeReason,
  type ProbeTlsKind,
  type Refusal,
  type RefusalDetails,
  type RefusedTls,
  type SignInReturn,
} from "./types.js";

export const NO_DETAILS: RefusalDetails = Object.freeze({
  reason: null,
  transport: null,
  tls: null,
  authHint: null,
  localServer: false,
  field: null,
  why: null,
  write: null,
  provider: null,
  mailboxLimit: null,
  mailboxCount: null,
});
const NO_ANSWER: Refusal = Object.freeze({ status: 0, code: null, message: "", details: NO_DETAILS });

/** A machine word: a code, a reason. */
const WORD = /^[a-z0-9_]{1,48}$/;
/** A validation's field: words joined by dots. */
const FIELD = /^[a-z0-9_.]{1,48}$/i;
/** A server's name as a certificate or a suggestion may carry it: no space, no markup, no direction mark. */
const HOST = /^[A-Za-z0-9*._:[\]-]{1,255}$/;
/** A SHA-256 fingerprint as Node prints it: 32 pairs of hex digits joined by colons. */
export const FINGERPRINT = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
/** The longest sentence of a server that is drawn. */
const SENTENCE_MAX = 600;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const word = (value: unknown): string | null =>
  typeof value === "string" && WORD.test(value) ? value : null;
const host = (value: unknown): string | null =>
  typeof value === "string" && HOST.test(value) ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const leg = (value: unknown): Leg | null => (value === "imap" || value === "smtp" ? value : null);

function tlsOf(value: unknown): RefusedTls | null {
  const tls = record(value);
  if (tls === null || tls.kind === undefined) return null;
  const sha256 = record(tls.certificate)?.sha256;
  return {
    // A kind this build has no sentence for (a newer server's) is named all the same; its word stays behind.
    kind: (PROBE_TLS_KINDS as readonly unknown[]).includes(tls.kind) ? (tls.kind as ProbeTlsKind) : null,
    certHost: host(tls.certHost),
    expectedHost: host(tls.expectedHost),
    suggestedHost: host(tls.suggestedHost),
    plaintext: tls.plaintext === "offered" || tls.plaintext === "not_private" ? tls.plaintext : null,
    trustVariable:
      word(typeof tls.trustVariable === "string" ? tls.trustVariable.toLowerCase() : null) === null
        ? null
        : (tls.trustVariable as string),
    certificate: typeof sha256 === "string" && FINGERPRINT.test(sha256) ? sha256 : null,
  };
}

/**
 * FOR A SHELL'S WIRE ADAPTER: what a transport threw or answered, as a refusal. Structural, so a server client's
 * error and a bridge's read alike. Only a value with a numeric status of 400 or more is a server's answer; anything
 * else (a network fault, an exception) is no answer, and its own text is never taken as a sentence.
 *
 * `repeats`, for a call that carried a password: whether a text repeats it. It is asked about the server's WHOLE
 * sentence, before the cut, and a sentence that repeats the password is not taken: no part of it can be drawn.
 */
export function refusalOf(thrown: unknown, repeats?: (text: string) => boolean): Refusal {
  const answer = record(thrown);
  if (
    answer === null ||
    typeof answer.status !== "number" ||
    !Number.isInteger(answer.status) ||
    answer.status < 400
  )
    return NO_ANSWER;
  const d = record(answer.details) ?? {};
  const said = typeof answer.message === "string" ? answer.message : "";
  return {
    status: answer.status,
    code: word(answer.code),
    message: repeats?.(said) === true ? "" : said.slice(0, SENTENCE_MAX),
    details: {
      reason: word(d.reason),
      transport: leg(d.transport),
      tls: tlsOf(d.tls),
      authHint: asAuthHint(d.authHint),
      localServer: d.localServer === true,
      field: typeof d.field === "string" && FIELD.test(d.field) ? d.field : null,
      why: word(d.why),
      write: word(d.write),
      provider: word(d.provider),
      mailboxLimit: count(d.mailboxLimit),
      mailboxCount: count(d.mailboxCount),
    },
  };
}

const PROBE_FAILED = "mailbox_probe_failed";

/** Which of the seven things failed when the server tried the login, or `null` for any other refusal. */
export function probeReasonOf(r: Refusal): ProbeReason | null {
  if (r.code !== PROBE_FAILED) return null;
  return (PROBE_REASONS as readonly (string | null)[]).includes(r.details.reason)
    ? (r.details.reason as ProbeReason)
    : null;
}

/** The certificate refusal in detail, with the leg to blame (the incoming one when unsaid). */
export function probeTlsOf(r: Refusal): (RefusedTls & { readonly transport: Leg }) | null {
  if (r.code !== PROBE_FAILED || r.details.tls === null) return null;
  return { ...r.details.tls, transport: r.details.transport ?? "imap" };
}

/** The leg whose no-encryption consent this refusal offers: only a server the server itself placed on a private network. */
export function plaintextOfferOf(r: Refusal): Leg | null {
  const tls = probeTlsOf(r);
  return tls?.kind === "tls_unavailable" && tls.plaintext === "offered" ? tls.transport : null;
}

/** The certificate this refusal offers to trust, and for which leg: a self-signed one, by its fingerprint. */
export function certificateOfferOf(r: Refusal): { readonly transport: Leg; readonly sha256: string } | null {
  const tls = probeTlsOf(r);
  return tls?.kind === "self_signed" && tls.certificate !== null
    ? { transport: tls.transport, sha256: tls.certificate }
    : null;
}

/**
 * The sentence a form with no port field says in place of the reason's own, with the field it may name: the refused
 * leg's host field where the form shows one; with none, `outgoing` for the outgoing server and `none` for the other.
 */
export function noPortProbeSentence(
  r: Refusal,
  hostFields: boolean,
  tlsKinds: "own" | "generic" = "own",
): { readonly key: NoPortProbeKey; readonly field: "imap" | "smtp" | "none" | "outgoing" } | null {
  const kind = r.details.tls?.kind;
  const key = noPortProbeKey(
    probeReasonOf(r),
    tlsKinds === "own" && kind !== undefined && kind !== "generic",
  );
  if (key === null) return null;
  const smtp = r.details.transport === "smtp";
  return { key, field: !hostFields ? (smtp ? "outgoing" : "none") : smtp ? "smtp" : "imap" };
}

/**
 * What a refused guarded press asks for. `factor`: the server's window for a fresh second factor is closed.
 * `signIn`: the session is dead or never finished enrolment. `other`: the press's own refusal.
 */
export function gateOf(r: Refusal): "factor" | "signIn" | "other" {
  if (r.status === 403 && r.code === "step_up_required") return "factor";
  if (r.status === 401 || (r.status === 403 && r.code === "enrollment_incomplete")) return "signIn";
  return "other";
}

/** What support may be told of a refusal: the probe's reason, else the code. A closed word, never anything typed. */
export function reasonCodeOf(r: Refusal): string | null {
  return probeReasonOf(r) ?? r.code;
}

/** A sentence to say: a catalogue key with its values, or the server's own words. */
export type Said =
  | {
      readonly ns: "mailboxes" | "join" | "devices" | "providerPicker" | "onboarding" | "phoneRefusal";
      readonly key: string;
      readonly values?: Readonly<Record<string, string | number>>;
      /** The key to say where the catalogue holds no sentence for `key`, or one that says nothing. */
      readonly orElse?: string;
    }
  | { readonly server: string };

/** What the table needs to know of the form that was refused. Facts, never anything typed. */
export interface SaidContext {
  readonly purpose: ConnectPurposeKind;
  /** The provider's tile, `null` on an edit. */
  readonly preset: string | null;
  /** The form shows the two host fields. */
  readonly manual: boolean;
  /** The form shows port fields, so a sentence may name a port. */
  readonly ports: boolean;
  /** This form offers the provider's own sign-in for this tile. */
  readonly signInArmed: boolean;
  /** The refused press was the one a verified factor sent. */
  readonly afterFactor: boolean;
  /** A dialog can be asked. */
  readonly factor: boolean;
}

const mailboxes = (key: string, values?: Readonly<Record<string, string | number>>): Said =>
  values === undefined ? { ns: "mailboxes", key } : { ns: "mailboxes", key, values };

/** Sign in again, in the mount's own words. */
export function signInSaid(purpose: ConnectPurposeKind): Said {
  if (purpose === "standalone") return STANDALONE_UNKNOWN;
  return purpose === "join" ? { ns: "join", key: "stepUpExpired" } : { ns: "devices", key: "stepUpExpired" };
}

/** A factor landed after Cancel and was thrown away: nothing ran. */
export function nothingRanSaid(purpose: ConnectPurposeKind): Said {
  if (purpose === "standalone") return STANDALONE_UNKNOWN;
  return purpose === "join"
    ? { ns: "devices", key: "stepUpCancelledNothingRan" }
    : mailboxes("cancelledNothingChanged");
}

export const PORT_INVALID: Said = mailboxes("portInvalid");

const TLS_KEYS: Readonly<Partial<Record<ProbeTlsKind, string>>> = {
  expired: "probe_tls_expired",
  not_yet_valid: "probe_tls_not_yet_valid",
  self_signed: "probe_tls_self_signed",
  untrusted: "probe_tls_untrusted",
};

function probeSaid(r: Refusal, reason: ProbeReason, ctx: SaidContext): Said {
  const transport = r.details.transport ?? "imap";
  // A form with no port field names none: the server name on the manual entry, nothing behind a preset.
  if (!ctx.ports) {
    const noPort = noPortProbeSentence(r, ctx.manual);
    if (noPort) return mailboxes(noPort.key, { field: noPort.field });
  }
  const tls = reason === "tls" ? r.details.tls : null;
  if (tls !== null) {
    const protocol = transport === "smtp" ? "SMTP" : "IMAP";
    if (tls.kind === "tls_unavailable")
      return mailboxes(
        tls.plaintext === "not_private" ? "probe_tls_unavailable_public" : "probe_tls_unavailable",
        { protocol },
      );
    if (tls.kind === "hostname_mismatch" && tls.certHost !== null && tls.expectedHost !== null) {
      const values = { certHost: tls.certHost, expectedHost: tls.expectedHost, protocol };
      return tls.suggestedHost !== null
        ? mailboxes("probe_tls_hostname_suggest", { ...values, suggestedHost: tls.suggestedHost })
        : mailboxes("probe_tls_hostname", values);
    }
    // A server on this computer whose own certificate the person may trust (the line under the sentence).
    if (tls.kind === "self_signed" && tls.certificate !== null)
      return mailboxes("probe_tls_self_signed_local");
    if ((tls.kind === "self_signed" || tls.kind === "untrusted") && tls.trustVariable !== null)
      return mailboxes(
        tls.kind === "self_signed" ? "probe_tls_self_signed_private" : "probe_tls_untrusted_private",
        { variable: tls.trustVariable },
      );
    const own = tls.kind === null ? undefined : TLS_KEYS[tls.kind];
    if (own !== undefined) return mailboxes(own);
  }
  // The provider refused the password where this form offers its sign-in: the way that works, not app-password advice.
  if (reason === "auth" && ctx.signInArmed && ctx.purpose === "join")
    return { ns: "join", key: "mailboxMicrosoftRefused" };
  const hint: AuthHint | null = reason === "auth" ? r.details.authHint : null;
  // A preset's own refused-password sentence is its app-password path: never said where the form offers the sign-in.
  return mailboxes(
    probeCopyKey(reason, r.details.localServer, transport, hint, ctx.signInArmed ? null : ctx.preset),
  );
}

/** The validation refusals the catalogue words, by the field they name. */
const FIELDS: ReadonlySet<string> = new Set([
  "address",
  "imap.host",
  "imap.pass",
  "provider",
  "imap",
  "imap.server",
  "imap.port",
  "smtp.port",
  "smtp.server",
]);

/** Code to the sentence and the values its details give it; `null` is a shape this table does not read. */
const TABLE: Readonly<Record<string, (d: RefusalDetails) => Said | null>> = {
  mailbox_limit_reached: (d) =>
    d.mailboxLimit !== null && d.mailboxCount !== null
      ? mailboxes("refused_mailbox_limit_reached", { limit: d.mailboxLimit, count: d.mailboxCount })
      : null,
  payment_required: (d) => (d.reason === "payment_required" ? mailboxes("refused_payment_required") : null),
  account_suspended: (d) => (d.reason === "suspended" ? mailboxes("refused_account_suspended") : null),
  mailbox_not_permitted: (d) =>
    d.reason === "not_permitted" ? mailboxes("refused_mailbox_not_permitted") : null,
  mailbox_exists: () => mailboxes("refused_mailbox_exists"),
  mailbox_disabled: (d) => (d.write === "credentials" ? mailboxes("refused_mailbox_disabled") : null),
  mailbox_signs_in_with_oauth: (d) =>
    d.provider !== null
      ? mailboxes("refused_signs_in_with_oauth", {
          provider: d.provider === "microsoft" ? "microsoft" : "other",
        })
      : null,
  credential_needed: () => mailboxes("refused_credential_needed"),
  mailbox_config_changed: (d) =>
    mailboxes("refused_mailbox_config_changed", { transport: d.transport ?? "imap" }),
  same_login: () => mailboxes("refused_same_login"),
  organizer_host_change_refused: () => mailboxes("refused_organizer_host_change"),
  mailbox_host_refused: (d) =>
    d.why === "address" || d.why === "plaintext"
      ? mailboxes(d.why === "plaintext" ? "refused_mailbox_host_plaintext" : "refused_mailbox_host_refused", {
          transport: d.transport ?? "imap",
        })
      : null,
  validation_failed: (d) =>
    d.field !== null && FIELDS.has(d.field) ? mailboxes(`refused_field_${d.field.replace(".", "_")}`) : null,
};

/**
 * THE ONE TABLE: a refusal to the sentence the shipped forms said for it. A closed window after a verified factor,
 * or with no dialog to ask, and a dead session say "sign in again" in the mount's words. Whatever no row words is
 * said in the server's own sentence; with no sentence at all, that the check did not finish.
 */
export function saidOf(r: Refusal, ctx: SaidContext): Said {
  if (ctx.purpose === "standalone") return standaloneSaid(r);
  const gate = gateOf(r);
  if (gate === "signIn" || (gate === "factor" && (ctx.afterFactor || !ctx.factor)))
    return signInSaid(ctx.purpose);
  const reason = probeReasonOf(r);
  if (reason !== null) return probeSaid(r, reason, ctx);
  const row = r.code !== null && Object.hasOwn(TABLE, r.code) ? TABLE[r.code]!(r.details) : null;
  if (row !== null) return row;
  return r.message !== "" ? { server: r.message } : mailboxes("probe_unknown");
}

/**
 * A provider's sign-in that came back with nothing connected. A declined consent is no fault: it is said calmly.
 * What finishing it refused is said in the join's own words on the join, and in the server's elsewhere.
 */
export function saidOfReturn(
  back: Extract<SignInReturn, { kind: "refused" | "failed" }>,
  purpose: ConnectPurposeKind,
): { readonly said: Said; readonly calm: boolean } {
  if (back.kind === "refused")
    return { said: mailboxes(`oauth_${back.reason}`), calm: back.reason === "consent_declined" };
  if (
    purpose === "join" &&
    back.reason !== null &&
    (SIGN_IN_FAILURES as readonly string[]).includes(back.reason)
  )
    return { said: { ns: "join", key: `mailboxOauth_${back.reason}` }, calm: false };
  return {
    said:
      back.message !== null && back.message !== ""
        ? { server: back.message }
        : mailboxes("oauth_consent_failed"),
    calm: false,
  };
}

/**
 * A refusal with everything taken out that repeats what the press sent: a server's sentence or a name it echoes the
 * request in is never drawn. `repeats` asks the sealed password, which stays sealed.
 */
export function withoutEcho(r: Refusal, repeats: (text: string) => boolean): Refusal {
  const clean = (value: string | null): string | null => (value !== null && repeats(value) ? null : value);
  const tls = r.details.tls;
  return {
    ...r,
    message: repeats(r.message) ? "" : r.message,
    details: {
      ...r.details,
      tls:
        tls === null
          ? null
          : {
              ...tls,
              certHost: clean(tls.certHost),
              expectedHost: clean(tls.expectedHost),
              suggestedHost: clean(tls.suggestedHost),
              trustVariable: clean(tls.trustVariable),
            },
    },
  };
}
