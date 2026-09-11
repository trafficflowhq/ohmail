"use client";

/**
 * One person off a message header — the popover a recipient chip opens. Three verbs, deliberately
 * no more: Copy address · Write · Screener settings; everything heavier stays in the screening
 * sheet the third verb opens. Omission, never deadness: Write and Screener settings appear exactly
 * when the chrome wires them; Copy has no machine behind it and is always offered. Display
 * decodes, the value does not: the head prints `displayAddress` (IDN decoded) while every action
 * acts on {@link ContactPopoverState.address} verbatim — what a person pastes into another client
 * must be the wire value (`idn.ts`). Placed like the sender sheet (`placePicker`); the items are
 * the pill's own {@link MoreMenu} with its keyboard contract; the CALLER returns focus to the chip.
 */
import { useRef } from "react";
import { useTranslations } from "next-intl";
import { displayAddress, displayAddressee } from "./idn";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import { useOverlayClamp } from "./overlay-clamp";
import { goAddress } from "./routing";

export interface ContactPopoverState {
  /** The message the chip sits on — the screening sheet's anchor into the mirror. */
  messageId: string;
  /** The STORED wire address. Decoded only for the face; every action dispatches this. */
  address: string;
  /** The display name as the message wrote it (or the account's own, for a "me" chip). */
  name: string | null;
  x: number;
  y: number;
  /** The anchor's edges, for the viewport clamp — see `overlay-clamp.ts`. */
  anchorTop?: number;
  anchorBottom?: number;
}

export function ContactPopover({
  state,
  anchor,
  onWrite,
  onScreen,
  onClose,
}: {
  state: ContactPopoverState;
  /**
   * The chip that opened this, as an element rather than two numbers. The edges below place the
   * popover; this is for the menu inside it, whose dismissal listener asks whether a press landed
   * outside itself. The chip is outside the MENU, so without this a press on the open chip ran
   * both halves of one gesture — `mousedown` closed the popover, the following `click` reopened it
   * — and the control could not be dismissed by pressing the thing that opened it. `anchor={null}`
   * was passed here deliberately and the reasoning was wrong: the menu being the popover's whole
   * content says nothing about whether the CHIP is a trigger, and it is one.
   */
  anchor?: HTMLElement | null;
  /** Absent where the chrome wires no compose — the item is then OMITTED, never dead. */
  onWrite?: () => void;
  /** Absent where the chrome wires no screening — same rule. */
  onScreen?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("message");
  /* The address view's row shares its ONE sentence with the screening sheet's row — the same
     words wherever the same page is offered, so `screening` is read for that one key. */
  const ts = useTranslations("screening");
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * THE VIEWPORT CLAMP. A chip on the LAST message of a thread — the default reading
   * position — anchors this popover near the fold, where the fixed downward placement clipped
   * it. Same rule as the sender sheet: flip, cap, scroll — never clip. See `overlay-clamp.ts`.
   */
  const style = useOverlayClamp(rootRef, state);
  const label = displayAddressee(state.name, state.address);
  const who = displayAddress(state.address);

  const items: MoreMenuItem[] = [
    {
      id: "copy",
      label: t("copyAddress"),
      run: () => {
        // The WIRE form, not the face: a decoded domain pasted into another client is an
        // address that resolves nowhere. Fire-and-forget — a refused clipboard (no permission,
        // no focus) must not strand an open popover.
        void navigator.clipboard?.writeText(state.address);
        onClose();
      },
    },
    /**
     * EVERYTHING FROM AND TO THIS ADDRESS — `#/address/<addr>`. Always offered, like Copy: it has no
     * machine behind it that a host could fail to wire. The hash router is the shell's own, so a
     * hash assignment (`goAddress`, the one spelling every address control shares) IS the
     * navigation. A chip is a person; this is the fourth thing a reader does with one — see all
     * the mail between us — and it sits after the address itself, before the acts of writing and
     * screening. The chip's own pixels stay the popover's trigger: `senderHitOf` answers null
     * here, and the popover is the chip's existing door, so the view is one verb in it rather
     * than a second click target laid over a control that already has one.
     */
    { id: "address", label: ts("addressOpen"), run: () => { onClose(); goAddress(state.address); } },
    ...(onWrite
      ? [{ id: "write", label: t("write"), run: () => { onClose(); onWrite(); } }]
      : []),
    ...(onScreen
      ? [{ id: "screen", label: t("screenerSettings"), run: () => { onClose(); onScreen(); } }]
      : []),
  ];

  return (
    <div
      ref={rootRef}
      className="cpop"
      role="dialog"
      aria-label={t("contactAria", { who })}
      style={style}
      /* THE PRESS STOPS AT THE POPOVER. On the reading pane nothing sits under this; in a
         reading-stream card the popover is a DOM descendant of an `<article>` that selects
         and EXPANDS on any click it receives (`StreamCard.expandOnClick`), so pressing Copy
         would also open the card underneath the popover. One handler on the root rather than
         three on the items: it covers the head, and it covers whatever item is added next.
         Same rule, same reason, as `.sc-actions` in `StreamCard`. */
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cpop-head">
        <b>{label}</b>
        {state.name ? <small>{who}</small> : null}
      </div>
      {/* THE CHIP IS EXCLUDED, for the reason written at the `anchor` prop: it is the trigger,
          whatever the menu is, and a trigger that is not excluded cannot dismiss what it opened. */}
      <MoreMenu items={items} ariaLabel={t("contactAria", { who })} anchor={anchor ?? null} onClose={onClose} />
    </div>
  );
}
