import type { Writable } from "node:stream";

/**
 * THE STDIO FRAME CODEC.
 *
 * The LOCAL engine is a Node sidecar reached over the shell's stdin/stdout — **this transport has
 * no TCP listener**, so there is no port to authenticate here and nothing on the machine that can
 * speak it except the process that spawned it. (Host mode, when armed, opens a SEPARATE loopback
 * HTTP door for the user's own paired devices — `host-listener.ts`, off by default and
 * mutation-pinned off; nothing about it passes through these frames.) This file is the whole of
 * the stdio transport, and it has to survive the two things a pipe does that an HTTP socket hides
 * from you: chunks arrive at arbitrary boundaries, and a writer that outruns its reader blocks.
 *
 * ── THE WIRE ───────────────────────────────────────────────────────────────────────────────
 *
 *     uint32BE headerLen · uint32BE bodyLen · header JSON (headerLen bytes) · body (bodyLen bytes)
 *
 * Both lengths are read together, in one 8-byte preamble, so BOTH caps are checked before a
 * single byte of either is allocated. Length-prefixed rather than delimited because the body is
 * arbitrary bytes — an RFC822 message, an attachment, a `/sync` page — and a delimiter would need
 * escaping, which costs a scan and a copy of every byte and gets the encoding wrong exactly once.
 *
 * ── WHY THIS CANNOT DEADLOCK ON A LARGE BODY ───────────────────────────────────────────────
 *
 * The classic pipe deadlock is symmetric: A is blocked writing a big response because B's pipe
 * buffer is full, while B is blocked writing a big request because A's is full, and neither is
 * reading. Three properties close it, and each is a rule about this file rather than a statement
 * of intent:
 *
 *  1. **The reader never stops reading.** {@link FrameDecoder} is a pure push decoder: chunk in,
 *     completed frames out, no `await` anywhere. The `data` handler driving it therefore cannot
 *     be the thing that stalls, whatever the handler behind it is doing.
 *  2. **Dispatch is decoupled from the read.** `host.ts` and `client.ts` start the work for a
 *     frame WITHOUT the read loop awaiting it, so a slow handler cannot stop the pipe draining.
 *  3. **The writer respects backpressure instead of ignoring it.** {@link FrameWriter} awaits
 *     `drain` rather than queueing unboundedly in userland.
 *
 * Frames carry a correlation `id`, so responses may come back out of order and one slow request
 * cannot head-of-line-block the rest.
 *
 * ── A CAP BREACH IS FATAL, DELIBERATELY ────────────────────────────────────────────────────
 *
 * `bodyLen` comes off the wire. Without {@link MAX_BODY_BYTES} a corrupted or hostile length makes
 * the decoder wait for — and eventually allocate — as many bytes as the number says. And there is
 * **no resync point** in a length-prefixed stream: once the two ends disagree about where a frame
 * starts, every subsequent byte is misread. So a breach throws {@link FrameError} and the caller
 * tears the stream down rather than trying to recover from a position it cannot know.
 */

/** Bumped when a change would make an older peer misread a frame. */
export const PROTOCOL_VERSION = 1;

/** Fixed-size preamble: two big-endian uint32 lengths. */
export const PREAMBLE_BYTES = 8;

/** The longest header JSON accepted. A header is a few hundred bytes; this is pure defence. */
export const MAX_HEADER_BYTES = 64 * 1024;

/**
 * The largest body accepted in one frame.
 *
 * Sized against what the API actually returns rather than "big enough": a `/sync` page and an
 * on-demand attachment fetch are the two large ones, and `DEFAULT_SYNC_BATCH_MAX_BYTES` in the
 * IMAP adapter is 32 MB. Match it and stop.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const EMPTY_BODY = new Uint8Array(0);

/** A decoded frame: its parsed header object and its body bytes. */
export interface Frame {
  header: Record<string, unknown>;
  body: Buffer;
}

/** A protocol-level failure. Fatal for the stream: the peer and we no longer agree on framing. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/**
 * A FIFO of byte chunks with no whole-buffer concatenation.
 *
 * The obvious implementation — keep one Buffer and `Buffer.concat` each arriving chunk — is O(n²)
 * in the body size: an 8 MB body arriving in 64 KB pipe reads copies ~512 MB. This keeps the
 * chunks and copies each byte exactly once, when it is taken.
 */
class ByteQueue {
  private chunks: Buffer[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  /** Copy the first `n` bytes out WITHOUT consuming them. Callers check {@link length} first. */
  peek(n: number): Buffer {
    return this.copy(n, false);
  }

  /** Remove and return the first `n` bytes. Callers check {@link length} first. */
  take(n: number): Buffer {
    return this.copy(n, true);
  }

  private copy(n: number, consume: boolean): Buffer {
    if (n > this.total) throw new FrameError(`ByteQueue wanted ${n} bytes with only ${this.total} buffered`);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    let index = 0;
    while (filled < n) {
      const head = this.chunks[index]!;
      const want = n - filled;
      if (head.length <= want) {
        head.copy(out, filled);
        filled += head.length;
        if (consume) this.chunks.shift();
        else index++;
      } else {
        head.copy(out, filled, 0, want);
        filled += want;
        if (consume) this.chunks[index] = head.subarray(want);
      }
    }
    if (consume) this.total -= n;
    return out;
  }
}

export interface FrameLimits {
  maxHeaderBytes: number;
  maxBodyBytes: number;
}

function limitsOf(over: Partial<FrameLimits>): FrameLimits {
  return {
    maxHeaderBytes: over.maxHeaderBytes ?? MAX_HEADER_BYTES,
    maxBodyBytes: over.maxBodyBytes ?? MAX_BODY_BYTES,
  };
}

/**
 * Chunks in, whole frames out. Synchronous and allocation-frugal, so the stream handler that feeds
 * it can never be the thing that blocks (property 1 above).
 */
export class FrameDecoder {
  private readonly q = new ByteQueue();
  /** Set once a preamble has been read and its header+body are still arriving. */
  private awaiting: { headerLen: number; bodyLen: number } | null = null;
  private readonly limits: FrameLimits;

  constructor(limits: Partial<FrameLimits> = {}) {
    this.limits = limitsOf(limits);
  }

  /** Whether anything is half-read. A clean EOF must find this true. */
  get idle(): boolean {
    return this.awaiting === null && this.q.length === 0;
  }

  /** @throws {FrameError} on a malformed header or a length outside the caps — always fatal. */
  push(chunk: Buffer): Frame[] {
    this.q.push(chunk);
    const out: Frame[] = [];
    for (;;) {
      if (this.awaiting === null) {
        if (this.q.length < PREAMBLE_BYTES) return out;
        const pre = this.q.peek(PREAMBLE_BYTES);
        const headerLen = pre.readUInt32BE(0);
        const bodyLen = pre.readUInt32BE(4);
        // Checked BEFORE the preamble is consumed and before anything is allocated, so a wrong
        // length is reported against the frame that carried it.
        if (headerLen === 0 || headerLen > this.limits.maxHeaderBytes) {
          throw new FrameError(
            `frame header length ${headerLen} is outside 1..${this.limits.maxHeaderBytes} — the peer ` +
              "is not speaking this protocol, or an earlier body length was wrong and the stream has " +
              "lost frame alignment",
          );
        }
        if (bodyLen > this.limits.maxBodyBytes) {
          throw new FrameError(`frame body length ${bodyLen} exceeds the ${this.limits.maxBodyBytes}-byte cap`);
        }
        this.q.take(PREAMBLE_BYTES);
        this.awaiting = { headerLen, bodyLen };
      }
      const { headerLen, bodyLen } = this.awaiting;
      if (this.q.length < headerLen + bodyLen) return out;
      const header = this.parseHeader(this.q.take(headerLen));
      const body = bodyLen === 0 ? Buffer.alloc(0) : this.q.take(bodyLen);
      this.awaiting = null;
      out.push({ header, body });
    }
  }

  private parseHeader(bytes: Buffer): Record<string, unknown> {
    let header: unknown;
    try {
      header = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      throw new FrameError(`frame header is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      throw new FrameError("frame header must be a JSON object");
    }
    return header as Record<string, unknown>;
  }
}

/** Serialize one frame to bytes. Exported so a test can feed the decoder hand-built input. */
export function encodeFrame(header: Record<string, unknown>, body: Uint8Array = EMPTY_BODY): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const pre = Buffer.allocUnsafe(PREAMBLE_BYTES);
  pre.writeUInt32BE(headerBytes.length, 0);
  pre.writeUInt32BE(body.byteLength, 4);
  return Buffer.concat([pre, headerBytes, Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
}

/**
 * Frames out, with backpressure honoured and the pieces of one frame kept adjacent.
 *
 * The serialization is load-bearing, not tidiness: `Writable.write` is only atomic per call, so
 * two concurrent frames each writing a preamble then a body would interleave into bytes the peer
 * cannot resynchronise from. Every frame therefore goes through one promise chain.
 *
 * The preamble and header are written together with the body kept separate, so a 32 MB body is
 * never copied into a second 32 MB buffer just to be handed to the stream.
 */
export class FrameWriter {
  private tail: Promise<void> = Promise.resolve();
  private failed: Error | null = null;
  private readonly limits: FrameLimits;

  constructor(
    private readonly out: Writable,
    limits: Partial<FrameLimits> = {},
  ) {
    this.limits = limitsOf(limits);
  }

  /** Queue one frame. Resolves when its bytes have been accepted by the stream. */
  write(header: Record<string, unknown>, body: Uint8Array = EMPTY_BODY): Promise<void> {
    const run = this.tail.then(
      () => this.writeOne(header, body),
      () => this.writeOne(header, body), // a previous frame's failure must not strand this one
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves once everything queued so far has been written (or has failed). */
  drained(): Promise<void> {
    return this.tail;
  }

  private async writeOne(header: Record<string, unknown>, body: Uint8Array): Promise<void> {
    if (this.failed) throw this.failed;
    if (body.byteLength > this.limits.maxBodyBytes) {
      throw new FrameError(`refusing to write a ${body.byteLength}-byte body (cap ${this.limits.maxBodyBytes})`);
    }
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.length > this.limits.maxHeaderBytes) {
      throw new FrameError(`refusing to write a ${headerBytes.length}-byte header (cap ${this.limits.maxHeaderBytes})`);
    }
    const pre = Buffer.allocUnsafe(PREAMBLE_BYTES);
    pre.writeUInt32BE(headerBytes.length, 0);
    pre.writeUInt32BE(body.byteLength, 4);
    await this.raw(Buffer.concat([pre, headerBytes]));
    if (body.byteLength > 0) {
      await this.raw(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    }
  }

  /**
   * One `write`, awaiting `drain` when the stream says its buffer is full.
   *
   * `error` and `close` are listened to as well, because a peer that has gone away never emits
   * `drain` — and a promise that could never settle here would hang the whole sidecar rather than
   * report a broken pipe.
   */
  private raw(bytes: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onDrain = (): void => done();
      const onError = (err: Error): void => done(err);
      const onClose = (): void => done(new FrameError("the transport closed before the frame was written"));
      const done = (err?: Error | null): void => {
        if (settled) return;
        settled = true;
        this.out.removeListener("drain", onDrain);
        this.out.removeListener("error", onError);
        this.out.removeListener("close", onClose);
        if (err) {
          this.failed ??= err;
          reject(err);
        } else {
          resolve();
        }
      };

      this.out.on("error", onError);
      this.out.on("close", onClose);
      const flushed = this.out.write(bytes, (err) => {
        if (err) done(err);
        else if (flushed) done();
      });
      if (!flushed) this.out.once("drain", onDrain);
    });
  }
}
