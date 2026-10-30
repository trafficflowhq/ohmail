/**
 * WHEN THE PHONE ASKS THE SENT-MAIL SEED — "you've written to these people; shall they get
 * through?" — the decisions, and the small per-account store they keep. No React Native.
 *
 * The web's `seed-offer.ts` on the phone's facts: owed while the account's consent answer says the
 * seed was never confirmed, on a mailbox this door organizes whose first import has finished, with
 * no profile-import question open. "Not now" is kept per account on this device; an answer, a
 * review with nobody to decide and a failed read settle it for this launch only. The review is
 * read once per launch, never per drain.
 */
import type { SeedReview } from "../net/consent";
import type { SecureKV } from "./servers";
import { importFloorInWindow } from "./surface";

/** What the account's consent answer said about the seed. */
export type WorldSeed =
  | { known: false }
  /** The door carries no seed (an older server): nothing to offer, nothing waits on it. */
  | { known: true; carried: false }
  | { known: true; carried: true; confirmedAt: string | null };

/** The consent read's seed field as the world holds it. */
export function worldSeedOf(seed: { confirmedAt: string | null } | null): WorldSeed {
  return seed === null ? { known: true, carried: false } : { known: true, carried: true, confirmedAt: seed.confirmedAt };
}

/** The mailbox facts the decision reads (`PhoneMailbox`'s fields). */
export interface SeedMailbox {
  status: string | null;
  organizerRole: "organizer" | "reader" | null;
  initialImportCompletedAt?: string | null;
  /** When the mailbox was connected: the first-import floor's clock. */
  createdAt?: string;
  /** `null`: nobody agreed to organize it; absent where the read carried no answer. */
  organizeConsentedAt?: string | null;
}

export interface SeedFacts {
  seed: WorldSeed;
  mailboxes: { known: boolean; rows: readonly SeedMailbox[] };
  /** A found-settings question is on screen: one card at a time. */
  profileQuestionOpen: boolean;
}

/** The mailboxes this door organizes — `organizerRole`, never `organizedByThisInstall`. */
export function organizedHere<R extends SeedMailbox>(rows: readonly R[]): R[] {
  return rows.filter((r) => r.status !== "disabled" && r.organizerRole === "organizer");
}

/**
 * An EMPTY waiting shelf while an organized mailbox's first import runs, by the web's bounded floor
 * (`importFloorInWindow`): the gate has judged nobody yet. A shelf with rows counts them, as the
 * badges do; an unwritten stamp a day old withholds nothing. On the standalone door the engine's
 * own word (`standaloneHere`) says it too: the mailbox read may predate this phone's start, and its
 * claim comes after the first pass. A mailbox nobody agreed to organize keeps its own empty state.
 */
export function firstPassWithholds(
  waiting: number, mailboxes: { known: boolean; rows: readonly SeedMailbox[] }, now: number,
  door: { organizing: boolean | null; firstSync: string | null } | null = null,
): boolean {
  if (waiting !== 0) return false;
  if (door !== null && door.firstSync === "pending") {
    // A fresh mailbox's claim is written after its first pass: not organizing yet is no reason to say nobody waits.
    if (door.organizing === true) return true;
    if (door.organizing === false && !neverAgreed(mailboxes)) return true;
  }
  return mailboxes.known && organizedHere(mailboxes.rows).some((r) => importFloorInWindow(r, now));
}

/** Every live mailbox read says nobody agreed to organize it. */
function neverAgreed(mailboxes: { known: boolean; rows: readonly SeedMailbox[] }): boolean {
  const live = mailboxes.rows.filter((r) => r.status !== "disabled");
  return mailboxes.known && live.length > 0 && live.every((r) => r.organizeConsentedAt === null);
}

/** Whether Settings offers the review again: the door carries the seed and organizes a mailbox. */
export function seedReopenable(facts: Pick<SeedFacts, "seed" | "mailboxes">): boolean {
  return facts.seed.known && facts.seed.carried && facts.mailboxes.known && organizedHere(facts.mailboxes.rows).length > 0;
}

/** What the facts alone say: `owed` asks, `waiting` cannot tell yet, `none` has nothing to ask. */
export function seedStage(facts: SeedFacts): "owed" | "waiting" | "none" {
  const { seed, mailboxes } = facts;
  if (!seed.known) return "waiting";
  if (!seed.carried || seed.confirmedAt !== null) return "none";
  if (!mailboxes.known) return "waiting";
  const here = organizedHere(mailboxes.rows);
  if (here.length === 0) return "none";
  if (here.some((r) => r.initialImportCompletedAt === null)) return "waiting";
  return facts.profileQuestionOpen ? "waiting" : "owed";
}

export type SeedOffer =
  | { kind: "waiting" }
  | { kind: "offer"; review: SeedReview; undecided: number }
  | { kind: "settled" };

interface OwnerState {
  /** `null` until the keystore answered. */
  notNow: boolean | null;
  /** This launch's own answer — kept in memory only. */
  launch: "answered" | "handedBack" | "unreadable" | null;
  review: SeedReview | null;
  work: Promise<void> | null;
}

const owners = new Map<string, OwnerState>();
const listeners = new Set<() => void>();
let kv: SecureKV | null = null;
let version = 0;

const notify = (): void => {
  version += 1;
  for (const l of [...listeners]) l();
};

function stateOf(owner: string): OwnerState {
  let st = owners.get(owner);
  if (st === undefined) {
    st = { notNow: null, launch: null, review: null, work: null };
    owners.set(owner, st);
  }
  return st;
}

/** The keystore "Not now" is kept in. Unbound, it holds for this launch only. */
export function bindSeedOfferKV(store: SecureKV): void {
  kv = store;
}

/** `boot.ts#dbFileName`'s injective `_hex_` encoding, so two owners never share a key. */
export function seedNotNowKey(owner: string): string {
  return `ohmail.seed.notNow.${owner.replace(/[^A-Za-z0-9.-]/gu, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`)}`;
}

export function subscribeSeedOffer(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function seedOfferVersion(): number {
  return version;
}

const undecidedOf = (r: SeedReview): number => r.candidates.filter((c) => !c.alreadyDecided).length;

/** The offer for this owner on these facts — a read of the store, no work started. */
export function seedOfferOf(owner: string, facts: SeedFacts): SeedOffer {
  const stage = seedStage(facts);
  if (stage === "none") return { kind: "settled" };
  const st = owners.get(owner);
  if (st?.launch != null || st?.notNow === true) return { kind: "settled" };
  if (stage === "waiting" || st === undefined || st.notNow === null || st.review === null) return { kind: "waiting" };
  return { kind: "offer", review: st.review, undecided: undecidedOf(st.review) };
}

/**
 * DO WHAT THE OFFER STILL NEEDS — read "Not now", then the review, once. Resolves when that work
 * is done (tests await it); a second call while it runs joins it.
 */
export function advanceSeedOffer(
  owner: string, facts: SeedFacts, read: () => Promise<SeedReview | null>,
): Promise<void> {
  if (seedStage(facts) !== "owed") return Promise.resolve();
  const st = stateOf(owner);
  if (st.launch !== null || st.notNow === true || st.review !== null) return Promise.resolve();
  if (st.work !== null) return st.work;
  const work = (async () => {
    if (st.notNow === null) {
      const store = kv;
      const raw = store === null ? null : await store.get(seedNotNowKey(owner)).catch(() => null);
      /* A press made while the keystore was being read is newer than the row. */
      if (st.notNow === null) st.notNow = raw === "1";
      notify();
      if (st.notNow) return;
    }
    const review = await read().catch(() => null);
    if (st.launch !== null || st.notNow === true) return;
    if (review === null) st.launch = "unreadable";
    else if (undecidedOf(review) === 0) st.launch = "handedBack";
    else st.review = review;
    notify();
  })();
  st.work = work;
  void work.finally(() => { if (st.work === work) st.work = null; });
  return work;
}

/** The review this launch read for the offer, if any — the route reuses it rather than re-reading. */
export function seedReviewHeld(owner: string): SeedReview | null {
  return owners.get(owner)?.review ?? null;
}

/** "Not now": kept for this account on this device. Writes nothing to the account. */
export function seedLater(owner: string): Promise<void> {
  const st = stateOf(owner);
  st.notNow = true;
  notify();
  const store = kv;
  return store === null ? Promise.resolve() : store.set(seedNotNowKey(owner), "1").catch(() => undefined);
}

/** The confirm landed: a stale consent read cannot bring the offer back this launch. */
export function seedAnswered(owner: string): void {
  stateOf(owner).launch = "answered";
  notify();
}

/** The review found nobody to decide about: this launch only, the sent mail may still arrive. */
export function seedHandBack(owner: string): void {
  const st = stateOf(owner);
  if (st.launch === null) st.launch = "handedBack";
  notify();
}

/**
 * THE OHBOX'S "SCREEN N" WAITS FOR THE SEED. Pressed first, it would hold the very people the
 * seed is about to let through, costing two server moves per letter.
 */
export function unscreenedOffered<U>(offer: SeedOffer, unscreened: U | null): U | null {
  return offer.kind === "settled" ? unscreened : null;
}

let profileOpen = false;

/** The found-settings card says whether its question is on screen; the offer waits behind it. */
export function publishProfileQuestion(open: boolean): void {
  if (profileOpen === open) return;
  profileOpen = open;
  notify();
}

export function profileQuestionOpenNow(): boolean {
  return profileOpen;
}

/** A relaunch, for the suite: this launch's answers go, the keystore stays where it is. */
export function relaunchSeedOfferForTests(): void {
  owners.clear();
  kv = null;
  profileOpen = false;
  notify();
}
