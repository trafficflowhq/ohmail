/**
 * Is there a holder, and does it have a name. Measured on a released build: connect a mailbox, decline to organize,
 * and every reader surface said "Organized by another install · Since —" — a named relationship with an install that
 * does not exist. The cause was one question standing in for another: the surfaces branched on the display NAME being
 * absent, and a name is absent in two different states — a holder exists that this build cannot name, and nobody
 * holds the mailbox at all.
 */

/**
 * `organizedBy` present/absent is the discriminator, not the name: the wire emits the object only when at least one
 * holder column was written (`mailbox-service.ts`), so its PRESENCE is exactly "something recorded a holder", and the
 * shell must not re-derive it from the fields. An object with an empty name is {@link ReaderHolder.unnamed}, never
 * `nobody`. NOT the routing predicate (that is `deriveOnboardingStep` row 3's, answered from `kind || name`), and not
 * about consent — folding consent in would make a fourth state out of two unrelated questions.
 */
export type ReaderHolder = "nobody" | "unnamed" | "named";

/** The holder columns as every door serves them — `MailboxFacts` and `OnboardingMailbox` alike. */
export interface ReaderHolderColumns {
  kind?: string | null;
  name?: string | null;
  since?: string | null;
}

/**
 * WHICH OF THE THREE READER STATES this mailbox is in.
 *
 * `undefined` and `null` are one answer — `nobody` — because an API too old to send the field and
 * one saying "no holder" are both builds in which nothing is known to organize the mailbox, and
 * the sentence for that state names no install and promises no date. Absent must NOT read as a
 * holder: that is the direction that puts a stranger's name over somebody's own mailbox.
 */
export function readerHolder(organizedBy?: ReaderHolderColumns | null): ReaderHolder {
  if (!organizedBy) return "nobody";
  const name = organizedBy.name;
  return name !== null && name !== undefined && name.trim() !== "" ? "named" : "unnamed";
}

/**
 * And the routing question, which is a different one. {@link readerHolder} answers "which of three SENTENCES is
 * true", and for a sentence it is right that an API too old to send the field and one saying "no holder" collapse —
 * neither may print a name. For a decision about which SCREEN somebody sees, that collapse is the defect: it reads
 * "this build has not been told" as "the mailbox is free", and the screen it takes away is the one asking whether to
 * displace an existing organizer (measured: a read carrying no organizer answer released the cursor and the run
 * resumed on the consent statement, one Agree from an unshown takeover).
 */

/**
 * So this asks whether a read ANSWERED: `unknown` — no row, or a row with no organizer field: nothing may be
 * concluded; `nobody` — the field was there and empty, an ANSWER; `somebody` — a holder recorded, named or not. It
 * cannot tell a CURRENT `nobody` from a STALE one — ordering needs a fact this shape does not carry; see
 * `OnboardingMailbox`, where the missing field is named.
 */
export type HolderVerdict = "unknown" | "nobody" | "somebody";

/** What a read said about who organizes one mailbox — see {@link HolderVerdict}. */
export function holderVerdict(
  mailbox: { organizedBy?: ReaderHolderColumns | null } | null | undefined,
): HolderVerdict {
  /* NO ROW, NO ANSWER. `undefined` and `null` are one case here for the same reason they are two
     in `readerHolder`: there, both mean "name nobody"; here, neither is the mailbox saying
     anything about itself, because there is no mailbox in the run to say it. */
  if (mailbox === null || mailbox === undefined) return "unknown";
  /* ABSENT IS NOT EMPTY. `undefined` is a read that did not carry the field; `null` is the field,
     carried, saying nothing holds this mailbox — which every current producer distinguishes in
     its type and neither emits today, both mapping absent to `null` at their own seam. Honoured
     anyway, and named as unreachable rather than counted as a defence: the state it guards is one
     a wire change would reintroduce silently. */
  if (mailbox.organizedBy === undefined) return "unknown";
  return mailbox.organizedBy === null ? "nobody" : "somebody";
}

/**
 * HAS THE HOLDER STOPPED CHECKING IN — the lease's own answer, read and never re-derived: `stopped` is
 * `peekLease`'s verdict against the staleness bound, carried on the row as `organizerState`. The
 * wire carries no heartbeat, so a surface cannot judge freshness itself. `null` and absent are
 * "not looked", which is not a stop. Every surface showing the claim question asks this one
 * function (`first-run-stale-holder.test.tsx`'s census).
 */
export function holderStopped(
  mailbox: { organizerState?: "held" | "stopped" | null } | null | undefined,
): boolean {
  return mailbox?.organizerState === "stopped";
}

/* ── A PHONE IS THE THIRD HOLDER KIND, AND FOUR SURFACES HAD ARMS FOR TWO ───────────────────
   `OrganizerKind` is `local | cloud | mobile`. The rail, the desktop mailboxes pane, both
   first-run reader rows and the restore card branched on `local` and `cloud` and let a phone
   fall into whichever arm was last — "Another ohmail install files this mailbox on its own
   schedule", "Since <date>. This computer reads the mailbox", or no holder named at all. A
   phone's one difference is that it organizes while its app is open, and none of those
   sentences carried it. Asked ONCE here, so four surfaces cannot drift into four wordings. */

/** Whether the phone still renews its claim — the two states a holder line has to tell apart. */
export type PhoneHolderState = "organizing" | "stopped";

/** A phone holder, and the two things that decide which of the sentences below it gets. */
export interface PhoneHolder {
  state: PhoneHolderState;
  /** Whether the claim recorded a display name: the sentence interpolates one, or stands without. */
  named: boolean;
}

/**
 * How much room the surface has. `full` is a paragraph and carries the clause; `short` is a line
 * and drops it, which is what {@link PHONE_HOLDER_WHY_KEY} exists for. `short` is stateless
 * because its one surface — the restore card — reads a SAVED PROFILE rather than a live claim,
 * so it knows the producer's kind and nothing about whether that phone still holds anything.
 */
export type PhoneHolderVoice = "full" | "short";

/** Is a phone organizing this mailbox, and is it still doing it. `null` for every other holder. */
export function phoneHolder(
  organizedBy: ReaderHolderColumns | null | undefined,
  stopped: boolean,
): PhoneHolder | null {
  if (!organizedBy || organizedBy.kind !== "mobile") return null;
  const name = organizedBy.name;
  return {
    state: stopped ? "stopped" : "organizing",
    named: name !== null && name !== undefined && name.trim() !== "",
  };
}

/**
 * The `mailboxes` key the surface renders. THE ONE TABLE: no surface spells a phone sentence of
 * its own, and `phone-holder-sentence.test.tsx`'s census refuses a second site that does.
 */
export function phoneHolderKey(phone: PhoneHolder, voice: PhoneHolderVoice): string {
  if (voice === "short") return "readerHolderPhoneShort";
  if (phone.state === "stopped") {
    return phone.named ? "readerHolderPhoneStopped" : "readerHolderPhoneStoppedUnnamed";
  }
  return phone.named ? "readerHolderPhone" : "readerHolderPhoneUnnamed";
}

/** The clause the short form has no room for, for that line's title. */
export const PHONE_HOLDER_WHY_KEY = "readerHolderPhoneWhy";

/* ── AND WHAT TO PRESS, WHICH NO HOLDER SENTENCE CARRIED (issue #5) ─────────────────────────
   Every sentence above names WHO organizes the mailbox and stops there. Measured on the shipped
   build: of the desktop pane's nine arms only `readerNobodyReads` — the arm for NOBODY holding it
   — says what to press, so the rows that DO name a holder, which are the ones a person is stuck
   on, name no way out. The rail is the same: four sentences, no verb, a link to Settings.

   The verb is the SURFACE's, because it differs per surface and only the surface knows whether
   its press exists; the SENTENCE is this table's, so four surfaces cannot word one state four
   ways. `none` returns the sentence the surface already had — a surface with no press may not
   offer one. */

/** The holder kinds a sentence is written for. `unknown` is a recorded holder this build cannot name. */
export type HolderKind = "cloud" | "local" | "mobile" | "unknown";

/**
 * What the surface offers, as the verb its own control carries.
 *
 * `reclaim` is the desktop row's "Organize here instead"; `takeover` the browser's ceremony;
 * `start` the first-run choice; `none` a surface with no press at all — the restore card reads a
 * SAVED PROFILE, and a rail on a door whose take-over route is not served is the same case.
 */
export type HolderVerb = "reclaim" | "takeover" | "start" | "none";

/** The holder as any door reports it — the polled columns, or a refusal's own body. */
export interface HolderWho {
  kind: HolderKind | string | null;
  /**
   * The holder's name as THIS SURFACE calls it — empty or absent is "a holder we cannot name".
   *
   * The surface owns the spelling, not this table: the desktop pane calls an unnamed holder
   * "another install" (`holderOf`) and therefore keeps the arm for its kind, while first run
   * passes the raw column and takes the arm written for a holder with no name. One table, one
   * sentence per state, and each surface still decides what it calls a machine nobody named.
   */
  name?: string | null;
  /** Whether the claim has stopped renewing. The two states want opposite sentences. */
  stopped?: boolean;
  /** WHETHER there is a date — the raw column, never a formatted one. See {@link HolderWho.shown}. */
  since?: string | null;
  /** That same date as a person reads it, when the surface has formatted one. */
  shown?: string | null;
  /**
   * WHETHER THE CLAIM ITSELF RECORDED A NAME — read by the PHONE arm alone, because that arm is
   * the only one where a surface's fallback spelling would be a lie. Other arms treat a
   * surface-supplied word (the desktop pane's "another install") as a name, and rightly.
   *
   * The phone has two sentences differing only in whether a name is interpolated, so "another
   * install is organizing this mailbox — a phone organizes while its app is open" would describe
   * a phone as a computer. So the phone arm asks the claim, not the surface; absent, it derives
   * from the name, which is what a surface passing the raw column wants.
   */
  claimNamed?: boolean;
}

/** Which sentence, with which parameters, and the verb it was built for. */
export interface HolderSentence {
  key: string;
  params: Record<string, string>;
  verb: HolderVerb;
}

/**
 * WHICH SENTENCE THIS HOLDER GETS, and whether it says what to press.
 *
 * The `mobile` arm is {@link phoneHolderKey}, which this subsumes rather than copies: a second
 * table for the same question is the drift `phone-holder-sentence.test.tsx` exists to refuse.
 *
 * `voice` `short` drops the clause ({@link PHONE_HOLDER_WHY_KEY}) and never carries a verb clause.
 * `since` decides only whether the DATED arms are reachable: each opens with the date, so with
 * none there is nothing to open with (the em-dash defect).
 */
export function holderSentence(
  input: { who: HolderWho; verb: HolderVerb; voice?: PhoneHolderVoice },
): HolderSentence {
  const { who, verb } = input;
  const voice = input.voice ?? "full";
  const name = who.name;
  const named = name !== null && name !== undefined && name.trim() !== "";
  const params: Record<string, string> = {};
  if (named) params.name = name!.trim();
  /* THE DATE IS DECIDED ON THE RAW VALUE AND RENDERED FROM `shown`.
     `day(null)` is an em dash deliberately — right for a stamp somebody hovers, wrong for the one
     clause that PROMISES a date — so a surface that formats before asking would make the undated
     arm unreachable and announce "Since — · ohmail Cloud", which is the defect `readerReadsOnly`
     exists for. Asked on `since`, rendered from `shown ?? since`. */
  if (who.since) params.since = who.shown ?? who.since;

  /* A PHONE FIRST, on the rule the four surfaces already carry: both of its sentences state the
     state themselves, and every dated arm below promises a schedule a phone does not keep. */
  if (who.kind === "mobile") {
    /* `named` is this table's own reading of what it was handed; `claimNamed` is the claim's,
       and the phone arm prefers it — see {@link HolderWho.claimNamed}. `phoneHolder` asks only
       whether the name is empty, so the flag is passed as one. */
    const phoneNamed = who.claimNamed ?? named;
    const phone = phoneHolder(
      { kind: "mobile", name: phoneNamed ? name ?? "" : null },
      who.stopped === true,
    )!;
    return {
      key: phoneHolderKey({ ...phone, named: phoneNamed }, voice),
      params,
      verb,
    };
  }

  /* A SHORT LINE HAS NO ROOM FOR A CLAUSE, so it keeps the plain sentence whatever the verb is. */
  const withVerb = verb !== "none" && voice === "full";
  const how = (key: string): string => (withVerb ? `${key}How` : key);

  if (who.stopped === true) return { key: how("readerStopped"), params, verb };
  if (!who.since) return { key: "readerReadsOnly", params, verb };
  /* THE LOCAL ARM NAMES A MACHINE, so it is taken only where there is something to name —
     which is a question about what the SURFACE handed over, not about the claim. A pane that
     supplies its own word for an unnamed holder ("another install") takes this arm and reads
     "Since 30 Aug · another install"; one that passes the raw column falls to the arm written for
     a holder with no name, whose label has already said "another install" and must not say it
     twice. Both wordings are shipped, both are guarded by their own surface's control, and the
     difference is the fallback — not this table. */
  if (who.kind === "local" && named) return { key: how("readerSinceLocal"), params, verb };
  if (who.kind === "cloud") return { key: how("readerSinceCloud"), params, verb };
  return { key: how("readerSinceUnknown"), params, verb };
}

/**
 * THE RAIL'S OWN TABLE — the same question in the strip's words (`sync`, not `mailboxes`).
 *
 * A second function rather than a `voice`, because these are not the reader sentences abbreviated:
 * the strip is about FILING that is waiting, and it says who will do it. The verb clause is the
 * same bargain — `none` keeps the sentence the rail already had.
 */
export function filingElsewhereKey(who: HolderWho, verb: HolderVerb): string {
  const name = who.name;
  const named = name !== null && name !== undefined && name.trim() !== "";
  const how = (key: string): string => (verb === "none" ? key : `${key}How`);
  if (who.kind === "cloud") return how("filingElsewhereCloud");
  if (who.kind === "local" && named) {
    return how(who.stopped === true ? "filingElsewhereLocalStopped" : "filingElsewhereLocal");
  }
  return how("filingElsewhereUnknown");
}
