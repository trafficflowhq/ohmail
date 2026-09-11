/**
 * The standalone door's decisions, away from its markup. Every question the three screens
 * answer lives here: the platform sentence, whether Connect is offered, the server fields for
 * a typed address, the claim chip's label, where focus goes — the screens render answers and
 * decide nothing. Not a preference: this workspace has no React Native renderer, so a decision
 * inside a component is one no test can drive. It imports no `react-native` (expo and RN ship
 * Flow-typed JS the node transform refuses), so the platform is a parameter the screens pass
 * in. Nothing here holds a password beyond the form's own state: {@link StandaloneFields}
 * carries it to the engine once — never logged, stamped into a refusal, or stored.
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
 * Which refusals the IMAP host field may wear — a short list on purpose. The form attaches a
 * refusal to the incoming-server field while the server disclosure is open; right for the two
 * refusals that name it, false the moment the door gained refusals about the password and
 * encryption — a rejected sign-in pinned under "Incoming server (IMAP)" tells somebody the one
 * thing that is not wrong. Everything not on this list shows beside the verb instead. By key
 * rather than a flag: `RefusalKey` is derived from the deck, so a key that stops existing
 * stops compiling here.
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
 * WHAT KIND OF INSTALL HOLDS A MAILBOX THIS PHONE IS NOT ORGANIZING — the claim's own four.
 *
 * Mirrors `ORGANIZER_KINDS` and the closed `organized_elsewhere:*` reason set, declared here rather
 * than imported: this app reads the kind as a WORD off two doors and a new `@ohmail/core` subpath
 * would be six registration points for a union of four strings.
 */
export type HolderKind = "local" | "cloud" | "mobile" | "unknown";

/**
 * THE ONE READER OF THE KIND, AND IT TAKES BOTH SPELLINGS ON PURPOSE.
 *
 * The two doors say it differently and neither is wrong: the STANDALONE door hands the engine's own
 * stand-down reason (`organized_elsewhere:mobile`), the PAIRED door hands the roster's bare kind
 * word (`mobile`). One reader is the point — two would let the two arms of one panel put different
 * sentences on the same fact, which is the defect this whole row is about.
 *
 * Anything outside the four is `unknown`, which is a real answer and not a fallback: it is what a
 * claim written by a build this one cannot rank looks like, and it has its own sentence.
 */
export function holderKind(said: string | null | undefined): HolderKind {
  const word = (said ?? "").toLowerCase().split(":").pop() ?? "";
  return word === "local" || word === "cloud" || word === "mobile" ? word : "unknown";
}

/**
 * The claim chip in Settings. The five states are the desktop's, with the desktop's own keys
 * and values, derived from what the runtime reports and never from a stored flag — a flag can
 * disagree with the mailbox, and the mailbox is the master. `unknown` is its own arm rather
 * than a null, because "not read yet" and "read, and nothing holds it" are different facts,
 * and a chip that showed one for the other would state a claim nobody measured.
 */
export type PhoneClaim =
  /** Nothing has been read yet. */
  | { k: "unknown" }
  /** This install holds the claim. `stopping` = a hand-back is asked for and not yet confirmed. */
  | { k: "ours"; stopping: boolean }
  /** Read, and no install holds it. */
  | { k: "free" }
  /** Somebody else holds it, and named itself. */
  | { k: "theirs"; name: string; kind: HolderKind }
  /** Somebody else holds it and named nothing — an install from before the holder columns. */
  | { k: "theirsUnnamed"; kind: HolderKind };

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
 * Is the START verb offered? Only over a mailbox this phone has READ and nothing holds.
 *
 * `free` and nothing else, and each exclusion is a state the verb would lie in: `unknown` has not
 * been read, `ours` is already organizing, and the two foreign arms would promise a takeover this
 * build does not have — the door refuses a live foreign claim 409, so the press would do nothing
 * and say it had.
 */
export function mayStartHere(claim: PhoneClaim): boolean {
  return claim.k === "free";
}

/**
 * Is Send later offered at all — the composer's one predicate for the affordance. Two reasons
 * to withhold, held in one place because they are one question (may this message be given an
 * appointment?): a forward cannot wear one — a draft row stores no forward reference; and the
 * standalone door keeps no appointments — this phone organizes only while ohmail is running,
 * so an accepted appointment is a promise about a moment nothing will be awake for (the
 * engine refuses the verb: 409, `composition-passes.ts`). A paired session keeps the offer:
 * there the appointment is kept by the install the phone is paired to, which stays on.
 */
export function sendLaterOffered(o: { standalone: boolean; forward: boolean }): boolean {
  return !o.standalone && !o.forward;
}

/**
 * The chip's state, derived from the mailboxes read and nothing else. The standalone engine
 * answers the same `/mailboxes` contract every other door answers, so the app already holds
 * this fact: `world.mailboxes` gives `known` and `phoneOrganizer(...)`'s holder. This adds one
 * question only a standalone install can ask — is the holder us — answered by name, the one
 * this install wrote (`PhoneEngineDeps.machineName`). No column name appears in this app and
 * no second store is consulted; both are the phone's census rules, and both are one rule: one
 * source of truth for who organizes a mailbox.
 */
export function claimFrom(
  read: {
    known: boolean;
    organizer: { name: string; stopped: boolean; kind?: string | null } | null;
  },
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
  /* THE KIND TRAVELS WITH THE HOLDER, because the sentence under the chip reads it: a mailbox
     another PHONE organizes is organized only while ohmail is open on that phone, which is the one
     thing about a holder that changes what a person should expect of their mail. */
  const kind = holderKind(holder.kind);
  return holder.name.length > 0
    ? { k: "theirs", name: holder.name, kind }
    : { k: "theirsUnnamed", kind };
}

/**
 * ═══ THE SAME CLAIM FOR THE DOOR IN THIS PROCESS, AND IT ASKS NOBODY'S NAME ════════════════════
 *
 * {@link claimFrom} recognises our own claim BY NAME, which is all a roster read offers. Every
 * ohmail phone writes the SAME display name (`PHONE_CLAIM_NAME`), so on the ordinary two-phone case
 * the name test answers `ours` for the OTHER phone's claim: the panel would wear "Organizing" and
 * offer a hand-back over a mailbox this phone organizes nothing of. The engine already answers what
 * the name test stood in for — `organizing` is this install's verdict on its own claim — so this
 * reads that and compares nothing. `null` stays `unknown`: no chip, no verb, no sentence about a
 * mailbox opened a second ago.
 */
export function claimHere(
  here: {
    organizing: boolean | null;
    heldBy: { name: string; standDownReason: string } | null;
  },
  stopAsked: boolean = false,
): PhoneClaim {
  if (here.organizing === null) return { k: "unknown" };
  if (here.organizing) return { k: "ours", stopping: stopAsked };
  const held = here.heldBy;
  if (held === null) return { k: "free" };
  const kind = holderKind(held.standDownReason);
  return held.name.length > 0
    ? { k: "theirs", name: held.name, kind }
    : { k: "theirsUnnamed", kind };
}

/**
 * ═══ THE SENTENCE UNDER THE CHIP — what this phone does about THIS mailbox ═════════════════════
 *
 * The panel rendered {@link platformRuleLine} in every state, and that sentence describes what
 * organizing on a phone means ("It organizes while its notification is shown"). Over a mailbox
 * another machine holds it is false, and it was the only sentence a standing-down phone got beside
 * a chip naming nobody. So the note follows the claim: `ours`, `free` and `unknown` keep the
 * platform rule, and the two foreign arms name the holder and say what this phone does instead, in
 * the desktop's words (`mailboxes.readerReadsOnly`). No arm offers a takeover — there is no such
 * press in this panel, and promising one would be a claim the screen makes false.
 */
export function claimNoteLine(claim: PhoneClaim, os: string): string {
  switch (claim.k) {
    case "theirs":
      return claim.kind === "mobile"
        ? Copy.phoneStateReaderWhyPhone(claim.name)
        : Copy.phoneStateReaderWhy(claim.name);
    case "theirsUnnamed":
      /* A relaunch is where this arm lives: the engine reassembles a stood-down mailbox from its
         own row, which remembers the REASON and not the holder. The kind survives that and the
         name does not, so the phone clause is still said. */
      return claim.kind === "mobile"
        ? Copy.phoneStateReaderWhyUnnamedPhone
        : Copy.phoneStateReaderWhyUnnamed;
    default:
      return platformRuleLine(os);
  }
}
