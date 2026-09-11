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
import { faultDetail, refuse, type Refusal } from "../refusal";
import type { StandaloneFields } from "../ui/standalone-form";

/**
 * THE RUNNING ENGINE, AS THIS APP USES IT. Structural, because the bundle is not typed — so every
 * member here is a CLAIM about the artifact, and `test/engine-bundle-loads.test.ts` reads them off
 * a real booted one rather than off this declaration.
 *
 * The first three are the client's seam and the next two name the mailbox it serves. The last three
 * are the background half's: `handBack` and `resume` are the acts `background.ts` drives at every
 * app-state edge, and `runtimes` is the three-answer read the claim watch and the reader check both
 * ask. They were absent from this type while `createBackgroundOrganizing` had no call site, which
 * is what made the omission invisible.
 */
export interface StandaloneEngine {
  handle(req: Request): Promise<Response>;
  sessionToken: string;
  stop(): Promise<void>;
  /**
   * WHOSE MAILBOX THIS IS, in the engine's own words — half of the mirror's owner key.
   *
   * Read off the booted engine and never composed here, for `boot.ts`'s reason: the mirror is named
   * `(origin, accountId)`, so an id this app invented would key a SECOND copy of the one mailbox
   * this phone holds. This door mounts no `/auth/session`, which is where every paired door's
   * client reads the same fact.
   */
  accountId: string;
  /** The mailbox this install serves. The notification names it; nothing logs it. */
  address: string;
  /** Remove this install's claim on every mailbox and leave the rows alone. */
  handBack(): Promise<readonly { mailboxId: string; released: number | null }[]>;
  /** Force one gated cycle per mailbox, so the lease is re-read now. */
  resume(): Promise<void>;
  /** What each mailbox reports — the row's answer, not the gate's optimism. */
  runtimes(): { organizer: Record<string, { organizing: boolean }> };
}

/** The engine's composition root, as the artifact exports it. */
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
}) => Promise<StandaloneEngine>;

/**
 * THE RELAUNCH'S ENTRY — the same engine, started from what it sealed for itself.
 *
 * No `imap` and no `address`: a phone's credential form exists once, and every later launch has
 * only the store. Measured over the real composition, against an engine booted on a store:
 * the first launch seals the typed password beside the coordinates it was proved against, and a
 * launch given neither dials with both. So this app keeps no mailbox password anywhere — the one
 * copy is the engine's own sealed row, under the key ring `kek.ts` holds in the keystore.
 *
 * `no-credential` is a STATE and not a failure: a store with nothing sealed has no mailbox to open,
 * and the door that renders this says so rather than starting an engine that would authenticate to
 * nothing.
 */
export type StartPhoneEngineFromSealed = (deps: {
  exec: unknown;
  machineName: string;
  installId: string;
  keks?: Record<number, string>;
}) => Promise<{ kind: "started"; engine: StandaloneEngine } | { kind: "no-credential" }>;

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

/**
 * HOW THIS PHONE NAMES ITSELF IN THE CLAIM — a constant, and deliberately NOT a deck string.
 *
 * This value is written into the organizer claim in the mailbox, read back by every install, and
 * rendered on somebody else's desktop as the holder line. Two consequences decide it:
 *
 *  · it must not depend on the language. `claimFrom` recognises this install's own claim BY NAME,
 *    so a name read from the deck would change when the person switches language and the phone
 *    would stop recognising its own claim — the misread-own-claim class, arriving through copy.
 *  · it is DATA leaving this app, like an address, not a sentence this app renders. What the reader
 *    sees is the other client's `readerLabel("<name>")` around it, in the reader's own language.
 */
export const PHONE_CLAIM_NAME = "ohmail on a phone";

/** What the form does next. A refusal carries the engine's own words, or the missing-field one. */
export type StandaloneOutcome =
  | { ok: true; door: StandaloneEngine }
  | { ok: false; reason: Refusal };

/**
 * ═══ WHY A DIAL FAILED, AS FAR AS THIS APP MAY JUDGE IT ════════════════════════════════════════
 *
 * The engine refuses a launch the mail server ANSWERED WITH A NO and rethrows the server's own
 * error, which carries imapflow's two flags. These two predicates read them, and they are the
 * whole of what this app decides about a dial.
 *
 * They are not imports. The engine reaches this app as a pre-bundled artifact (see the banner), so
 * its `credentialsRefused`/`tlsRefused` cannot be named from here — and a second READING of the
 * same flag is not a second decision: the flags are imapflow's published surface, not ours.
 * `test/standalone-door.test.ts` pins the pair by BEHAVIOUR, driving the real artifact against a
 * server that refuses, so a divergence is caught by what happens rather than by a name.
 *
 * The `cause` walk and the hop bound are the engine's, for the engine's reason: the adapter wraps,
 * and a predicate that read only the outermost error would answer `false` for the wrapped shape it
 * exists to recognise.
 */
const flagged = (err: unknown, flag: "authenticationFailed" | "tlsFailed"): boolean => {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as Record<string, unknown>)[flag] === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

/** The server answered and rejected the sign-in. A password, not a network. */
export const signInRefused = (err: unknown): boolean => flagged(err, "authenticationFailed");

/** The server offered no encrypted way in on that port, or one that could not be trusted. */
export const encryptionRefused = (err: unknown): boolean => flagged(err, "tlsFailed");

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
    /* ── THE TWO ANSWERS A MAIL SERVER GAVE, WORDED AS THIS APP'S OWN SENTENCES ──────────────
     *
     * Both arrive as the server's own error, and neither may be shown as one: an English library
     * message inside a German screen is the defect `refusal.ts` exists for, and the sentence a
     * person needs here is about their password or their port, not about STARTTLS. So each becomes
     * a KEYED refusal with no arguments — which also means neither can carry the password. */
    if (signInRefused(err)) return { ok: false, reason: refuse("standaloneSignInRefused") };
    if (encryptionRefused(err)) return { ok: false, reason: refuse("standaloneNoEncryption") };
    /* `faultDetail`, never `String(err)`: it words a fault THIS APP authored (a store fault
       becomes a keyed refusal, rendered in the reader's language at the moment it is shown) and
       quotes anybody else's verbatim. The password is in neither — it is not in any argument this
       module builds. */
    return { ok: false, reason: refuse("standaloneRefused", faultDetail(err)) };
  }
}

/* ══ OPENING IT AGAIN, AFTER THE APP WAS KILLED ════════════════════════════════════════════════
 *
 * The door above runs once, behind a form. This runs on every launch after it, from the connection
 * layer, over a stored profile row — and it composes the same three things in the same order, with
 * the credential coming from the engine's own sealed row instead of from a field.
 */

/** What the relaunch needs of the app. The same shape {@link StandaloneDeps} has, minus the form. */
export interface ReopenDeps {
  /** The artifact's relaunch entry, or `null` where this build carries no engine. */
  startFromSealed: StartPhoneEngineFromSealed | null;
  /** The engine's own store and key ring — `openLocalEnginePlatform`'s answer. */
  platform: () => Promise<{ exec: unknown; keks: Record<number, string> }>;
  machineName: () => string;
  /** This install's durable id, from the app's install marker. Never the store's account id. */
  installId: () => Promise<string>;
}

/** The relaunch's answer. A refusal is a keyed sentence, never a fall-through to the chooser. */
export type ReopenOutcome =
  | { ok: true; door: StandaloneEngine }
  | { ok: false; reason: Refusal };

/**
 * OPEN THE MAILBOX THIS PHONE ALREADY HOLDS. Three refusals, each naming a different absence.
 *
 * The engine's own `no-credential` is the one worth a sentence of its own: it means the profile row
 * says this phone organizes a mailbox and the engine's store says nothing was ever sealed — a
 * disagreement between the two stores, which the person resolves by taking the door again.
 */
export async function reopenStandaloneMailbox(deps: ReopenDeps): Promise<ReopenOutcome> {
  const start = deps.startFromSealed;
  if (start === null) return { ok: false, reason: refuse("standaloneNoEngine") };
  try {
    const platform = await deps.platform();
    const started = await start({
      exec: platform.exec,
      machineName: deps.machineName(),
      installId: await deps.installId(),
      keks: platform.keks,
    });
    if (started.kind === "no-credential") {
      return { ok: false, reason: refuse("standaloneNoSealedCredential") };
    }
    return { ok: true, door: started.engine };
  } catch (err) {
    /* `faultDetail` for `openStandaloneMailbox`'s reason: it words a fault this app authored as a
       keyed refusal and quotes anybody else's verbatim. No password is in any argument this
       function builds — it never has one. */
    return { ok: false, reason: refuse("standaloneRefused", faultDetail(err)) };
  }
}
