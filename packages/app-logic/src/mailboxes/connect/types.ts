/**
 * WHAT CONNECTING A MAILBOX CARRIES between the one form and a shell's wire. Types and closed lists; no behaviour.
 *
 * A wire never throws: every call answers {@link Answered}. A password is a {@link Secret}, never a string. A mailbox
 * is named by a {@link MailboxId}, which only the account's own rows or a wire's answer hand out.
 */
import type { AuthHint } from "@ohmail/client-engine";
import type { FirstRunProbeOk } from "../../doors/first-run-host.js";
import type { Secret } from "./secret.js";

/** An id the account's own list or a wire's answer handed. A route's word is not one, and a string does not compile. */
export type MailboxId = string & { readonly __ofTheAccount: unique symbol };

/** The incoming or the outgoing server. */
export type Leg = "imap" | "smtp";

/** Why a tried login was refused, as the server classes it. */
export const PROBE_REASONS = ["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

/** What was wrong with a certificate, or that the server offers no encryption at all. */
export const PROBE_TLS_KINDS = [
  "hostname_mismatch",
  "expired",
  "not_yet_valid",
  "self_signed",
  "untrusted",
  "tls_unavailable",
  "generic",
] as const;
export type ProbeTlsKind = (typeof PROBE_TLS_KINDS)[number];

/** A certificate refusal in detail. Names and hosts come from a mail server: bounded, drawn as words. */
export interface RefusedTls {
  /** `null`: a kind a newer server names that this build has no sentence for: named all the same, and it opens nothing. */
  readonly kind: ProbeTlsKind | null;
  readonly certHost: string | null;
  readonly expectedHost: string | null;
  /** A name the certificate proves and the server answers to: offered as one press, never applied. */
  readonly suggestedHost: string | null;
  /** No encryption: `offered` on a private network (a consent line may open), `not_private` otherwise. */
  readonly plaintext: "offered" | "not_private" | null;
  /** On the operator's own network: the setting that makes this server trust a private authority. */
  readonly trustVariable: string | null;
  /** A server on this computer serving its own certificate: its SHA-256 fingerprint, in that form alone. */
  readonly certificate: string | null;
}

/**
 * What a refusal says beyond its code: the fields this record names, each read by its type and copied one by one.
 * Never the answer's own `details` whole: what a server echoes of a request stays behind.
 */
export interface RefusalDetails {
  /** `details.reason` when it is an identifier: a probe's reason, an allowance's, a sign-in's. */
  readonly reason: string | null;
  readonly transport: Leg | null;
  readonly tls: RefusedTls | null;
  readonly authHint: AuthHint | null;
  /** The server that refused is on this computer. */
  readonly localServer: boolean;
  /** A validation refusal's field, an identifier with dots. */
  readonly field: string | null;
  /** `address` or `plaintext`: why a stored host is no longer dialled. */
  readonly why: string | null;
  /** `credentials`: the write a disconnected mailbox refused. */
  readonly write: string | null;
  /** The provider a mailbox signs in with. */
  readonly provider: string | null;
  readonly mailboxLimit: number | null;
  readonly mailboxCount: number | null;
}

/** A refused call, as a shell's adapter read it off its transport. No answer at all is `status` 0. */
export interface Refusal {
  readonly status: number;
  /** The machine name, when it is an identifier. */
  readonly code: string | null;
  /** The server's own sentence, bounded; empty where there was none. */
  readonly message: string;
  readonly details: RefusalDetails;
}

export type Answered<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };

/** One server of a connection. The two claims stand only where ticked for this server after its own offer. */
export interface ConnectServer {
  readonly host: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly allowInsecure?: true;
  readonly trustCertificate?: string;
}

/** A mailbox as typed, for the test and for the connect alike: the test dials what the connect dials. */
export interface ConnectInput {
  readonly address: string;
  readonly provider: string;
  readonly imap: ConnectServer & { readonly pass: Secret };
  readonly smtp?: ConnectServer & { readonly pass?: Secret };
}

/** What a passed test proved: the host that answered, the login it took, the folders, the sending leg. */
export type ConnectProbed = FirstRunProbeOk;

/** Corrections to a connected mailbox. A blank is left out: it keeps the stored value. The password always rides. */
export interface ConnectPatch {
  readonly imap: { host?: string; port?: number; user?: string; pass: Secret; allowInsecure?: true };
  readonly smtp?: { host?: string; port?: number; user?: string; pass: Secret; allowInsecure?: true };
}

export interface Connected {
  readonly mailboxId: MailboxId;
  readonly address: string | null;
}

/** What the form is opened for. */
export const CONNECT_PURPOSES = ["join", "firstRun", "add", "edit", "reconnect"] as const;
export type ConnectPurposeKind = (typeof CONNECT_PURPOSES)[number];

/** A provider whose own sign-in connects a mailbox. Another provider widens this list, and nothing else. */
export const SIGN_IN_PROVIDERS = ["microsoft"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/** Which ceremonies this shell can run for a provider. Unread is shut. */
export type SignInWays = Readonly<
  Record<SignInProvider, { readonly redirect: boolean; readonly device: boolean }>
>;

/** Why a provider's sign-in came back refused: the four a return's address can say. */
export const SIGN_IN_REFUSALS = [
  "admin_consent_required",
  "consent_declined",
  "consent_failed",
  "state_invalid",
] as const;
export type SignInRefusalReason = (typeof SIGN_IN_REFUSALS)[number];

/** Why finishing a sign-in failed: the eight the server names. */
export const SIGN_IN_FAILURES = [
  "state_invalid",
  "state_expired",
  "account_mismatch",
  "provider_unavailable",
  "exchange_failed",
  "no_refresh_token",
  "no_address",
  "oauth_unconfigured",
] as const;
export type SignInFailureReason = (typeof SIGN_IN_FAILURES)[number];

/** What a sign-in started earlier came back with. Reasons are narrowed where the return is read. */
export type SignInReturn =
  | { readonly kind: "running" }
  | { readonly kind: "connected"; readonly created: boolean; readonly address: string | null }
  | { readonly kind: "refused"; readonly reason: SignInRefusalReason }
  | { readonly kind: "failed"; readonly reason: SignInFailureReason | null; readonly message: string | null };

/** A sign-in by code as a view may draw it. The shell holds the ceremony; a view holds nothing of it. */
export type CodeCeremony =
  | { readonly kind: "checking" }
  | { readonly kind: "shown"; readonly code: string; readonly openAt: string | null; readonly until: number }
  | {
      readonly kind: "ended";
      readonly why: "declined" | "expired" | "refused";
      readonly refusal: Refusal | null;
    }
  | { readonly kind: "connected"; readonly connected: Connected; readonly created: boolean };

/**
 * What a person typed into the form, the password apart: a password is in no record and in no holder.
 * A host is the field whole, a port after the name included (`mail.example.com:1143`).
 */
export interface ConnectTyped {
  readonly address: string;
  /** The provider's tile; `null` until one is chosen, by the person or by the address. */
  readonly provider: string | null;
  /** The tile was pressed by the person: the address no longer chooses. */
  readonly byHand: boolean;
  readonly user: string;
  readonly imapHost: string;
  readonly smtpHost: string;
  /** An edit's own two fields; a new connection writes a port after the name. */
  readonly imapPort: string;
  readonly smtpPort: string;
  /** On a provider that signs in: "use an app password instead" was taken. */
  readonly byPassword: boolean;
}

/**
 * Typed words held by a caller that outlives the form (a wizard whose other steps unmount it). Memory only: nothing
 * of it is stored, and it never holds a password.
 */
export interface ConnectKept {
  read(): ConnectTyped | null;
  write(typed: ConnectTyped): void;
}
