/**
 * HOW A LARGE MESSAGE CROSSES THE BRIDGE: its text in pieces of at most {@link PIECE_BYTES}, then a
 * head naming how many there were; the receiver joins them and parses the whole once. Both sides use
 * this: the page for what it sends and what it receives, the app's native side for what it sends.
 * (The native module joins what the page sends before anything reads it.)
 */
import { PIECE_BYTES, type Joined, type Piece } from "./bridge-kinds";

/** The texts to post for one message, in order: the message itself, or its pieces and their head. */
export function framesOf(text: string, id: number, epoch: string): string[] {
  if (text.length <= PIECE_BYTES) return [text];
  const out: string[] = [];
  let seq = 0;
  for (let at = 0; at < text.length; at += PIECE_BYTES) {
    const piece: Piece = { id, epoch, kind: "piece", seq: seq++, chunk: text.slice(at, at + PIECE_BYTES) };
    out.push(JSON.stringify(piece));
  }
  const head: Joined = { id, epoch, kind: "joined", count: seq };
  out.push(JSON.stringify(head));
  return out;
}

/**
 * Joins pieces back into the message they were cut from. A piece of another epoch, a gap in the
 * order, or a head whose count does not match drops what was gathered: nothing half-joined is ever
 * parsed. Bounded: a message over {@link JOINED_MAX} is dropped as it grows.
 */
export class Joiner {
  private readonly gathering = new Map<number, { next: number; parts: string[]; size: number }>();

  constructor(private readonly epoch: string, private readonly onDropped: () => void = () => {}) {}

  /** A parsed frame in; the whole text out when a head completes it, else null. */
  take(frame: { kind?: unknown; id?: unknown; epoch?: unknown; seq?: unknown; chunk?: unknown; count?: unknown }): string | null {
    if (frame.epoch !== this.epoch || typeof frame.id !== "number") return this.drop(null);
    const id = frame.id;
    if (frame.kind === "piece") {
      const g = this.gathering.get(id) ?? { next: 0, parts: [], size: 0 };
      if (frame.seq !== g.next || typeof frame.chunk !== "string" || g.size + frame.chunk.length > JOINED_MAX) {
        return this.drop(id);
      }
      g.parts.push(frame.chunk);
      g.next += 1;
      g.size += frame.chunk.length;
      this.gathering.set(id, g);
      return null;
    }
    if (frame.kind === "joined") {
      const g = this.gathering.get(id);
      this.gathering.delete(id);
      if (!g || frame.count !== g.next) return this.drop(null);
      return g.parts.join("");
    }
    return null;
  }

  private drop(id: number | null): null {
    if (id !== null) this.gathering.delete(id);
    this.onDropped();
    return null;
  }
}

/** The largest message joined back, in characters. */
export const JOINED_MAX = 96 * 1024 * 1024;
