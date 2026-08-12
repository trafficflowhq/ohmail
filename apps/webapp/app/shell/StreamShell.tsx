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
  scrollTo: (id: string) => void;
  element: () => HTMLDivElement | null;
}

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
    /** Changes re-scan the container for [data-unseen] cards. */
    contentKey: unknown;
    children: ReactNode;
  }
>(function StreamShell({ ariaLabel, onCurrentChange, onSeen, onNear, onLeave, contentKey, children }, ref) {
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
  const onCurrentRef = useRef(onCurrentChange);
  onCurrentRef.current = onCurrentChange;
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

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
    const order = cards.map((c) => c.dataset.sid!);
    const kept = rangeRef.current.newestSeenId;
    const keptIdx = kept === null ? -1 : order.indexOf(kept);
    rangeRef.current = {
      // The newest (lowest-index) card ever displayed wins; a vanished tracked card falls
      // back to what is on screen rather than pinning the commit to a message that is gone.
      newestSeenId: keptIdx >= 0 && keptIdx < order.indexOf(topVisible) ? kept : topVisible,
      bottomVisibleId: bottomVisible,
    };
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useEffect(() => {
    observer.observe();
    measureRef.current();
  }, [observer, contentKey]);

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
    scrollTo: (id: string) => {
      const el = divRef.current;
      if (!el) return;
      const card = el.querySelector<HTMLElement>(`.scast[data-sid="${CSS.escape(id)}"]`);
      if (!card) return;
      curRef.current = id;
      // Protect the landing from the scroll-spy for the flight's duration — see {@link jumpRef}.
      // The deadline is generous against a slow smooth-scroll; the in-flight checks usually
      // clear it well before.
      jumpRef.current = { id, until: Date.now() + 1500 };
      el.scrollTo({
        top:
          card.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop -
          14,
        behavior: "smooth",
      });
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
