import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../icons.js";
import { Badge } from "../primitives/Chip.js";
import { estimateCardHeight, estimateClipReserve } from "./stream-estimate.js";
import { pageEnds } from "../format/long-text.js";
import "./stream.css";

const SC_CLAMP = 348;

export interface StreamCardProps {
  /** Stable id, stamped as data-sid (used by useSeenOnScroll + scroll-spy). */
  id: string;
  from: string;
  address?: string;
  /** Receipts: the amount beside the sender. */
  amount?: string;
  time: string;
  /**
   * A fact about the message, said in the meta line between sender and
   * time. What the reading pane says as a bar ("A tracking pixel was
   * blocked.") a card says as a glyph whose sentence opens on demand.
   * A slot, not a shape: the app owns the words and the primitive
   * (`BlockNotice` over `Gloss`); this file decides only where the node
   * stands and what it inherits — the time's size and ink, never the
   * accent. A press on it does not select or expand the card.
   * Default-absent: pass nothing and the card is unchanged.
   */
  notice?: ReactNode;
  subject: string;
  /**
   * Body text (white-space: pre-line). A "[[img]]" marker splits the
   * body around the inline `art` node.
   */
  body: string;
  /** Inline figure rendered at the [[img]] marker. */
  art?: ReactNode;
  /**
   * Stamps `data-unseen` for the seen-on-scroll observer — and DRAWS NOTHING.
   *
   * The reading streams carry no per-card unread status: newness is a card's position
   * relative to the waterline, so the dot this used to render is gone. The attribute
   * stays because the observer is the eventual `\Seen` sweep and selects on it —
   * read-state still flows to the user's own IMAP server; it just is not card chrome.
   */
  unread?: boolean;
  /** Scroll-spy current card — raised to lift-2. */
  current?: boolean;
  /** Clamp height in px; the card only clamps if meaningfully taller. */
  clampHeight?: number;
  expandLabel: string;
  collapseLabel: string;
  /**
   * What `body` is. Omitted ⇒ "full", the shape every existing caller
   * had. It lives here because it changes the card's own measurement:
   * `short` is computed from `scrollHeight`, so a card holding a one-line
   * snippet measured short, `.scast.short .sc-x{display:none}` hid the
   * Expand pill, and there was no way left to ask for the rest. Anything
   * other than "full" keeps the pill reachable however short the text is,
   * because the text being short is precisely the symptom.
   */
  bodyState?: "full" | "snippet" | "loading" | "failed" | "withheld";
  /** Shown in place of the body while it is being fetched. App-owned copy. */
  loadingLabel?: string;
  /**
   * The press for the next page of a body longer than one page (`BODY_PAGE_CHARS`), given the
   * percent shown. App-owned copy. Absent, an open card still draws one page and no press.
   */
  moreLabel?: (percentShown: number) => string;
  /** Shown when the fetch failed — distinct from "this is the whole message". */
  failedLabel?: string;
  /**
   * Shown when the server holds NO content for this message (the account's storage space was
   * full when it arrived). TERMINAL, unlike the two above: expanding fetches nothing more, so
   * `withheld` does not keep the pill reachable the way `pending` states do — the preview plus
   * this sentence IS the whole of what this card can show. App-owned copy.
   */
  withheldLabel?: string;
  /**
   * The rendered message, swapped in for the plain-text preview once the
   * card is open. Omitted ⇒ text-only, as before. Present, it renders only
   * while expanded: the collapsed card keeps the fast clamp-measured
   * `body` preview; expanding lifts the clamp and drops in this node (the
   * same sanitized html viewer the reading pane uses). A plain-text
   * message passes no slot. The viewer sizes itself (an iframe measured
   * to its own content), so the measuring effect and the clamp step aside
   * for it — see `showViewer` below.
   */
  bodySlot?: ReactNode;
  /**
   * THE MESSAGE'S FILES, under the body — drawn only while the card is OPEN, so a stream of two
   * hundred collapsed cards mounts no strip and asks for no list; opening the card is the ask.
   * A slot: the app passes its own strip, which holds its own list. Default-absent.
   */
  files?: ReactNode;
  onSelect?: (id: string) => void;
  /**
   * Called after the expand state flips (collapse-keeping-in-view etc.).
   *
   * `open: true` is also the point at which a caller should hydrate: a card that has only a
   * snippet is expanded FIRST and filled afterwards, because the body is what the expand was
   * asking for.
   */
  onToggle?: (open: boolean) => void;
  /**
   * Who else the message went to, under the subject. A slot, not a shape:
   * the reading pane already has a recipients block with chips, popover
   * and disclosure, and a composite re-describing it would be a second
   * copy drifting from the first. The caller passes the app's own
   * `MessageRecipients`; this file decides only where it sits.
   * Default-absent — a one-recipient message withholds the node rather
   * than the card drawing an empty row.
   */
  recipients?: ReactNode;
  /**
   * WHICH OF THE ACCOUNT'S MAILBOXES THE MESSAGE WAS DELIVERED TO — a face on the card's own line,
   * drawn only where the host hands one over (it decides; a single-mailbox account gets none).
   * A separate node from {@link StreamCardProps.recipients}, which answers a different question
   * from a different source: who else was addressed, off the headers. {@link mailboxTitle} carries
   * the sentence. Strings and not a slot, because the card's comparator keys on primitives.
   */
  mailbox?: string;
  /** The delivery badge's whole phrase ("Delivered to Work") — its hover title. */
  mailboxTitle?: string;
  /**
   * THE COLUMN WIDTH EVERY CARD IN THIS STREAM SHARES, measured ONCE by the stream.
   *
   * The height estimate below is a function of it, and the card used to read its own
   * `offsetWidth` in a layout effect — one forced layout per card, after the previous card's
   * effect had written a style, so sixty mounted cards cost sixty full layouts of the document,
   * and most of a switch into a stream went on them. Absent (or 0) keeps the documented fallback:
   * a card whose width nobody measured reserves {@link STREAM_CARD_FALLBACK_PX}, which is what
   * jsdom has always got.
   */
  estWidthPx?: number;
  /**
   * THE MESSAGE'S VERBS, at the foot of the card.
   *
   * Optional and default-absent: a card with no bar is exactly the card that shipped before.
   * The caller decides WHICH card gets one — in practice the current one, so a stream of two
   * hundred cards renders one bar and not two hundred — and the caller decides what is IN it,
   * because a composite that named the verbs would be a second, drifting copy of the reading
   * pane's. `.msg-actions` is the host class the bar's own container queries measure, so the
   * node passed here behaves as it does everywhere else in the product.
   */
  actions?: ReactNode;
}

/**
 * A clamped reading-stream card: light falloff instead of a border, the
 * single functional fade gradient over the clamp, and an expand pill
 * whose chevron turns with aria-expanded.
 */
export function StreamCard({
  id,
  from,
  address,
  amount,
  time,
  notice,
  subject,
  body: bodyIn,
  art,
  unread,
  current,
  clampHeight = SC_CLAMP,
  expandLabel,
  collapseLabel,
  bodyState = "full",
  loadingLabel,
  moreLabel,
  failedLabel,
  withheldLabel,
  bodySlot,
  files,
  onSelect,
  onToggle,
  recipients,
  mailbox,
  mailboxTitle,
  estWidthPx,
  actions,
}: StreamCardProps) {
  /* A message with no text part pages as an empty one: `pageEnds` and the slice below read its length. */
  const body = bodyIn ?? "";
  const [open, setOpen] = useState(false);
  const [short, setShort] = useState(false);
  /* A page at a time, keyed on the body like the reader's: a 2 MiB text drawn whole held the window. */
  const [paged, setPaged] = useState<{ body: string; pages: number }>({ body, pages: 1 });
  const pages = paged.body === body ? paged.pages : 1;
  const ends = pageEnds(body, pages);
  const shownEnd = ends[ends.length - 1] ?? 0;
  const shown = body.slice(0, shownEnd);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  /**
   * A card that renders the html viewer, in EITHER state. It renders collapsed too — clamped
   * at the same 348 with the fade and pill on — so the stream is a uniform height however tall
   * the mail is; `.scast.viewer.open` in `stream.css` unclamps it. A text-only card (no slot)
   * is untouched. Named `showViewer` because it is what keys the measurement effect below.
   */
  const showViewer = bodySlot != null;
  /**
   * THE PILL AND THE FADE ARE ONE CONDITION: THE CLIP OVERFLOWS. `short` hides both
   * (`.scast.short` in `stream.css`). For the text preview it is measured in the layout effect
   * below; for the rendered viewer, which sizes itself after it mounts, it is `viewerFits`,
   * re-read whenever the viewer's box changes. A viewer that fits opens from its head like any
   * card; one that does not is cut at the clamp with the fade and the pill under the cut.
   */
  const [viewerFits, setViewerFits] = useState(false);
  const isShort = showViewer ? viewerFits : short;

  // Clamp decisions need real layout — measure only once the card is
  // actually visible (offsetHeight > 0), like the prototype.
  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    /**
     * A viewer card is not measured HERE: the iframe sizes itself after this
     * runs, so its fit is `viewerFits` (the effect below), and its clamp states
     * are CSS (collapsed at most 348, `.scast.viewer.open` unclamped). JS only clears any inline
     * `max-height` pin a text-phase toggle left on the clip — including
     * the snippet-height pin of a card expanded before its body hydrated,
     * which would otherwise beat the CSS and clip the viewer at two
     * lines. Registering the pinned start first lets `max-height`
     * transition on collapse; this branch also runs under jsdom.
     */
    if (showViewer) {
      void clip.offsetHeight;
      clip.style.maxHeight = "";
      return;
    }
    const card = cardRef.current;
    if (!card || card.offsetHeight === 0) return;
    setShort(clip.scrollHeight <= clampHeight + 28); // no point clamping a few lines
    /**
     * RE-PIN AN OPEN TEXT CARD WHEN ITS CONTENT CHANGES.
     *
     * `toggle` opens by pinning `max-height` to the content height MEASURED AT THAT MOMENT.
     * Before hydration that moment holds a two-line snippet, so an expand-then-fill card
     * would clip the fetched body at the snippet's height — the pill would work, the request
     * would succeed, and the mail would still be one line. `scrollHeight` ignores the
     * constraint, so re-reading it here is enough. (A card that hydrated into a `bodySlot`
     * took the viewer branch above and unclamps in CSS instead.)
     */
    if (open) clip.style.maxHeight = `${clip.scrollHeight}px`;
  }, [clampHeight, shown, open, showViewer]);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!showViewer || !clip) return;
    // The clip's own threshold: `.scast.viewer:not(.open) .sc-clip{max-height:348px}` cuts anything
    // taller, so a card is short only where nothing is cut (no 28px tolerance here, unlike text).
    const read = () => setViewerFits(clip.scrollHeight > 0 && clip.scrollHeight <= clampHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    for (const el of clip.children) ro.observe(el);
    return () => ro.disconnect();
  }, [showViewer, clampHeight]);

  /**
   * THE BODY IS NOT (YET) THE WHOLE MESSAGE.
   *
   * `short` is a fact about the text on screen; this is a fact about whether that text is
   * the mail. They come apart wherever a snippet is short AND incomplete at once — and the
   * card must keep its affordance in that case rather than concluding from the height that
   * there is nothing more to show. `.pend` in `stream.css` re-enables the pill
   * and drops the fade for a card that is both short and pending.
   */
  // `withheld` is deliberately NOT pending: pending keeps the Expand pill reachable because
  // expanding is how the rest gets fetched, and for a withheld body there is no rest to fetch —
  // the server answered, and the answer is the sentence below.
  const pending = bodyState !== "full" && bodyState !== "withheld";
  const note = bodyState === "loading" ? loadingLabel
    : bodyState === "failed" ? failedLabel
    : bodyState === "withheld" ? withheldLabel
    : null;

  /**
   * WHAT THIS CARD RESERVES WHILE IT HAS NO CONTENTS: `.view-reads .stream .scast` is `content-visibility: auto`, so
   * a mounted card the reader has never approached is a BOX with nothing in it, and `contain-intrinsic-size` decides
   * how tall that box is. It used to be one number for every card — 200px — and a card that turns out to be 650 moves
   * everything below it by 450 the moment the browser lays it out. If the reader is mid-scroll at that moment, the
   * content under the viewport moves with it, which is the jump. The value is written as a custom property rather
   * than as `contain-intrinsic-size` itself so the property that reads it stays in the stylesheet beside the
   * containment rule that needs it, and so a card in a surface that does NOT contain (the reader, a test) is
   * unaffected.
   */

  /**
   * WHAT THIS CARD RESERVES, WORKED OUT IN THE RENDER AND WRITTEN WITH THE REST OF ITS STYLE.
   *
   * It used to be a layout effect that read this card's own `offsetWidth` and then wrote the
   * property — a read after the previous card's write, so each of the sixty cards a stream mounts
   * forced a full layout of the document. The width is the same for every card in a column, so the
   * stream measures it once and hands it down ({@link StreamCardProps.estWidthPx}); the value is
   * the same value, and the layout the browser now does once.
   */
  const est = estimateCardHeight({
    width: estWidthPx ?? 0,
    subject,
    preview: shown,
    recipients: recipients != null,
    pill: !(isShort && !pending),
    /* The pill's 44px touch size is a `max-width: 640px` media query, which is a fact about
       the WINDOW rather than about the card — so it is read here and passed in. */
    touch: typeof window !== "undefined" && window.innerWidth <= 640,
    /* A card whose body is fetched rather than synced lays out CLAMPED, because `onNear`
       hydrates it as it approaches — see `clamped`. `showViewer` is the arrived case and
       `pending` the one on its way; a card carrying its whole body inline is neither. */
    clamped: showViewer || pending,
  });

  /**
   * FOCUS FOLLOWS A KEYBOARD OPEN OF A SHORT CARD. Its pill is removed on the open card, so the
   * press that opened it hands focus to the card's first verb (Reply) once the caller has mounted
   * the bar — it arrives on a later render, keyed on the open state the toggle reports.
   */
  const focusVerbs = useRef(false);
  useLayoutEffect(() => {
    if (!focusVerbs.current || !open) return;
    const first = cardRef.current?.querySelector<HTMLElement>(".sc-actions button:not([disabled])");
    if (!first) return;
    focusVerbs.current = false;
    first.focus();
  }, [open, actions]);

  const toggle = () => {
    const clip = clipRef.current;
    // `short` alone used to gate this, so a pill made reachable by `pending` would have been
    // a button that did nothing when clicked. A SHORT card opens through it too: its pill is drawn
    // only under keyboard focus (stream.css), and the stream's Enter presses it — a card whose mail
    // fits still has verbs and files that only the open card mounts. A short card a click OPENED
    // closes through it: that press is the stream's controlled close (Back out of a reading).
    const next = !open;
    if (clip) {
      if (showViewer) {
        // The `open` class flip is what changes a viewer's CSS clamp target, and it lands on
        // the NEXT render — so pin the current height as the animation's start and let the
        // layout effect clear it AFTER the flip. Clearing here (the text path below) would run
        // against the pre-flip class and animate nothing: the collapse-doesn't-animate defect.
        clip.style.maxHeight = `${clip.scrollHeight}px`;
      } else if (next) {
        clip.style.maxHeight = `${clip.scrollHeight}px`;
      } else {
        clip.style.maxHeight = `${clip.scrollHeight}px`;
        void clip.offsetHeight;
        clip.style.maxHeight = "";
      }
    }
    setOpen(next);
    onToggle?.(next);
  };

  /**
   * A CLICK ANYWHERE ON THE CARD SELECTS AND EXPANDS IT. The reply bar is gated by the caller on the EXPANDED card,
   * not on the scroll-spy's `current` — so a bar must never appear on a card the reader merely scrolled past. Opening
   * on click is the other half of that contract: a plain click is how a reader engages a card, and engaging it is
   * what surfaces its verbs. Only ever OPENS (the pill still toggles both ways); clicking an already-open card just
   * re-selects. It opens even a card with nothing more to reveal — a short, fully-loaded one — because the point is
   * the engagement, not the extra text: the visual expand is a no-op there and the bar is what changes. The expand
   * pill and the action bar both `stopPropagation`, so neither reaches this.
   */
  const expandOnClick = () => {
    if (open) return;
    const clip = clipRef.current;
    if (clip) clip.style.maxHeight = `${clip.scrollHeight}px`;
    setOpen(true);
    onToggle?.(true);
  };

  const chunks = shown.split("[[img]]");
  const cls = [
    "scast",
    isShort ? "short" : null,
    pending ? "pend" : null,
    open ? "open" : null,
    showViewer ? "viewer" : null,
    current ? "cur" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      ref={cardRef}
      className={cls}
      /* `contain-intrinsic-size: auto var(--sc-est, 200px)` in `app.css` reads this. */
      style={
        (pending
          ? { "--sc-est": `${est}px`, "--sc-reserve": `${estimateClipReserve(estWidthPx ?? 0, shown)}px` }
          : { "--sc-est": `${est}px` }) as unknown as CSSProperties
      }
      data-sid={id}
      data-unseen={unread ? "1" : undefined}
      onClick={() => {
        onSelect?.(id);
        expandOnClick();
      }}
    >
      <div className="sc-head">
        <div className="sc-line">
          <b>{from}</b>
          {address ? <span className="addr"><span>{address}</span></span> : null}
          {amount ? <span className="amt num">{amount}</span> : null}
          {/* The delivery mailbox, beside the sender it arrived from — the head's one place for
              "whose mail is this", so the eye reads sender and recipient in one pass. */}
          {mailbox ? (
            <Badge variant="place" className="sc-place" title={mailboxTitle}>
              {mailbox}
            </Badge>
          ) : null}
          {/* Before the time, so the date keeps the corner the eye expects it in and the notice
              leads into it. `onClick` stops here: asking what the glyph means must not also select
              and open the card underneath it. */}
          {notice ? (
            <span className="sc-notice" onClick={(e) => e.stopPropagation()}>
              {notice}
            </span>
          ) : null}
          <span className="t num">{time}</span>
        </div>
        <h3>{subject}</h3>
        {/* Under the subject, inside the head's padding — the same order the reading pane
            keeps (sender, subject, then who else), so a card and a panel read alike. */}
        {recipients ? <div className="sc-rcpts">{recipients}</div> : null}
        {/* The delivered-to chip's home on a card under 600px, where the line has no room for it:
            drawn on the OPEN card only (stream.css), so the collapsed skim carries the name. */}
        {mailbox ? (
          <div className="sc-place-alt">
            <Badge variant="place" title={mailboxTitle}>
              {mailboxTitle ?? mailbox}
            </Badge>
          </div>
        ) : null}
      </div>
      <div className="sc-clip" ref={clipRef}>
        {showViewer ? (
          // The rendered message. The text preview is set aside, not stacked above it — one
          // copy of the message on screen, the same rule the reading pane keeps. Collapsed it
          // is clamped at 348 (base `.sc-clip`); expanding it unclamps via `.scast.viewer.open`.
          <div className="sc-viewer">{bodySlot}</div>
        ) : (
          chunks.map((chunk, i) => (
            <Fragment key={i}>
              {i > 0 ? art : null}
              <p className="sc-body msg-plain">{chunk.trim()}</p>
            </Fragment>
          ))
        )}
        {!showViewer && open && moreLabel && shownEnd < body.length ? (
          <button
            type="button"
            className="msg-page-more"
            onClick={(e) => {
              e.stopPropagation();
              setPaged({ body, pages: pages + 1 });
            }}
          >
            {moreLabel(Math.floor((shownEnd / body.length) * 100))}
          </button>
        ) : null}
        {/* The one line of chrome hydration adds, for the three states that need it:
            "we are fetching this", "we could not", and "the server holds no content for this
            one" (the storage cap — terminal, no retry implied). A card whose body has not been
            asked for says nothing — the Expand pill IS that signal — and a complete body says
            nothing either, which is the Blanc card unchanged. It sits INSIDE `.sc-clip`
            beside the text it qualifies, above the fade. */}
        {note ? (
          <p className={bodyState === "failed" ? "sc-state warn" : "sc-state"} role="status">
            {note}
          </p>
        ) : null}
        <div className="sc-fade" />
      </div>
      {/* Outside the clip, so the clamp never hides a file. `onClick` stops here: saving a file
          must not also re-select the card underneath it. */}
      {open && files ? (
        <div className="sc-files" onClick={(e) => e.stopPropagation()}>
          {files}
        </div>
      ) : null}
      <button
        type="button"
        className="sc-x"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          // A short card's pill leaves once the card is open, so a keyboard press that opened it
          // would drop focus to the page: it goes to the card's first verb instead (below).
          if (!open && isShort && !pending && e.currentTarget === document.activeElement) focusVerbs.current = true;
          toggle();
        }}
      >
        <span>{open ? collapseLabel : expandLabel}</span>
        <Icon name="chev" className="chev" />
      </button>
      {/* The verbs, below the expand pill — the end of the message, which is where the reading
          pane puts them too. `onClick` stops here: pressing Later must not also re-select the
          card underneath it. */}
      {actions ? (
        <div className="msg-actions sc-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </article>
  );
}

export interface StreamArtProps {
  ariaLabel: string;
  caption?: string;
  children: ReactNode;
}

/** Figure wrapper for inline stream illustrations. */
export function StreamArt({ ariaLabel, caption, children }: StreamArtProps) {
  return (
    <figure className="sc-art" role="img" aria-label={ariaLabel}>
      {children}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
