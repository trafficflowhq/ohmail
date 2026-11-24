/**
 * THE CONSENT ROW ABOVE THE PANES: the account's one consent answer for a mounted frame, with its writers. What
 * stands above every pane makes the row's one call and provides it here; a place reads it with `useConsent()` and
 * never calls for it.
 */
import { SCREENER_ACKNOWLEDGEMENTS, type ScreenerAcknowledgement } from "@trafficflow/core/screener-acknowledgements";
import { createContext, useContext, useMemo, type Context } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { StorageScope } from "../storage/scope.js";
import { useConsentState, windowOwnersOf, type ConsentTransport } from "./consent-state.js";

/**
 * The row as its one hook answers it: the account's stored choices (`ConsentState`) and the writers that change them.
 *
 * A reader MAY RELY ON: one row per mounted frame, of the frame's own scope, the same object for every reader of a
 * render. Until the live answer is in (`known` false) each field rests on its protective side: pictures and pixels
 * blocked, nothing bought, no folder shown. A writer is the row's own, so what it stores is what every reader reads
 * next. The row is a new object whenever its holder renders: a memo keys on the fields it reads, never on the row.
 *
 * A reader MAY NEVER: call the row's hook itself (a second caller asks the wire twice and holds a second answer);
 * keep the row or a field of it where it outlives the frame's mount (a module's variable, a stored key, a cache keyed
 * by anything but the scope): consent is never remembered wider than its scope; or read the context with a fallback
 * of its own. No row is no answer, and `useConsent` throws.
 */
export type ConsentRow = ReturnType<typeof useConsentState>;

/** Filled by what stands above the panes, once per mounted frame. Read it with {@link useConsent}. */
export const ConsentContext: Context<ConsentRow | null> = createContext<ConsentRow | null>(null);

/** The consent row of this frame. Throws where none stands above: a picture never loads on a guessed answer. */
export function useConsent(): ConsentRow {
  const row = useContext(ConsentContext);
  if (row === null) throw new Error("useConsent: no consent row stands above (ConsentContext)");
  return row;
}

/**
 * What the row's one call is handed. Every field is required and none has a default: a scope nobody handed in is
 * refused by the row's own pin, and a wire nobody handed in is `"none"`, said by the caller.
 */
export interface ConsentRowInput {
  engine: OhmailEngine;
  /** The derived stamp (`useDerivedVersion`): what the settings stamp is read again on. */
  derived: number;
  /** `GET /mailboxes`, or null while it has not answered: the roles a promotion re-asks on. */
  facts: ReadonlyArray<{ id: string; organizerRole?: "organizer" | "reader" }> | null;
  /**
   * `false` in the demo: nothing is asked and the row rests. A caller hands the BROWSER's own answer
   * (`useResolvedDemoMode`), never the flag a prerendered page was served with: that flag reads false for one
   * render of a demo page, a row keyed on it asked the consent wire from the fixture world, and an effect's
   * cleanup cannot recall a request.
   */
  active: boolean;
  /** Whose remembered answer this mount reads and writes: the scope its host handed. */
  scope: StorageScope;
  /** The wire the host handed in, or `"none"`: nothing is asked, nothing is written and the row rests. */
  transport: ConsentTransport | "none";
}

/**
 * THE ROW'S ONE CALL, with the two keys it re-asks on. What stands above the panes calls it once per mounted frame
 * and provides its answer ({@link ConsentContext}); nothing else calls it.
 */
export function useConsentRow({
  engine,
  derived,
  facts,
  active,
  scope,
  transport,
}: ConsentRowInput): ConsentRow {
  /**
   * THE SETTINGS STAMP off the mirror — the `settings` entity's `updatedAt`, recomputed per
   * version bump. The entity is the sync channel's doorbell for consent-settings writes made on
   * ANY surface (`change-log.ts` says why it exists); `useConsentState` re-asks `GET /consent`
   * whenever it moves, which is what lets a folders flip or an image-posture change made in
   * another window reach THIS one within normal sync latency instead of at the next boot. The
   * record's CONTENT is deliberately not read beyond the stamp — the live consent read stays the
   * one authority, so the two cannot drift.
   */
  const settingsStamp = useMemo(() => {
    const read = engine.read();
    const rows = read.entries<{ updatedAt?: string }>("settings");
    /* …AND EACH MAILBOX_PROFILE ROW'S SEQ (RULING-026): a new organizer document can move a mailbox's
       window, which `GET /consent` answers in `screeningByMailbox`; the row is the doorbell, never read. */
    const profiles = read.entries("mailbox_profile").map((e) => `${e.id}:${e.seq}`).sort().join(",");
    if (rows.length === 0 && profiles === "") return null;
    return `${String(rows[0]?.seq ?? rows[0]?.entity?.updatedAt ?? "")}|${profiles}`;
    // `derived` is the subscription; the reader object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, derived]);
  const windowOwners = useMemo(() => windowOwnersOf(facts), [facts]); // the roles; a promotion re-asks (R20-02)
  return useConsentState(active, scope, transport, settingsStamp, windowOwners);
}

/** The current account's remembered Screener confirmations. */
export function useScreenerAcknowledgements() {
  const { screenerAcknowledgements, acknowledgeScreener } = useConsent();
  return {
    has: (kind: ScreenerAcknowledgement) =>
      (screenerAcknowledgements & SCREENER_ACKNOWLEDGEMENTS[kind]) !== 0,
    remember: acknowledgeScreener,
  };
}
