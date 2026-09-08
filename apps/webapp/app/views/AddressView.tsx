"use client";

/**
 * ═══ EVERYTHING FROM AND TO ONE ADDRESS — `#/address/<addr>` ═══════════════════════════════
 *
 * One list, newest first, of the mail one address sent and the mail sent to it, with a toggle that
 * narrows to either direction. It consumes `shell/address-view.ts` and nothing else: the device's
 * rows and counts, the archive's answer, and `coverage` — the field that says whether the archive's
 * answer covers the direction on screen. That module's header explains why the two halves are
 * unequal (the archive is searchable by SENDER only); this file is about what a person sees.
 *
 * ── THE ANATOMY, top to bottom ─────────────────────────────────────────────────────────────
 *
 *   the header     the person: their name when any of their mail carries one, the address beside
 *                  it in the header's meta type; the address alone when there is no name. A
 *                  long address WRAPS rather than overflowing a 390px pane.
 *   the toggle     All · From them · To them, the segmented control every other filter in this
 *                  product uses, with the number of rows each direction would show right now.
 *   the count line the two totals, device first — "3 on this device · 40 in the archive (by
 *                  sender)" — because the device half answers instantly and is the number a
 *                  reader can check by counting; the archive slot fills in beside it without
 *                  moving it. On To them the archive slot is a NAMED line, never a number that
 *                  would have to be zero: "the archive cannot be searched by recipient yet".
 *                  The "(by sender)" and the named line each carry a Gloss with the one-sentence
 *                  reason, so the caveat costs no line of the surface.
 *   the list       the search result row (`SearchHitRow`), so a message looks the same wherever
 *                  it is found. A sent copy reads "Sent" in its meta line — the row labels by
 *                  `placeLabel`, which falls through to the folder's leaf for a folder no view
 *                  owns. The row's own address is printed, not linked: it is this view.
 *   the empty      names the address in the direction's own words — "Nothing sent to
 *                  anna@acme.test." — with the count line under it, so an empty list while the
 *                  archive is still answering never reads as an empty corpus.
 *
 * ── WHICH ROWS THE ARCHIVE MAY ADD ─────────────────────────────────────────────────────────
 *
 * The contract appends the archive's rows behind the device's whatever the toggle says, and the
 * archive answers `from`. Under All those rows belong (All includes what they sent). Under To them
 * they do not — they are mail the address SENT, and listing them under "To them" is the false claim
 * the contract's own header warns against. So {@link archiveRowsBelong} decides per direction and
 * the view drops the archive's rows where they do not belong; the named line says why the list is
 * device-only there. The same rule gives the toggle its numbers.
 *
 * ── KEYBOARD ───────────────────────────────────────────────────────────────────────────────
 *
 * Tab order is the reading order: the toggle, then each row's address link and open control.
 * Escape leaves the view through `onExit` (the shell decides where to) and is listed in the `?`
 * sheet under Navigate; `/` is the shell's own binding and still opens Search from here. Nothing
 * here binds `j`/`k` — those follow pile order by ruling, and this is not a pile.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { OhmailEngine, SearchHit as EngineSearchHit } from "@ohmail/client-engine";
import { Gloss, SegmentedControl } from "@ohmail/ui";
import {
  ADDRESS_DIRECTIONS,
  DEFAULT_ADDRESS_DIRECTION,
  messagesWith,
  useAddressView,
  type AddressDirection,
  type AddressHit,
} from "../shell/address-view";
import { displayAddress } from "../shell/idn";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { SearchHitRow } from "./SearchView";
import "./search-keys.css";

/**
 * DO THE ARCHIVE'S ROWS BELONG UNDER THIS DIRECTION? The archive answered `answered`; the screen
 * shows `direction`. They belong when the screen shows everything, or exactly what was answered.
 * Pure and exported so the rule is tested by name rather than inferred from a rendered list.
 */
export function archiveRowsBelong(direction: AddressDirection, answered: AddressDirection): boolean {
  return direction === "any" || direction === answered;
}

/** The catalogue key for each segment's label — one table, so the order is `ADDRESS_DIRECTIONS`'. */
const SEGMENT_KEY: Record<AddressDirection, "addressAll" | "addressFrom" | "addressTo"> = {
  any: "addressAll",
  from: "addressFrom",
  to: "addressTo",
};

/** The empty state's sentence per direction — each names the address. */
const EMPTY_KEY: Record<AddressDirection, "addressEmptyAny" | "addressEmptyFrom" | "addressEmptyTo"> = {
  any: "addressEmptyAny",
  from: "addressEmptyFrom",
  to: "addressEmptyTo",
};

/**
 * THE NAME THIS ADDRESS GOES BY, from the newest row that carries one. A sender writes their own
 * name in `From:`; a recipient's name is what the sender wrote for them. Either is a fact about the
 * address, and the newest is the one most likely to be current. `null` when no row names them.
 */
export function nameFor(rows: readonly AddressHit[], address: string): string | null {
  const key = address.toLowerCase();
  for (const { hit: { message: m } } of rows) {
    if (m.from.address.toLowerCase() === key && m.from.name) return m.from.name;
    for (const r of [...m.to, ...m.cc]) {
      if (r.address.toLowerCase() === key && r.name) return r.name;
    }
  }
  return null;
}

export function AddressView({
  engine,
  version,
  now,
  address,
  onOpen,
  placeOf,
  onExit,
}: {
  engine: OhmailEngine;
  version: number;
  now: Date;
  /** The address the route names — decoded, as the sender wrote it. */
  address: string;
  onOpen: (hit: EngineSearchHit) => void;
  /** Where each message is PRESENTED — see `SearchView`'s prop of the same name. */
  placeOf?: ReadonlyMap<string, string | null>;
  /** Escape — back to wherever the address was clicked. Optional so a bare mount stays inert. */
  onExit?: () => void;
}) {
  const t = useTranslations("search");
  const [direction, setDirection] = useState<AddressDirection>(DEFAULT_ADDRESS_DIRECTION);
  // A new address is a new question; the toggle a reader narrowed for one person must not carry
  // over to the next, or the view would open on "To them" for somebody it has nothing sent to.
  useEffect(() => setDirection(DEFAULT_ADDRESS_DIRECTION), [address]);

  const view = useAddressView({ engine, version, address, direction });
  const archive = view.archive;
  const answered = archive.state === "ready" ? archive.direction : null;

  const shownAddress = displayAddress(address);
  const name = useMemo(() => nameFor(view.items, address), [view.items, address]);

  /** The rows on screen — the archive's extras only where they belong (see the header). */
  const rows = useMemo(
    () =>
      answered !== null && !archiveRowsBelong(direction, answered)
        ? view.items.filter((r) => !r.archiveOnly)
        : view.items,
    [view.items, direction, answered],
  );

  /**
   * HOW MANY ROWS THE ARCHIVE ADDS — the archive's rows this device does not hold, counted against
   * the direction the archive answered. `view.items` cannot be read for this under To them, where
   * the contract's `held` set is the device's to-rows and every archive row looks new; so the
   * device's rows for the ANSWERED direction are asked for directly (`messagesWith` is pure).
   */
  const extras = useMemo(() => {
    if (archive.state !== "ready") return 0;
    const held = new Set(messagesWith(engine, address, archive.direction).items.map((h) => h.message.id));
    return archive.items.filter((m) => !held.has(m.id)).length;
    // `version` is the mirror's change stamp, the same dependency the contract's own memo takes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, address, archive, version]);

  /** The number a segment shows: the rows pressing it would put on screen right now. */
  const shownCount = (d: AddressDirection): number =>
    view.counts[d] + (answered !== null && archiveRowsBelong(d, answered) ? extras : 0);

  const keys: KeyBinding[] = [
    {
      chord: "Escape",
      group: "navigate",
      label: t("addressKeyClose"),
      disabled: onExit == null,
      run: () => onExit?.(),
    },
  ];
  useKeyBindings(keys);

  /**
   * THE COUNT LINE — device first, the archive's slot beside it. Six arms; one is always on screen
   * while the view is. `coverage` decides the archive's slot: `complete` prints the number plain,
   * `senders-only` prints it with "(by sender)" under All and the named line under To them. The
   * caveat is derived in the contract, not here, so the day the archive answers every direction
   * the plain arm takes over without a change to this file.
   */
  const deviceHalf = t("addressDevice", { count: view.counts[direction] });
  const archiveHalf =
    archive.state === "searching" ? (
      t("scopeSearching")
    ) : archive.state === "unavailable" ? (
      t("scopeNoArchive")
    ) : archive.state === "failed" ? (
      t("scopeFailed", { reason: archive.error })
    ) : view.coverage === "complete" ? (
      t("addressArchive", { count: archive.total })
    ) : direction === "to" ? (
      <>
        {t("addressArchiveNoRecipients")}{" "}
        <Gloss placement="meta" text={t("addressArchiveNoRecipientsWhy")} />
      </>
    ) : (
      <>
        {t("addressArchiveBySender", { count: archive.total })}{" "}
        <Gloss placement="meta" text={t("addressArchiveBySenderWhy")} />
      </>
    );
  /**
   * A phrase joins the device's number with a separator; a SENTENCE (no archive behind this
   * client, or one that refused) takes a line of its own, as Search's scope line does — a bullet
   * before a full sentence is a bullet, not a join. `search-keys.css` draws the separator, so the
   * empty state can stack the two halves without it.
   */
  const archiveIsSentence = archive.state === "unavailable" || archive.state === "failed";
  /* The archive returned fewer rows than it holds — a page, not the whole. Said in Search's own
     words rather than left for the reader to notice by counting. */
  const archiveShown =
    archive.state === "ready" && archive.total > archive.items.length
      ? t("resultsShown", { shown: archive.items.length })
      : null;
  const scope = (
    <>
      <b className="addr-device">{deviceHalf}</b>
      <span className={archiveIsSentence ? "addr-archive sentence" : "addr-archive"}>{archiveHalf}</span>
      {archiveShown ? <span className="addr-archive">{archiveShown}</span> : null}
    </>
  );

  return (
    <section className="view col view-address">
      <div className="vhead">
        <h1>{name ?? shownAddress}</h1>
        {name ? <span className="meta">{shownAddress}</span> : null}
      </div>
      <div className="scroller">
        {/* The same 740px column as Search: this view is what a search row's address opens into,
            and the rows are the same rows, so the two read as one place at two zoom levels. */}
        <div className="search-wrap">
          <div className="addr-bar">
            <SegmentedControl<AddressDirection>
              ariaLabel={t("addressToggleAria")}
              value={direction}
              onChange={setDirection}
              options={ADDRESS_DIRECTIONS.map((d) => ({
                id: d,
                label: t(SEGMENT_KEY[d]),
                count: shownCount(d),
              }))}
            />
          </div>
          {rows.length === 0 ? (
            /* "Nothing here" is a claim, and its size depends on which pass has answered. The
               count line is rendered INSIDE the empty state for that reason. */
            <div className="empty">
              <span className="glyph">🌫</span>
              <b>{t(EMPTY_KEY[direction], { address: shownAddress })}</b>
              <span className="addr-scope">{scope}</span>
            </div>
          ) : (
            <>
              <div className="results-head addr-scope">{scope}</div>
              {rows.map(({ hit, archiveOnly }) => (
                <div key={hit.message.id} className="hit-w" data-hit={hit.message.id}>
                  <SearchHitRow
                    hit={hit}
                    now={now}
                    onOpen={onOpen}
                    archiveOnly={archiveOnly}
                    placeOf={placeOf}
                    here={address}
                  />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
