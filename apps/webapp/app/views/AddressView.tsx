"use client";

/**
 * Everything from and to one address — `#/address/<addr>`: one list, newest first, with a direction toggle. It
 * consumes `shell/address-view.ts` and nothing else; that module's header explains why the halves are unequal (the
 * archive is searchable by SENDER only) — this file is what a person sees.
 */

/**
 * The anatomy: the header (name when any mail carries one, address beside it; a long address wraps at 390px); the
 * toggle (All · From them · To them, with live counts); the count line (device first — the number a reader can check
 * by counting — the archive slot filling in beside it, and on To them a NAMED line, never a number that would have to
 * be zero: "the archive cannot be searched by recipient yet", each caveat carrying a Gloss); the list
 * (`SearchHitRow`, a sent copy reading "Sent" via `placeLabel`); the empty state names the address in the direction's
 * own words, with the count line under it, so an empty list mid-answer never reads as an empty corpus.
 */

/**
 * Which rows the archive may add: it answers ONE direction (`from`), so its rows belong under All
 * and From them, never under To them — mail the address SENT listed as mail sent TO it is the false
 * claim the contract's header warns against. {@link archiveRowsBelong} is that rule, applied twice
 * on purpose (the contract holds rows back; this file applies the same rule to what it renders) and
 * a third time for the toggle's numbers, where it is the only thing deciding them. Keyboard: tab
 * order is the reading order; Escape leaves through `onExit` and is in the `?` sheet; `/` still
 * opens Search. Nothing binds `j`/`k` — those follow pile order by ruling, and this is not a pile.
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
   * the direction the archive answered. `view.items` cannot be read for this at all: under To them
   * the contract holds the archive's rows back entirely, so counting the marked rows there would
   * answer zero and each segment would show its device count alone. The device's rows for the
   * ANSWERED direction are therefore asked for directly (`messagesWith` is pure), which is the
   * same number whatever the toggle shows.
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
   * the plain arm takes over without a change to this file. The refusal arm is the only one that
   * carries a control — see it for why.
   */
  const deviceHalf = t("addressDevice", { count: view.counts[direction] });
  const archiveHalf =
    archive.state === "searching" ? (
      t("scopeSearching")
    ) : archive.state === "unavailable" ? (
      t("scopeNoArchive")
    ) : archive.state === "failed" ? (
      /* A refusal is the one archive state a reader can do something about, so it is the one
         that carries a control. `retry` hangs off the failed arm of the contract, so there is no
         way to render this button over a state that has nothing to ask again. A text button on
         the count line rather than a banner: the failure is about one half of one line, and a
         block above the list would claim the whole view had failed when the device's rows are
         right there. Search's own retry is the same control on the same line. */
      <>
        {t("scopeFailed", { reason: archive.error })}{" "}
        <button type="button" className="btn ghost" onClick={archive.retry}>
          {t("addressRetry")}
        </button>
      </>
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
