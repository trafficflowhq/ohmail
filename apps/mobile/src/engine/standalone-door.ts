/**
 * ═══ OPENING A MAILBOX ON THIS PHONE ═══════════════════════════════════════════════════════════
 *
 * The form's fields in, a running engine and a client bound to it out. Everything about providers,
 * ports and TLS is decided before this module is called; everything about mail is decided by the
 * engine. What is here is the composition and the two refusals it can honestly make.
 *
 * ── THE ENGINE IS A PRE-BUNDLED ARTIFACT, AND THAT IS WHY `startEngine` IS A PARAMETER ─────────
 *
 * `local-engine.ts` states the rule: the engine reaches this app as a bundle whose specifiers are
 * already resolved and whose Node builtins are already substituted, and importing its SOURCE from
 * here would undo all of it. So this module never names the engine's module — it takes the
 * artifact's `startPhoneEngine` as a value.
 *
 * That parameter is also what keeps the fourth door from being a dead control. Whether the artifact
 * is in a build is a packaging fact, so the DOOR is offered exactly where the artifact resolves
 * ({@link standaloneAvailable}) — a build without it shows three doors rather than a fourth one
 * that refuses. Data-driven, not a flag.
 *
 * ── THE PASSWORD PASSES THROUGH AND IS NEVER WRITTEN DOWN HERE ─────────────────────────────────
 *
 * It goes into `imap.auth.pass` and nowhere else: not into a log line, not into a refusal's
 * arguments, not into the mirror. The only thing that may keep it is the engine, sealed under the
 * key ring `kek.ts` produces. Nothing in this file calls `console`.
 */
import { portMeansImplicitTls } from "@ohmail/client-engine";
import { refuse, type Refusal } from "../refusal";
import type { StandaloneFields } from "../ui/standalone-form";

/** The engine's composition root, as the artifact exports it. Structural: the bundle is not typed. */
export type StartPhoneEngine = (deps: {
  exec: unknown;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    smtp?: { host: string; port: number; secure: boolean };
  };
  address: string;
  machineName: string;
  installId: string;
  keks?: Record<number, string>;
}) => Promise<{ handle(req: Request): Promise<Response>; sessionToken: string; stop(): Promise<void> }>;

/** What this module needs of the app. Each one is a seam the suite drives directly. */
export interface StandaloneDeps {
  /** The artifact's composition root, or `null` where this build carries no engine. */
  startEngine: StartPhoneEngine | null;
  /** The engine's own store and key ring — `openLocalEnginePlatform`'s answer. */
  platform: () => Promise<{ exec: unknown; keks: Record<number, string> }>;
  /** How this phone names itself in the claim. The holder line on somebody's desktop reads it. */
  machineName: () => string;
  /** This install's durable id, from the app's install marker. Never the store's account id. */
  installId: () => Promise<string>;
}

/**
 * IS THERE A FOURTH DOOR IN THIS BUILD? The artifact decides, and nothing else does.
 *
 * A `false` here is what makes the chooser show three doors. It is deliberately not a capability
 * flag somebody can set: a build whose engine is absent cannot organize whatever a flag says.
 */
export const standaloneAvailable = (deps: Pick<StandaloneDeps, "startEngine">): boolean =>
  deps.startEngine !== null;

/**
 * THE IMAP CONFIG THE ENGINE IS GIVEN — `secure` from the PORT, never from the form's switch.
 *
 * This is the same derivation `enterLocalDoor` makes on the desktop, and it is the reason the
 * form's TLS control sets the port rather than a flag of its own: two places deciding whether a
 * socket starts encrypted is one place too many for a password.
 */
export function imapConfigFor(fields: StandaloneFields): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  smtp?: { host: string; port: number; secure: boolean };
} {
  const imapPort = Number(fields.imapPort);
  const smtpPort = Number(fields.smtpPort);
  const base = {
    host: fields.imapHost.trim(),
    port: imapPort,
    secure: portMeansImplicitTls(imapPort),
    /* The login is the address. The desktop's form offers a separate username for the mailboxes
       whose login differs; this one does not, so there is nothing here that could disagree. */
    auth: { user: fields.address.trim(), pass: fields.password },
  };
  return fields.smtpHost.trim().length > 0 && Number.isFinite(smtpPort)
    ? {
        ...base,
        smtp: { host: fields.smtpHost.trim(), port: smtpPort, secure: portMeansImplicitTls(smtpPort) },
      }
    : base;
}

/** What the form does next. A refusal carries the engine's own words, or the missing-field one. */
export type StandaloneOutcome =
  | { ok: true; door: { handle(req: Request): Promise<Response>; sessionToken: string; stop(): Promise<void> } }
  | { ok: false; reason: Refusal };

/**
 * Open it. Two refusals before the engine is asked anything, and after that the engine's own.
 *
 * The host check is here rather than on the button because a refusal that names the missing field
 * is a better sentence than a control that will not press — see `mayConnect`'s note. Nothing is
 * retried and nothing is cached: a second press composes again from the fields as they now stand.
 */
export async function openStandaloneMailbox(
  fields: StandaloneFields,
  deps: StandaloneDeps,
): Promise<StandaloneOutcome> {
  const start = deps.startEngine;
  if (start === null) return { ok: false, reason: refuse("standaloneNoEngine") };
  const imap = imapConfigFor(fields);
  if (imap.host.length === 0) return { ok: false, reason: refuse("standaloneNoHost") };
  if (!Number.isFinite(imap.port) || imap.port <= 0) {
    return { ok: false, reason: refuse("standaloneNoPort") };
  }
  try {
    const platform = await deps.platform();
    const engine = await start({
      exec: platform.exec,
      imap,
      address: imap.auth.user,
      machineName: deps.machineName(),
      installId: await deps.installId(),
      keks: platform.keks,
    });
    return { ok: true, door: engine };
  } catch (err) {
    /* THE ENGINE'S OWN SENTENCE, and the value rather than the class: a thrown STRING loses its
       payload at every `errorClass` log site, so what travels is what was thrown. The password is
       not in it — it is not in any argument this module builds. */
    return { ok: false, reason: refuse("standaloneRefused", String(err)) };
  }
}
