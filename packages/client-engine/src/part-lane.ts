/**
 * ONE MAILBOX'S BYTE ASKS, IN LINE. Every part fetch is one `cost: "connection"` request, a fresh
 * IMAP login behind the API's per-mailbox door, and that door admits two at a time. An open
 * conversation draws the pictures of every expanded letter at once, so without a line the third
 * ask met the door's `mailbox_busy` and the picture read as failed. Here no mailbox is asked for
 * more than the door admits, a person's press never waits behind automatic work, and a busy answer
 * is a wait, not a failure. Pure: no engine import.
 */

/** In flight per mailbox: the API door's own number (`MAX_IMAP_PER_MAILBOX`). */
export const PART_FETCHES_PER_MAILBOX = 2;
/** Of those, automatic (embedded pictures, invitations): one slot always stays free for a press. */
export const AUTO_PART_FETCHES_PER_MAILBOX = 1;
/** How long a mailbox may answer busy, from its first busy answer, before busy is final. */
export const BUSY_PATIENCE_MS = 60_000;
const BUSY_WAIT_MIN_MS = 1_000;
const BUSY_WAIT_MAX_MS = 10_000;

/** What `run` answers for an ask whose letter was released before it was asked or while it waited. */
export const LANE_DROPPED: unique symbol = Symbol("part-lane-dropped");

export interface LaneTask {
  /** The mailbox. */
  key: string;
  /** The letter, for {@link PartLane.drop}. */
  messageId: string;
  /** The engine's flight key, for {@link PartLane.promote}. */
  flight: string;
  kind: "press" | "auto";
}

interface Entry extends LaneTask {
  start: () => void;
  dropped: boolean;
  /** Ends a busy wait early (a drop). */
  wake?: () => void;
  settle: (dropped: true) => void;
}

interface Line {
  running: number;
  runningAuto: number;
  presses: Entry[];
  autos: Entry[];
  /** The first busy answer of the current episode; null once a mailbox answered otherwise. */
  busySince: number | null;
  active: Set<Entry>;
}

function busyWait(err: unknown): number | null {
  const e = err as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown } | null;
  if (e?.code !== "mailbox_busy" || e.retryable === false) return null;
  const said = typeof e.retryAfterMs === "number" ? e.retryAfterMs : BUSY_WAIT_MIN_MS;
  return Math.min(BUSY_WAIT_MAX_MS, Math.max(BUSY_WAIT_MIN_MS, said)) * (1 + 0.2 * Math.random());
}

export class PartLane {
  private readonly lines = new Map<string, Line>();

  run<T>(task: LaneTask, ask: () => Promise<T>): Promise<T | typeof LANE_DROPPED> {
    const line = this.lineOf(task.key);
    return new Promise<T | typeof LANE_DROPPED>((resolve, reject) => {
      const entry: Entry = {
        ...task,
        dropped: false,
        settle: () => resolve(LANE_DROPPED),
        start: () => { void this.work(line, entry, ask).then(resolve, reject); },
      };
      (entry.kind === "press" ? line.presses : line.autos).push(entry);
      this.pump(task.key, line);
    });
  }

  /** A press met this part's queued automatic ask: it moves up with the presses. */
  promote(flight: string): void {
    for (const line of this.lines.values()) {
      const i = line.autos.findIndex((e) => e.flight === flight);
      if (i < 0) continue;
      const [entry] = line.autos.splice(i, 1);
      entry!.kind = "press";
      line.presses.push(entry!);
    }
    for (const [key, line] of this.lines) this.pump(key, line);
  }

  /** The letter was released: its queued asks are never made, a busy wait ends now. */
  drop(messageId: string): void {
    for (const [key, line] of this.lines) {
      for (const queue of [line.presses, line.autos]) {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.messageId !== messageId) continue;
          const [entry] = queue.splice(i, 1);
          entry!.settle(true);
        }
      }
      for (const entry of line.active) {
        if (entry.messageId !== messageId) continue;
        entry.dropped = true;
        entry.wake?.();
      }
      this.forget(key, line);
    }
  }

  /** Everything, for an engine being disposed. */
  dropAll(): void {
    const ids = new Set<string>();
    for (const line of this.lines.values()) for (const e of [...line.presses, ...line.autos, ...line.active]) ids.add(e.messageId);
    for (const id of ids) this.drop(id);
  }

  private lineOf(key: string): Line {
    let line = this.lines.get(key);
    if (!line) {
      line = { running: 0, runningAuto: 0, presses: [], autos: [], busySince: null, active: new Set() };
      this.lines.set(key, line);
    }
    return line;
  }

  private pump(key: string, line: Line): void {
    while (line.running < PART_FETCHES_PER_MAILBOX) {
      let entry = line.presses.shift();
      if (!entry && line.runningAuto < AUTO_PART_FETCHES_PER_MAILBOX) entry = line.autos.shift();
      if (!entry) break;
      line.running += 1;
      if (entry.kind === "auto") line.runningAuto += 1;
      line.active.add(entry);
      entry.start();
    }
    this.forget(key, line);
  }

  private forget(key: string, line: Line): void {
    if (line.running === 0 && line.presses.length === 0 && line.autos.length === 0 && line.busySince === null) {
      this.lines.delete(key);
    }
  }

  private async work<T>(line: Line, entry: Entry, ask: () => Promise<T>): Promise<T | typeof LANE_DROPPED> {
    const auto = entry.kind === "auto";
    try {
      for (;;) {
        try {
          const got = await ask();
          line.busySince = null;
          return got;
        } catch (err) {
          const wait = busyWait(err);
          if (wait === null) { line.busySince = null; throw err; }
          const now = Date.now();
          line.busySince ??= now;
          if (now - line.busySince >= BUSY_PATIENCE_MS) throw err;
          if (entry.dropped) return LANE_DROPPED;
          await new Promise<void>((r) => {
            const t = setTimeout(r, wait);
            entry.wake = () => { clearTimeout(t); r(); };
          });
          entry.wake = undefined;
          if (entry.dropped) return LANE_DROPPED;
        }
      }
    } finally {
      line.running -= 1;
      if (auto) line.runningAuto -= 1;
      line.active.delete(entry);
      this.pump(entry.key, line);
    }
  }
}
