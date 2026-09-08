import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Icon } from "../icons.js";
import "./gloss.css";

/**
 * Where the gloss stands. The glyph is sized to sit on the line it explains, not to the (i)'s own
 * idea of a comfortable size — a 15px mark in an 11.5px meta line reads as a button, not a note.
 *
 *   meta    inline in a meta line (a card's date · sender · state line). 13px glyph.
 *   chip    beside a chip or a short label. 14px glyph, centred on the chip's cap height.
 *   figure  beside a number or a figure's caption ("2 000 credits"). The 15px base glyph.
 */
export type GlossPlacement = "meta" | "chip" | "figure";

export interface GlossProps {
  /**
   * THE WHOLE SENTENCE, in the mechanism's own words. It is the trigger's accessible NAME when
   * there is no caption, and its accessible DESCRIPTION when there is one — a reader who never
   * sees the card gets exactly what a reader who opens it gets.
   */
  text: string;
  /**
   * A visible caption before the glyph — the meta-line form ("Tracker blocked"). When given, the
   * caption is what the trigger is CALLED and `text` is what it explains.
   */
  caption?: ReactNode;
  placement?: GlossPlacement;
  className?: string;
}

/** The card's inset from the window's edges and its gap from the glyph — one pair, tested. */
export const GLOSS_EDGE = 8;
export const GLOSS_GAP = 6;

export interface GlossPosition { top: number; left: number; side: "below" | "above" }

/**
 * Place the card by three rectangles — the glyph's, the card's own size, the window — the same
 * pure function the date picker uses for its month, so the flip is tested with real numbers.
 *
 * Below the glyph when the whole card fits there; above it otherwise; and if it fits neither way
 * (a very short window) below. Then BOTH axes are clamped to the window's insets — the promise is
 * "inside the window", never a side, and it holds even for an anchor that is itself off-screen
 * (a glyph pressed by script, or one the layout has just moved): a card that follows its anchor
 * out of the window is unreadable by construction. Left edge starts a little before the glyph so
 * the text lines up with the line it explains.
 */
export function placeGloss(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): GlossPosition {
  const below = anchor.bottom + GLOSS_GAP;
  const above = anchor.top - GLOSS_GAP - size.height;
  const fitsBelow = below + size.height + GLOSS_EDGE <= viewport.height;
  const fitsAbove = above >= GLOSS_EDGE;
  const side: GlossPosition["side"] = fitsBelow || !fitsAbove ? "below" : "above";
  const clamp = (v: number, max: number): number => Math.max(GLOSS_EDGE, Math.min(v, max));
  const top = clamp(side === "below" ? below : above, viewport.height - size.height - GLOSS_EDGE);
  const left = clamp(anchor.left - GLOSS_EDGE, viewport.width - size.width - GLOSS_EDGE);
  return { top, left, side };
}

/**
 * DETAIL ON DEMAND — the (i) whose sentence opens beside it.
 *
 * Several surfaces carry a sentence a person needs ONCE and then reads past for ever: what "this
 * computer files this mailbox" means, repeated under every mailbox row; what a credit buys, beside
 * the number; that a tracking pixel was refused, above a message it has nothing to do with. Each
 * was spending a line of the surface on a fact that is true and rarely wanted. The gloss keeps the
 * fact and stops spending the line: a small glyph (or a short caption) stands where the sentence
 * stood, and the sentence opens beside it when asked.
 *
 * It is the second (i) in this system and the difference from `InfoNote` is where the words go
 * when they open. `InfoNote` opens IN THE FLOW under its lead — right for a settings note or a
 * view's description, where a line of room exists. The gloss opens in a card OVER the surface —
 * for a meta line, a chip, a figure, where there is no room for a second line and pushing the
 * rows down would be the disturbance being removed.
 *
 * ── NEVER A TOOLTIP ──────────────────────────────────────────────────────────────────────────
 *
 * A hover-only affordance does not exist for a finger or for a keyboard. So the trigger is a real
 * button: hover opens it (mouse only — a touch's pointerenter is the tap itself and would cancel
 * the press that follows), focus opens it, a press PINS it, Escape closes it and keeps focus where
 * it was, a press outside closes it, a second press closes it. Nothing inside the card takes focus,
 * so there is nothing to trap: Tab leaves as it always did and the card goes with the focus.
 *
 * Two kinds of open, deliberately: `soft` (hover, focus) follows the pointer and the focus away;
 * `pinned` (a press) stays until Escape, an outside press, blur or a second press. A mouse press
 * therefore reads: focus opens it, the click pins it, the pointer may leave and it stands.
 *
 * The card is `position: fixed` and placed by {@link placeGloss} from the glyph's rectangle, so a
 * scroll container's `overflow: hidden` cannot clip it; it is re-placed on resize and on any
 * scroll while open. It is in the DOM closed as well as open (`hidden`), because the accessible
 * description has to be computable BEFORE it opens — a description that appears on focus is one
 * the reader asks for and does not get.
 */
export function Gloss({ text, caption, placement = "meta", className }: GlossProps) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [soft, setSoft] = useState(false);
  const open = pinned || soft;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<GlossPosition | null>(null);

  const closeAll = useCallback(() => {
    setPinned(false);
    setSoft(false);
  }, []);

  /* Placed after layout, when the card has a size; re-placed while open on resize and on scroll
     anywhere (capture, so an inner scroller's scroll reaches it). */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = (): void => {
      const a = triggerRef.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (!a || !card) return;
      setPos(placeGloss(a, { width: card.offsetWidth, height: card.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  /* An outside press closes it. Capture phase, so a press on something that stops propagation
     (a row, a button) still counts as "outside". */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) closeAll();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, closeAll]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== "Escape" || !open) return;
    /* Handled and stopped here — the gloss is the innermost open thing, so the shell's Escape
       ladder must not also act on the same key. Native `stopImmediatePropagation` as well as the
       synthetic stop, because the keymap registry listens natively beside React. */
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    closeAll();
  };
  const mouseOnly = (fn: () => void) => (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === "mouse") fn();
  };

  const cls = ["gloss", `gloss-${placement}`, open ? "open" : null, className].filter(Boolean).join(" ");
  return (
    <span ref={rootRef} className={cls}>
      <button
        ref={triggerRef}
        type="button"
        className="gloss-t"
        aria-expanded={open}
        aria-label={caption ? undefined : text}
        aria-describedby={caption ? id : undefined}
        onPointerEnter={mouseOnly(() => setSoft(true))}
        onPointerLeave={mouseOnly(() => setSoft(false))}
        onFocus={() => setSoft(true)}
        onBlur={closeAll}
        onClick={() => {
          if (pinned) closeAll();
          else setPinned(true);
        }}
        onKeyDown={onKeyDown}
      >
        {caption ? <span className="gloss-cap">{caption}</span> : null}
        <Icon name="info" className="gloss-i" />
      </button>
      {/* With a caption the card IS the description (`role="tooltip"`, referenced above). Without
          one the sentence is already the trigger's name, and the card is its visual echo — hidden
          from the tree so nothing is read twice. */}
      <span
        ref={cardRef}
        id={id}
        role={caption ? "tooltip" : undefined}
        aria-hidden={caption ? undefined : true}
        hidden={!open}
        className="gloss-pop"
        data-side={pos?.side}
        style={pos ? { top: pos.top, left: pos.left } : undefined}
      >
        {text}
      </span>
    </span>
  );
}
