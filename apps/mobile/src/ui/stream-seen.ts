/**
 * A stream's seen run over its MailList (`SeenRun`): the gesture reports the list takes, a look at
 * each and one when a rest under way is due, and what turned read goes to `mark`.
 */
import { useEffect, useMemo, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { SweepFrame, SweepView } from "../state/sweep";
import { createThreadRead, type ThreadRead } from "./reader-seen";

/** A lifted finger's list still moves by the hand until its reports have been quiet this long. */
const HAND_QUIET_MS = 150;

/** A move no hand made waits this long for the cells' new layout before it counts as a jump. */
const SETTLE_MS = 100;

/** A card's first lines: its sender line and about three lines of its text, or the whole card when shorter (the web's too). */
export const CARD_LEAD_DP = 140;

/**
 * A STREAM'S SEEN RUN (News, Receipts), the web's rest rule: a card turns read once its first lines
 * have stayed on screen for `THREAD_READ_HOLD_MS`, by the engine's thread-read rule. A fling's glide
 * and the drift after a lift count nothing, so the rest starts where the list stops; a card showing
 * only its sender line at the foot stays unread. Only a visit the person drove counts: nothing is read
 * before their first drag, and a scroll the app makes that moves what is on the glass (a status-bar
 * tap, a place coming back) reads nothing until they drag again. The list holding its place (mail
 * arriving above, cells measured late) leaves the cards where they stood, and their rest goes on. A
 * card marked unread during the visit stays unread until the leave. A visit starts from nothing (`restart`).
 */
export class SeenRun {
  private record: ThreadRead = createThreadRead();
  private by: "app" | "finger" | "lifted" | "glide" | "rest" = "app";
  private blind = true;
  private view: SweepView | null = null;
  private handUntil = 0;
  /** The list moved after the lift: nothing counts until the hand has been quiet. */
  private drifting = false;
  /** Each card's place on the glass at the last look that counted. */
  private stood = new Map<string, number>();
  /** When a move no hand made began, while it is not yet known whether the cards moved on the glass. */
  private doubt: number | null = null;
  /** Each row's read state as last rendered. */
  private wasUnread = new Map<string, boolean>();

  /** `foot`: the strip at the list's foot that the bottom chrome stands over. */
  constructor(private readonly foot: () => number = () => 0) {}

  restart(): void {
    this.record = createThreadRead();
    this.by = "app";
    this.blind = true;
    this.view = null;
    this.drifting = false;
    this.doubt = null;
    this.stood.clear();
  }

  /** The rows as rendered: one that turns unread (Mark unread) is kept unread for the visit. */
  rows(rows: Iterable<{ id: string; unread: boolean }>): void {
    const next = new Map<string, boolean>();
    for (const r of rows) {
      if (r.unread && this.wasUnread.get(r.id) === false) this.record.keepUnread(r.id);
      next.set(r.id, r.unread);
    }
    this.wasUnread = next;
  }

  drag(now: number): void {
    this.by = "finger";
    this.blind = false;
    this.drifting = false;
    this.doubt = null;
    this.record.enter(now);
  }

  scroll(v: SweepView, frames: Iterable<SweepFrame>, now: number): string[] {
    this.settle(now);
    const moved = this.view === null || Math.abs(v.y - this.view.y) > 0.5;
    if (this.by === "finger") this.handUntil = now + HAND_QUIET_MS;
    else if (this.by === "lifted" && moved) {
      this.handUntil = now + HAND_QUIET_MS;
      this.drifting = true;
    } else if (moved && this.by === "rest" && this.doubt === null) this.doubt = now;
    return this.look(v, frames, now);
  }

  lift(v: SweepView, frames: Iterable<SweepFrame>, now: number): string[] {
    if (this.by === "finger") this.by = "lifted";
    this.handUntil = now + HAND_QUIET_MS;
    return this.look(v, frames, now);
  }

  glide(now: number): void {
    if (this.by !== "lifted") return;
    this.by = "glide";
    this.record.observe([], null, new Set(), now);
  }

  land(v: SweepView, frames: Iterable<SweepFrame>, now: number): string[] {
    if (this.by !== "glide") return this.scroll(v, frames, now);
    this.by = "rest";
    return this.look(v, frames, now);
  }

  /** A look at the screen the list stands on, when a rest under way is due. */
  tick(frames: Iterable<SweepFrame>, now: number): string[] {
    return this.view === null ? [] : this.look(this.view, frames, now);
  }

  /** When the next look is due, or `null` when none is. */
  get due(): number | null {
    if (this.blind || this.by === "glide") return null;
    if (this.doubt !== null) return this.doubt + SETTLE_MS;
    if (this.by === "lifted" && this.drifting) return this.handUntil + 1;
    return this.record.due;
  }

  private settle(now: number): void {
    if (this.by !== "lifted" || now <= this.handUntil) return;
    this.by = "rest";
    this.drifting = false;
  }

  /** Did every card that stood on the glass at the last counted look keep its place there? */
  private held(v: SweepView, frames: SweepFrame[]): boolean {
    let seen = 0;
    for (const f of frames) {
      const was = this.stood.get(f.id);
      if (was === undefined) continue;
      if (Math.abs(f.top - v.y - was) > 1) return false;
      seen++;
    }
    return seen > 0;
  }

  private look(v: SweepView, all: Iterable<SweepFrame>, now: number): string[] {
    this.settle(now);
    this.view = v;
    const frames = [...all];
    if (this.doubt !== null) {
      if (this.held(v, frames)) this.doubt = null;
      else if (now - this.doubt < SETTLE_MS) return [];
      else {
        this.doubt = null;
        this.blind = true;
      }
    }
    const counts = !this.blind && this.by !== "glide" && !(this.by === "lifted" && this.drifting);
    const panels = frames.map((f) => {
      const lead = { top: f.top, bottom: f.top + Math.min(f.bottom - f.top, CARD_LEAD_DP) };
      return { id: f.id, ready: true, height: f.bottom - f.top, first: lead, lead, end: { top: f.bottom, bottom: f.bottom } };
    });
    const view = counts ? { top: v.y, bottom: v.y + v.height - this.foot() } : null;
    if (view !== null) {
      this.stood.clear();
      for (const f of frames) if (f.bottom > view.top && f.top < view.bottom) this.stood.set(f.id, f.top - v.y);
    }
    // Every card is a candidate: the sweep flips only the unread, and a read one still anchors the leave.
    return this.record.observe(panels, view, new Set(panels.map((p) => p.id)), now);
  }
}

type ScrollEv = NativeSyntheticEvent<NativeScrollEvent>;

const viewOf = (e: ScrollEv) => ({
  y: e.nativeEvent.contentOffset.y,
  height: e.nativeEvent.layoutMeasurement.height,
});

/** `foot`: the strip at the list's foot that the bottom chrome stands over; `rows`: the rows as rendered, with their read state. */
export function useSeenRun(
  frames: () => Iterable<SweepFrame>,
  mark: (ids: string[]) => void,
  foot: () => number,
  rows: readonly { id: string; unread: boolean }[],
) {
  const at = useRef({ frames, mark, foot });
  at.current = { frames, mark, foot };
  const built = useMemo(() => {
    const r = new SeenRun(() => at.current.foot());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (ids: string[]) => {
      clearTimeout(timer);
      timer = undefined;
      const due = r.due;
      if (due !== null) timer = setTimeout(() => send(r.tick(at.current.frames(), Date.now())), Math.max(0, due - Date.now()) + 1);
      if (ids.length > 0) at.current.mark(ids);
    };
    const run = {
      /** A new visit, or the stream gone behind: whatever was resting reads nothing. */
      restart: () => {
        clearTimeout(timer);
        timer = undefined;
        r.restart();
      },
      rows: (rows: readonly { id: string; unread: boolean }[]) => r.rows(rows),
    };
    const gestures = {
      onScrollBeginDrag: () => r.drag(Date.now()),
      onScroll: (e: ScrollEv) => send(r.scroll(viewOf(e), at.current.frames(), Date.now())),
      onScrollEndDrag: (e: ScrollEv) => send(r.lift(viewOf(e), at.current.frames(), Date.now())),
      onMomentumScrollBegin: () => {
        r.glide(Date.now());
        send([]);
      },
      onMomentumScrollEnd: (e: ScrollEv) => send(r.land(viewOf(e), at.current.frames(), Date.now())),
    };
    return { run, gestures };
  }, []);
  useEffect(() => built.run.restart, [built]);
  useEffect(() => built.run.rows(rows), [built, rows]);
  return built;
}
