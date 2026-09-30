/**
 * THE CLOCK THE LISTS ARE DRAWN WITH, ticking by itself. An idle mailbox re-derives nothing, so the
 * world re-runs when time alone changes what a list says: the reader's next local midnight (every
 * stamp, the Receipts "Today" group) and the moment a send left `sending` becomes interrupted or a
 * held send stops "checking". `nextClockEdge` names that instant; `worldClock` arms one timer to it
 * and ticks, and a resume from the background ticks at once when the edge passed while asleep.
 */
import {
  HELD_SEND_RECHECK_MS, SENDING_STALE_AFTER_MS, zonedFields, zonedInstant,
  type EngineDraft, type EntityReader,
} from "@ohmail/client-engine";

/** The next instant after `now` at which a clock-read list says something different. */
export function nextClockEdge(reader: EntityReader, now: Date, zone: string): number {
  const at = now.getTime();
  const f = zonedFields(now, zone);
  let edge = zonedInstant({ year: f.year, month: f.month, day: f.day + 1, hour: 0, minute: 0, second: 0 }, zone).getTime();
  if (!(edge > at)) edge = at + 60 * 60 * 1000;
  for (const d of reader.list<EngineDraft>("draft")) {
    const left = Date.parse(d.updatedAt ?? "");
    if (!Number.isFinite(left)) continue;
    const turns = d.status === "sending" ? left + SENDING_STALE_AFTER_MS + 1
      : d.status === "unverified" ? left + HELD_SEND_RECHECK_MS : NaN;
    if (turns > at && turns < edge) edge = turns;
  }
  return edge;
}

export interface WorldClock {
  /** Arm the timer to the next edge (replacing an armed one). */
  arm(): void;
  /** Back from the background: tick now if the edge passed while the timer could not fire, else re-arm. */
  resume(): void;
  stop(): void;
}

export function worldClock(opts: { edge: () => number; tick: () => void; now?: () => number }): WorldClock {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let due = Infinity;
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const arm = () => {
    clear();
    due = opts.edge();
    timer = setTimeout(() => { timer = null; opts.tick(); }, Math.max(0, due - now()) + 50);
  };
  return {
    arm,
    resume: () => { if (now() >= due) { clear(); opts.tick(); } else arm(); },
    stop: clear,
  };
}
