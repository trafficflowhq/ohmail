"use client";

/**
 * ONE PERSON OFF A MESSAGE HEADER — the popover a recipient chip opens (viewer redesign).
 *
 * Three verbs, and deliberately no more: **Copy address · Write · Screener settings.** The chip
 * names a person; this answers the three things a reader does with a person, and everything
 * heavier (destinations, scopes, rules) stays in the screening sheet the third verb opens.
 *
 * ── OMISSION, NEVER DEADNESS ────────────────────────────────────────────────────────────────
 *
 * Write and Screener settings appear exactly when the chrome wires them (`onWrite`/`onScreen`
 * present) — the INERT-CHROME RULE the header's ⋯ menu already follows. Copy is the one verb
 * with no machine behind it, so it is always offered; a popover with Copy alone is still a
 * popover, which is what keeps the chip honest as a disclosure on every surface.
 *
 * ── DISPLAY DECODES, THE VALUE DOES NOT ─────────────────────────────────────────────────────
 *
 * The head prints the readable address (`displayAddress` — an IDN domain decoded), while every
 * action acts on {@link ContactPopoverState.address} verbatim: Copy writes the STORED A-label
 * form to the clipboard, because what a person pastes into another client must be the wire
 * value. Same split, same reason, as everywhere `idn.ts` is consulted.
 *
 * ── POSITIONING AND DISMISS — the sender sheet's idiom, the menu's keyboard ─────────────────
 *
 * A fixed box placed from the pressed chip's rectangle (`placePicker`, exactly as
 * `SenderMenu`/`TagPicker` are placed) — the popover opens where the press was, in a scrolling
 * column. The items inside are the pill's own {@link MoreMenu}, which brings the whole keyboard
 * contract for free: focus lands on the first item, arrows rove, Escape and an outside
 * `mousedown` dismiss, and every claimed key is stopped before the shell's registry sees it.
 * The CALLER returns focus to the chip — it owns the button.
 */
import { useRef } from "react";
import { useTranslations } from "next-intl";
import { displayAddress, displayAddressee } from "./idn";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import { useOverlayClamp } from "./overlay-clamp";

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
  onWrite,
  onScreen,
  onClose,
}: {
  state: ContactPopoverState;
  /** Absent where the chrome wires no compose — the item is then OMITTED, never dead. */
  onWrite?: () => void;
  /** Absent where the chrome wires no screening — same rule. */
  onScreen?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("message");
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
    >
      <div className="cpop-head">
        <b>{label}</b>
        {state.name ? <small>{who}</small> : null}
      </div>
      <MoreMenu items={items} ariaLabel={t("contactAria", { who })} onClose={onClose} />
    </div>
  );
}
