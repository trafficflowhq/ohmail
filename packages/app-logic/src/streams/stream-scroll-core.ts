/**
 * THE STREAM'S SCROLL, ITS STATE AND ITS READINGS: the web shell's `StreamShell` carried over line for line, the
 * refs of the component as fields and its closures as methods (`stream-scroll.ts` says what each part is). The
 * landing is `stream-scroll-land.ts`; the anchor hold is `stream-scroll-hold.ts`. No read code: what a stream reads
 * is `read-rule.ts`'s.
 */
import { cssRect } from "../geometry/index.js";

/** Where a landed card sits: 14px below the top of the scrollport. */
export const LANDING_LEAD_PX = 14;
/** The reading line: the scroll-spy's current card is the last one whose top is at or above it. */
export const READING_LINE_PX = 90;
/** Near enough to be the same pixel to a reader; below this the loop stops correcting. */
export const ANCHOR_TOLERANCE_PX = 2;
/** A held cursor's first lines: on screen, it stays the cursor (the web shell's `FIRST_LINES_PX`). */
const HELD_FIRST_LINES_PX = 140;

/** The card's names: its class, the attribute that carries its id, and the class it wears while its body is on the way. */
export interface StreamCardNames {
  readonly base: string;
  readonly attr: string;
  readonly pending: string;
}

/** What the stream's own scroll and its owner share (the web shell's seen observer, or nothing). */
export interface StreamScrollSeam {
  /** Run a scroll that is the stream's own: it neither starts nor extends a landing. */
  own?(scroll: () => void): void;
  /** The app moved the stream: the scroll that follows is not the hand's. */
  moved?(): void;
  /** How many times a hand moved the pane. */
  hands?(): number;
  /** A jump to an end is in flight. */
  landing?(): boolean;
  /** A key in the host scroller is driving the native end. */
  edgeLanding?(): boolean;
  /** A scroll nobody announced is being judged. */
  judging?(): boolean;
  /** The run starts again where the landing rests. */
  restart?(): void;
  /** The current application landing is displaying its real destination. */
  settled?(): void;
  /** The part of the port that contributes to the leave range. */
  readView?(el: HTMLElement): { top: number; bottom: number };
}

/** What the core reads of its caller on every use (the hook's latest props). */
export interface StreamScrollInputs {
  readonly card: StreamCardNames;
  readonly onCurrentChange: (id: string, byHand?: boolean) => void;
  readonly pileIndexOf?: (id: string) => number;
  readonly seam?: StreamScrollSeam;
}

/** The leave range: the newest card displayed this visit, and the last one on screen. */
export interface StreamRange {
  readonly newestSeenId: string | null;
  readonly bottomVisibleId: string | null;
}

/** A screen of the stream: its top and bottom visible cards, by id. */
type Screen = { top: string; bottom: string };

/** An id spelled for an attribute selector (the page's own escape where it has one). */
const escapeId = (id: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/["\\]/g, "\\$&");

export class StreamScrollCore {
  el: HTMLElement | null = null;
  inputs: StreamScrollInputs;
  /** Hands counted here when the seam does not count them. */
  ownHands = 0;
  private handsAtPin = 0;
  cur: string | null = null;
  /** A programmatic jump in flight: its target, and when to stop protecting it. */
  jump: { id: string; until: number } | null = null;
  /** The held cursor: the card a jump, a step, a press or an open put the cursor on. */
  held: string | null = null;
  /** The visit's own reset scroll is in flight: the spy's next reading is taken, not announced. */
  quiet = false;
  /** The anchoring loop's live frame. 0 when nothing is in flight. */
  anchor = 0;
  offScreen = new Map<string, () => void>();
  /** A far landing in flight: what it passes or flashes is not displayed, so nothing is tracked. */
  landing = false;
  /** A judged scroll is in flight, and the next measure bridges what it skipped. */
  bridge = false;
  /** The spy's last reading found a screen a held window had not mounted yet. */
  owed = false;
  /** The screen before a jump to an end, taken by its first measure; `undefined` outside one. */
  endFrom: Screen | null | undefined = undefined;
  range: StreamRange = { newestSeenId: null, bottomVisibleId: null };
  /** The screen the last measure saw, by id: a move that neither overlaps nor touches it skipped cards. */
  shown: Screen | null = null;
  /** The anchor hold's card, its offset and the `scrollTop` it was read at. */
  holdAt: { sid: string; offset: number; scrollTop: number } | null = null;
  holdRaf = 0;
  /** Drift too small to be worth a `scrollTop` write yet. */
  holdAcc = 0;
  /** The hold loop's half of a card's toggle, bound while the loop is mounted. */
  toggledFn: (sid: string, open: boolean) => void = () => {};
  /** The scroll handler's frame, and the spy's re-reading. */
  raf = 0;
  respy: () => void = () => {};

  constructor(inputs: StreamScrollInputs) {
    this.inputs = inputs;
  }

  all(el: HTMLElement): HTMLElement[] {
    const n = this.inputs.card;
    return Array.from(el.querySelectorAll<HTMLElement>(`.${n.base}[${n.attr}]`));
  }
  one(el: HTMLElement, id: string): HTMLElement | null {
    const n = this.inputs.card;
    return el.querySelector<HTMLElement>(`.${n.base}[${n.attr}="${escapeId(id)}"]`);
  }
  idOf(c: HTMLElement): string {
    return c.getAttribute(this.inputs.card.attr)!;
  }

  own(scroll: () => void): void {
    const own = this.inputs.seam?.own;
    if (own) own(scroll);
    else scroll();
  }
  moved(): void {
    this.inputs.seam?.moved?.();
  }
  hands(): number {
    const hands = this.inputs.seam?.hands;
    return hands ? hands() : this.ownHands;
  }
  seamLanding(): boolean {
    return this.inputs.seam?.landing?.() ?? false;
  }
  judging(): boolean {
    return this.inputs.seam?.judging?.() ?? false;
  }
  restart(): void {
    this.inputs.seam?.restart?.();
  }

  pin(id: string): void {
    this.handsAtPin = this.hands();
    this.held = id;
    this.cur = id;
  }

  /** Is this card in the port? Unmounted, or a stream with no layout yet, answers no. */
  inPort(id: string, viewOf: (el: HTMLElement) => { top: number; bottom: number } = cssRect): boolean {
    const el = this.el;
    const c = el ? this.one(el, id) : null;
    if (!el || !c) return false;
    const root = viewOf(el);
    const r = cssRect(c);
    return root.bottom > root.top && r.height > 0 && r.bottom > root.top && r.top < root.bottom;
  }

  /** Whether the stream has settled with part of this card in its readable viewport. */
  settledInReadView(id: string): boolean {
    return (
      !this.seamLanding() &&
      !this.judging() &&
      !this.raf &&
      !this.anchor &&
      !this.owed &&
      !this.landing &&
      this.pendingShift() === 0 &&
      this.inPort(id, this.inputs.seam?.readView)
    );
  }
  settleOffScreen(): void {
    for (const [id, cb] of [...this.offScreen]) {
      if (this.inPort(id)) continue;
      this.offScreen.delete(id);
      cb();
    }
  }

  /** Content moved under the held anchor since the anchoring loop last ran: the px the loop is about to scroll by. */
  pendingShift(): number {
    const el = this.el;
    const anchor = this.holdAt;
    if (!el || !anchor || this.jump || !this.holdRaf) return 0;
    const ac = this.one(el, anchor.sid);
    if (!ac) return 0;
    const drift = cssRect(ac).top - cssRect(el).top - (anchor.offset - (el.scrollTop - anchor.scrollTop));
    return Math.abs(drift + this.holdAcc) > 0.5 ? drift + this.holdAcc : 0;
  }

  /** Do two screens neither overlap nor touch, in the pile's order? Unknown order answers no. */
  skipped(a: Screen, b: Screen): boolean {
    const pIdx = this.inputs.pileIndexOf;
    if (!pIdx) return false;
    const [lt, lb, ti, bi] = [a.top, a.bottom, b.top, b.bottom].map((id) => pIdx(id)) as [
      number,
      number,
      number,
      number,
    ];
    return Math.min(lt, lb, ti, bi) >= 0 && (ti > lb + 1 || bi < lt - 1);
  }

  /** The seam's jump to an end has rested. */
  endLanded(): void {
    const from = this.endFrom;
    this.endFrom = undefined;
    this.measure();
    // It skipped cards: the run starts on the screen it rests on.
    if (from && this.shown && this.skipped(from, this.shown)) {
      this.range = { newestSeenId: null, bottomVisibleId: null };
      this.shown = null;
      this.measure();
    }
    this.spy();
  }
  /** A judged scroll ended: the run takes the screen it left, which it neither resets nor stretches over. */
  judged(): void {
    this.measure();
    this.spy();
  }

  /** The visible range, tracked: the newest card displayed and the last one on screen, in the pile's order. */
  measure(): void {
    const el = this.el;
    if (!el || this.landing) return;
    // A judged scroll in flight: what it passes is not displayed, and the run waits for where it rests.
    if (this.judging()) {
      this.bridge = true;
      return;
    }
    const cards = this.all(el);
    if (cards.length === 0) return;
    const rootRect = this.inputs.seam?.readView?.(el) ?? cssRect(el);
    if (rootRect.bottom <= rootRect.top) return; // detached or unlaid-out: keep what we know
    if (this.pendingShift() !== 0) return; // a frame the anchoring loop has not corrected yet
    const screen = this.screenOf(cards, rootRect);
    if (!screen) return;
    const last = this.shown;
    if (!this.seamLanding()) this.endFrom = undefined;
    else if (this.endFrom === undefined) this.endFrom = last;
    this.shown = screen;
    let kept = this.range.newestSeenId;
    // A move that skipped cards ends the run: they were never on screen. A judged scroll's skip does not.
    const bridged = this.bridge;
    this.bridge = false;
    if (kept !== null && last && !bridged && this.skipped(last, screen)) kept = null;
    this.range = { newestSeenId: this.newestOf(kept, screen.top, cards), bottomVisibleId: screen.bottom };
  }
  private screenOf(cards: HTMLElement[], rootRect: { top: number; bottom: number }): Screen | null {
    let top: string | null = null;
    let bottom: string | null = null;
    for (const c of cards) {
      const r = cssRect(c);
      if (r.bottom <= rootRect.top || r.top >= rootRect.bottom) continue;
      if (top === null) top = this.idOf(c);
      bottom = this.idOf(c);
    }
    return top === null ? null : { top, bottom: bottom! };
  }
  /** Judged in the pile's order, not the mounted DOM's: a window unmounts the tracked card as the reader scrolls on. */
  private newestOf(kept: string | null, topVisible: string, cards: HTMLElement[]): string {
    if (kept === null) return topVisible;
    const pIdx = this.inputs.pileIndexOf;
    if (pIdx) {
      const ki = pIdx(kept);
      const ti = pIdx(topVisible);
      return ki >= 0 && (ti < 0 || ki < ti) ? kept : topVisible;
    }
    const order = cards.map((c) => this.idOf(c));
    const keptIdx = order.indexOf(kept);
    return keptIdx >= 0 && keptIdx < order.indexOf(topVisible) ? kept : topVisible;
  }

  /** A visit starts from nothing: the tracked range empty, the scroller at its top. */
  visitStart(): void {
    this.resetRange();
    this.landing = false;
    this.cur = null;
    this.jump = null;
    this.held = null;
    this.owed = false;
    const el = this.el;
    if (el && el.scrollTop !== 0) {
      this.quiet = true;
      this.own(() => el.scrollTo({ top: 0, behavior: "instant" }));
    }
  }

  /** The next screen supplies the range for another reading run. */
  resetRange(): void {
    this.range = { newestSeenId: null, bottomVisibleId: null };
    this.shown = null;
    this.bridge = false;
    this.endFrom = undefined;
  }

  /** The scroll-spy: the current card is the last one at or above the reading line, the last one at the end. */
  spy(): void {
    const el = this.el;
    if (!el) return;
    // A jump to an end or a judged scroll in flight: the cursor waits for the screen it rests on.
    if (this.seamLanding() || this.judging()) return;
    const cards = this.all(el);
    if (!cards.length) return;
    if (this.jumpInFlight(el)) return; // a jump in flight emits nothing
    if (this.heldStands(el)) return;
    let current: HTMLElement | null = null;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
      current = cards[cards.length - 1]!; // pinned to the end: the last card is current
    } else {
      const top = cssRect(el).top;
      for (const c of cards) {
        if (cssRect(c).top - top <= READING_LINE_PX) current = c;
        else break;
      }
    }
    if (!current) current = cards[0]!;
    // A window held while the scroll flew has not mounted this screen: the cursor waits for the commit that does.
    const port = cssRect(el);
    const box = cssRect(current);
    this.owed = port.height > 0 && (box.bottom <= port.top || box.top >= port.bottom);
    if (this.owed) return;
    const id = this.idOf(current);
    if (this.quiet) {
      this.quiet = false;
      this.cur = id;
      return;
    }
    if (id !== this.cur) {
      this.cur = id;
      this.inputs.onCurrentChange(id, this.hands() !== this.handsAtPin);
    }
  }
  /** Still travelling to the jump's own aim (clamped as the landing clamps it): true. Landed or expired: cleared. */
  private jumpInFlight(el: HTMLElement): boolean {
    const jump = this.jump;
    if (!jump) return false;
    const card = Date.now() > jump.until ? null : this.one(el, jump.id);
    if (card) {
      const raw = cssRect(card).top - cssRect(el).top + el.scrollTop - LANDING_LEAD_PX;
      const aim = Math.min(Math.max(raw, 0), Math.max(0, el.scrollHeight - el.clientHeight));
      if (Math.abs(aim - el.scrollTop) > ANCHOR_TOLERANCE_PX) return true;
    }
    this.jump = null; // landed, expired, or the card left the stream mid-flight
    return false;
  }
  /** The held cursor stands while its first lines are on screen or it covers the reading line. */
  private heldStands(el: HTMLElement): boolean {
    const held = this.held;
    if (!held) return false;
    const pIdx = this.inputs.pileIndexOf;
    const hc = this.one(el, held);
    const inPile = pIdx ? pIdx(held) >= 0 : hc != null;
    const port = cssRect(el);
    const box = hc ? cssRect(hc) : null;
    const head =
      box != null &&
      box.top >= port.top - 0.5 &&
      box.top + Math.min(box.height, HELD_FIRST_LINES_PX) <= port.bottom + 0.5;
    const line =
      box != null && box.top - port.top <= READING_LINE_PX && box.bottom - port.top > READING_LINE_PX;
    if (inPile && (port.height <= 0 || head || line)) {
      this.quiet = false; // the hold took the visit's reset reading
      if (this.cur !== held) {
        this.cur = held;
        this.inputs.onCurrentChange(held);
      }
      return true;
    }
    this.held = null;
    return false;
  }

  /** The scroll handler: one frame later, the range, the off-screen waiters and the spy. */
  attachSpy(el: HTMLElement): () => void {
    const onScroll = (): void => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.measure(); // keep the leave's visible range current
        if (this.offScreen.size) this.settleOffScreen();
        this.spy();
      });
    };
    this.respy = onScroll;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      this.respy = () => {};
      el.removeEventListener("scroll", onScroll);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    };
  }
}
