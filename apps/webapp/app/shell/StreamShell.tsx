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
 * Why a deep landing is anchored over several frames, not scrolled to once. `.scast` carries
 * `content-visibility: auto` with a 200px intrinsic guess, and the stream mounts a growing prefix — so a deep
 * jump aims at an offset computed from guesses, and every card the flight passes replaces its guess mid-flight
 * while the destination stays fixed (measured: an 800-card pile, jumping to card 400, settled 18 301px short
 * and never arrived; short cards overshoot into the tail spacer instead). So the landing re-measures: each
 * frame reads the card's CURRENT offset and corrects until it is at the line; the budget stops an unsettled
 * card from holding the loop open. A card already near the fold keeps the smooth scroll — laid out, no guess in
 * play; anything further is a teleport nobody's eye follows, so it is instant and exact.
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
 * `newestSeenId` is the newest card actually DISPLAYED at any point during
 * the visit — normally the first card, but a card arriving above a reader
 * already deep in the pile was never displayed and never becomes it, which
 * is what keeps unseen arrivals above the committed line. `bottomVisibleId`
 * is the last card on screen at leave. `drove` is `useSeenOnScroll`'s
 * user-intent authority, verbatim: false means no human ever drove this
 * scroller and NOTHING may be written on the way out.
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
     * The leave-commit seam — called exactly once, from the unmount cleanup; the views unmount
     * precisely when the route changes away, so those are one event, and that pair is the
     * DELIBERATE definition of leaving. Tab-hide is deliberately not it (it fires on every
     * cmd-tab). Closing the tab outright commits nothing — the conservative side: the per-card
     * sweep already wrote what was scrolled past, and a line that failed to advance shows old mail
     * as new, never the reverse. The visible range is TRACKED continuously rather than read here: a
     * passive cleanup runs against detached DOM whose geometry is gone.
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
   * A programmatic jump in flight — its target, and when to stop protecting it. `scrollTo`
   * animates, and every frame fires the scroll-spy, which reads "current" off mid-flight geometry:
   * each intermediate card became current, and a target near the END handed the cursor to the LAST
   * card, permanently — a search jump landed cursor, highlight and (via the dwell) a `\Seen` write
   * on a message nobody clicked. While a jump is in flight the spy stands down; it resumes when the
   * target reaches the line, when the scroller bottoms out with the target on screen (the cursor is
   * then the TARGET, stated explicitly), or at a deadline — so a jump that never lands cannot mute
   * the spy for the life of the view.
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
   * The tab going away is a leave too — `pagehide`, the OhboxView #4 twin: React never unmounts a
   * page the browser is killing, so without this the stream's waterline evaporated on exactly the
   * departure a phone reader takes most often. The same range and authority go up through the same
   * handler; `commitFeedSeen` skips a commit that says nothing new and `feed_mark_seen` is
   * idempotent, so an unmount commit that may still follow double-charges nothing. The verb is
   * persisted by the engine's durable outbox before the wire, so a flush in a dying tab's last
   * milliseconds is deliverable on the next boot. Registered once, reads only refs.
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
   * The stream holds its place when a card ABOVE the reader changes height ("the list jumps
   * 50–100px during the scroll"): everything below moves by the difference while the viewport keeps
   * its offset. The estimate cause is fixed at its source (`stream-estimate.ts`); the rest — a body
   * arriving, the viewer filling its clamp, the frame re-measuring — is the mail arriving, so
   * `scrollTop` moves by the same amount in the same frame. The browser's anchoring did not fire:
   * `content-visibility: auto` hides changes inside skipped subtrees (measured, −63.25px
   * unadjusted). Only a card ENTIRELY ABOVE the port costs a correction; `behavior: "instant"`;
   * suspended while a landing is in flight (`jumpRef`); heights per card id, forgotten on unmount.
   */
  /**
   * Holding the anchor, one rect per frame — scroll anchoring by hand, because the browser's cannot see these
   * changes. The on-screen card is the anchor; its offset is remembered with the `scrollTop` it was read at,
   * each frame's offset is PREDICTED from the scroll since (`remembered − Δ scrollTop`), and any difference is
   * content that moved on its own — absorbed the same frame. Predicting matters: the jump happens DURING a
   * scroll, and "compensate only when scrollTop did not change" ignores exactly that case. Not a
   * ResizeObserver: measured, 27 height changes delivered THREE callbacks — `content-visibility: auto`
   * suppresses observations inside skipped subtrees; one rect per frame sees hydration, clamp fill and
   * re-measure, plus non-card changes. Suspended during a landing (`jumpRef`); `behavior: "instant"`.
   */
  const holdRef = useRef<{ sid: string; offset: number; scrollTop: number } | null>(null);
  const holdRafRef = useRef(0);
  /** Drift too small to be worth a `scrollTop` write yet — see the accumulator below. */
  const holdAccRef = useRef(0);
  useEffect(() => {
    const el = divRef.current;
    if (!el || typeof requestAnimationFrame === "undefined") return;

    /**
     * The topmost card that has FULLY entered the scrollport — its top at or below the top edge,
     * not merely its bottom. The obvious choice (any part on screen) holds the wrong thing: that
     * card STRADDLES the top edge, so a change inside it leaves its own top where it was and moves
     * everything below — including the card being read (measured: the reference moved 63.25px while
     * the straddler's offset drifted 0, so holding the straddler reports no drift for exactly the
     * shift readers complain about). A reader's own expand of the straddler is unaffected: clicking
     * selects, the selection lands at the reading line, and `jumpRef` suspends this loop for the
     * flight.
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
       * The remainder is carried, not discarded — the first version discarded it. A deadband is
       * needed (sub-pixel drift per frame is layout noise), but a change arriving OVER many frames
       * — the clamp's half-second transition is the ordinary case — is a long run of sub-threshold
       * drifts, and dropping each drops the whole change. Measured: expanding a card above the
       * scrollport moved the held card 13px while the loop had absorbed 26 of the 39 — it lost
       * exactly the part that arrived a third of a pixel at a time. The accumulator keeps it and
       * spends it when it is worth a pixel.
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
       * …and the same offset CLAMPED to what this scroller can actually reach — what a card that
       * cannot reach the line needs: the last card in a pile is held short of it because the
       * scroller bottoms out first, so aiming at the reachable offset is the honest answer (the
       * scroll-spy's bottomed-out branch acts on the same fact). The maximum is itself an estimate:
       * `scrollHeight` sums unrendered cards and GROWS as they render — measured, a clamped aim of
       * 4 638 met a real maximum of 5 128 a frame later, leaving the card 63px below the fold — so
       * a clamped aim only ends the landing once the card is actually on screen (`settle`).
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
       * Is the card already laid out near the fold — measured on the CARD, never on an offset. Read
       * off the card's own rect: within a viewport above or two below, its position is a fact and
       * one exact scroll reaches it — the j/k step and the neighbouring click, where the smooth
       * animation is the product's feel. Deliberately NOT "wanted offset vs scrollTop", which this
       * used to be: the wanted offset is clamped by `scrollHeight`, a sum of unrendered estimates,
       * so a jump to the far end can masquerade as a one-viewport hop — measured, it took the
       * smooth path, landed 63px below the fold, and never corrected.
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
       * One frame of the landing. Two ways to be there — the second is why this is a loop rather
       * than a second scroll: `atLine` — the card sits where a landed card sits, the ordinary
       * success; `parked` — the scroller is at the offset it can reach AND the card is on screen
       * (the last card in a pile). The "on screen" half is not decoration: `scrollHeight` grows as
       * cards render, so reaching a clamped aim with the card below the fold means the maximum was
       * an under-estimate. Either must hold for {@link ANCHOR_STABLE_FRAMES}; the loop is bounded
       * by {@link ANCHOR_FRAMES} so an unsettled card cannot keep it open.
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
