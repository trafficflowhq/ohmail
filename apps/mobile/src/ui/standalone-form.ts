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
import { holderIsLive, portMeansImplicitTls, serverGuessFor } from "@ohmail/client-engine";
import { Copy } from "../copy";
/* TYPE ONLY, so the session's module state does not travel into every consumer of this module.
   The mapping from the instruction to a chip is a DECISION and belongs here rather than in a
   component — the header's rule. */
import type { OrganizeInstruction } from "../engine/organizer-session";
import { refuse, type Refusal, type RefusalKey } from "../refusal";

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

/** The four server fields a refusal can be worn by. */
export type ServerField = (typeof GUESSED)[number];

/**
 * WHICH FIELD WEARS WHICH REFUSAL — a short map on purpose. A rejected sign-in pinned under
 * "Incoming server (IMAP)" tells somebody the one thing that is not wrong, so only a refusal
 * about a server field is attached to one; everything else shows beside the verb. By key:
 * `RefusalKey` is derived from the deck, so a key that stops existing stops compiling here.
 */
const FIELD_OF: Readonly<Partial<Record<RefusalKey, ServerField>>> = {
  standaloneNoHost: "imapHost",
  serverSettingsImapUnreachable: "imapHost",
  serverSettingsHostWhileOrganizing: "imapHost",
  serverSettingsHostHeld: "imapHost",
  serverSettingsHostHeldUnnamed: "imapHost",
  standaloneNoPort: "imapPort",
  /* The certificate is the server's: the host name is the field that fixes a mismatch. */
  standaloneCertificateRefused: "imapHost",
  standaloneNoSmtpHost: "smtpHost",
  standaloneNoSmtpPort: "smtpPort",
  standaloneSmtpSignInRefused: "smtpHost",
  standaloneSmtpNoEncryption: "smtpHost",
  standaloneSmtpUnreachable: "smtpHost",
};

/** The server field this refusal is about, or `null` for one that belongs beside the verb. */
export function refusalField(r: Refusal): ServerField | null {
  return FIELD_OF[r.say] ?? null;
}

/** Does this refusal name a server field? See {@link refusalField}. */
export function refusalNamesServerFields(r: Refusal): boolean {
  return refusalField(r) !== null;
}

/**
 * A PORT A SOCKET CAN BE OPENED ON: digits only, a whole number from 1 to 65535. `Number()`
 * admitted `587465` (typing 465 behind a prefilled 587), `70000`, `1e3` and `""` as `0`, and the
 * form then left as connected over a submission server nothing could reach.
 */
export function portIsDialable(text: string): boolean {
  const t = text.trim();
  return /^[0-9]{1,5}$/.test(t) && Number(t) >= 1 && Number(t) <= 65535;
}

/**
 * THE PORT RULE, ASKED BEFORE ANYTHING DIALS — the IMAP port always, the SMTP port wherever an
 * outgoing server is named (a blank one is "no submission server", which has no port to judge).
 * One question for the Connect press and the Settings edit, so the two cannot disagree.
 */
export function portRefusal(f: Pick<StandaloneFields, "imapPort" | "smtpHost" | "smtpPort">): Refusal | null {
  if (!portIsDialable(f.imapPort)) return refuse("standaloneNoPort");
  if (f.smtpHost.trim() !== "" && !portIsDialable(f.smtpPort)) return refuse("standaloneNoSmtpPort");
  return null;
}

/**
 * THE SENTENCE A PORT FIELD WEARS WHILE IT IS TYPED — before any press. Silent while empty: the
 * press answers an empty port, and a field that scolds before anything is typed is noise.
 */
export function portFieldSaid(text: string, leg: "imap" | "smtp"): Refusal | null {
  if (text.trim() === "" || portIsDialable(text)) return null;
  return leg === "imap" ? refuse("standaloneNoPort") : refuse("standaloneNoSmtpPort");
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
 * THE ONE READER OF THE KIND, AND IT TAKES BOTH SPELLINGS ON PURPOSE. The two doors say it
 * differently and neither is wrong: the STANDALONE door hands the engine's stand-down reason
 * (`organized_elsewhere:mobile`), the PAIRED door the roster's bare kind word (`mobile`). One reader
 * is the point — two would let the two arms of one panel put different sentences on the same fact.
 * Anything outside the four is `unknown`, a real answer not a fallback: what a claim written by a
 * build this one cannot rank looks like, and it has its own sentence.
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
  /**
   * The DOOR IN THIS PROCESS holds the claim — {@link claimHere} and no other producer.
   * `stopping` = a hand-back is asked for and not yet confirmed. `releasePending` = the person's
   * stop is RECORDED on the row and the mail server has not honoured it: the engine's own second
   * answer, carried so the chip is the engine's state rather than a plain `Organizing` over a
   * mailbox somebody has already asked this phone to let go.
   */
  | { k: "ours"; stopping: boolean; releasePending: boolean; siblingLapse?: boolean }
  /** Read, and no install holds it. `starting` = a start is asked for and not yet confirmed. */
  | { k: "free"; starting: boolean }
  /**
   * THE SERVER THIS PHONE IS PAIRED WITH ORGANIZES IT — the normal Cloud-paired state, and the
   * one this panel could not say. It is not `theirs`: that arm names a FOREIGN install and offers
   * the reader's sentence about somebody else's machine, while this is the very server answering
   * the request, which organizes whether or not this app is open. Reached only from a paired
   * roster; the door in this process answers `ours` from its own engine and never this.
   */
  | { k: "pairedServer" }
  /**
   * THIS INSTALL GAVE THE MAILBOX BACK AND HAS NOT TAKEN IT AGAIN — the transitional state.
   *
   * A refinement of `free` and not a sixth unrelated arm: the engine says this install organizes
   * nothing and nobody else holds it, which is what `free` means, plus the one fact only this
   * install knows — that the release was ours and was completed on every mailbox. Read as `free`
   * the panel said `Nothing organizes this mailbox` about a mailbox this phone had just released
   * and is about to take back, which invites a person to press a verb for something already
   * happening.
   */
  | { k: "handedBack" }
  /**
   * PAUSED BY THE CLOSED ACCOUNT (mail 0135): the paired server released it at the park and takes
   * it back on its own once the account is open — not `free` (no press is owed) and not a stop.
   */
  | { k: "parked" }
  /** Somebody else holds it, and named itself. */
  | { k: "theirs"; name: string; kind: HolderKind }
  /** Somebody else holds it and named nothing — an install from before the holder columns. */
  | { k: "theirsUnnamed"; kind: HolderKind }
  /**
   * THIS PHONE'S GATE CANNOT READ `ohmail/_meta` for a reason fixed on the mail server — ahead of
   * `ours` and `free`, the desktop's precedence. `holding`: this install still holds the claim, so
   * Stop stays offered; it reads `ours` again at the first healthy pass.
   */
  | { k: "blocked"; reason: "meta_folder_full" | "meta_undeletable"; holding: boolean };

/** The chip's caption. `null` for `unknown`: no chip at all rather than a chip that guesses. */
export function claimChipLabel(claim: PhoneClaim): string | null {
  switch (claim.k) {
    case "unknown":
      return null;
    case "ours":
      /* THE ENGINE'S STATE, IN THE ORDER A PERSON NEEDS IT. A stop this phone is carrying out is
         `Stopping`; one the mail server has been asked for and has not honoured is its own chip —
         rendered as `Organizing` it told somebody their press had done nothing and offered them
         the same verb again. */
      return claim.stopping ? Copy.phoneStateStopping
        : claim.releasePending ? Copy.phoneStateStopPending
          : Copy.phoneStateOrganizing;
    case "free":
      return claim.starting ? Copy.phoneStateStarting : Copy.phoneStateNotOrganized;
    case "pairedServer":
      return Copy.phoneStatePairedServer;
    case "handedBack":
      return Copy.phoneStateHandedBack;
    case "parked":
      return Copy.phoneStateParked;
    case "theirs":
      return Copy.phoneStateReader(claim.name);
    case "theirsUnnamed":
      return Copy.phoneStateReaderLegacy;
    case "blocked":
      // The chip is the whole sentence: the desktop row's, word for word.
      return metaBlockedLine(claim.reason);
  }
}

/** The desktop row's sentence for the gate's two named `_meta` refusals. */
export function metaBlockedLine(reason: "meta_folder_full" | "meta_undeletable"): string {
  return reason === "meta_folder_full" ? Copy.phoneStateMetaFolderFull : Copy.phoneStateMetaUndeletable;
}

/**
 * Is the hand-back verb offered? Only where there is a claim of OURS to hand back.
 *
 * `stopping` already means one was asked for, so offering it again would queue a second request for
 * a thing that is already happening — and `stopOrganizingNot` on the desktop exists because that
 * press was reachable there.
 */
export function mayStopHere(claim: PhoneClaim): boolean {
  return (claim.k === "ours" && !claim.stopping) || (claim.k === "blocked" && claim.holding);
}

/**
 * Is the RE-SUPPLY verb offered? On the door in THIS process, once the engine has named the
 * mailbox it serves — the press addresses that id, and a card with none has nothing to send.
 *
 * In EVERY claim state, unlike the two verbs beside it: a password is changed at the provider
 * BEFORE the server starts refusing, so a verb that appeared only after the refusal would arrive
 * a sync late. It is about the credential, which no claim state describes.
 */
export function maySignInAgain(here: { readonly id: string | null } | null): boolean {
  return here !== null && here.id !== null && here.id !== "";
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
  /* …and not while one is already being carried out. `stopping` has the same rule on the verb
     above and for the same reason: a second press would queue a second instruction for a thing
     that is already happening. */
  return claim.k === "free" && !claim.starting;
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
/**
 * WHY THIS PHONE KEEPS NO APPOINTMENT, in the state it is in: organizing its own mailbox it does
 * so only while ohmail runs, and reading one it organizes nothing — the install that organizes it
 * is the one that can keep a later send. `holder` is the named organizer when this phone reads.
 */
export function scheduledNotHereSentence(holder: { name: string; stopped?: boolean } | null): string {
  if (holder === null) return Copy.scheduledNotOnThisPhone;
  return holder.stopped ? Copy.scheduledReaderHereStopped(holder.name) : Copy.scheduledReaderHere(holder.name);
}

/** The connect notice's sentence: the holder named, or the claim that named nobody. */
export function readingAtConnectLine(holder: { name: string }): string {
  const name = holder.name.trim();
  return name === "" ? Copy.readingAtConnectUnknown : Copy.readingAtConnect(name);
}

export function sendLaterOffered(o: {
  standalone: boolean;
  forward: boolean;
  /**
   * A draft row stores no attachment bytes (`ComposeAttachment`'s contract: nothing filed
   * against the account), so a scheduled send could not carry them — the webapp withholds the
   * affordance (`sendLaterUnavailable`) and this phone follows. REQUIRED, so TypeScript is the
   * census over every caller: optional, a surface that gained attachments would keep offering
   * an appointment the server refuses.
   */
  hasAttachments: boolean;
}): boolean {
  return !o.standalone && !o.forward && !o.hasAttachments;
}

/**
 * THE CHIP'S STATE ON A PAIRED ROSTER, AND IT DECIDES NO IDENTITY BY NAME.
 *
 * This took the name this install writes into its claim (`PHONE_CLAIM_NAME`) and answered `ours`
 * where the roster's holder matched it. Every ohmail phone writes that same string, so a second
 * phone organizing the mailbox read as this one: the chip said `Organizing`, the hand-back was
 * offered over a claim this app does not hold, and the press — which asks the PAIRED SERVER to give
 * up ITS claim — answered "not organizing" and left the chip reading `Stopping` for the life of the
 * screen while the other phone organized on.
 *
 * The comparison is gone rather than re-sourced, because its answer is a constant: a paired phone
 * runs no IMAP client and writes no claim (`live.ts#phoneOrganizer` says so), so no holder a paired
 * roster can name is ever this install's. Every holder here is another install — including the
 * server this phone is paired to — and the card names it and offers no verb. The door in this
 * process is the one card that can say `ours`, and it says it from the engine's own verdict on its
 * own claim ({@link claimHere}), never from a name.
 */
export function claimFrom(
  read: {
    known: boolean;
    /**
     * WHAT THE ANSWERING SERVER SAID IT IS TO THIS MAILBOX — `MailboxDTO.organizerRole`, and the
     * field this read did not have. REQUIRED, so TypeScript is the census over every caller: made
     * optional, a caller that forgot it would go on answering `free` from a null holder, which is
     * exactly the false state ("Nothing organizes this mailbox" over a Cloud-organized mailbox)
     * and nothing would say so. `null` is a server that named no role.
     */
    role: "organizer" | "reader" | null;
    /** `MailboxDTO.organizedByThisInstall` — see below; it only ever admits the paired arm. */
    serverHolds: boolean;
    /** `MailboxDTO.organizerParkedAt` is set — the closed account's pause. Absent reads as not paused. */
    parked?: boolean;
    organizer: { name: string; stopped: boolean; kind?: string | null } | null;
  },
): PhoneClaim {
  if (!read.known) return { k: "unknown" };
  /* ══ THE ANSWERING SERVER'S OWN CLAIM, AND IT OUTRANKS EVERY NAME ═══════════════════════════
   * `organizerRole` is what THIS install is to this mailbox, and on a paired roster this install is
   * the server that answered. Read FIRST because such a row can still carry a holder, and that
   * holder is the same server's own claim — `theirs` would call the paired server another install.
   * `organizedByThisInstall` admits the arm from the other side and is never required for it: on
   * the live hosted service the role reads `organizer` while that boolean reads `false`. The
   * webapp's own rule one install further (`app/shell/mail-state.ts#noticeKind`). */
  if (read.role === "organizer" || read.serverHolds) return { k: "pairedServer" };
  // Ahead of every holder arm: a paused mailbox is neither free nor stopped (the web's rule).
  if (read.parked === true) return { k: "parked" };
  const holder = read.organizer;
  /* A HOLDER WHOSE LEASE LAPSED IS NOBODY, by the reader refusal's own decider: it organizes
     nothing, and a card naming it would send somebody to a machine that stopped. */
  if (holder === null || !holderIsLive({
    by: { kind: holder.kind ?? null, name: holder.name }, state: holder.stopped ? "stopped" : null,
  })) {
    /* NOBODY, AND ONLY BECAUSE THE SERVER SAID SO. A holder-less row is `free` only where the role
       says `reader`: null alone cannot tell "nobody has ever claimed it" from "the server that
       answered organizes it". A server that named no role gets no chip rather than a guessed one —
       `unknown` is already what this panel renders as silence. NEVER `starting` here: this app
       holds no engine to ask on a paired row. */
    return read.role === "reader" ? { k: "free", starting: false } : { k: "unknown" };
  }
  /* THE KIND TRAVELS WITH THE HOLDER, because the sentence under the chip reads it: a mailbox
     another PHONE organizes is organized only while ohmail is open on that phone, which is the one
     thing about a holder that changes what a person should expect of their mail. */
  const kind = holderKind(holder.kind);
  return holder.name.trim().length > 0
    ? { k: "theirs", name: holder.name, kind }
    : { k: "theirsUnnamed", kind };
}

/**
 * One paired row's holder in {@link claimFrom}'s shape — the recorded holder, or nothing. Whether
 * it still organizes is `claimFrom`'s question, asked of the reader refusal's decider. The KIND
 * rides along: the note under the chip reads it, and a phone holder has its own sentence.
 */
export function claimHolderOf(row: {
  organizedBy: { kind: string | null; name: string | null } | null;
  organizerState: "held" | "stopped" | null;
}): { name: string; stopped: boolean; kind: string | null } | null {
  const by = row.organizedBy;
  return by === null
    ? null
    : { name: by.name ?? "", stopped: row.organizerState === "stopped", kind: by.kind ?? null };
}

/**
 * THE SAME CLAIM FOR THE DOOR IN THIS PROCESS, AND IT ASKS NOBODY'S NAME. {@link claimFrom}
 * recognises our own claim BY NAME, all a roster read offers, but every ohmail phone writes the SAME
 * `PHONE_CLAIM_NAME`, so on the two-phone case the name test answers `ours` for the OTHER phone's
 * claim (the panel would offer a hand-back over a mailbox this phone organizes nothing of). The engine
 * already answers what the name test stood in for — `organizing` is this install's verdict on its own
 * claim — so this reads that and compares nothing. `null` stays `unknown`: no chip, no verb.
 */
export function claimHere(
  here: {
    organizing: boolean | null;
    /**
     * THE PERSON'S STOP STILL STANDING ON THE ROW — the engine's second answer, and the only thing
     * that separates a stop the mail server honoured from one it refused. Without it a refused
     * stop rendered `free` with "Start organizing here" beside it, over a mailbox this phone was
     * still holding: the false state, arriving by the other door.
     *
     * REQUIRED, so TypeScript is the census over every caller: optional, a caller that forgot it
     * would render `free` over a standing stop and nothing would say so.
     */
    releaseRequestedAt: string | null;
    /** `sibling_lapse`: a copy of this install holds the claim and the stop waits for it to lapse. */
    releaseRefusal?: "sibling_lapse" | null;
    /** The gate's named `_meta` refusal ({@link StandaloneHere}); absent reads as none. */
    metaBlocked?: "meta_folder_full" | "meta_undeletable" | null;
    /**
     * WHO ELSE HOLDS IT, from the engine's stand-down and its last look. `holderState` decides
     * whether that holder still organizes: `none` or `stopped` is nobody, as {@link claimFrom}
     * reads a paired row; `null` is a look not taken, and the remembered reason stands.
     */
    heldBy: { name: string; standDownReason: string; holderState: "held" | "stopped" | "none" | null } | null;
  },
  /**
   * THE SESSION'S ONE STANDING INSTRUCTION, and it may only ever MODIFY the engine's answer.
   *
   * This took a `stopAsked` boolean the panel held as its own screen state, which nothing ever
   * spent: the chip read `Stopping` for three minutes over a phone that was filing mail, and
   * settled only on leaving Settings. The instruction is settled from the engine's own word
   * (`organizerInstruction`), so a transition ends when the engine says it has.
   */
  instruction: OrganizeInstruction = "idle",
  /**
   * THE ONE FACT ONLY THIS INSTALL HOLDS — did WE give the mailbox back, and not take it again?
   *
   * `organizerHandedBack()`. Nothing in the engine's answer can say it: a mailbox this install
   * released and a mailbox nobody ever claimed are the same three fields, so without this the
   * transitional state renders as `Nothing organizes this mailbox` and offers a start for
   * something the next foreground already does. It may only ever refine the FREE arm — a holder
   * is the truer sentence, and our own claim outranks a stale flag.
   */
  handedBack: boolean = false,
): PhoneClaim {
  if (here.organizing === null) return { k: "unknown" };
  /* THE STANDING RELEASE TRAVELS WITH BOTH `ours` ARMS. It is one fact about one claim — the
     person asked and the mail server has not said yet — and it is true whether the pass is still
     reporting itself organizing or has already stopped reporting it. */
  const releasePending = here.releaseRequestedAt !== null;
  const siblingLapse = releasePending && here.releaseRefusal === "sibling_lapse";
  const ours = (): PhoneClaim => ({
    k: "ours", stopping: instruction === "stopping", releasePending, ...(siblingLapse ? { siblingLapse } : {}),
  });
  /* A REFUSED GATE'S REASON WINS OVER `organizing`, the desktop's precedence — except while a
     stop the person made is being carried out, which is their act and says so. */
  if (here.metaBlocked != null && instruction !== "stopping" && here.releaseRequestedAt === null) {
    return { k: "blocked", reason: here.metaBlocked, holding: here.organizing };
  }
  if (here.organizing) return ours();
  const held = here.heldBy;
  /* A STOP THE MAIL SERVER HAS NOT HONOURED IS STILL OURS. The engine arranges nothing while it
   * carries out a release, so `organizing` is false on both of its endings — and on a device that
   * read as a FREE mailbox, with "Start organizing here" beside it, while the claim was still in
   * `ohmail/_meta`. Nobody else holds a mailbox whose claim is ours and standing, so this arm sits
   * above `free` and below `theirs`. `stopping` comes from the INSTRUCTION exactly as the
   * organizing arm above takes it, not from the standing request: a stop still being carried out
   * reads `Stopping`, one the server refused reads `Organizing`. Pinned `true` here, the chip said
   * `Stopping` for ever and the Stop verb — the only way to ask again — stayed hidden. */
  if (held === null && here.releaseRequestedAt !== null) return ours();
  /* A HOLDER THAT LET GO IS NOBODY: the look that read no claim, or a lapsed one, answers the
     remembered stand-down reason, and the card offers the start rather than naming a machine. */
  if (held !== null && !holderIsLive({
    by: held.holderState === "none" ? null : { kind: holderKind(held.standDownReason), name: held.name },
    state: held.holderState,
  })) {
    if (handedBack && instruction !== "starting") return { k: "handedBack" };
    return { k: "free", starting: instruction === "starting" };
  }
  if (held === null) {
    /* NOT WHILE A PRESS IS IN FLIGHT: `starting` is a transition a person asked for and is the
       sentence they are waiting on, and a hand-back flag from before it would replace it. */
    if (handedBack && instruction !== "starting") return { k: "handedBack" };
    return { k: "free", starting: instruction === "starting" };
  }
  const kind = holderKind(held.standDownReason);
  return held.name.length > 0
    ? { k: "theirs", name: held.name, kind }
    : { k: "theirsUnnamed", kind };
}

/**
 * THE SENTENCE UNDER THE CHIP — what this phone does about THIS mailbox. The panel rendered
 * {@link platformRuleLine} in every state (it describes what organizing on a phone means, "It
 * organizes while its notification is shown"), which over a mailbox another machine holds is false
 * and was the only sentence a standing-down phone got. So the note follows the claim: `ours`, `free`
 * and `unknown` keep the platform rule, and the two foreign arms name the holder and say what this
 * phone does instead, in the desktop's words (`mailboxes.readerReadsOnly`). No arm offers a takeover —
 * there is no such press in this panel.
 */
export function claimNoteLine(
  claim: PhoneClaim,
  os: string,
  /**
   * THIS PHONE DECLINED TO ORGANIZE BEHIND ITS NOTIFICATION — notifications off or battery saver,
   * as the card's own records say. The platform rule is then false and the decline's sentence
   * beside it is the true one, so `ours` says nothing here rather than contradicting it.
   */
  facts?: { readonly declined: boolean },
): string | null {
  switch (claim.k) {
    case "free":
      /* AND NOTHING AT ALL WHERE NOTHING ORGANIZES IT. The platform rule tells somebody to dismiss
         a notification to stop — under the words "Nothing organizes this mailbox", beside a verb
         that says "Start organizing here". It is an instruction about a notification that is not
         there, so the free state gets no note; `unknown` keeps its silence for the same reason. */
      return null;
    case "unknown":
      return null;
    case "ours":
      /* A STOP THE MAIL SERVER HAS NOT HONOURED gets the sentence that says what is happening —
         the platform rule ("dismiss the notification to stop") is an instruction about a press
         that has already been made. Every other `ours` keeps it. */
      if (claim.siblingLapse === true) return Copy.phoneStateStopSiblingLapse;
      if (claim.releasePending) return Copy.phoneStateStopPendingWhy;
      return facts?.declined === true ? null : platformRuleLine(os);
    case "pairedServer":
      /* AND THE PLATFORM RULE IS FALSE HERE, which is what made the paired card wrong twice over:
         "it organizes while its notification is shown" describes THIS phone, and the server that
         answered the roster organizes whether or not this app is open. Its own sentence says so
         and says what this phone does instead, in the reader's words the two foreign arms use. */
      return Copy.phoneStatePairedServerWhy;
    case "parked":
    case "blocked":
      // The chip is the whole sentence, and the platform rule describes a phone that organizes.
      return null;
    case "handedBack":
      /* AND THIS ONE DOES GET A SENTENCE, where `free` gets none: the chip names a state a person
         has never seen a word for, and what it means for them is that their laptop may take the
         mailbox right now. The platform rule is not said here — it describes a notification that
         is deliberately not showing. */
      return Copy.phoneStateHandedBackWhy;
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

/**
 * WHAT THE LAST PRESS ANSWERED — a record of one act, never a description of the current state.
 *
 * Three words and not two booleans: the panel held `startRefusal` and `stopFailed` side by side
 * and rendered each on its own, so the two could both be standing at once over one card.
 */
export type PressSaid = "startRefused" | "startUnreadable" | "startMetaFolderFull" | "startMetaUndeletable"
  | "stopRefused" | null;

/** What a START press answered, as the line beside the verb records it; `null` owes no sentence. */
export function pressSaidOf(outcome: string): PressSaid {
  return outcome === "refused" ? "startRefused"
    : outcome === "unreadable" ? "startUnreadable"
      : outcome === "meta_folder_full" ? "startMetaFolderFull"
        : outcome === "meta_undeletable" ? "startMetaUndeletable"
          : null;
}

/**
 * THE SENTENCE BESIDE THE VERB, AND IT MAY NOT OUTLIVE THE STATE IT DESCRIBES.
 *
 * Measured on a device: a stop the mail server could not confirm put *"This phone could not hand
 * that mailbox back, so it is still organizing it"* under the chip — correct, while the claim was
 * still ours. The standing request was then honoured on the next round with no second press, and
 * the panel carried the new chip over the old sentence: `Nothing organizes this mailbox`, that
 * sentence beneath it, and `Start organizing here` offered. Nothing but another press cleared it.
 *
 * So the press RECORDS and the claim DECIDES, read together at every render. Each sentence is
 * false in exactly the states the other verb's is true of: "could not hand it back, so it is still
 * organizing it" is about a claim of ours, and "could not start … nothing changed" is about one
 * that is not. `unknown` keeps whatever was said — it means the engine has not answered yet, and
 * taking the sentence away there would drop the answer to a press somebody has just made.
 */
/**
 * WHAT THE STOP LEFT OFF THE MAILBOX, beside the card — only once the claim is no longer ours, so
 * the sentence never stands over a phone still organizing (the next start clears the record).
 */
export function settingsLeftLine(left: "kept_other" | "not_saved" | null, claim: PhoneClaim): string | null {
  if (left === null || claim.k === "ours" || claim.k === "unknown" || (claim.k === "blocked" && claim.holding)) return null;
  return left === "kept_other" ? Copy.settingsStopLeftOther : Copy.settingsStopLeftUnsaved;
}

export function pressSaidLine(said: PressSaid, claim: PhoneClaim): string | null {
  if (said === null) return null;
  if (claim.k !== "unknown") {
    const ours = claim.k === "ours" || (claim.k === "blocked" && claim.holding);
    if (said === "stopRefused" ? !ours : ours) return null;
  }
  /* A press refused over a `_meta` the gate cannot read says the desktop row's sentence — once: a
     chip already saying it needs no second copy beside it. */
  if (said === "startMetaFolderFull" || said === "startMetaUndeletable") {
    return claim.k === "blocked" ? null : metaBlockedLine(said === "startMetaFolderFull" ? "meta_folder_full" : "meta_undeletable");
  }
  return said === "stopRefused" ? Copy.settingsStopHereFailed
    : said === "startUnreadable" ? Copy.settingsStartHereUnreadable
      : Copy.settingsStartHereFailed;
}

/* ══ SETTINGS → THE MAILBOX'S SERVERS ═══════════════════════════════════════════════════════════ */

/** One server's coordinates as the engine states them (`StandaloneEngine.serverSettings`). */
interface ServerAt { readonly host: string; readonly port: number; readonly secure: boolean }

/**
 * THE SHEET'S FIELDS, FROM WHAT THE ENGINE SAYS THE SERVERS ARE. Every server field counts as
 * typed, so nothing re-guesses them; the address and the password are not on this sheet's form.
 */
export function serverFieldsFrom(at: { imap: ServerAt; smtp: ServerAt | null }): StandaloneFields {
  return {
    ...EMPTY_STANDALONE,
    imapHost: at.imap.host,
    imapPort: String(at.imap.port),
    imapTls: portMeansImplicitTls(at.imap.port),
    smtpHost: at.smtp?.host ?? "",
    smtpPort: at.smtp === null ? "" : String(at.smtp.port),
    typed: new Set(GUESSED),
  };
}

/**
 * WHAT THE SHEET REFUSES BEFORE ANYTHING DIALS — a blank incoming host, a blank outgoing host on a
 * mailbox that has one (it cannot be removed here), and the port rule. `null` admits the press.
 */
export function serverSettingsRefusal(f: StandaloneFields, hadSmtp: boolean): Refusal | null {
  if (f.imapHost.trim() === "") return refuse("standaloneNoHost");
  if (hadSmtp && f.smtpHost.trim() === "") return refuse("standaloneNoSmtpHost");
  return portRefusal(f);
}

/**
 * THE CHANGE THE SHEET SENDS — both TLS modes follow their PORT, as on the Connect form, so the
 * switch is a view of the port and never a second answer to how the password travels.
 */
export function serverChangeOf(f: StandaloneFields): { imap: ServerAt; smtp: ServerAt | null } {
  const imapPort = Number(f.imapPort.trim());
  const smtpPort = Number(f.smtpPort.trim());
  return {
    imap: { host: f.imapHost.trim(), port: imapPort, secure: portMeansImplicitTls(imapPort) },
    smtp: f.smtpHost.trim() === ""
      ? null
      : { host: f.smtpHost.trim(), port: smtpPort, secure: portMeansImplicitTls(smtpPort) },
  };
}
