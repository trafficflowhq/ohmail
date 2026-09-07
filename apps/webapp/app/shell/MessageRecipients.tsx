"use client";

/**
 * WHO ELSE GOT THIS MESSAGE — one block, worn by every surface that shows a message header.
 *
 * This is the Ohbox's recipients line, lifted OUT of `MessageHeader` unchanged so a second
 * surface can wear it rather than spell it again. Nothing about the reading pane's face moved
 * in the lift: `MessageCard` mounts it with no `max`, which is the every-chip form this block
 * has had since the viewer redesign, and `test/contact-chips.test.tsx` still holds it to "no
 * fold, no +N, no count standing in for a person" there.
 *
 * ── THE CHIPS ───────────────────────────────────────────────────────────────────────────────
 *
 * To and Cc in full, one CHIP per person. (`Bcc` does not render because the wire does not
 * carry it: an incoming message's blind copies are, by definition, not in its headers, and
 * `EngineMessage` has no such field — a row for it would be a control over data that cannot
 * exist.)
 *
 * The FACE is names-first and decoded (`displayAddress`); the VALUE under every chip is the
 * stored wire address, which is what the popover's verbs dispatch. A "me" chip wears the
 * ACCOUNT's identity — `chrome.ownNameOf` (from `GET /mailboxes`' `displayName`), never the
 * sender's spelling of the reader — and falls back to the bare address when the mailbox
 * carries no label, because inventing a name is worse than omitting one.
 *
 * ── `max` — THE COUNT FORM, AND WHY IT IS A PROP AND NOT A VARIANT ──────────────────────────
 *
 * A reading pane has the room to name everyone and is the surface a reader opened in order to
 * read; a card in a scrolling stream is a summary, and three lines of chips in a 620px card
 * has stopped being one. So the block takes a CAP rather than a second spelling: `max`
 * omitted draws every chip (the reading pane, byte-for-byte as before), and `max = N` draws
 * the first N across To then Cc and folds the rest into a count.
 *
 * THE COUNT IS THE SAME CONTROL AS `details`, not a second one. `.msg-rcpt-more` already
 * exists, already carries `aria-expanded`, and already reveals what the chips do not say —
 * the exact date and where the message physically sits. Folding puts the remainder behind
 * that same press, so the block has one disclosure however it is mounted, and a reader who
 * presses it gets everything that was held back at once. A second "+N" button beside a
 * "details" button would be two doors onto one room.
 *
 * ── THE POPOVER AND `content-visibility` ────────────────────────────────────────────────────
 *
 * `ContactPopover` is `position: fixed` and renders INSIDE this block, so wherever this block
 * is mounted inside a layout-contained element the card becomes its containing block and the
 * popover lands at the card's offset instead of the viewport's. Reads and Receipts carry
 * `content-visibility: auto` on their mounted cards for exactly that reason, and `app.css`
 * releases the OPEN card (`.scast.open { content-visibility: visible }`) — which is the fix,
 * and is why there is no portal here. A portal would fix this component and leave the cause
 * standing for the next fixed descendant; the release covers every one of them.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";
import type { EngineMessage } from "@ohmail/client-engine";
import { ContactPopover, type ContactPopoverState } from "./ContactPopover";
import { fullDateTime, recipientRows, type RecipientRowChip } from "./format";
import { displayAddress } from "./idn";
import { useMessageChrome } from "./message-chrome";
import { placePicker } from "./TagPicker";

export function MessageRecipients({
  message,
  max,
}: {
  message: EngineMessage;
  /**
   * How many chips to draw before the rest folds into a count. OMITTED ⇒ no cap, which is the
   * reading pane's form: every recipient named, nothing standing in for a person.
   */
  max?: number;
}) {
  const tm = useTranslations("message");
  const to = useTranslations("ohbox");
  const chrome = useMessageChrome();
  const [details, setDetails] = useState(false);
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
  const abs = fullDateTime(message);

  const total = rows.to.length + rows.cc.length;
  /**
   * THE CAP, NORMALISED AT THE BOUNDARY — because `slice` reads a negative as "from the end".
   *
   * `max` is a `number`, so a negative is type-valid, and `rows.to.slice(0, -1)` would then
   * drop the LAST recipient and keep the rest — the exact inverse of "the first N", and it
   * would render a plausible-looking block rather than fail. Review found this; nothing in the
   * product passes a negative, which is precisely why it would have gone unnoticed.
   *
   * Clamped rather than thrown: this runs in render, and taking down a message header over a
   * caller's bad constant is a worse failure than showing every recipient. `Math.trunc` folds
   * a fractional cap onto the same rail, since `slice` would truncate it anyway and the fold
   * arithmetic below must agree with what `slice` actually did. `0` is a legitimate cap — every
   * name behind the count — and renders no chip rows rather than an empty one.
   */
  const cap = max === undefined ? undefined : Math.max(0, Math.trunc(max));
  /**
   * WHAT THE DISCLOSURE WILL ACTUALLY REVEAL — because the accessible name is a CLAIM.
   *
   * Both `<dd>`s below are conditional: `fullDateTime` answers "" for a message with no `Date:`
   * header (a routine production path — spam and scripts omit it, see `format.ts`), and
   * `physicalFolder` is optional on the wire. The name said "the exact date and where this
   * message sits" regardless, so on such a message a screen-reader user was promised two things
   * and given one, or none.
   */
  const hasDate = !!abs;
  const hasFolder = !!message.physicalFolder;
  /**
   * Folded exactly when a cap was asked for, the reader has not opened the disclosure, and
   * there is genuinely something the cap holds back. A cap at or above the total therefore
   * behaves as no cap at all rather than drawing an honest-looking "+0".
   */
  const folded = cap !== undefined && !details && total > cap;
  const shownTo = folded ? rows.to.slice(0, cap) : rows.to;
  const shownCc = folded ? rows.cc.slice(0, Math.max(0, cap! - rows.to.length)) : rows.cc;
  const hidden = total - (shownTo.length + shownCc.length);

  const chipRow = (label: string, group: "to" | "cc", chips: RecipientRowChip[]): ReactNode =>
    chips.length === 0 ? null : (
      <div className="rcpt-row">
        <span className="rcpt-k">{label}</span>
        {chips.map((r, i) => {
          const key = `${group}:${i}`;
          const face = r.me ? (chrome.ownNameOf?.(r.address) ?? null) : r.name;
          const shown = displayAddress(r.address);
          return (
            <button
              key={key}
              type="button"
              className="rcpt-chip"
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
                  name: face,
                  ...placePicker(e.currentTarget),
                });
              }}
            >
              {face ? (
                <>
                  <span className="rcpt-name">{face}</span>
                  {" – "}
                  <span className="rcpt-addr">{shown}</span>
                </>
              ) : (
                <span className="rcpt-addr">{shown}</span>
              )}
            </button>
          );
        })}
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
  const canDisclose = folded || hasDate || hasFolder;
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


  return (
    <>
      <div className="msg-rcpts">
        {chipRow(tm("toLabel"), "to", shownTo)}
        {chipRow(tm("ccLabel"), "cc", shownCc)}
        {/* What the chips do not already say: the exact date and where the message physically
            sits — and, where a cap is in force, the recipients it is holding back. One press,
            one disclosure; the label names whichever of the two is the reason to press it. */}
        {canDisclose ? (
        <button
          type="button"
          className="msg-rcpt-more"
          aria-expanded={details}
          /* THE ACCESSIBLE NAME FOLLOWS THE STATE, because the next press is what it describes.
             Expanded, this control COLLAPSES — an accessible name reading "Show …" there
             tells a screen-reader user the opposite of what pressing it does, and it said
             exactly that in every expanded state before. The collapsed names are unchanged:
             `+N more` where a cap is holding names back, `details` where it is not. */
          aria-label={tm(ariaKey)}
          onClick={(e) => {
            e.stopPropagation();
            setDetails((v) => !v);
          }}
        >
          {folded ? tm("moreRecipients", { count: hidden }) : tm("details")}{" "}
          <Icon name="chev" size={10} />
        </button>
        ) : null}
      </div>
      {details ? (
        <dl className="msg-rcpt-full">
          {abs ? (
            <div>
              <dd>
                <time dateTime={message.date ?? undefined}>{abs}</time>
              </dd>
            </div>
          ) : null}
          {message.physicalFolder ? (
            <div>
              <dd>{to("onServer", { folder: message.physicalFolder })}</dd>
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
