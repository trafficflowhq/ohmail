/**
 * THE REPLY YOU SENT, BROUGHT INTO VIEW — the phone's half of the web's `sent-reveal.ts`. The composer
 * stands over the reader as a sheet; when a reply sent from it is confirmed, the sheet closes and the
 * sent copy joins the conversation below, where the reader's place (the open anchor, the kept place:
 * an arrival never moves the reader) left it under the fold. So the composer says when a send was
 * pressed and when it went (`noteReplySend`), and the reader, once the copy is drawn, the sheet gone
 * and the layout still for {@link REVEAL_QUIET_MS}, scrolls once to show it: its bottom a margin above
 * what stands over the view, or its top where it is taller. Nothing moves when it is already wholly on
 * screen, when the person dragged since the press (`hand`), or past {@link REVEAL_WINDOW_MS}. The
 * scroll is the platform's own smooth scroll (eased, about 250-300 ms, and a touch stops it), or an
 * instant one under the reduce-motion setting; it is shorter than the read rule's dwell, so nothing
 * it passes turns read.
 */

export const REVEAL_MARGIN_DP = 16;
/** The layout stood still this long: the sheet gone, the copy drawn at its height. */
export const REVEAL_QUIET_MS = 120;
/** A copy whose body is still landing is revealed this long after it joined, at the latest. */
export const REVEAL_SETTLE_CAP_MS = 1500;
/** A send confirmed later than this after its press moves nothing. */
export const REVEAL_WINDOW_MS = 60_000;

/** The composer's word to the reader under it, about the message it answers. */
export interface ReplySendNote { parentId: string; phase: "pressed" | "sent" }
const listeners = new Set<(n: ReplySendNote) => void>();
export function noteReplySend(parentId: string, phase: ReplySendNote["phase"]): void {
  for (const run of [...listeners]) run({ parentId, phase });
}
export function onReplySend(run: (n: ReplySendNote) => void): () => void {
  listeners.add(run);
  return () => { listeners.delete(run); };
}

/** Where the view should stand to show a panel (content dp); `null` when it is wholly on screen. */
export function revealY(
  panel: { top: number; height: number },
  view: { y: number; height: number; chrome: number; content: number },
  margin = REVEAL_MARGIN_DP,
): number | null {
  const shown = view.height - view.chrome;
  if (shown <= 0) return null;
  const bottom = panel.top + panel.height;
  if (panel.top >= view.y && bottom <= view.y + shown) return null;
  const tall = panel.height + 2 * margin > shown;
  const aim = tall ? panel.top - margin : bottom - shown + margin;
  const to = Math.max(0, Math.min(Math.max(0, view.content - view.height), aim));
  return Math.abs(to - view.y) < 1 ? null : to;
}

export interface SentRevealOptions {
  /** The members drawn now: the person's own, and whose body is final. */
  members: () => readonly { id: string; mine: boolean; ready: boolean }[];
  /** A member's panel in content dp, once laid out. */
  measure: (id: string) => { top: number; height: number } | null;
  view: () => { y: number; height: number; chrome: number; content: number };
  /** The reader is on screen with nothing over it. */
  inSight: () => boolean;
  scrollTo: (y: number) => void;
  now?: () => number;
  after?: (ms: number, run: () => void) => () => void;
}

export interface SentReveal {
  /** A send pressed in the composer over this reader: the members drawn now are the ones it knew. */
  pressed: () => void;
  /** …and confirmed. */
  sent: () => void;
  /** The person's own scroll: nothing moves for this send. */
  hand: () => void;
  /** A layout moved: the wait for a still layout starts over. */
  layout: () => void;
  /** Look whether the wait can start (a commit, the sheet gone). */
  poke: () => void;
  dispose: () => void;
}

export function createSentReveal(o: SentRevealOptions): SentReveal {
  const now = o.now ?? Date.now;
  const after = o.after ?? ((ms: number, run: () => void) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  });
  let owed: { at: number; known: Set<string>; sent: boolean; joined: number | null } | null = null;
  let quiet: (() => void) | null = null;
  const stop = (): void => { quiet?.(); quiet = null; };
  const drop = (): void => { owed = null; stop(); };
  const copy = (): { id: string; ready: boolean } | null => {
    const known = owed?.known;
    if (!known) return null;
    const all = o.members();
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.mine && !known.has(all[i]!.id)) return all[i]!;
    return null;
  };
  const fire = (): void => {
    quiet = null;
    const w = owed;
    const c = copy();
    if (!w || !c || !o.inSight()) return;
    const late = w.joined !== null && now() - w.joined >= REVEAL_SETTLE_CAP_MS;
    const box = o.measure(c.id);
    if (!box || (!c.ready && !late)) { if (!late) arm(true); return; }
    drop();
    const y = revealY(box, o.view());
    if (y !== null) o.scrollTo(y);
  };
  /** Start the wait; `again` restarts one under way unless the cap is past. */
  const arm = (again: boolean): void => {
    const w = owed;
    if (!w || !w.sent) return;
    if (now() - w.at > REVEAL_WINDOW_MS) { drop(); return; }
    if (!copy() || !o.inSight()) return;
    w.joined ??= now();
    if (quiet && (!again || now() - w.joined >= REVEAL_SETTLE_CAP_MS)) return;
    stop();
    quiet = after(REVEAL_QUIET_MS, fire);
  };
  return {
    pressed: () => { drop(); owed = { at: now(), known: new Set(o.members().map((m) => m.id)), sent: false, joined: null }; },
    sent: () => { if (owed) { owed.sent = true; arm(true); } },
    hand: drop,
    layout: () => arm(true),
    poke: () => arm(false),
    dispose: drop,
  };
}
