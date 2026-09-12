/**
 * Opening a mailbox on this phone: the form's fields in, a running engine and a client bound
 * to it out. Providers, ports and TLS are decided before this module; mail is decided by the
 * engine — what is here is the composition and its two honest refusals. The engine is a
 * pre-bundled artifact (`local-engine.ts` states the rule), so `startEngine` is a parameter:
 * importing the engine's source would undo the bundling, and the door is offered exactly
 * where the artifact resolves ({@link standaloneAvailable}) — never a dead control. The
 * password passes through into `imap.auth.pass` and nowhere else — no log, no refusal
 * argument, no mirror; only the engine may keep it, sealed under `kek.ts`'s key ring.
 */
import { portMeansImplicitTls } from "@ohmail/client-engine";
import { LOCAL_ENGINE_ORIGIN } from "./boot";
import { faultDetail, refuse, type Refusal } from "../refusal";
import type { EngineLogSink } from "./engine-log";
import type { StandaloneFields } from "../ui/standalone-form";

/**
 * WHAT ASKING FOR THIS PHONE ANSWERED — three states, named, and no `null` among them.
 *
 * `held` and `refused` are separate because only one of them is worth a sentence. A live foreign
 * holder is the ordinary state of a phone whose mailbox a laptop organizes: nothing is wrong and
 * the panel already says which machine has it. `refused` is everything else the door said, and
 * that one a person reads. Collapsed, the claim watch would write "we could not start organizing"
 * under that chip once a minute for as long as the laptop kept the mailbox.
 */
export type ClaimHereOutcome = "claimed" | "held" | "refused";

/**
 * WHAT THE PERSON'S STOP SETTLED — the engine's own three answers, mirrored here.
 *
 * `released` is the only one a caller may act on as "the mailbox has been let go": the claim is
 * out of the mail server's records and the row has recorded the stop. `not_organizing` is a
 * mailbox with nothing to give up, and `refused` covers both a route that said no and a cycle
 * that could not confirm the claim left. A boolean collapsed the last two into the first, so the
 * notification came down over a phone that was still organizing.
 */
export type StopOrganizingOutcome = "released" | "not_organizing" | "refused";

/**
 * The running engine, as this app uses it. Structural, because the bundle is not typed — every
 * member here is a claim about the artifact, and `test/engine-bundle-loads.test.ts` reads them
 * off a real booted one rather than off this declaration. The first three are the client's
 * seam and the next two name the mailbox it serves. The last three are the background half's:
 * `handBack` and `resume` are the acts `background.ts` drives at every app-state edge, and
 * `runtimes` is the three-answer read the claim watch and the reader check both ask.
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
  /**
   * DISCARD THE PASSWORD THIS ENGINE SEALED FOR ITSELF — the refused launch's second effect.
   *
   * The seal is written at attach, before anything dials, and `resolveLogin` lets the STORE win:
   * a launch the app could not record leaves a credential that beats the next press's corrected
   * form. The engine already removes it on the refusals IT decides (`mailbox_open_seal_discarded`);
   * this is the same act for the one the APP decides, and the only caller is that refusal.
   */
  forgetStoredLogin(): Promise<boolean>;
  /** Force one gated cycle per mailbox, so the lease is re-read now. */
  resume(): Promise<void>;
  /**
   * ASK FOR THIS PHONE — the consent, recorded, and the gate asked now.
   *
   * A METHOD on the engine and not a request this app composes, and that is structural: the
   * privacy census admits a transport and a URL in six named files, and the organizer session is
   * not one of them. The app presses a verb; the engine's own door presses its own route.
   *
   * `held` is the refusal that matters and it is the ORDINARY answer for a phone whose mailbox
   * another machine organizes — see {@link ClaimHereOutcome}.
   */
  claimHere(): Promise<ClaimHereOutcome>;
  /**
   * THE PERSON'S STOP, WHERE A RELAUNCH CAN STILL READ IT.
   *
   * NOT {@link handBack}, and the difference is the whole of rows 1 and 3 of the device run.
   * `handBack` removes the claim and leaves the row saying organizer, because it serves an app
   * leaving the foreground and the next resume must take the mailbox back with no press. A
   * person's stop is the opposite instruction, so it goes through the release the ROW records —
   * and a reader with no press never re-enters the gate, on this launch or any later one.
   */
  stopOrganizing(): Promise<StopOrganizingOutcome>;
  /**
   * What each mailbox reports — the row's answer, not the gate's optimism.
   *
   * `heldBy` is the OTHER install's name when this one has stood down, and `reason` is WHY it stood
   * down (`organized_elsewhere:<kind>`). Both are needed and neither replaces the other: a claim
   * that named nothing leaves `heldBy` null, and so does a relaunch reading the stand-down off its
   * own row — so a panel branching on the name alone calls both of those a free mailbox and says
   * `Nothing organizes this mailbox` about a mailbox another machine holds. `reason` is the fact
   * "somebody else has it"; `heldBy` is who, where the claim said.
   */
  runtimes(): {
    organizer: Record<string, {
      organizing: boolean;
      heldBy: string | null;
      reason: string | null;
      /**
       * THE PERSON'S STOP STILL STANDING ON THE ROW — ISO 8601, or `null`.
       *
       * `organizing` answers what the engine's pass may ARRANGE, and a pass carrying out a release
       * arranges nothing whether or not the claim actually left the mailbox. So this is the only
       * field that separates a stop the mail server honoured from one it refused, and the panel
       * and the press both read it rather than inferring a stop from `organizing: false`.
       */
      releaseRequestedAt: string | null;
    }>;
    /**
     * CAN THIS INSTALL REACH THE MAIL SERVER RIGHT NOW — the engine's own connection facts, which
     * this type did not carry while the engine had been serving them all along.
     *
     * `organizer` answers who files the mailbox; this answers whether anything can. The two are
     * different questions with different remedies, and dropping this half is why the phone's only
     * sentence through a measured two-and-a-half-minute outage was the freshness stamp — true,
     * and useless. `unreachableSince` is the FIRST observation of the current outage, never the
     * latest attempt.
     */
    connection: Record<string, {
      reachable: boolean;
      unreachableSince: Date | null;
      signInRefused: boolean;
    }>;
  };
}

/**
 * WHERE THE ENGINE'S OWN DIAGNOSTIC LINES GO — a sink, on both entries.
 *
 * The engine writes one finished JSON line per event and this is where it goes; `engine-log.ts`
 * holds the whole argument for why the app supplies a DESTINATION and never a `Diagnostic` it
 * would have to compose fields for. Without it a phone's engine wrote nothing anywhere, so every
 * device-only defect had to be read off the mail server's wire and the ones that never reach the
 * wire could not be read at all.
 */
export type StartPhoneEngineLogging = { logSink?: EngineLogSink };

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
} & StartPhoneEngineLogging) => Promise<StandaloneEngine>;

/**
 * The relaunch's entry — the same engine, started from what it sealed for itself. No `imap`
 * and no `address`: a phone's credential form exists once, and every later launch has only the
 * store — the first launch seals the typed password beside the coordinates it was proved
 * against, and a launch given neither dials with both. So this app keeps no mailbox password
 * anywhere; the one copy is the engine's own sealed row, under the key ring `kek.ts` holds in
 * the keystore. `no-credential` is a state, not a failure: a store with nothing sealed has no
 * mailbox to open, and the door that renders this says so.
 */
export type StartPhoneEngineFromSealed = (deps: {
  exec: unknown;
  machineName: string;
  installId: string;
  keks?: Record<number, string>;
} & StartPhoneEngineLogging) => Promise<
  { kind: "started"; engine: StandaloneEngine } | { kind: "no-credential" }
>;

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
  /**
   * WHERE THE ENGINE'S LINES GO. `undefined` and it writes nothing, which is what a phone did.
   *
   * A seam like every other member here, so a case can read the exact lines a dial produced
   * instead of asserting that a channel was passed.
   */
  logSink?: EngineLogSink;
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
 * How this phone names itself in the claim — a constant, deliberately not a deck string. The
 * value is written into the organizer claim in the mailbox, read back by every install, and
 * rendered on somebody else's desktop as the holder line. It must not depend on the language:
 * `claimFrom` recognises this install's own claim by name, so a deck-read name would change on
 * a language switch and the phone would stop recognising its own claim. And it is data leaving
 * this app, like an address — the reader sees the other client's `readerLabel("<name>")`
 * around it, in the reader's own language.
 */
export const PHONE_CLAIM_NAME = "ohmail on a phone";

/**
 * HOW LONG A CLAIM THIS PHONE COULD NOT GIVE BACK GOES ON BLOCKING THE MAILBOX.
 *
 * Every install honours one staleness window and the desktop's is the fleet's
 * (`DEFAULT_STALE_AFTER_MS`, and the invariant is that no tier configures its own). The app may
 * not import the lease — the privacy census holds the engine behind the connection layer — so the
 * number is spelled here and PINNED against the lease's own constant by
 * `test/phone-claim-lapse-minutes.test.ts`, which is what keeps it from becoming a second answer
 * to "when can my laptop have the mailbox".
 */
export const CLAIM_LAPSES_AFTER_MINUTES = 10;

/**
 * IS THIS PROFILE ROW THE MAILBOX THIS PHONE OPENED ITSELF? The ORIGIN decides, and nothing else.
 *
 * Answered here rather than in the screen that asks, because a screen may not reach `engine/boot.ts`
 * — the privacy census holds the connection layer as the one door to the engine seam, and the
 * chooser importing the origin would have been a screen naming the engine's address. Both readings
 * that depend on it (the row's name, and whether a token-less row means "re-pair") are one question.
 */
export const organizesHere = (profile: { origin: string }): boolean =>
  profile.origin === LOCAL_ENGINE_ORIGIN;

/** What the form does next. A refusal carries the engine's own words, or the missing-field one. */
export type StandaloneOutcome =
  | { ok: true; door: StandaloneEngine }
  | { ok: false; reason: Refusal };

/**
 * Why a dial failed, as far as this app may judge it. The engine refuses a launch the mail
 * server answered with a no and rethrows the server's own error, carrying imapflow's two
 * flags; these predicates read them, and they are the whole of what this app decides about a
 * dial. Not imports: the engine arrives pre-bundled, so `credentialsRefused`/`tlsRefused`
 * cannot be named from here — a second reading of a published flag is not a second decision.
 * `test/standalone-door.test.ts` pins the pair by behaviour against a refusing server. The
 * `cause` walk and hop bound are the engine's: the adapter wraps, and reading only the
 * outermost error would answer `false` for the wrapped shape this exists to recognise.
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
      /* ABSENT rather than `undefined` when this app has no sink: the engine spreads on presence
         (`exactOptionalPropertyTypes`), and an `undefined` member would read as a channel. */
      ...(deps.logSink !== undefined ? { logSink: deps.logSink } : {}),
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
  /** See {@link StandaloneDeps.logSink}. A relaunch has no screen, so it needs it more. */
  logSink?: EngineLogSink;
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
      ...(deps.logSink !== undefined ? { logSink: deps.logSink } : {}),
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
