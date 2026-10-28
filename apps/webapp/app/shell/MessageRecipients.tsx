"use client";

/**
 * Who else got this message — one block, worn by every surface that shows a message header. One
 * CHIP per person, To and Cc each on its own line; Bcc does not render because the wire cannot
 * carry it. The FACE is the name alone (the decoded address when there is none), the address rides
 * the title and the popover; the VALUE under every chip is the stored wire address. The reader's
 * own chip says "you", first in its field, with the ACCOUNT's identity (`chrome.ownNameOf`) on its
 * title — never the sender's spelling of the reader.
 */

/**
 * `max` is a CAP PER FIELD, not a variant: omitted draws every chip, `max = N` draws the first N of
 * To and of Cc and folds each field's rest into its own count ("and 31 others") — the SAME control
 * as `details` (`.msg-rcpt-more`), one disclosure however mounted. The reading pane folds at three
 * (a letter to 34 people otherwise spent its first screen on names), a stream card at two. `ContactPopover` is `position: fixed` and
 * renders inside this block; `app.css` releases the OPEN card (`content-visibility: visible`),
 * which is why there is no portal — a portal would fix this component and leave the cause standing
 * for the next fixed descendant.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import type { EngineMessage } from "@ohmail/client-engine";
import type { BlockNotice } from "../components/BlockNotice";
import { ContactPopover, type ContactPopoverState } from "./ContactPopover";
import { recipientRows, writtenDateTime, writtenInstant, type RecipientRowChip } from "./format";
import { displayAddress } from "./idn";
import { useMessageChrome } from "./message-chrome";
import { placePicker } from "./TagPicker";

export function MessageRecipients({
  message,
  max,
  notice = null,
}: {
  message: EngineMessage;
  /**
   * WHAT THIS MESSAGE'S BODY HAD REFUSED, as the panel that mounts the body reports it. It arrives
   * HERE rather than staying in `MessageHeader` because the details `<dl>` moved into this
   * component with the rest of the recipients block: the glyph keeps the header's right cluster,
   * and the full sentence is printed by the disclosure that owns it. `null` — nothing refused, or
   * a caller with no report to make — renders nothing.
   */
  notice?: BlockNotice | null;
  /** How many chips per field to draw before the rest folds into a count. OMITTED ⇒ no cap. */
  max?: number;
}) {
  const tm = useTranslations("message");
  const to = useTranslations("ohbox");
  const chrome = useMessageChrome();
  const [details, setDetails] = useState(false);
  /** Folded names per field that fit their line whole, as measured for one message; null until a name is cut. */
  const [measured, setFit] = useState<{ id: string; to: number; cc: number } | null>(null);
  const fit = measured?.id === message.id ? measured : null;
  const block = useRef<HTMLDivElement | null>(null);
  /**
   * The open contact popover, or null — one per block, because one chip is pressed at a time
   * and a second press re-points it (the same one-question-at-a-time rule the ⋯ menu keeps).
   * The pressed chip element is held beside it so Escape can put the keyboard back where the
   * press came from, and so the screening sheet is anchored on the chip rather than nowhere.
   */
  const [contact, setContact] = useState<(ContactPopoverState & { key: string }) | null>(null);
  const contactAnchor = useRef<HTMLButtonElement | null>(null);
  /**
   * A message swap in the same mounted position (the single-message pane re-pointed by
   * selection, a stream card re-keyed) must not leave a popover open over a different
   * message's recipient — the same rule the header's ⋯ menu applies on `message.id`. The
   * FOLD resets with it: a reader who expanded one card's recipients has not asked to see
   * another's.
   */
  useEffect(() => { setContact(null); setDetails(false); }, [message.id]);
  const closeContact = (): void => {
    setContact(null);
    contactAnchor.current?.focus();
  };

  // `?? []` tolerates a bare test harness that predates the field; the real provider always
  // supplies it (default `[]`), so on every live path this is exactly `chrome.ownAddresses`.
  const ownAddresses = chrome.ownAddresses ?? [];
  const rows = recipientRows(message, ownAddresses);
  const abs = writtenDateTime(message);

  /**
   * The cap, normalised at the boundary — because `slice` reads a negative as "from the end".
   * `max` is a `number`, so a negative is type-valid, and `rows.to.slice(0, -1)` would drop the
   * LAST recipient and keep the rest — the exact inverse of "the first N", rendering a
   * plausible-looking block rather than failing (review found this; nothing in the product passes
   * a negative, which is precisely why it would go unnoticed). Clamped rather than thrown: this
   * runs in render, and taking down a message header over a caller's bad constant is worse than
   * showing every recipient. `Math.trunc` folds a fractional cap onto `slice`'s own rail. The floor
   * is one: a field of only a count ("To and 3 others") names nobody.
   */
  const cap = max === undefined ? undefined : Math.max(1, Math.trunc(max));
  /**
   * WHAT THE DISCLOSURE WILL ACTUALLY REVEAL — because the accessible name is a CLAIM.
   *
   * Both `<dd>`s below are conditional: `writtenDateTime` answers "" for a message with no `Date:`
   * header and no arrival (a routine production path — spam and scripts omit it, see `format.ts`), and
   * `physicalFolder` is optional on the wire. The name said "the exact date and where this
   * message sits" regardless, so on such a message a screen-reader user was promised two things
   * and given one, or none.
   */
  const hasDate = !!abs;
  const hasFolder = !!message.physicalFolder;
  /**
   * Folded exactly when a cap was asked for, the reader has not opened the disclosure, and a
   * field genuinely holds more than the cap. A cap at or above both fields therefore behaves as
   * no cap at all rather than drawing an honest-looking "and 0 others".
   */
  const capHolds = cap !== undefined && (rows.to.length > cap || rows.cc.length > cap);
  const folded = capHolds && !details;
  const room = { to: Math.min(cap ?? Infinity, fit?.to ?? Infinity), cc: Math.min(cap ?? Infinity, fit?.cc ?? Infinity) };
  const shownTo = folded ? rows.to.slice(0, room.to) : rows.to;
  const shownCc = folded ? rows.cc.slice(0, room.cc) : rows.cc;

  /* A folded field is one line: while a shown name is cut, hand one more to the count (never the
     last). A width change measures again from the cap. */
  useLayoutEffect(() => {
    if (!folded || !block.current) return;
    const next = { id: message.id, to: shownTo.length, cc: shownCc.length };
    let cut = false;
    for (const row of block.current.querySelectorAll<HTMLElement>(".rcpt-row")) {
      const field = row.dataset.field as "to" | "cc";
      const chips = [...row.querySelectorAll<HTMLElement>(".rcpt-chip")];
      if (next[field] > 1 && chips.some((c) => c.scrollWidth > c.clientWidth + 1)) { next[field] -= 1; cut = true; }
    }
    if (cut) setFit(next);
  });
  useEffect(() => {
    const el = block.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; setFit(null); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.empty]);

  /* The pressed count unmounts when the block opens (and `details` when it folds): focus the
     disclosure that replaced it, so the keyboard keeps its place. */
  const pressed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = pressed.current;
    pressed.current = null;
    if (was && !was.isConnected) block.current?.querySelector<HTMLElement>(".msg-rcpt-more")?.focus();
  }, [details]);

  const chipRow = (label: string, group: "to" | "cc", chips: RecipientRowChip[], all: number): ReactNode =>
    chips.length === 0 ? null : (
      <div className="rcpt-row" data-field={group}>
        <span className="rcpt-k">{label}</span>
        <span className="rcpt-names">
          {chips.map((r, i) => {
            const key = `${group}:${i}`;
            const own = r.me ? (chrome.ownNameOf?.(r.address) ?? null) : null;
            const face = r.me ? tm("you") : r.name;
            const shown = displayAddress(r.address);
            return (
              <button
                key={key}
                type="button"
                className={i < chips.length - 1 ? "rcpt-chip rcpt-comma" : "rcpt-chip"}
                title={own ? `${own} <${shown}>` : shown}
                aria-haspopup="menu"
                aria-expanded={contact?.key === key}
                onClick={(e) => {
                  /**
                   * The press must not also reach the card underneath. A stream card selects and
                   * EXPANDS on any click it receives (`StreamCard.expandOnClick`), so without this
                   * a chip press would open the popover and re-arrange the surface under it in the
                   * same tick. The reading pane has no such handler and is unaffected — this is
                   * the header ⋯ menu's own rule, applied to the chip that gained a second host.
                   */
                  e.stopPropagation();
                  contactAnchor.current = e.currentTarget;
                  /* A TRIGGER TOGGLES. Setting the state unconditionally re-opened the popover
                     an open chip was already showing; and once the chip is excluded from the
                     menu's outside-press listener (below, via `anchor`), nothing dismissed it at
                     all. The two halves sit on DIFFERENT events — the dismiss on `mousedown`, this
                     toggle on `click` — so a test that presses with `click` alone exercises only
                     one of them; see `test/reads-recipients.test.tsx`. */
                  if (contact?.key === key) { setContact(null); return; }
                  setContact({
                    key,
                    messageId: message.id,
                    address: r.address,
                    name: r.me ? own : r.name,
                    ...placePicker(e.currentTarget),
                  });
                }}
              >
                {face ? <span className="rcpt-name">{face}</span> : <span className="rcpt-addr">{shown}</span>}
              </button>
            );
          })}
          {all > chips.length
            ? disclosure(
                tm("moreRecipients", { count: all - chips.length }),
                tm("moreRecipientsAriaField", {
                  field: label,
                  names: chips.map((r) => (r.me ? tm("you") : r.name || displayAddress(r.address))).join(", "),
                  count: all - chips.length,
                  action: tm(ariaKey),
                }),
              )
            : null}
        </span>
      </div>
    );

  if (rows.empty) return null;
  /**
   * A DISCLOSURE WITH NOTHING BEHIND IT IS NOT RENDERED.
   *
   * No names held back, no date, no folder — pressing it would open an empty `<dl>`. That is
   * the dead control the header's own ⋯ menu refuses to be ("degrade by OMISSION, never a menu
   * of dead controls"), and it is the only state for which no honest name exists. The chips
   * still render; it is the press that goes away.
   */
  const canDisclose = capHolds || hasDate || hasFolder;
  /**
   * The name, chosen from what is genuinely behind the press. Whole strings per combination
   * rather than glued fragments: a German name is not an English one with its parts swapped,
   * and `detailsAria`/`moreRecipientsAria` keep their exact wording for the both-present case,
   * so the common path's copy has not moved.
   */
  const ariaKey = details
    ? "detailsHideAria"
    : folded
      ? hasDate && hasFolder
        ? "moreRecipientsAria"
        : hasDate
          ? "moreRecipientsAriaDate"
          : hasFolder
            ? "moreRecipientsAriaFolder"
            : "moreRecipientsAriaOnly"
      : hasDate && hasFolder
        ? "detailsAria"
        : hasDate
          ? "detailsAriaDate"
          : "detailsAriaFolder";

  /* What the chips do not already say: the exact date and where the message physically sits —
     and, where a cap is in force, the recipients it is holding back. One press, one disclosure:
     folded, each held-back field ends in its own count; otherwise one `details` closes the block. */
  function disclosure(face: string, name: string = tm(ariaKey)): ReactNode {
    return (
      <button
        type="button"
        className="msg-rcpt-more"
        aria-expanded={details}
        /* THE ACCESSIBLE NAME FOLLOWS THE STATE, because the next press is what it describes.
           Expanded, this control COLLAPSES — an accessible name reading "Show …" there
           tells a screen-reader user the opposite of what pressing it does, and it said
           exactly that in every expanded state before. The collapsed names are unchanged:
           A count's name leads with its field, names and count, so it holds the visible label. */
        aria-label={name}
        onClick={(e) => {
          e.stopPropagation();
          pressed.current = e.currentTarget;
          setDetails((v) => !v);
        }}
      >
        {face}{" "}
        <Icon name="chev" size={10} />
      </button>
    );
  }

  return (
    <>
      <div ref={block} className={folded ? "msg-rcpts is-folded" : "msg-rcpts"}>
        <div className="rcpt-groups">
          {chipRow(tm("toLabel"), "to", shownTo, rows.to.length)}
          {chipRow(tm("ccLabel"), "cc", shownCc, rows.cc.length)}
        </div>
        {canDisclose && !folded ? disclosure(tm("details")) : null}
      </div>
      {details && (abs || message.physicalFolder || notice) ? (
        <dl className="msg-rcpt-full">
          {abs ? (
            <div>
              <dd>
                <time dateTime={writtenInstant(message) ?? undefined}>{abs}</time>
              </dd>
            </div>
          ) : null}
          {message.physicalFolder ? (
            <div>
              <dd>{to("onServer", { folder: message.physicalFolder })}</dd>
            </div>
          ) : null}
          {/* The blocking disclosure IN FULL — the sentence the glyph above describes, said once
              more where a reader who opened "details" is already reading facts about this
              message. `.msg-rcpt-notice` is the tests' hook. */}
          {notice ? (
            <div>
              <dd className="msg-rcpt-notice">{notice.text}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {contact ? (
        <ContactPopover
          state={contact}
          /* THE CHIP IS THE TRIGGER, so the menu's outside-press dismiss must not count a press
             on it as "outside" — otherwise the listener closes on `mousedown` and the toggle
             above re-opens on the `click` that follows, and the chip can never close what it
             opened. `MoreMenu` reads this as `anchor?.contains(target)`. */
          anchor={contactAnchor.current}
          onWrite={
            chrome.writeTo
              ? () => chrome.writeTo!(contact.address, contact.name ?? undefined)
              : undefined
          }
          onScreen={
            chrome.screenAddress
              ? () => chrome.screenAddress!(message.id, contact.address, contactAnchor.current)
              : undefined
          }
          onClose={closeContact}
        />
      ) : null}
    </>
  );
}
