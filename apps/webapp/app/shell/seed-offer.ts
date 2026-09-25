"use client";

import { useCallback, useEffect, useState } from "react";
import { durableSet } from "./durable";
import { storageOwner } from "./storage-owner";

/**
 * `ohmail.ui.seed.notNow.<owner>` — "Not now" on the sent-mail review, for one account on this
 * device. A dismissal and no mail, so it survives sign-out (`sign-out-clears-durable-stores`).
 */
export function seedNotNowKey(owner: string | null): string {
  return `ohmail.ui.seed.notNow.${owner ?? "local"}`;
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

/**
 * WHEN THE SENT-MAIL REVIEW TAKES THE STAGE. Offered once the server says it is owed
 * (`seedConfirmedAt` null, read — `known`), where the browser client that runs it exists, until it
 * is answered, put off, or found to have nobody in it. The stored "Not now" is read after mount
 * (hydration) and held as the KEY it was read under, so another account's answer never applies.
 */
export function useSeedOffer(input: {
  demo: boolean; known: boolean; supported: boolean; seedConfirmedAt: string | null;
}): SeedOffer {
  const key = seedNotNowKey(storageOwner());
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [handedBack, setHandedBack] = useState(false);
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    try {
      setHeldKey(window.localStorage.getItem(key) === "1" ? key : null);
    } catch {
      /* storage blocked — the offer stands, as it did before "Not now" was kept */
    }
  }, [key]);
  const notNow = heldKey === key;
  const owed = !input.demo && input.known && input.supported
    && (reopened || (input.seedConfirmedAt === null && !handedBack && !notNow));

  const reopen = useCallback(() => setReopened(true), []);
  const later = useCallback(() => {
    setHeldKey(key);
    durableSet(key, "1", "ui.flag");
    setHandedBack(true);
    setReopened(false);
  }, [key]);
  const settle = useCallback(() => { setHandedBack(true); setReopened(false); }, []);
  return { owed, reopened, reopen, later, nothingToDecide: settle, done: settle };
}
