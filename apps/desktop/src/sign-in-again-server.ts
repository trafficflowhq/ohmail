/**
 * WHERE "SIGN IN AGAIN" DIALS WHEN THE ENGINE CANNOT SAY — a mailbox an earlier version signed
 * out, which kept no record of its incoming server. The engine refuses the password-only press
 * as `mailbox_server_unknown` with what the install still knows; this module turns that into a
 * server the press can dial, or into the ask-once form's starting values. The provider table
 * lives in the client engine, which the engine process does not link, so this is decided here.
 */

import { PROVIDERS, portMeansImplicitTls, presetForAddress } from "../../webapp/app/shell/providers";

/** What the engine answered about a mailbox it cannot place. Every field may be absent. */
export interface ServerUnknown {
  /** The provider the mailbox was added as — a preset id, or `imap` for any other server. */
  provider: string | null;
  /** The login the outgoing server kept, when one was kept. */
  login: string | null;
  /** The outgoing server's host, when one was kept. */
  outgoingHost: string | null;
}

/** The refusal's details, read field by field; `null` when the answer is not this refusal. */
export function readServerUnknown(code: string | undefined, details: unknown): ServerUnknown | null {
  if (code !== "mailbox_server_unknown") return null;
  const d = (typeof details === "object" && details !== null ? details : {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return { provider: text(d.provider), login: text(d.login), outgoingHost: text(d.outgoingHost) };
}

/** An incoming server as the seal takes it. */
export interface IncomingServer { host: string; port: number; secure: boolean; user: string }

/**
 * THE SERVER THE INSTALL CAN STILL STATE AS A FACT: the named provider the mailbox was added as
 * (its hosts were imposed, never typed), or the named provider its outgoing server belongs to.
 * `null` otherwise — the address's domain is a guess, and a guess only pre-fills the form.
 */
export function knownIncoming(hint: ServerUnknown, address: string): IncomingServer | null {
  const outgoing = hint.outgoingHost?.toLowerCase() ?? null;
  const preset = PROVIDERS.find((p) => !p.manual && p.id === hint.provider)
    ?? (outgoing === null ? undefined : PROVIDERS.find((p) => !p.manual && p.smtp.host === outgoing));
  if (!preset) return null;
  return { ...preset.imap, user: hint.login ?? address.trim() };
}

/** What the ask-once form starts with — values the person sees and can change. */
export interface ServerAsk { host: string; port: string; user: string; outgoingHost: string | null }

export function askFor(hint: ServerUnknown, address: string): ServerAsk {
  const guess = presetForAddress(address);
  return {
    host: guess?.imap.host ?? "",
    port: String(guess?.imap.port ?? 993),
    user: hint.login ?? address.trim(),
    outgoingHost: hint.outgoingHost,
  };
}

/** The form's fields as the seal takes them, or `null` while one cannot be sent. */
export function incomingFromAsk(ask: ServerAsk): IncomingServer | null {
  const host = ask.host.trim();
  const port = Number(ask.port.trim());
  const user = ask.user.trim();
  if (host === "" || user === "" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, secure: portMeansImplicitTls(port), user };
}
