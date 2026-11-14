/**
 * WHEN THE SENT-MAIL REVIEW TAKES THE STAGE, moved out of the web shell (`apps/webapp/app/shell/seed-offer.ts`) with
 * the scope a required argument: the "Not now" is kept for the account the mount's scope names, on this device. One
 * instance a frame: whoever computes it provides it ({@link SeedOfferContext}) and the stage reads that one.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { localStorageDoor } from "../../storage/durable.js";
import { scopeSuffix, type StorageScope } from "../../storage/scope.js";

/**
 * `ohmail.ui.seed.notNow.<owner>` — "Not now" on the sent-mail review, for one account on this
 * device. A dismissal and no mail, so it survives sign-out (`sign-out-clears-durable-stores`).
 * The scope is the one the shell hands in; a scope nobody handed in is refused.
 */
export function seedNotNowKey(owner: StorageScope): string {
  return `ohmail.ui.seed.notNow.${scopeSuffix(owner)}`;
}

/** Whether the polled `/mailboxes` facts hold a live mailbox (`null` while unread) — the sync strip's `noMailbox` rule. */
export function hasLiveMailbox(facts: readonly { status: string }[] | null): boolean | null {
  return facts === null ? null : facts.some((m) => m.status !== "disabled");
}

export interface SeedOffer {
  /** The review takes the stage now. */
  owed: boolean;
  /** Opened from Settings rather than offered — the review then says when nobody is waiting. */
  reopened: boolean;
  reopen: () => void;
  /** "Not now": kept for this account on this device; Settings still opens it. */
  later: () => void;
  /** The review found nobody to decide about: this tab only, the sent mail may still arrive. */
  nothingToDecide: () => void;
  /** Confirmed; the server's `seedConfirmedAt` carries it from the next read. */
  done: () => void;
}

/* The one door the "Not now" is read and written through: a read that storage refuses is "nothing kept". */
const kept = localStorageDoor("ui.flag");

/**
 * WHEN THE SENT-MAIL REVIEW TAKES THE STAGE. Offered once the server says it is owed
 * (`seedConfirmedAt` null, read — `known`), on an account with a mailbox to review (`hasMailbox`;
 * `null` is not known yet and is not owed), where the browser client that runs it exists, until it
 * is answered, put off, or found to have nobody in it. The stored "Not now" is read after mount
 * (hydration) and held as the KEY it was read under, so another account's answer never applies.
 * The key is the scope's the shell hands in (`scope`); with none, "Not now" holds for the mount and
 * nothing is stored.
 */
export function useSeedOffer(input: {
  demo: boolean;
  known: boolean;
  supported: boolean;
  seedConfirmedAt: string | null;
  hasMailbox: boolean | null;
  /** Whose "Not now" this is: the mount's storage scope, handed in and never looked up. */
  scope: StorageScope;
}): SeedOffer {
  const key = input.scope === null ? null : seedNotNowKey(input.scope);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [handedBack, setHandedBack] = useState(false);
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    if (key === null) return;
    /* A storage that refuses the read answers nothing kept: the offer stands, as it did before "Not now" was kept. */
    setHeldKey(kept.get(key) === "1" ? key : null);
  }, [key]);
  const notNow = key !== null && heldKey === key;
  const owed =
    !input.demo &&
    input.known &&
    input.hasMailbox === true &&
    input.supported &&
    (reopened || (input.seedConfirmedAt === null && !handedBack && !notNow));

  const reopen = useCallback(() => setReopened(true), []);
  const later = useCallback(() => {
    if (key !== null) {
      setHeldKey(key);
      kept.set(key, "1");
    }
    setHandedBack(true);
    setReopened(false);
  }, [key]);
  const settle = useCallback(() => {
    setHandedBack(true);
    setReopened(false);
  }, []);
  return { owed, reopened, reopen, later, nothingToDecide: settle, done: settle };
}

/** The seed offer of this frame, provided once by whoever computes it. */
export const SeedOfferContext = createContext<SeedOffer | null>(null);

/** The frame's seed offer, or `null` where nobody provides one: the review is then not this stage's to draw. */
export function useSeedOfferHere(): SeedOffer | null {
  return useContext(SeedOfferContext);
}
