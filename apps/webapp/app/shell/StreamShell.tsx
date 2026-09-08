"use client";

/**
 * The reading-stream machinery shared by Reads and Receipts: one
 * scroll container with
 *  - scroll-spy (the stream drives the list selection),
 *  - seen-on-scroll (a card fully risen into the top third marks seen,
 *    only after a real user scroll — via @ohmail/ui's useSeenOnScroll),
 *  - imperative scrollTo(id) for row clicks and j/k.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { useSeenOnScroll } from "@ohmail/ui";

export interface StreamHandle {
  /**
   * Bring one card to the reading line and keep it there until it IS there.
   *
   * `onLanded` fires exactly once per call, on the frame the card has arrived (or when the
   * anchoring budget below is spent), which is the seam a caller uses to do anything that
   * depends on the card being both mounted and laid out — see {@link ANCHOR_FRAMES}.
   */
  scrollTo: (id: string, onLanded?: () => void) => void;
  element: () => HTMLDivElement | null;
}

/**
 * WHERE A LANDED CARD SITS — 14px below the top of the scrollport.
 *
 * The scroll-spy reads `current` off the card nearest a line 90px down, so a card parked at 14
 * is unambiguously that card and not the one above it.
 */
const LANDING_LEAD_PX = 14;

/** Near enough to be the same pixel to a reader; below this the loop stops correcting. */
const ANCHOR_TOLERANCE_PX = 2;

/**
 * ═══ WHY A DEEP LANDING IS ANCHORED OVER SEVERAL FRAMES AND NOT SCROLLED TO ONCE ═══════════
 *
 * `.view-reads .stream .scast` carries `content-visibility: auto` with
 * `contain-intrinsic-size: auto 200px` (`app.css`), so a mounted card the reader has never
 * approached has a BOX but no layout: its height is the 200px guess until the browser renders
 * it. The stream also mounts a growing prefix rather than the pile (`stream-window.ts`), so a
 * jump deep into Reads mounts hundreds of cards that are all still at that guess.
 *
 * A single `scrollTo({ top: card.top, behavior: "smooth" })` therefore aims at an offset
 * computed from guesses, and every card the flight passes replaces its guess with its real
 * height mid-flight while the destination offset stays fixed. Measured in a real Chromium against
 * this component over a synthetic pile eight hundred cards deep, jumping to the four-hundredth: the
 * stream settled 18 301px short — the requested card eighty cards below the fold, three other cards
 * on screen instead, and it never arrived. What that looks like to a reader is a search result that
 * "scrolls to a position where there is no message". On a pile whose cards run SHORTER than the
 * guess the same arithmetic overshoots instead, into the reserved tail spacer, where there is
 * literally nothing.
 *
 * So the landing re-measures. Each frame reads the card's CURRENT offset — layout the browser
 * has already done — and corrects, until the card is at the line. It converges because every
 * correction renders the cards around the new position, which is what replaces their guesses;
 * the budget is what stops a card whose height will not settle from holding the loop open.
 *
 * A CARD ALREADY NEAR THE FOLD KEEPS THE SMOOTH SCROLL. The browser has laid it out, so no guess
 * is in play and there is nothing to correct — that is the j/k step and the click on an adjacent
 * row, where the animation is the product's feel. Anything further is a teleport nobody's eye
 * follows anyway, so it is instant and exact.
 */
const ANCHOR_FRAMES = 90;

/**
 * FRAMES THE LANDING MUST HOLD BEFORE IT IS REPORTED — and this is not belt-and-braces.
 *
 * A card's own position keeps moving after the scroller has stopped, because the cards ABOVE it are
 * still swapping their intrinsic guesses for real heights as they render. Measured on the fixture
 * Reads pile: the landing was correct on the frame it was declared — the last card on screen, 405px
 * down — and two frames later the cards above it had finished rendering, pushed it to 935px, and it
 * was below the fold with the loop already finished. Requiring the condition to hold across
 * consecutive frames is what makes the landing a resting state rather than an instant.
 */
const ANCHOR_STABLE_FRAMES = 3;

/**
 * What the stream knew when it was left — the leave-commit's whole input.
 *
 * `newestSeenId` is "the top of what was on screen": the newest card that was actually
 * DISPLAYED at any point during the visit. A reader enters at the top, so this is normally
 * the first card — but a card that arrives above a reader who is already deep in the pile
 * was never displayed and never becomes it, which is exactly what keeps unseen arrivals
 * above the committed line. `bottomVisibleId` is the last card on screen when the reader
 * left. `drove` is `useSeenOnScroll`'s user-intent authority, verbatim: false means no
 * human ever drove this scroller and NOTHING may be written on the way out.
 */
export interface StreamLeaveState {
  drove: boolean;
  newestSeenId: string | null;
  bottomVisibleId: string | null;
}

/** The card the scroll settles on marks itself seen after this long — the Ohbox's dwell. */
const DWELL_MS = 2000;

export const StreamShell = forwardRef<
  StreamHandle,
  {
    ariaLabel: string;
    onCurrentChange: (id: string) => void;
    onSeen: (id: string) => void;
    /**
     * A card has come within a lookahead of the viewport — hydrate it. Optional: a stream with
     * no bodies to fetch (Receipts today, the demo, a test) leaves it off and no observer is
     * armed. This is the ONLY viewport-driven fetch trigger; it is per-card and fires once per
     * id, never pile-wide: a paid fetch follows a person's explicit intent, never a scroll.
     */
    onNear?: (id: string) => void;
    /**
     * THE LEAVE-COMMIT SEAM. Called exactly once, from the unmount cleanup — and the views
     * unmount precisely when the route changes away from them, so "component unmount" and
     * "route-change away" are one event here. That pair is the DELIBERATE definition of
     * leaving; tab-hide is deliberately NOT it (it fires on every cmd-tab, and a reader
     * glancing at another window has not left the pile). Closing the tab outright commits
     * nothing, which is the conservative side: the per-card sweep already wrote what was
     * scrolled past, and a line that failed to advance shows old mail as new — never the
     * reverse.
     *
     * The visible range is TRACKED continuously (scroll + content passes) rather than read
     * here, because a passive cleanup runs against detached DOM whose geometry is gone.
     */
    onLeave?: (state: StreamLeaveState) => void;
    /**
     * The view's order over the WHOLE pile (`-1` for an id it does not hold) — what lets the
     * leave-range tracker keep a displayed card's claim after the sliding window unmounts it;
     * see `measure()`. Optional: without it the tracker judges by the mounted order, which is
     * only sound when nothing ever unmounts (a bare test mount).
     */
    pileIndexOf?: (id: string) => number;
    /** Changes re-scan the container for [data-unseen] cards. */
    contentKey: unknown;
    children: ReactNode;
  }
>(function StreamShell({ ariaLabel, onCurrentChange, onSeen, onNear, onLeave, pileIndexOf, contentKey, children }, ref) {
  const divRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const dwellRef = useRef(0);
  const curRef = useRef<string | null>(null);
  /**
   * A PROGRAMMATIC JUMP IN FLIGHT — its target, and when to stop protecting it.
   *
   * `scrollTo` animates (`behavior: "smooth"`), and every frame of that animation fires the
   * scroll-spy below, which reads "current" off the geometry mid-flight: each intermediate
   * card became current in turn, and when the target sat near the END of the pile the
   * pinned-to-end rule handed the cursor to the LAST card — permanently, because a card
   * below the reading line never reaches it. So a search jump landed cursor, highlight and
   * (via the dwell, on a session the user had already scrolled) a `\Seen` write on a message
   * nobody clicked. While a jump is in flight the spy stands down; it resumes when the
   * target arrives at the line, when the scroller bottoms out with the target on screen
   * (the cursor is then the TARGET, stated explicitly, not the pile's last card), or at a
   * deadline that covers a smooth scroll with margin — so a jump that never lands (the card
   * unmounted mid-flight) cannot mute the spy for the life of the view.
   */
  const jumpRef = useRef<{ id: string; until: number } | null>(null);
  /** The anchoring loop's live frame — see {@link ANCHOR_FRAMES}. 0 when nothing is in flight. */
  const anchorRef = useRef(0);
  const onCurrentRef = useRef(onCurrentChange);
  onCurrentRef.current = onCurrentChange;
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const pileIndexOfRef = useRef(pileIndexOf);
  pileIndexOfRef.current = pileIndexOf;

  const observer = useSeenOnScroll({
    root: divRef,
    onSeen,
    rootMargin: "0px 0px -62% 0px",
  });
  // Read inside the []-deps scroll effect, so it must reach the LATEST observer by ref.
  const observerRef = useRef(observer);
  observerRef.current = observer;

  /**
   * THE VISIBLE RANGE, TRACKED — the leave-commit's data (see {@link StreamLeaveState}).
   *
   * `measure()` walks the mounted cards and records which are inside the viewport right now,
   * plus the newest card ever displayed (`newestSeenId` — kept by comparing indices in the
   * CURRENT card order, so arrivals shifting positions cannot corrupt it, and a tracked card
   * that leaves the pile resets it to what is actually on screen). It runs on mount, on every
   * `contentKey` pass and inside the scroll handler's rAF — never at unmount, when the DOM is
   * already detached and every rect reads zero.
   */
  const rangeRef = useRef<{ newestSeenId: string | null; bottomVisibleId: string | null }>({
    newestSeenId: null,
    bottomVisibleId: null,
  });
  const measure = () => {
    const el = divRef.current;
    if (!el) return;
    const cards = Array.from(el.querySelectorAll<HTMLElement>(".scast[data-sid]"));
    if (cards.length === 0) return;
    const rootRect = el.getBoundingClientRect();
    if (rootRect.height <= 0) return; // detached or unlaid-out: keep what we know
    let topVisible: string | null = null;
    let bottomVisible: string | null = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= rootRect.top || r.top >= rootRect.bottom) continue;
      if (topVisible === null) topVisible = c.dataset.sid!;
      bottomVisible = c.dataset.sid!;
    }
    if (topVisible === null) return;
    const kept = rangeRef.current.newestSeenId;
    let newest = topVisible;
    if (kept !== null) {
      const pIdx = pileIndexOfRef.current;
      if (pIdx) {
        /**
         * JUDGED IN THE PILE'S ORDER, NOT THE MOUNTED DOM'S. Under the sliding window
         * (`stream-window.ts`) the tracked card UNMOUNTS as the reader scrolls on; a
         * mounted-order lookup then failed and this tracker silently handed the claim to
         * whatever stood at the top of a much deeper viewport — so the leave-commit anchored
         * the waterline hundreds of cards below anything ever displayed. The view owns the
         * pile's order, so it answers; a card the PILE no longer holds (a delta removed it)
         * still falls back to what is on screen.
         */
        const ki = pIdx(kept);
        const ti = pIdx(topVisible);
        if (ki >= 0 && (ti < 0 || ki < ti)) newest = kept;
      } else {
        // No pile order provided (a bare mount, older tests): the mounted order, as before.
        const order = cards.map((c) => c.dataset.sid!);
        const keptIdx = order.indexOf(kept);
        if (keptIdx >= 0 && keptIdx < order.indexOf(topVisible)) newest = kept;
      }
    }
    rangeRef.current = { newestSeenId: newest, bottomVisibleId: bottomVisible };
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useEffect(() => {
    observer.observe();
    measureRef.current();
  }, [observer, contentKey]);

  /** An anchoring loop must not outlive the stream it is scrolling. */
  useEffect(
    () => () => {
      if (anchorRef.current) cancelAnimationFrame(anchorRef.current);
      anchorRef.current = 0;
    },
    [],
  );

  /**
   * The leave-commit itself: unmount ⇒ hand the tracked range and the user-intent authority
   * up through `onLeave`. Empty deps — this must fire once, on the way out, with whatever
   * the refs last knew. `drove` false (a visit that was never humanly scrolled — including
   * React's dev-mode probe mount) reports as such, and the handler behind `onLeave` then
   * writes nothing.
   */
  useEffect(() => {
    return () => {
      const fn = onLeaveRef.current;
      if (!fn) return;
      fn({
        drove: observerRef.current.userHasDriven(),
        newestSeenId: rangeRef.current.newestSeenId,
        bottomVisibleId: rangeRef.current.bottomVisibleId,
      });
    };
  }, []);

  /**
   * THE TAB GOING AWAY IS A LEAVE TOO — `pagehide`, the OhboxView #4 twin, because the
   * unmount commit above structurally cannot run on a tab close: React never unmounts a page
   * the browser is killing. Without this the stream's waterline — the whole "new since last
   * visit" statement — evaporated on exactly the departure a phone reader takes most often.
   * The same range and the same authority go up through the same handler; downstream,
   * `commitFeedSeen` skips a commit that says nothing new and `feed_mark_seen` is idempotent,
   * so the unmount commit that MAY still follow (a bfcache freeze that resumes, then a real
   * navigation) double-charges nothing. The dispatched verb is persisted by the engine's
   * durable outbox before the wire, which is what makes a flush during a dying tab's last
   * milliseconds deliverable on the next boot even when its fetch never leaves the machine.
   * Registered once, reads only refs — the exact discipline the unmount commit documents.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageHide = (): void => {
      const fn = onLeaveRef.current;
      if (!fn) return;
      fn({
        drove: observerRef.current.userHasDriven(),
        newestSeenId: rangeRef.current.newestSeenId,
        bottomVisibleId: rangeRef.current.bottomVisibleId,
      });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  /**
   * HYDRATE ON VIEWPORT INTENT — one IntersectionObserver, bottom-only lookahead.
   *
   * `rootMargin: "0px 0px 50% 0px"` extends the root half a viewport DOWNWARD only, so a card
   * fires `onNear` just before it would scroll into view and the rendered message is ready when
   * it arrives. Fired once per id ever (`nearFired`), and never for the pile above the fold that
   * a reader may never reach. Re-scanning happens on `contentKey` below; the fired set survives
   * it, so a card already asked for is not asked again after a delta re-renders the stream.
   */
  const nearFired = useRef<Set<string>>(new Set());
  const nearIoRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const el = divRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const fn = onNearRef.current;
        if (!fn) return;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const id = (en.target as HTMLElement).dataset.sid;
          if (id && !nearFired.current.has(id)) {
            nearFired.current.add(id);
            fn(id);
          }
        }
      },
      { root: el, rootMargin: "0px 0px 50% 0px" },
    );
    nearIoRef.current = io;
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) io.observe(c);
    return () => {
      io.disconnect();
      nearIoRef.current = null;
    };
  }, []);
  useEffect(() => {
    const el = divRef.current;
    const io = nearIoRef.current;
    if (!el || !io) return;
    io.disconnect();
    for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) io.observe(c);
  }, [contentKey]);

  /**
   * ═══ THE STREAM HOLDS ITS PLACE WHEN A CARD ABOVE THE READER CHANGES HEIGHT ═══════════════
   *
   * The reader's report is "the list often jumps 50–100px during the scroll and flickers". The
   * cause is not the scroll and not a re-keyed list: it is a card ABOVE the viewport getting
   * taller or shorter while the reader is somewhere below it. Everything under that card moves
   * by the difference, and since `scrollTop` is measured from the top of the content, the
   * viewport keeps its offset and the content slides through it.
   *
   * Measured on a 300-card fixture, one 40-step scroll with no expands at all, every change
   * attributed to its cause:
   *
   *   the intrinsic estimate resolving    `200 → 653`, `200 → 545`, `200 → 536`, `200 → 450`
   *   a body arriving (snippet → viewer)  `653 → 500`, `567 → 414`, `545 → 455` — both directions
   *   the viewer's content filling the clamp  `436 → 672`, `414 → 650`, `288 → 524`
   *   the message frame re-measuring      `329 → 416`, `267 → 329`, `476 → 563`
   *
   * The first is fixed at its source (`stream-estimate.ts` — the estimate is now this card's own
   * data rather than a flat 200). The other three are not estimates: they are the mail arriving,
   * and no reservation can predict the height of a document that has not been fetched. What CAN
   * be done is what the browser's own scroll anchoring would do — move `scrollTop` by the same
   * amount, in the same frame, so the reader's view does not move.
   *
   * ── WHY THE BROWSER IS NOT DOING THIS ────────────────────────────────────────────────────
   *
   * The stream deliberately keeps `overflow-anchor` ON (`app.css` says so, and the reason is
   * that the stream is not windowed the way the list columns are). Anchoring still did not fire:
   * measured at 1440, expanding a card BELOW a fully visible reference moved that reference
   * −63.25px with `scrollTop` unchanged at 3600 — i.e. the browser made no adjustment for a
   * change it should have adjusted for. The cards carry `content-visibility: auto`, and a change
   * inside a skipped subtree is not a change anchoring's candidate selection can see. So the
   * compensation is done here, from the measurement, rather than argued about from the cascade.
   *
   * ── THE RULE, AND WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
   *
   * A card whose box lies ENTIRELY ABOVE the scrollport's top and whose height changed by `d`
   * costs `scrollTop += d`. A card that is on screen or below it costs nothing: content below
   * the fold growing does not move anything the reader can see, and content the reader is
   * looking at growing is the reader's own expand — moving the viewport for that would take the
   * card they just opened out from under them.
   *
   * `behavior: "instant"`, because `.stream` carries `scroll-behavior: smooth` and a bare
   * `scrollTop +=` is a scrolling API: it would ANIMATE the correction, which is the visible
   * slide this exists to remove.
   *
   * SUSPENDED WHILE A LANDING IS IN FLIGHT (`jumpRef`): that loop owns `scrollTop` for the
   * duration and re-reads the card's position every frame, so a second writer would be two
   * loops fighting over one offset — the failure `scrollTo` documents at length.
   *
   * The observer is rebuilt on `contentKey` beside the near-observer, so cards a delta added are
   * covered; heights are remembered per card id, and an id that leaves the pile is forgotten,
   * so a card that unmounts and remounts is measured fresh rather than against a stale number.
   */
  /**
   * ── HOLDING THE ANCHOR, ONE RECT PER FRAME ───────────────────────────────────────────────
   *
   * The mechanism is scroll anchoring's, done by hand because the browser's cannot see the
   * changes that matter here. A card that is at least partly on screen is the ANCHOR; its offset
   * from the top of the scrollport is remembered with the `scrollTop` it was read at. On every
   * frame the offset is predicted from the scroll that has happened since — `remembered −
   * (scrollTop_now − scrollTop_then)` — and any difference between that prediction and the
   * reading is content that moved on its own. `scrollTop` absorbs exactly that difference, in
   * the same frame, before the reader can see it.
   *
   * Predicting rather than "compensate only when scrollTop did not change" is the whole point:
   * the report is of a jump DURING a scroll, so the two happen in the same frame and a rule
   * that treats a moved scroll as permission to re-anchor would ignore precisely the case it
   * exists for.
   *
   * ── WHY NOT A ResizeObserver OVER THE CARDS ──────────────────────────────────────────────
   *
   * That was tried first and it is the wrong instrument here, measured: over a 20-step scroll in
   * which a per-frame poll recorded 27 card-height changes, an observer over all 60 mounted
   * cards delivered THREE callbacks. `.scast` carries `content-visibility: auto`, and an
   * element whose contents are skipped does not deliver resize observations for changes inside
   * them — the observer reports when a card becomes relevant to the user and then stays quiet
   * through the hydration, the clamp fill and the frame's re-measure, which are the three
   * mechanisms that actually move the stream. One rect on one element per frame sees all of
   * them, and it sees changes that are not a card at all (the waterline, the chip row).
   *
   * ── WHAT MOVES, MEASURED, AND WHAT IS FIXED ELSEWHERE ────────────────────────────────────
   *
   * One 40-step scroll over a 300-card fixture, no expands, every height change attributed:
   *
   *   the intrinsic estimate resolving        `200 → 653`, `200 → 545`, `200 → 536`, `200 → 450`
   *   a body arriving (snippet → viewer)      `653 → 500`, `567 → 414`, `545 → 455` — both ways
   *   the viewer's content filling the clamp  `436 → 672`, `414 → 650`, `288 → 524`
   *   the message frame re-measuring          `329 → 416`, `267 → 329`, `476 → 563`
   *
   * The first is fixed at its source: the estimate is now the card's own data rather than a flat
   * 200px (`stream-estimate.ts`). The other three are the mail arriving, and no reservation can
   * predict the height of a document that has not been fetched — so they are absorbed here.
   *
   * SUSPENDED WHILE A LANDING IS IN FLIGHT (`jumpRef`): that loop owns `scrollTop` for its
   * duration and re-reads the card's position every frame, so a second writer would be two loops
   * fighting over one offset — the failure `scrollTo` documents at length below.
   *
   * `behavior: "instant"`, because `.stream` carries `scroll-behavior: smooth` and every
   * scrolling API honours it: a correction left to animate is the visible slide this removes.
   */
  const holdRef = useRef<{ sid: string; offset: number; scrollTop: number } | null>(null);
  const holdRafRef = useRef(0);
  /** Drift too small to be worth a `scrollTop` write yet — see the accumulator below. */
  const holdAccRef = useRef(0);
  useEffect(() => {
    const el = divRef.current;
    if (!el || typeof requestAnimationFrame === "undefined") return;

    /**
     * THE TOPMOST CARD THAT HAS FULLY ENTERED THE SCROLLPORT — its top at or below the top edge,
     * not merely its bottom.
     *
     * The obvious choice is the topmost card with ANY part of it on screen, which is what the
     * browser's own anchoring approximates, and it holds the wrong thing: that card STRADDLES
     * the top edge, so a change inside it leaves its top exactly where it was and moves
     * everything below — including the card the reader is actually reading. Measured at 1440,
     * expanding a card below a fully visible reference: the reference moved 63.25px with
     * `scrollTop` unchanged and the straddling card's own offset drifting by 0. Holding the
     * straddler reports no drift for precisely the shift a reader complains about.
     *
     * Holding the first card FULLY inside the port makes "content above the anchor" include the
     * straddler's own contents, which is what the reader sees move. A reader's own expand of the
     * straddling card is not affected: clicking a card selects it, and the view lands the
     * selection at the reading line, which sets `jumpRef` and suspends this loop for the flight.
     */
    const pick = (rootTop: number): HTMLElement | null => {
      for (const c of el.querySelectorAll<HTMLElement>(".scast[data-sid]")) {
        if (c.getBoundingClientRect().top >= rootTop - 0.5) return c;
      }
      return null;
    };
    const remember = (rootTop: number) => {
      const c = pick(rootTop);
      holdRef.current = c
        ? { sid: c.dataset.sid!, offset: c.getBoundingClientRect().top - rootTop, scrollTop: el.scrollTop }
        : null;
    };

    const frame = () => {
      holdRafRef.current = requestAnimationFrame(frame);
      const rootRect = el.getBoundingClientRect();
      if (rootRect.height <= 0) return; // detached, or a hidden tab: nothing to hold
      const held = holdRef.current;
      if (!held) { remember(rootRect.top); return; }
      const card = el.querySelector<HTMLElement>(`.scast[data-sid="${CSS.escape(held.sid)}"]`);
      /* The anchor left the pile or unmounted under the sliding window — take a new one rather
         than compensate against a card that is not there. `stream-window.ts` reserves what it
         unmounts, so nothing has moved. */
      if (!card) { holdAccRef.current = 0; remember(rootRect.top); return; }
      const offset = card.getBoundingClientRect().top - rootRect.top;
      const scrolled = el.scrollTop - held.scrollTop;
      const drift = offset - (held.offset - scrolled);
      /**
       * THE REMAINDER IS CARRIED, NOT DISCARDED — and the first version of this discarded it.
       *
       * A deadband is needed: a sub-pixel drift every frame is layout noise, and writing
       * `scrollTop` for it would be a correction nobody asked for. But a change that arrives
       * OVER many frames — the clamp's own half-second transition is the ordinary case — is a
       * long run of sub-threshold drifts, and throwing each one away throws away the whole
       * change. Measured: expanding a card above the scrollport moved the held card 13px while
       * the loop had already absorbed 26 of the 39, i.e. it lost exactly the part that arrived
       * a third of a pixel at a time. The accumulator keeps it and spends it when it is worth
       * a pixel.
       */
      holdAccRef.current += drift;
      if (Math.abs(holdAccRef.current) > 0.5 && !jumpRef.current) {
        el.scrollTo({ top: el.scrollTop + holdAccRef.current, behavior: "instant" });
        holdAccRef.current = 0;
      }
      /* Re-anchor every frame, from the state AFTER any correction: the anchor is a running
         reference, not a fixed one, and a card scrolled off the top must hand over to the next
         one or the offset it is compared against grows without bound. */
      remember(rootRect.top);
    };
    holdRafRef.current = requestAnimationFrame(frame);
    return () => {
      if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = 0;
      holdRef.current = null;
      holdAccRef.current = 0;
    };
  }, []);


  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        measureRef.current(); // keep the leave-commit's visible range current
        const cards = Array.from(el.querySelectorAll<HTMLElement>(".scast[data-sid]"));
        if (!cards.length) return;
        // A jump in flight owns the cursor — see {@link jumpRef}.
        const jump = jumpRef.current;
        if (jump) {
          const card = Date.now() > jump.until
            ? null
            : el.querySelector<HTMLElement>(`.scast[data-sid="${CSS.escape(jump.id)}"]`);
          if (card) {
            const atLine = card.getBoundingClientRect().top - el.getBoundingClientRect().top <= 90;
            const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
            if (!atLine && !atEnd) return; // still travelling — emit nothing
            jumpRef.current = null;
            if (!atLine) {
              // Bottomed out with the target short of the line: the target IS the cursor.
              // Falling through would pin the pile's LAST card instead — the wrong-message
              // landing this ref exists to prevent.
              if (curRef.current !== jump.id) {
                curRef.current = jump.id;
                onCurrentRef.current(jump.id);
              }
              return;
            }
            // Arrived at the line — the ordinary computation below now lands on the target.
          } else {
            jumpRef.current = null; // expired, or the card left the stream mid-flight
          }
        }
        let current: HTMLElement | null = null;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          current = cards[cards.length - 1]!; // pinned to the end — the last card is current
        } else {
          const top = el.getBoundingClientRect().top;
          for (const c of cards) {
            if (c.getBoundingClientRect().top - top <= 90) current = c;
            else break;
          }
        }
        if (!current) current = cards[0]!;
        const id = current.dataset.sid!;
        if (id !== curRef.current) {
          curRef.current = id;
          onCurrentRef.current(id);
          /**
           * DWELL-TO-SEEN. The card a scroll SETTLES on marks itself seen after 2s — the last
           * screenful never exits the top, so the IntersectionObserver's "risen above the line"
           * rule never reaches it (see `useSeenOnScroll`). Cancel-on-change means only the card
           * a sweep LANDS on survives to fire: a j/k fly-past re-lands current on every
           * intermediate and cancels each before 2s, and `ReadsView.jump` already marks the
           * key's own target. Gated on `userHasDriven()` — the SAME authority the IO commit
           * sits behind — because read-state writes `\Seen` to the user's real IMAP, and a
           * programmatic jump must never trip it.
           */
          if (dwellRef.current) window.clearTimeout(dwellRef.current);
          dwellRef.current = window.setTimeout(() => {
            dwellRef.current = 0;
            if (observerRef.current.userHasDriven()) onSeenRef.current(id);
          }, DWELL_MS);
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (dwellRef.current) window.clearTimeout(dwellRef.current);
      dwellRef.current = 0;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    element: () => divRef.current,
    scrollTo: (id: string, onLanded?: () => void) => {
      const el = divRef.current;
      if (!el) return;
      const find = () => el.querySelector<HTMLElement>(`.scast[data-sid="${CSS.escape(id)}"]`);
      const card = find();
      // A card that is not mounted cannot be scrolled to, and `onLanded` is deliberately NOT
      // called: nothing landed. Callers extend the mounted run first (`stream-window.ts`'s
      // `ensure`) and scroll after the commit, so this is the "it left the pile" case.
      if (!card) return;
      curRef.current = id;
      // One landing at a time: a second jump while the first is still correcting must not have
      // two loops fighting over `scrollTop`.
      if (anchorRef.current) cancelAnimationFrame(anchorRef.current);
      anchorRef.current = 0;

      /** How far below the top of the scrollport the card sits right now. */
      const lineOf = (c: HTMLElement): number =>
        c.getBoundingClientRect().top - el.getBoundingClientRect().top;

      /** The offset that would put the card exactly at the reading line. May be unreachable. */
      const rawTop = (c: HTMLElement): number => lineOf(c) + el.scrollTop - LANDING_LEAD_PX;

      /**
       * …and the same offset CLAMPED to what this scroller can actually reach.
       *
       * The clamp is what a card that cannot reach the line needs: the last card in a pile is held
       * short of it because the scroller bottoms out first, so its raw offset is past the maximum
       * for ever, and aiming at the reachable one is the honest answer — the same fact the
       * scroll-spy's own bottomed-out branch acts on, where the target is the cursor although it
       * never reached the line.
       *
       * THE MAXIMUM IS ITSELF AN ESTIMATE, which is why reaching it is not on its own a landing.
       * `scrollHeight` sums cards that have mostly not been laid out, so it GROWS as they render.
       * Measured against the fixture Reads pile: a jump to the last of fifteen cards reached a
       * clamped aim of 4 638 on one frame, the scroller's real maximum turned out to be 5 128 a
       * frame later, and the card was left 63px BELOW the fold — reached, clamped, and invisible.
       * So a clamped aim only ends the landing once the card is actually on screen; see `settle`.
       */
      const aimTop = (c: HTMLElement): number =>
        Math.min(Math.max(rawTop(c), 0), Math.max(0, el.scrollHeight - el.clientHeight));

      // Protect the landing from the scroll-spy for the flight's duration — see {@link jumpRef}.
      // Re-stamped on every correction below, so a long anchored flight cannot outlive its own
      // deadline and hand the cursor to whichever card the geometry happened to be under.
      const protect = () => {
        jumpRef.current = { id, until: Date.now() + 1500 };
      };
      protect();

      /**
       * IS THE CARD ALREADY LAID OUT NEAR THE FOLD — measured on the CARD, never on an offset.
       *
       * Read straight off the card's own rect relative to the scrollport: a card within a viewport
       * above or two below has been rendered by the browser, so its position is a fact and one
       * exact scroll reaches it. That is the j/k step and the click on a neighbouring row, where the
       * smooth animation is the product's feel.
       *
       * It deliberately does NOT compare the wanted OFFSET against `scrollTop`, which is what this
       * test used to do: the wanted offset is clamped by `scrollHeight`, `scrollHeight` is a sum of
       * unrendered estimates, and a clamp can squash a jump to the far end of a pile into an offset
       * that looks like a one-viewport hop. Measured on the fixture Reads pile: a jump to the last
       * of fifteen cards took the smooth one-shot path, landed 63px below the fold, and — having
       * declared itself a hop — never corrected.
       */
      const near = lineOf(card) > -el.clientHeight && lineOf(card) < el.clientHeight * 2;
      // `behavior` is always explicit: `stream.css` sets `scroll-behavior: smooth` on `.stream`,
      // so an omitted behavior is a smooth scroll — which is exactly what a correction must not be.
      el.scrollTo({ top: aimTop(card), behavior: near ? "smooth" : "instant" });
      if (near) {
        // Reported immediately, and that is sound rather than a shortcut: this branch's premise is
        // that the card is already laid out, so a caller that acts on the landing sees real
        // geometry now — and opening the landed card cannot spoil the flight, because a card's own
        // height does not move its own top.
        onLanded?.();
        return;
      }

      let frames = 0;
      let held = 0;
      /**
       * ONE FRAME OF THE LANDING. Two ways to be there, and the second one is the whole reason this
       * is a loop rather than a second scroll:
       *
       *   · `atLine`   the card sits exactly where a landed card sits. The ordinary success.
       *   · `parked`   the scroller is at the offset it can reach AND the card is on screen. This is
       *                the last card in a pile, which the scroller bottoms out before reaching the
       *                line. The "on screen" half is not decoration: `scrollHeight` grows as cards
       *                render, so reaching a clamped aim while the card is still below the fold
       *                means the maximum was an under-estimate and there is further to go.
       *
       * Either has to HOLD for {@link ANCHOR_STABLE_FRAMES}, and the whole loop is bounded by
       * {@link ANCHOR_FRAMES} so a card whose height never settles cannot keep it open.
       */
      const settle = () => {
        anchorRef.current = 0;
        const c = find();
        if (!c) return; // left the stream mid-flight — nothing landed
        const aim = aimTop(c);
        const line = lineOf(c);
        const atLine = Math.abs(rawTop(c) - el.scrollTop) <= ANCHOR_TOLERANCE_PX;
        const onScreen = line < el.clientHeight - 1 && line + c.getBoundingClientRect().height > 1;
        const parked = Math.abs(aim - el.scrollTop) <= ANCHOR_TOLERANCE_PX && onScreen;
        if (atLine || parked) {
          if (++held >= ANCHOR_STABLE_FRAMES) {
            onLanded?.();
            return;
          }
        } else {
          held = 0;
          el.scrollTo({ top: aim, behavior: "instant" });
        }
        if (++frames > ANCHOR_FRAMES) {
          onLanded?.();
          return;
        }
        protect();
        anchorRef.current = requestAnimationFrame(settle);
      };
      anchorRef.current = requestAnimationFrame(settle);
    },
  }));

  return (
    <div className="stream" ref={divRef} aria-label={ariaLabel}>
      {children}
    </div>
  );
});

/** The Wohnfalz newsletter's inline product illustration (KLAPPRI), verbatim. */
export function FoldTableArt() {
  return (
    <svg
      viewBox="0 0 520 216"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      <rect x="0.7" y="0.7" width="518.6" height="214.6" rx="14" stroke="none" fill="var(--tint)" />
      <path d="M96 26v152" />
      <path d="M60 178h404" />
      <path d="M98 96h224" />
      <path d="M98 104h224" />
      <path d="M310 104l-46 74" />
      <path d="M310 104l8 74" />
      <circle cx="150" cy="86" r="9" />
      <path d="M159 86h7" />
      <path d="M418 178v-64M404 114h28M410 100l8-14 8 14" />
    </svg>
  );
}
