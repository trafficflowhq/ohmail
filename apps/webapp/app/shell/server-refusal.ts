import { activeTranslator } from "./locale";
import { probeCopyKey, refusalAuthHint } from "./local-server-host";
import { noPortProbeKey } from "./no-port-sentence";
import type { ServiceErrorCode } from "@ohmail/wire";

/*
 * A SERVER'S REFUSAL IN THE READER'S LANGUAGE. The server writes English in every language (the
 * same sentence is the API's and the log's), so a screen that showed `message` showed English under
 * German. Each code below has a catalogue sentence whose English is the server's own for the same
 * `details`; a code this build does not know, or a shape it cannot read, keeps the server's
 * sentence, which is always true. Read structurally, so the hosted `ApiError` and the desktop's
 * wire errors read alike. No import of `app/api-client`: the desktop aliases it to a stub.
 */

type Details = Record<string, unknown>;
type Values = Record<string, string | number>;
interface Line { key: string; values?: Values }

const transportOf = (d: Details): "imap" | "smtp" => (d.transport === "smtp" ? "smtp" : "imap");
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The `details.field` values of the mailbox service's validation refusals; each has `refused_field_<field>`. */
const FIELDS: ReadonlySet<string> = new Set([
  "address", "imap.host", "imap.pass", "provider", "imap", "imap.server", "imap.port", "smtp.port", "smtp.server",
]);

/** Code → the sentence and the values `details` gives it; `null` is a shape this table does not read. */
const TABLE: Readonly<Record<string, (d: Details) => Line | null>> = {
  mailbox_limit_reached: (d) => (typeof d.mailboxLimit === "number" && typeof d.mailboxCount === "number"
    ? { key: "refused_mailbox_limit_reached", values: { limit: d.mailboxLimit, count: d.mailboxCount } } : null),
  payment_required: (d) => (d.reason === "payment_required" ? { key: "refused_payment_required" } : null),
  account_suspended: (d) => (d.reason === "suspended" ? { key: "refused_account_suspended" } : null),
  mailbox_not_permitted: (d) => (d.reason === "not_permitted" ? { key: "refused_mailbox_not_permitted" } : null),
  mailbox_exists: () => ({ key: "refused_mailbox_exists" }),
  // The send path refuses a disconnected mailbox under the same code in other words.
  mailbox_disabled: (d) => (d.write === "credentials" ? { key: "refused_mailbox_disabled" } : null),
  mailbox_signs_in_with_oauth: (d) => (typeof d.provider === "string"
    ? { key: "refused_signs_in_with_oauth", values: { provider: d.provider === "microsoft" ? "microsoft" : "other" } } : null),
  credential_needed: () => ({ key: "refused_credential_needed" }),
  mailbox_config_changed: (d) => ({ key: "refused_mailbox_config_changed", values: { transport: transportOf(d) } }),
  same_login: () => ({ key: "refused_same_login" }),
  organizer_host_change_refused: () => ({ key: "refused_organizer_host_change" }),
  mailbox_host_refused: (d) => (d.why === "address" || d.why === "plaintext"
    ? { key: d.why === "plaintext" ? "refused_mailbox_host_plaintext" : "refused_mailbox_host_refused", values: { transport: transportOf(d) } }
    : null),
  step_up_required: () => ({ key: "refused_step_up_required" }),
  validation_failed: (d) => (typeof d.field === "string" && FIELDS.has(d.field)
    ? { key: `refused_field_${d.field.replace(".", "_")}` } : null),
} satisfies Partial<Record<ServiceErrorCode, (d: Details) => Line | null>>;

/** The codes {@link refusalCopy} words itself; any other keeps the server's sentence. */
export const SERVER_REFUSAL_CODES: ReadonlySet<string> = new Set([...Object.keys(TABLE), "mailbox_probe_failed"]);

const PROBE_REASONS = new Set(["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"]);
const TLS_KEYS: Readonly<Record<string, string>> = {
  expired: "probe_tls_expired", not_yet_valid: "probe_tls_not_yet_valid",
  self_signed: "probe_tls_self_signed", untrusted: "probe_tls_untrusted",
};

/**
 * A refused probe, as the connect forms word it (`probeCopyKey`). `manual`: `true` where the form
 * shows the host and port fields, `false` where it shows neither (the sentence names no field, and
 * an outgoing refusal says it was the outgoing server), absent where the caller cannot say.
 */
function probeLine(d: Details, opts: RefusalCopyOptions): Line | null {
  const reason = str(d.reason);
  if (reason === undefined || !PROBE_REASONS.has(reason)) return null;
  const transport = transportOf(d);
  const protocol = transport === "smtp" ? "SMTP" : "IMAP";
  const tls = (typeof d.tls === "object" && d.tls !== null ? d.tls : {}) as Details;
  const kind = reason === "tls" ? str(tls.kind) : undefined;
  if (kind === "tls_unavailable") {
    return { key: tls.plaintext === "not_private" ? "probe_tls_unavailable_public" : "probe_tls_unavailable", values: { protocol } };
  }
  if (kind === "hostname_mismatch" && str(tls.certHost) && str(tls.expectedHost)) {
    const values = { certHost: str(tls.certHost)!, expectedHost: str(tls.expectedHost)!, protocol };
    return str(tls.suggestedHost)
      ? { key: "probe_tls_hostname_suggest", values: { ...values, suggestedHost: str(tls.suggestedHost)! } }
      : { key: "probe_tls_hostname", values };
  }
  // A server on this computer whose own certificate the person may trust (the line below the sentence).
  if (kind === "self_signed" && typeof tls.certificate === "object" && tls.certificate !== null) return { key: "probe_tls_self_signed_local" };
  if ((kind === "self_signed" || kind === "untrusted") && str(tls.trustVariable)) {
    return { key: kind === "self_signed" ? "probe_tls_self_signed_private" : "probe_tls_untrusted_private", values: { variable: str(tls.trustVariable)! } };
  }
  if (kind !== undefined && Object.hasOwn(TLS_KEYS, kind)) return { key: TLS_KEYS[kind]! };
  if (opts.manual === false) {
    const noPort = noPortProbeKey(reason, false);
    if (noPort) return { key: noPort, values: { field: transport === "smtp" ? "outgoing" : "none" } };
  }
  const localServer = d.localServer === true;
  const hint = refusalAuthHint({ code: "mailbox_probe_failed", details: d });
  return { key: probeCopyKey(reason, localServer, transport, hint, opts.presetId ?? null) };
}

export interface RefusalCopyOptions {
  /** The provider the form is on, for the presets whose refused password says its own sentence. */
  presetId?: string | null;
  /** Whether the form shows the host and port fields; see {@link probeLine}. */
  manual?: boolean;
}

/**
 * The sentence for a refusal: the catalogue's in the reader's language for a code the table reads,
 * else the server's own; `null` when the error carries no sentence at all.
 */
export function refusalCopy(err: unknown, opts: RefusalCopyOptions = {}): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; message?: unknown; details?: unknown };
  const said = str(e.message) ?? null;
  const code = str(e.code);
  if (code === undefined || !SERVER_REFUSAL_CODES.has(code)) return said;
  const d = (typeof e.details === "object" && e.details !== null ? e.details : {}) as Details;
  const line = code === "mailbox_probe_failed" ? probeLine(d, opts) : TABLE[code]!(d);
  if (line === null) return said;
  return activeTranslator("mailboxes")?.(line.key, line.values) || said;
}
