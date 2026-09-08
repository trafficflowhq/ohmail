"use client";

/**
 * ═══ EVERYTHING FROM AND TO ONE ADDRESS — the seam the address view is built on ════════════
 *
 * `#/address/<addr>` shows one list: mail that address sent, and mail sent to it, newest first,
 * with a toggle that narrows to either direction. This module is the WHOLE of what the view and
 * the address controls consume — the two halves are composed here rather than in the view, for
 * the reason the halves are unequal:
 *
 *   · THE DEVICE answers all three directions, instantly, from the mirror it already holds
 *     (`SearchIndex.messagesWith` — exact lowercased postings over `from.address`, `to[]` and
 *     `cc[]`).
 *   · THE ARCHIVE answers ONE — `from` — and refuses the other two by name.
 *
 * That asymmetry is not a temporary rough edge to be smoothed over in the view; it is a fact
 * about the database, and a view that hid it would state something false. On the server the
 * recipients are two JSONB columns (`messages.to_addresses` / `.cc_addresses`) with no index on
 * either, and it is not merely slow: measured with `EXPLAIN (ANALYZE, BUFFERS)` on 20 000 rows,
 * `lower(from_address) = $1` is an index scan on `messages_account_from_addr_idx` at four
 * buffers, every spelling of the recipient predicate is a sequential scan, and putting the two
 * in ONE `or` predicate loses the sender index as well. A recipient index is a migration with a
 * backfill and is not this change.
 *
 * So {@link AddressView.coverage} exists, and it is the field the view must render a sentence
 * from. `senders-only` means: these archive rows are mail this address SENT, and mail sent TO it
 * that is older than this device's mirror is not in this list and we know it. The alternative —
 * appending the from-half under a toggle that says "To them" — is a claim about the whole
 * archive that is false by exactly the recipients, with a 200 and nothing on screen to say so.
 *
 * ── WHY THE TOGGLE NEVER REACHES THE WIRE ─────────────────────────────────────────────────
 *
 * One archive request per opened view, for `from`, whatever the toggle says. Switching to "To
 * them" changes what is SHOWN; it is not a new question for a door that cannot answer it, and
 * making it one would spend a round trip to be refused. `OhmailEngine.searchAddressServer` takes
 * no direction for the same reason.
 *
 * ── WHAT THIS MODULE DEPENDS ON THAT IS NOT OBVIOUS ───────────────────────────────────────
 *
 * **Mail this account SENT is in the mirror**, and the "To them" direction is mostly worthless
 * without it. It is there, and it is worth naming because the shape suggests otherwise: a sent
 * copy's folder is `"Sent"`, which is NOT one of the six `Folder` members and matches no pile
 * view, so it is invisible everywhere a surface reads the mirror BY PILE. It reaches the mirror
 * anyway — `recordSent` (`packages/core/src/sent-record.ts`) writes a real `messages` row
 * through the ordinary ingest path for every send, the Sent-folder watch is the backstop behind
 * it, and `/sync`'s snapshot selects on account and `deleted_at is null` with NO folder filter
 * (`packages/services/src/sync-service.ts`). `messagesWith` therefore selects on the from/to/cc
 * FIELDS and never on the folder — anything reaching the mirror by folder would miss every
 * message this account ever sent. Both halves of that are covered: one case asserts the sync
 * snapshot emits a message whose folder is outside the six-member union, and another asserts the
 * selector returns such a row and labels it through `folderLeaf`.
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
 * WHAT THE ARCHIVE PASS IS DOING FOR THE ADDRESS CURRENTLY OPEN.
 *
 * `unavailable` is a first-class answer and not a failure: the demo has no server and the
 * desktop tier has no Cloud, so "there is no archive behind this client" and "the archive has
 * not answered yet" and "the archive refused" are three different true sentences, and a view
 * that renders any two of them identically is lying about one.
 *
 * `direction` on `ready` is the direction the SERVER answered, which is not necessarily the one
 * on screen. See {@link AddressView.coverage}.
 */
export type AddressArchive =
  | { state: "searching" }
  | { state: "ready"; items: EngineMessage[]; total: number; direction: AddressDirection }
  | { state: "failed"; error: string }
  | { state: "unavailable" };

/**
 * DOES THE ARCHIVE'S ANSWER COVER THE DIRECTION ON SCREEN?
 *
 * A derived, two-member field rather than something the view works out from `direction` and the
 * toggle. It is derived HERE because getting it wrong is silent: the archive answers `from`
 * always, so a view comparing nothing at all renders the from-half under "To them" and the
 * numbers add up.
 *
 *  · `complete` — the archive answered the direction being shown (the toggle is "From them", or
 *    the archive is unavailable/failed and the view is stating that instead).
 *  · `senders-only` — the archive answered `from` while the view is showing "All" or "To them".
 *    The view MUST say so: mail sent TO this address, older than this device's mirror, is not in
 *    the list. The sentence belongs to the view; the fact belongs here.
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
   * Device rows first, then the archive's extras, each half newest-first.
   *
   * NOT ONE RE-SORTED LIST, and that is deliberate: the device holds every direction and the
   * archive holds one, so interleaving by date would mix a complete answer with a partial one
   * into a single timeline in which the reader cannot tell which rows could be missing. The
   * device's half is the list; the archive's half completes it from behind, which is also the
   * order the two arrive in.
   */
  items: AddressHit[];
  /** Per-direction counts over the DEVICE's mirror. `any` is the union — never `from + to`. */
  counts: AddressCounts;
  archive: AddressArchive;
  /** Whether `archive` covers `direction`. See {@link AddressCoverage}. */
  coverage: AddressCoverage;
}

/**
 * THE HREF FOR ONE ADDRESS — every control that prints an address navigates through this.
 *
 * A DELEGATION to the router's own {@link addressHash} and deliberately not a second
 * `encodeURIComponent` call. The router owns the hash format: it splits a path on `/` to find
 * the `m/<id>` open-message tail (so a `/` in a quoted local part would become a path boundary),
 * `parseHash` decodes the segment, and `canonicalHash` re-encodes it to decide whether the
 * address bar needs rewriting. Three spellings that agree today are three that can drift, and
 * the drift is invisible: `normalizedHash` would rewrite the bar on every render of a link that
 * was already right, truncating the address it was correcting.
 *
 * The case is NOT folded. Matching is `lower()`-insensitive at both doors, so folding here would
 * only make the URL disagree with the address printed beside it — and the address as the sender
 * wrote it is the one worth putting in a link somebody may read.
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
 * THE WHOLE VIEW — the device half now, the archive's half when it lands.
 *
 * `version` is the mirror's change stamp and is a dependency for the reason `SearchView`'s local
 * pass takes it: the engine's index is cached on that stamp, so a mirror that moves (a drain, a
 * send, a delete) must re-derive the list rather than keep showing what was true a moment ago.
 *
 * The archive pass is keyed by the ADDRESS it answers, and an answer for an address the reader
 * has since navigated away from is DISCARDED rather than rendered. Two passes over one screen
 * means the slow one can land after the question changed, and showing it would attach one
 * person's mail to another person's name — which on this view is worse than on the search box,
 * because the header states whose mail this is.
 *
 * There is NO debounce. An address view is opened by a click, not typed into, so there is one
 * request per opened view already — the thing `SearchView`'s 250 ms exists to prevent (a request
 * per keystroke) cannot happen here, and a delay would only make the archive land later.
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
  const available = engine.serverAddressSearchAvailable();

  useEffect(() => {
    if (address.trim() === "") {
      setPass(null);
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
                ? { state: "failed", error: outcome.error }
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
  }, [engine, address, available, limit]);

  /** The archive's answer, but only while it still belongs to the address on screen. */
  const archive: AddressArchive =
    pass && pass.address === address ? pass.outcome : { state: "searching" };

  const items = useMemo<AddressHit[]>(() => {
    const rows: AddressHit[] = device.items.map((hit) => ({ hit, archiveOnly: false }));
    if (archive.state !== "ready") return rows;
    const held = new Set(device.items.map((h) => h.message.id));
    for (const message of archive.items) {
      if (held.has(message.id)) continue;
      // Score 0 and no matches, exactly as the device half's hits carry: an address query is an
      // equality and has no relevance dimension. See `AddressResult` in the client engine.
      rows.push({ hit: { message, score: 0, matches: [] }, archiveOnly: true });
    }
    return rows;
  }, [device.items, archive]);

  /**
   * `senders-only` exactly when the archive ANSWERED and answered a narrower direction than the
   * one on screen. Keyed on the answer's own `direction` rather than on "the toggle is not
   * `from`", so the day the recipient index lands and the server answers `any`, this goes
   * `complete` on its own and the view's caveat disappears without a code change here.
   */
  const coverage: AddressCoverage =
    archive.state === "ready" && archive.direction !== direction ? "senders-only" : "complete";

  return { items, counts: device.counts, archive, coverage };
}
