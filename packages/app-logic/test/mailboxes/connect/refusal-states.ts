/**
 * THE STATES OF A REFUSED CONNECT, one row for each the design's registry draws (`state=c-…` of its onboarding
 * screen), in the registry's order. A row says what makes the state: the refusal a wire answered and the form it
 * was answered to, or the form's own event where no refusal makes it. The states page draws a state from its row,
 * and the row's sentence is the one table's ({@link saidOf}), so a state cannot be drawn in words the form would
 * not say.
 */
import {
  NO_DETAILS,
  PORT_INVALID,
  nothingRanSaid,
  saidOf,
  type Said,
  type SaidContext,
} from "../../../src/mailboxes/connect/refusal.js";
import type {
  ConnectPurposeKind,
  Leg,
  ProbeTlsKind,
  Refusal,
  RefusalDetails,
  RefusedTls,
} from "../../../src/mailboxes/connect/types.js";

/** A state no refusal makes: a port that is none, a factor thrown away, the looked-up servers, a ticked line. */
export type OwnState = "port" | "wentBack" | "serversFound" | "plainTicked" | "trustTicked";

export interface ConnectStateRow {
  /** The registry's `state=` word. */
  readonly id: `c-${string}`;
  /** The tile the state is drawn on. */
  readonly preset: string;
  /** The form it is drawn in: one with port fields is the edit. */
  readonly purpose: ConnectPurposeKind;
  readonly refusal: Refusal | null;
  readonly own: OwnState | null;
}

/** A fingerprint in the form a server's certificate has: 32 pairs of hex digits joined by colons. A sample, assembled. */
const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  ((i * 37 + 122) % 256).toString(16).toUpperCase().padStart(2, "0"),
).join(":");

const refused = (
  code: string,
  details: Partial<RefusalDetails> = {},
  status = 422,
  message = "",
): Refusal => ({
  status,
  code,
  message,
  details: { ...NO_DETAILS, ...details },
});
const probe = (details: Partial<RefusalDetails>): Refusal => refused("mailbox_probe_failed", details);
const tls = (kind: ProbeTlsKind, over: Partial<RefusedTls> = {}): RefusedTls => ({
  kind,
  certHost: null,
  expectedHost: null,
  suggestedHost: null,
  plaintext: null,
  trustVariable: null,
  certificate: null,
  ...over,
});
const certificate = (kind: ProbeTlsKind, transport: Leg = "imap", over: Partial<RefusedTls> = {}): Refusal =>
  probe({ reason: "tls", transport, tls: tls(kind, over) });
/** The server's own sentence for an address it will not dial: these have no catalogue key. */
const address = (message: string): Refusal => refused("validation_failed", { field: "u" }, 422, message);

const row = (
  id: ConnectStateRow["id"],
  preset: string,
  refusal: Refusal | null,
  purpose: ConnectPurposeKind = "add",
  own: OwnState | null = null,
): ConnectStateRow => ({ id, preset, purpose, refusal, own });
const password = (
  id: ConnectStateRow["id"],
  preset: string,
  details: Partial<RefusalDetails> = {},
): ConnectStateRow => row(id, preset, probe({ reason: "auth", transport: "imap", ...details }));

export const CONNECT_STATES: readonly ConnectStateRow[] = [
  // The password, by provider.
  password("c-auth", "imap"),
  password("c-gmail-app", "gmail", { authHint: "app_password_required" }),
  password("c-gmail-invalid", "gmail", { authHint: "invalid" }),
  password("c-gmail-web", "gmail", { authHint: "web_login" }),
  password("c-gmail-imap", "gmail", { authHint: "imap_disabled" }),
  password("c-microsoft", "microsoft"),
  password("c-icloud", "icloud"),
  password("c-yahoo", "yahoo"),
  password("c-fastmail", "fastmail"),
  password("c-gmx", "gmx"),
  password("c-infomaniak", "infomaniak"),
  password("c-webde", "webde"),
  password("c-tonline", "tonline"),
  password("c-bluewin", "bluewin"),
  password("c-local", "imap", { localServer: true }),
  // The server.
  row("c-connect", "imap", probe({ reason: "connect", transport: "imap" }), "edit"),
  row("c-timeout", "imap", probe({ reason: "timeout", transport: "imap" }), "edit"),
  row("c-noport", "imap", probe({ reason: "connect", transport: "imap" })),
  row("c-smtp-auth", "imap", probe({ reason: "auth", transport: "smtp" }), "edit"),
  row("c-smtp-connect", "imap", probe({ reason: "connect", transport: "smtp" }), "edit"),
  row("c-smtp-timeout", "imap", probe({ reason: "timeout", transport: "smtp" }), "edit"),
  row("c-localwait", "imap", probe({ reason: "timeout", transport: "imap", localServer: true }), "edit"),
  row("c-host-empty", "imap", address("Enter the incoming (IMAP) server address."), "edit"),
  row(
    "c-host-shape",
    "imap",
    address("That is not a incoming (IMAP) server address. It looks like imap.example.com."),
    "edit",
  ),
  row(
    "c-host-missing",
    "imap",
    address("That incoming (IMAP) server address could not be found. Check the host name for a typo."),
    "edit",
  ),
  row(
    "c-host-private",
    "imap",
    address("That incoming (IMAP) server address points inside a private network and cannot be used here."),
    "edit",
  ),
  row(
    "c-host-self",
    "imap",
    address(
      "That incoming (IMAP) server address names this machine or your own network, not a mail server on the internet.",
    ),
    "edit",
  ),
  row("c-port", "imap", null, "edit", "port"),
  row("c-dns", "imap", probe({ reason: "connect", transport: "imap" }), "add", "serversFound"),
  row("c-check", "imap", probe({ reason: "storage" })),
  row("c-check-unknown", "imap", probe({ reason: "unknown" })),
  // The certificate.
  row("c-tls", "imap", certificate("generic"), "edit"),
  row("c-tls-smtp", "imap", certificate("generic", "smtp"), "edit"),
  row(
    "c-tls-name",
    "imap",
    certificate("hostname_mismatch", "imap", {
      certHost: "mail.hostwerk.example",
      expectedHost: "mail.lichtgrat.example",
    }),
    "edit",
  ),
  row(
    "c-tls-suggest",
    "imap",
    certificate("hostname_mismatch", "imap", {
      certHost: "mail.hostwerk.example",
      expectedHost: "mail.lichtgrat.example",
      suggestedHost: "mail.hostwerk.example",
    }),
  ),
  row("c-tls-expired", "imap", certificate("expired")),
  row("c-tls-early", "imap", certificate("not_yet_valid")),
  row("c-tls-self", "imap", certificate("self_signed")),
  row("c-tls-untrusted", "imap", certificate("untrusted")),
  row("c-tls-self-own", "imap", certificate("self_signed", "imap", { trustVariable: "NODE_EXTRA_CA_CERTS" })),
  row("c-tls-trust", "imap", certificate("self_signed", "imap", { certificate: FINGERPRINT })),
  row(
    "c-tls-trusted",
    "imap",
    certificate("self_signed", "imap", { certificate: FINGERPRINT }),
    "add",
    "trustTicked",
  ),
  // No encryption.
  row("c-plain", "imap", certificate("tls_unavailable", "imap", { plaintext: "offered" })),
  row(
    "c-plain-on",
    "imap",
    certificate("tls_unavailable", "imap", { plaintext: "offered" }),
    "add",
    "plainTicked",
  ),
  row("c-plain-public", "imap", certificate("tls_unavailable", "imap", { plaintext: "not_private" })),
  // The account.
  row("c-limit", "imap", refused("mailbox_limit_reached", { mailboxLimit: 5, mailboxCount: 5 }, 402)),
  row("c-unpaid", "imap", refused("payment_required", { reason: "payment_required" }, 402)),
  row("c-suspended", "imap", refused("account_suspended", { reason: "suspended" }, 403)),
  row("c-notpermitted", "imap", refused("mailbox_not_permitted", { reason: "not_permitted" }, 403)),
  row(
    "c-unverified",
    "imap",
    refused(
      "email_unverified",
      {},
      403,
      "Connecting a mailbox needs a confirmed address. Open the link in the mail we sent when you signed up.",
    ),
  ),
  row("c-exists", "imap", refused("mailbox_exists", {}, 409)),
  row("c-samelogin", "imap", refused("same_login", {}, 409)),
  row("c-oauth", "microsoft", refused("mailbox_signs_in_with_oauth", { provider: "microsoft" }, 409), "edit"),
  row("c-changed", "imap", refused("mailbox_config_changed", { transport: "imap" }, 409), "edit"),
  row("c-backed", "imap", null, "add", "wentBack"),
];

/** The form a state's refusal was answered to, as the one table reads it. */
export function contextOfState(state: ConnectStateRow): SaidContext {
  return {
    purpose: state.purpose,
    preset: state.purpose === "edit" ? null : state.preset,
    manual: state.preset === "imap",
    ports: state.purpose === "edit",
    signInArmed: false,
    afterFactor: false,
    factor: true,
  };
}

/** The sentence a state draws; `null` where it draws none (a ticked line stands calm). */
export function saidOfState(state: ConnectStateRow): Said | null {
  switch (state.own) {
    case "port":
      return PORT_INVALID;
    case "wentBack":
      return nothingRanSaid(state.purpose);
    case "serversFound":
      return { ns: "providerPicker", key: "discoveredHosts" };
    case "plainTicked":
    case "trustTicked":
      return null;
    default:
      return state.refusal === null ? null : saidOf(state.refusal, contextOfState(state));
  }
}
