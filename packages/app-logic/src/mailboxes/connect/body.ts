/**
 * WHAT A CONNECT, A TEST AND AN EDIT SEND. It begins with the rules moved here as they stood: a server name with a
 * port after it (the web's `host-port.ts`), and the edit's port check and its two patch blocks (the Mailboxes pane).
 * Under them, the one form's bodies: built once at the press, frozen, the password sealed inside.
 */
import { discoveryRequestFor, type ProviderPreset } from "./providers.js";
import type { Secret } from "./secret.js";
import { senderNameOf } from "./sender-name.js";
import type { ConnectInput, ConnectPatch, ConnectServer, ConnectTyped, Leg } from "./types.js";

/**
 * One server of a `PATCH /mailboxes/:id` body, as the server takes it. `P` is the password as its holder has it:
 * a string in the forms that still hold one, the seal in the one form.
 */
export interface PatchBlock<P = string> {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass: P;
  allowInsecure?: boolean;
}

/**
 * A SERVER NAME WITH A PORT AFTER IT — `mail.home.arpa:1143`, `[fd00::25]:587` — split for a connect
 * form that has one field per server. A bare name, an unbracketed IPv6 literal and a port outside
 * 1–65535 stay one host, so nothing that is not plainly `name:port` changes what is sent.
 */
export function splitHostPort(raw: string): { host: string; port?: number } {
  const value = raw.trim();
  const m = /^\[([^\]\s]+)\]:(\d{1,5})$/.exec(value) ?? /^([^:\s[\]]+):(\d{1,5})$/.exec(value);
  if (!m) return { host: value };
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1]!, port } : { host: value };
}

/**
 * What the edit form holds. Separate from the connect form's {@link Typed} on purpose: an edit is a
 * PATCH of stored settings, so every field is a correction that may be omitted, and the server
 * merges what is sent over what it has. The ports are strings because they are input values, parsed
 * once on submit; everything is held across the ceremony so a refused probe returns to a form that
 * still has it. `smtpHost`/`smtpPort` are the sending half (SET-M3): `PATCH /mailboxes/:id` has
 * always accepted an `smtp` block — probed before it is stored — but the edit form patched IMAP
 * only, so a mistyped or migrated SMTP host had no correction path.
 */
export interface EditForm<P = string> {
  host: string;
  port: string;
  user: string;
  pass: P;
  smtpHost: string;
  smtpPort: string;
  /** The plaintext opt-in — rendered only after the server reported `tls_unavailable`. */
  allowInsecure: boolean;
  /** The SMTP server's own opt-in, on the same rule. */
  allowInsecureSmtp: boolean;
}

/** A port is optional; if given it has to be one a server could actually listen on. */
export function validPort(raw: string): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1 && n <= 65535;
}

/**
 * Turn the typed corrections into a PATCH body. Blank fields are DROPPED rather than sent empty —
 * an omitted field means "keep the stored value", which is what makes "rotate only the password"
 * a one-field edit. The password is the one field always sent: its presence is what makes the
 * server re-try the login before it stores anything.
 */
export function imapPatchOf<P = string>(e: EditForm<P>): PatchBlock<P> {
  const imap: PatchBlock<P> = { pass: e.pass };
  const host = e.host.trim();
  const user = e.user.trim();
  const port = e.port.trim();
  if (host) imap.host = host;
  if (user) imap.user = user;
  if (port) imap.port = Number(port);
  // Sent only when checked — the server re-proves TLS is absent before honoring it, so a stray
  // flag costs nothing, but omitting a false keeps the wire identical to the pre-consent shape.
  if (e.allowInsecure) imap.allowInsecure = true;
  return imap;
}

/**
 * The SMTP half of the same PATCH — or `undefined` when no SMTP field was touched, so an edit that
 * only rotates the password dials no SMTP server at all: the server probes the `smtp` block
 * whenever one arrives with a `pass`, and an unasked-for dial against a working submission server
 * is a way to fail a save about something else. When a field WAS touched, `pass` rides along
 * because the server re-tries the SMTP login before storing anything, and a typed username
 * correction rides into both transports. Blank fields are dropped; the server merges over the
 * stored `smtp` meta, so a host-only correction keeps the stored port.
 */
export function smtpPatchOf<P = string>(e: EditForm<P>): PatchBlock<P> | undefined {
  const host = e.smtpHost.trim();
  const port = e.smtpPort.trim();
  if (!host && !port) return undefined;
  const smtp: PatchBlock<P> = { pass: e.pass };
  if (host) smtp.host = host;
  if (port) smtp.port = Number(port);
  const user = e.user.trim();
  if (user) smtp.user = user;
  if (e.allowInsecureSmtp) smtp.allowInsecure = true;
  return smtp;
}

/** What a press may claim for each server: only what the server offered for it and the person ticked. */
export type Claims = Readonly<
  Record<Leg, { readonly allowInsecure?: true; readonly trustCertificate?: string }>
>;

function serverOf(
  field: string,
  preset: ProviderPreset,
  of: Leg,
): Pick<ConnectServer, "host" | "port" | "secure"> {
  // A manual server sends no TLS mode, and a port only when one follows the name: the server's probe walks the
  // standard ladder and stores what it proved. A preset sends its own pair.
  return preset.manual
    ? splitHostPort(field)
    : { host: field.trim(), port: preset[of].port, secure: preset[of].secure };
}

/**
 * THE BODY OF A TEST AND OF A CONNECT, the same for both: the test dials what the connect dials. The username
 * defaults to the address on both servers; a claim rides only the server it stands for. The name the letters carry
 * rides only where one was typed, as it is stored. Frozen: a press parked behind the second factor is re-sent as
 * this value.
 */
export function inputOf(
  typed: ConnectTyped,
  preset: ProviderPreset,
  pass: Secret,
  claims: Claims,
): ConnectInput {
  const address = typed.address.trim();
  const user = typed.user.trim() || address;
  // A name that cannot be stored never reaches a body: the press refuses it first.
  const name = senderNameOf(typed.displayName ?? "");
  const block = (of: Leg, field: string) =>
    Object.freeze({
      ...serverOf(field, preset, of),
      user,
      pass,
      ...(claims[of].allowInsecure ? { allowInsecure: true as const } : {}),
      ...(claims[of].trustCertificate !== undefined ? { trustCertificate: claims[of].trustCertificate } : {}),
    });
  return Object.freeze({
    provider: preset.id,
    address,
    imap: block("imap", typed.imapHost),
    smtp: block("smtp", typed.smtpHost),
    ...(typeof name === "string" ? { displayName: name } : {}),
  });
}

/**
 * THE BODY OF AN EDIT: the password always, every other field only when typed, and the outgoing block only when one
 * of its fields was touched, so rotating a password dials no outgoing server.
 */
export function patchOf(typed: ConnectTyped, pass: Secret, claims: Claims): ConnectPatch {
  const edit: EditForm<Secret> = {
    host: typed.imapHost,
    port: typed.imapPort,
    user: typed.user,
    pass,
    smtpHost: typed.smtpHost,
    smtpPort: typed.smtpPort,
    allowInsecure: claims.imap.allowInsecure === true,
    allowInsecureSmtp: claims.smtp.allowInsecure === true,
  };
  const smtp = smtpPatchOf(edit);
  return Object.freeze({
    imap: Object.freeze(imapPatchOf(edit)),
    ...(smtp ? { smtp: Object.freeze(smtp) } : {}),
  }) as ConnectPatch;
}

/**
 * EACH SERVER AS A PRESS NAMES IT, for the consents: the field whole, trimmed and lower-cased, its port included.
 * An edit that types no host names the stored one. A consent given for one name is none for another.
 */
export function sentOf(typed: ConnectTyped, preset: ProviderPreset | null): Record<Leg, string> {
  const name = (field: string, port: string, of: Leg): string => {
    if (preset !== null) return (preset.manual ? field : preset[of].host).trim().toLowerCase();
    const host = field.trim().toLowerCase() || "stored";
    return port.trim() === "" ? host : `${host}:${port.trim()}`;
  };
  return {
    imap: name(typed.imapHost, typed.imapPort, "imap"),
    smtp: name(typed.smtpHost, typed.smtpPort, "smtp"),
  };
}

/** What the lookup of who hosts a domain's mail is asked: the domain alone, never the part before the @. */
export function lookupOf(address: string): string | null {
  return discoveryRequestFor(address)?.domain ?? null;
}
