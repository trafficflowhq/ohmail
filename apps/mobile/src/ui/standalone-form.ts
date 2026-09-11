/**
 * ═══ THE STANDALONE DOOR'S DECISIONS, AWAY FROM ITS MARKUP ═════════════════════════════════════
 *
 * Every question the three screens answer lives here: which platform sentence the limitations
 * screen shows, whether Connect is offered, what the server fields hold for a typed address, which
 * label the claim chip wears, and where focus goes. The screens render these answers and decide
 * nothing themselves.
 *
 * That split is not a preference. This workspace has NO React Native renderer — `react-test-renderer`
 * and `@testing-library/react-native` are absent from the store, which `test/unsaved-changes.test.ts`
 * and `test/locale.test.ts` both record — so a decision written inside a component is a decision no
 * test can drive. The app already answers this by keeping its rules in plain modules; this is the
 * same move for the fourth door.
 *
 * ── AND IT IMPORTS NO `react-native`, WHICH IS WHAT MAKES IT LOADABLE AT ALL ───────────────────
 *
 * The expo and react-native packages ship Flow-typed JavaScript, and the node-side suite's
 * transform refuses it with `Expected 'from', got 'typeOf'` — a parse error naming neither the
 * package nor the import that reached it. So the platform is a PARAMETER here and the screens pass
 * it in, which is the same split `servers-native.ts` and `local-engine.ts` already make. It is also
 * the better shape: the platform is a fact about the runtime, and a function that read it for
 * itself could not be asked what it would say on the other one.
 *
 * ── AND NOTHING HERE HOLDS A PASSWORD BEYOND THE FORM'S OWN STATE ──────────────────────────────
 *
 * {@link StandaloneFields} carries the password because the form does, and it goes to the engine
 * once. It is never logged, never stamped into a refusal, and never stored by this module — the
 * only thing that may keep it is the platform's secure store, under the engine's key ring.
 */
import { portMeansImplicitTls, serverGuessFor } from "@ohmail/client-engine";
import { Copy } from "../copy";
import type { Refusal, RefusalKey } from "../refusal";

/** The two steps. The limitations screen comes first and cannot be skipped. */
export type StandaloneStep = "limits" | "credentials";

/**
 * THE PLATFORM SENTENCE — the only fork on any of these three screens.
 *
 * Taken from the runtime rather than from a build flag, and the iOS arm is the DEFAULT: a platform
 * this app has not met must not be told that something keeps organizing behind a notification it
 * may have no way to show. The conservative sentence is the true one for everything that is not
 * Android.
 */
export function platformRuleLine(os: string): string {
  return os === "android" ? Copy.phoneStandaloneL1Android : Copy.phoneStandaloneL1Ios;
}

/** The limitations screen's three lines, in the ruled order. */
export function limitationLines(os: string): readonly string[] {
  return [platformRuleLine(os), Copy.phoneStandaloneL2, Copy.phoneStandaloneL3];
}

/** The credential form's state. Ports and the TLS arm are strings and a flag, as the fields are. */
export interface StandaloneFields {
  readonly address: string;
  readonly password: string;
  readonly imapHost: string;
  readonly imapPort: string;
  readonly imapTls: boolean;
  readonly smtpHost: string;
  readonly smtpPort: string;
  /**
   * WHICH SERVER FIELDS THE PERSON TYPED THEMSELVES — the provenance rule, and it is the whole
   * reason this field exists.
   *
   * `hostsFor` in the provider table states the hazard for the picker: a value this app put in a
   * host field must never survive into a different server's attempt. Here the guess comes from the
   * address, so editing the address re-guesses — and would overwrite a host somebody typed by hand
   * if nothing recorded who put it there. A field named in this set is theirs and is left alone.
   */
  readonly typed: ReadonlySet<keyof StandaloneFields>;
}

/** An empty form. The ports are absent rather than invented: the first guess fills them. */
export const EMPTY_STANDALONE: StandaloneFields = {
  address: "",
  password: "",
  imapHost: "",
  imapPort: "",
  imapTls: true,
  smtpHost: "",
  smtpPort: "",
  typed: new Set(),
};

/** The four server fields a guess may write. The address and the password are never guessed. */
const GUESSED = ["imapHost", "imapPort", "smtpHost", "smtpPort"] as const;

/**
 * The address changed, so the guess changes with it — except in the fields the person has typed.
 *
 * An unrecognised domain still fills the PORTS (993 and 587 are the two numbers worth offering for
 * any mailbox) and leaves the hosts empty, because an empty host is the absence of a value and a
 * wrong host is a value. `serverGuessFor` is the shared table's; nothing about providers is decided
 * in this app.
 */
export function withAddress(fields: StandaloneFields, address: string): StandaloneFields {
  const guess = serverGuessFor(address);
  const keep = <K extends keyof StandaloneFields>(key: K, next: string): string =>
    fields.typed.has(key) ? (fields[key] as string) : next;
  const imapPort = keep("imapPort", guess.imapPort);
  return {
    ...fields,
    address,
    imapHost: keep("imapHost", guess.imapHost),
    imapPort,
    /* The switch follows the port it ends up with, never the guess's own flag — see `setImapPort`:
       the port is the one source of truth and the switch is a view of it. */
    imapTls: portMeansImplicitTls(Number(imapPort)),
    smtpHost: keep("smtpHost", guess.smtpHost),
    smtpPort: keep("smtpPort", guess.smtpPort),
  };
}

/** A server field the person edited. Recorded as theirs, so no later guess overwrites it. */
export function setTyped(
  fields: StandaloneFields,
  key: (typeof GUESSED)[number],
  value: string,
): StandaloneFields {
  const typed = new Set(fields.typed);
  typed.add(key);
  return { ...fields, [key]: value, typed };
}

/**
 * THE PORT AND THE SWITCH ARE ONE FACT, in both directions.
 *
 * `enterLocalDoor` derives `secure` from the PORT and ignores any separate flag, so a switch
 * holding its own value would be a control the engine never reads — a false affordance in the one
 * place somebody is deciding how their password travels. Typing a port moves the switch; moving the
 * switch sets the port. There is one value underneath and the two controls are views of it.
 */
export function setImapPort(fields: StandaloneFields, port: string): StandaloneFields {
  const typed = new Set(fields.typed);
  typed.add("imapPort");
  return { ...fields, imapPort: port, imapTls: portMeansImplicitTls(Number(port)), typed };
}

/** Implicit TLS is port 993; without it, 143, which STARTTLS upgrades. */
export function setImapTls(fields: StandaloneFields, on: boolean): StandaloneFields {
  return setImapPort(fields, on ? "993" : "143");
}

/**
 * CONNECT IS OFFERED ON THE ADDRESS AND THE PASSWORD, and on nothing else.
 *
 * The hosts are deliberately not a condition. Behind a recognised domain they are this app's own
 * fact, and behind an unrecognised one the engine's refusal names the missing host in its own
 * words — which is a better sentence than a disabled button that explains nothing. A control that
 * cannot be pressed and does not say why is the dead end this door's whole design refuses.
 */
export function mayConnect(fields: StandaloneFields): boolean {
  return fields.address.trim().length > 0 && fields.password.length > 0;
}

/**
 * WHICH REFUSALS THE IMAP HOST FIELD MAY WEAR — and it is a short list on purpose.
 *
 * The form attaches a refusal to the incoming-server field as that field's own error while the
 * server disclosure is open. That is right for the two refusals that NAME it, and it became a
 * false statement the moment the door gained refusals about the password and about encryption: a
 * sign-in the server rejected, pinned under "Incoming server (IMAP)", tells somebody the one
 * thing that is not wrong. Everything not on this list is shown beside the verb instead, where the
 * closed-disclosure case already shows it.
 *
 * The list is by KEY rather than by a flag on the refusal: `RefusalKey` is derived from the deck,
 * so a key that stops existing stops compiling here.
 */
const SERVER_FIELD_REFUSALS: ReadonlySet<RefusalKey> = new Set<RefusalKey>([
  "standaloneNoHost",
  "standaloneNoPort",
]);

/** Does this refusal name the server fields? See {@link SERVER_FIELD_REFUSALS}. */
export function refusalNamesServerFields(r: Refusal): boolean {
  return SERVER_FIELD_REFUSALS.has(r.say);
}

/**
 * WHERE FOCUS GOES WHEN A STEP MOUNTS. The limitations screen is a read, so focus goes to its
 * heading and the reader starts at the top; the form is work, so it goes to the first field.
 */
export function focusTargetFor(step: StandaloneStep): "title" | "address" {
  return step === "credentials" ? "address" : "title";
}

/**
 * ═══ THE CLAIM CHIP IN SETTINGS ════════════════════════════════════════════════════════════════
 *
 * The five states are the desktop's, with the desktop's own keys and values. They are derived from
 * what the runtime reports and never from a stored flag, which is the reason the desktop's row is
 * trustworthy: a flag can disagree with the mailbox, and the mailbox is the master.
 *
 * `unknown` is its own arm rather than a null, because "not read yet" and "read, and nothing holds
 * it" are different facts and a chip that showed one for the other would be stating a claim nobody
 * measured.
 */
export type PhoneClaim =
  /** Nothing has been read yet. */
  | { k: "unknown" }
  /** This install holds the claim. `stopping` = a hand-back is asked for and not yet confirmed. */
  | { k: "ours"; stopping: boolean }
  /** Read, and no install holds it. */
  | { k: "free" }
  /** Somebody else holds it, and named itself. */
  | { k: "theirs"; name: string }
  /** Somebody else holds it and named nothing — an install from before the holder columns. */
  | { k: "theirsUnnamed" };

/** The chip's caption. `null` for `unknown`: no chip at all rather than a chip that guesses. */
export function claimChipLabel(claim: PhoneClaim): string | null {
  switch (claim.k) {
    case "unknown":
      return null;
    case "ours":
      return claim.stopping ? Copy.phoneStateStopping : Copy.phoneStateOrganizing;
    case "free":
      return Copy.phoneStateNotOrganized;
    case "theirs":
      return Copy.phoneStateReader(claim.name);
    case "theirsUnnamed":
      return Copy.phoneStateReaderLegacy;
  }
}

/**
 * Is the hand-back verb offered? Only where there is a claim of OURS to hand back.
 *
 * `stopping` already means one was asked for, so offering it again would queue a second request for
 * a thing that is already happening — and `stopOrganizingNot` on the desktop exists because that
 * press was reachable there.
 */
export function mayStopHere(claim: PhoneClaim): boolean {
  return claim.k === "ours" && !claim.stopping;
}

/**
 * ═══ IS SEND LATER OFFERED AT ALL — the composer's one predicate for the affordance ════════════
 *
 * Two reasons to withhold it, and the file that used to test only the first now holds both in one
 * place, because they are one question: may this message be given an appointment?
 *
 *  · a FORWARD cannot wear one — a draft row stores no forward reference;
 *  · the STANDALONE door keeps no appointments. This phone organizes the mailbox only while
 *    ohmail is running on it, so an appointment it accepted is a promise about a moment nothing
 *    will be awake for. The engine refuses the verb (409, `composition-passes.ts`), and a control
 *    that fails after the pick is exactly what the forward arm is already shaped to avoid.
 *
 * A PAIRED session keeps the offer, and that is the half worth stating: there the appointment is
 * kept by the install the phone is paired to — a computer, a self-host box, ohmail Cloud — and
 * that install stays on, so the promise is true and narrowing it would remove a working feature.
 */
export function sendLaterOffered(o: { standalone: boolean; forward: boolean }): boolean {
  return !o.standalone && !o.forward;
}

/**
 * THE CHIP'S STATE, DERIVED FROM THE MAILBOXES READ AND NOTHING ELSE.
 *
 * The standalone engine answers the same `/mailboxes` contract every other door answers, so the app
 * already holds this fact: `world.mailboxes` gives `known` and `phoneOrganizer(...)`'s holder. This
 * adds one question that only a standalone install can ask — is the holder US — and it is answered
 * by NAME, because the name in the claim is the one this install wrote (`PhoneEngineDeps.machineName`).
 *
 * No column name appears in this app and no second store is consulted. Both are rules the phone's
 * censuses hold, and both are the same rule: one source of truth for who organizes a mailbox.
 */
export function claimFrom(
  read: { known: boolean; organizer: { name: string; stopped: boolean } | null },
  ourName: string,
  stopAsked: boolean = false,
): PhoneClaim {
  if (!read.known) return { k: "unknown" };
  const holder = read.organizer;
  if (holder === null) return { k: "free" };
  if (holder.name === ourName) {
    /* A stop this app asked for is the newest word until the row carries it; once the row says
       `stopped`, the row is. Either way the chip must not read "Organizing" — the desktop's
       `stopQueued` rule, and it exists because that press showed no trace anywhere. */
    return { k: "ours", stopping: stopAsked || holder.stopped };
  }
  return holder.name.length > 0 ? { k: "theirs", name: holder.name } : { k: "theirsUnnamed" };
}
