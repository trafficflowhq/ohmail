"use client";

/**
 * Everything from and to one address. `#/address/<addr>` shows mail the address sent and mail sent to
 * it, newest first, with a direction toggle; this module is the whole of what the view consumes. The
 * halves are unequal: the device answers all directions from the mirror (`SearchIndex.messagesWith`,
 * lowercased postings over `from.address`, `to[]`, `cc[]`); the archive answers only `from` — the
 * recipients are two unindexed JSONB columns, and a recipient index is a migration with a backfill,
 * not this change. So {@link AddressView.coverage} is the field the view must render a sentence from:
 * `senders-only` means mail sent TO the address older than this mirror is missing and we know it. The
 * toggle never reaches the wire — one archive request per opened view, for `from`, whatever it says.
 */

/**
 * A dependency that is not obvious: mail this account SENT is in the mirror, although its folder is
 * `"Sent"` — outside the six `Folder` members, so it matches no pile view. It arrives anyway:
 * `recordSent` (`packages/core/src/sent-record.ts`) writes a real `messages` row through ordinary
 * ingest, the Sent-folder watch is the backstop, and `/sync`'s snapshot filters on account and
 * `deleted_at is null` with no folder filter (`packages/services/src/sync-service.ts`) —
 * `messagesWith` selects on the from/to/cc fields, never the folder. Covered both ways: one case
 * asserts the snapshot emits a folder outside the union, another that the selector labels such a row.
 */

import { useEffect, useMemo, useState } from "react";
import { addressHash } from "./routing";
import {
  type AddressCounts,
  type AddressDirection,
  type EngineMessage,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
  type ServerAddressOutcome,
} from "@ohmail/client-engine";

export type { AddressCounts, AddressDirection } from "@ohmail/client-engine";

/** The default, and the one the route means when the hash names no direction. */
export const DEFAULT_ADDRESS_DIRECTION: AddressDirection = "any";

/** The three directions in the order the toggle renders them. */
export const ADDRESS_DIRECTIONS: readonly AddressDirection[] = ["any", "from", "to"];

/**
 * What the archive pass is doing for the address currently open. `unavailable` is a first-class
 * answer, not a failure: the demo has no server and the desktop tier has no Cloud, so "there is no
 * archive behind this client", "the archive has not answered yet" and "the archive refused" are
 * three different true sentences, and a view that renders any two identically is lying about one.
 * `direction` on `ready` is the direction the server answered, which is not necessarily the one on
 * screen — see {@link AddressView.coverage}.
 */
export type AddressArchive =
  | { state: "searching" }
  | { state: "ready"; items: EngineMessage[]; total: number; direction: AddressDirection }
  /**
   * `retry` hangs off THIS arm and no other, so "ask again" cannot be offered where there is
   * nothing to ask again: `unavailable` means there is no archive behind this client at all and
   * `ready` has already answered. A retry control over either would be a button that does
   * nothing, which is the same defect as a missing one and harder to see.
   */
  | { state: "failed"; error: string; retry: () => void }
  | { state: "unavailable" };

/**
 * Does the archive's answer cover the direction on screen? Derived here rather than worked out by the
 * view, because getting it wrong is silent: the archive answers `from` always, so a view comparing
 * nothing renders the from-half under "To them" and the numbers add up. `complete` — the archive
 * answered the direction being shown (or is unavailable/failed and the view states that instead).
 * `senders-only` — the archive answered `from` while the view shows "All" or "To them"; the view
 * must say that mail sent TO this address, older than this device's mirror, is not in the list. The
 * sentence belongs to the view; the fact belongs here.
 */
export type AddressCoverage = "complete" | "senders-only";

/** One row, and where it came from — the archive-only ones are marked on screen. */
export interface AddressHit {
  hit: EngineSearchHit;
  /** True when the archive returned it and this device's mirror does not hold the row. */
  archiveOnly: boolean;
}

/** What the view renders. The designer's AddressView consumes exactly this and nothing else. */
export interface AddressView {
  /**
   * Device rows first, then the archive's extras where they answer the direction on screen, each half
   * newest-first. Not one re-sorted list, deliberately: the device holds every direction and the
   * archive holds one, so interleaving by date would mix a complete answer with a partial one into a
   * timeline where the reader cannot tell which rows could be missing. The archive's half is present
   * under `any` and under the direction the archive itself answered, absent otherwise — under
   * "To them" against a sender-only archive this is the device's rows alone.
   */
  items: AddressHit[];
  /** Per-direction counts over the DEVICE's mirror. `any` is the union — never `from + to`. */
  counts: AddressCounts;
  archive: AddressArchive;
  /** Whether `archive` covers `direction`. See {@link AddressCoverage}. */
  coverage: AddressCoverage;
}

/**
 * The href for one address — every control that prints an address navigates through this. A
 * delegation to the router's own {@link addressHash}, deliberately not a second `encodeURIComponent`
 * call: the router owns the hash format, and three spellings that agree today can drift invisibly —
 * `normalizedHash` would rewrite the bar on every render of a link that was already right. The case
 * is not folded: matching is `lower()`-insensitive at both doors, and the address as the sender wrote
 * it is the one worth putting in a link somebody may read.
 */
export function addressHref(address: string): string {
  return addressHash(address);
}

/**
 * THE DEVICE HALF — pure, synchronous, total. Every message in this mirror involving `address`,
 * in `direction`, newest first, plus the counts for all three directions.
 *
 * Exported beside the hook because it is the part with no React in it: a non-React caller (a
 * test, a keyboard handler counting rows before it navigates) needs the answer without an
 * effect, and the hook is this function plus the archive pass.
 */
export function messagesWith(
  engine: OhmailEngine,
  address: string,
  direction: AddressDirection = DEFAULT_ADDRESS_DIRECTION,
): { items: EngineSearchHit[]; counts: AddressCounts } {
  return engine.messagesWith(address, direction);
}

/**
 * The whole view — the device half now, the archive's half when it lands. `version` is the mirror's
 * change stamp and a dependency for the reason `SearchView`'s local pass takes it: the engine's index
 * is cached on that stamp, so a mirror that moves must re-derive the list. The archive pass is keyed
 * by the address it answers, and an answer for an address the reader has navigated away from is
 * discarded — showing it would attach one person's mail to another person's name, worse here than on
 * the search box because the header states whose mail this is. No debounce: an address view is opened
 * by a click, not typed into, so there is already one request per opened view.
 */
export function useAddressView({
  engine,
  version,
  address,
  direction = DEFAULT_ADDRESS_DIRECTION,
  limit,
}: {
  engine: OhmailEngine;
  version: number;
  address: string;
  direction?: AddressDirection;
  limit?: number;
}): AddressView {
  const device = useMemo(
    () => engine.messagesWith(address, direction),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, address, direction, version],
  );

  const [pass, setPass] = useState<{ address: string; outcome: AddressArchive } | null>(null);
  /**
   * A human press on a failed pass, and nothing else, re-issues the request. A counter rather than a
   * boolean: two presses on a door that keeps refusing must be two requests — a boolean's second
   * press is a no-op that reads as the button being dead. It is a dependency of the effect below, so
   * the retry is the ordinary pass run again and cannot drift from it. Deliberately no automatic
   * re-ask: a failed pass is one door refusing, and a timer turns one person's outage into a request
   * per second from every open view; the reader decides.
   */
  const [retryTick, setRetryTick] = useState(0);
  const available = engine.serverAddressSearchAvailable();

  useEffect(() => {
    if (address.trim() === "") {
      // A BLANK ADDRESS IS AN ANSWERED QUESTION, NOT A PENDING ONE. Leaving the pass null read
      // as `searching` below — a view showing "searching the archive" for a question nobody will
      // ever ask, for ever. It is unreachable from the router (`parseHash` refuses an address
      // branch with an empty segment), which is exactly why it is worth stating rather than
      // leaving to a fallback: this is the shape a reader takes for a guarantee.
      //
      // `ready` with nothing, and the direction the archive serves — byte for byte what
      // `OhmailEngine.searchAddressServer` itself answers for a blank address, so the contract
      // and the engine cannot disagree about what "nothing to ask" looks like.
      setPass({ address, outcome: { state: "ready", items: [], total: 0, direction: "from" } });
      return;
    }
    if (!available) {
      setPass({ address, outcome: { state: "unavailable" } });
      return;
    }
    let live = true;
    setPass({ address, outcome: { state: "searching" } });
    // `searchAddressServer` never rejects — the outcome is a value the view renders, so there is
    // no unhandled promise here and no error boundary over somebody's mailbox.
    void engine.searchAddressServer(address, { ...(limit !== undefined ? { limit } : {}) })
      .then((outcome: ServerAddressOutcome) => {
        if (!live) return;
        setPass({
          address,
          outcome:
            outcome.state === "ready"
              ? {
                state: "ready",
                items: outcome.items,
                total: outcome.total,
                direction: outcome.direction,
              }
              : outcome.state === "failed"
                ? { state: "failed", error: outcome.error, retry: () => setRetryTick((n) => n + 1) }
                : { state: "unavailable" },
        });
      });
    return () => {
      live = false;
    };
    // `direction` is DELIBERATELY NOT a dependency: the archive answers `from` whatever the
    // toggle says, so a toggle press must not re-issue the request. Re-fetching would spend a
    // round trip to receive the identical rows, and would blank the archive's half of the count
    // line while it was in flight — a number that flickers on a control that changed nothing
    // about what was asked.
  }, [engine, address, available, limit, retryTick]);

  /** The archive's answer, but only while it still belongs to the address on screen. */
  const archive: AddressArchive =
    pass && pass.address === address ? pass.outcome : { state: "searching" };

  const items = useMemo<AddressHit[]>(() => {
    const rows: AddressHit[] = device.items.map((hit) => ({ hit, archiveOnly: false }));
    if (archive.state !== "ready") return rows;
    /**
     * The archive's rows only where they answer the question on screen. The archive answers one
     * direction; its rows belong in a list showing everything or exactly that direction — nowhere
     * else. Appending them under every direction put mail the address SENT into a list titled
     * "To them": the false claim this module's header warns against, arriving with a 200.
     * `direction === archive.direction` rather than the literal `"from"`, so the day the recipient
     * index lands this needs no edit — and it is the conservative side: an archive answering `any`
     * under a screen showing `from` contributes nothing. The view applies the same rule to what it
     * renders; this one decides what the contract yields, and its absence is the silent one.
     */
    if (!(direction === "any" || direction === archive.direction)) return rows;
    const held = new Set(device.items.map((h) => h.message.id));
    for (const message of archive.items) {
      if (held.has(message.id)) continue;
      // Score 0 and no matches, exactly as the device half's hits carry: an address query is an
      // equality and has no relevance dimension. See `AddressResult` in the client engine.
      rows.push({ hit: { message, score: 0, matches: [] }, archiveOnly: true });
    }
    return rows;
  }, [device.items, archive, direction]);

  /**
   * `senders-only` exactly when the archive ANSWERED and answered a narrower direction than the
   * one on screen. Keyed on the answer's own `direction` rather than on "the toggle is not
   * `from`", so the day the recipient index lands and the server answers `any`, this goes
   * `complete` on its own and the view's caveat disappears without a code change here.
   */
  /**
   * A blank address is not a question, so it has no shortfall — its own case, not folded into "the
   * archive answered everything asked of it". Without it the rule reads `ready` + `from` against a
   * toggle of `any` and answers `senders-only`, printing "the archive cannot be searched by recipient
   * yet" over a screen with no subject and no rows. `total === 0` is deliberately not the test: a
   * real address with nothing in the from-half still has the shortfall — mail sent to that person may
   * be in the archive — so keying on emptiness would hide the caveat exactly where it is most needed.
   */
  const asked = address.trim() !== "";
  const coverage: AddressCoverage =
    asked && archive.state === "ready" && archive.direction !== direction
      ? "senders-only"
      : "complete";

  return { items, counts: device.counts, archive, coverage };
}
