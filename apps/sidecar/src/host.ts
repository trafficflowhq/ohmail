import type { Readable, Writable } from "node:stream";
import { FrameDecoder, FrameWriter, MAX_BODY_BYTES, PROTOCOL_VERSION, type FrameLimits } from "./frame.js";
import { describeMethod, describeRoute, type Diagnostic } from "./log.js";
import { decodeRequest, encodeResponse, type ErrorHeader, type ReadyHeader, type ReadyInfo, type RequestHeader } from "./protocol.js";

/**
 * THE SIDECAR SIDE OF THE BRIDGE — frames on stdin, `app.handle` behind them, frames back out.
 *
 * The one rule this file exists to hold: **the read loop never awaits a handler.** Every request
 * frame starts its work and the loop immediately goes back to the stream. That is property 2 of
 * `frame.ts`'s deadlock argument, and it is the difference between a bridge and a hang — a host
 * that awaited its own response before reading the next chunk would deadlock the moment the client
 * sent a request larger than one pipe buffer while a large response was on its way back.
 *
 * The handler is injected as a bare `(req) => Promise<Response>` rather than an `App` + `ApiDeps`,
 * for two reasons: `ApiDeps` is MUTABLE (the middleware chain writes `requestId`, `session` and
 * `idempotency` into it), so the caller has to mint a fresh one per request anyway — and it lets
 * the transport be tested against a trivial handler instead of the whole Cloud service.
 */

export interface StdioHostOptions {
  /** Usually `(req) => app.handle(req, freshDeps())`. */
  handle: (req: Request) => Promise<Response>;
  input: Readable;
  output: Writable;
  /** Diagnostics. NEVER stdout — stdout is the frame stream. Defaults to silence. */
  log?: Diagnostic;
  /**
   * Called when the stream is unusable: a malformed frame, a cap breach, a write failure. There is
   * no resync point in a length-prefixed stream, so this is terminal by design.
   */
  onFatal?: (err: unknown) => void;
  limits?: Partial<FrameLimits>;
}

export interface StdioHost {
  /** Requests accepted and not yet answered. */
  readonly inFlight: number;
  /** Announce the per-launch session to the shell. */
  ready(info: ReadyInfo): Promise<void>;
  /** Resolves when the input ends AND every accepted request has been answered. */
  finished(): Promise<void>;
  /** Detach from the streams. Does not close them — the process owns those. */
  stop(): void;
}

export function serveOverStdio(opts: StdioHostOptions): StdioHost {
  const log = opts.log ?? ((): void => undefined);
  const maxBody = opts.limits?.maxBodyBytes ?? MAX_BODY_BYTES;
  const decoder = new FrameDecoder(opts.limits ?? {});
  const writer = new FrameWriter(opts.output, opts.limits ?? {});

  let inFlight = 0;
  let ended = false;
  let stopped = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  const settleIfDone = (): void => {
    if (ended && inFlight === 0) resolveFinished();
  };

  const fatal = (err: unknown): void => {
    if (stopped) return;
    stop();
    log("frame_stream_fatal", { err });
    opts.onFatal?.(err);
  };

  /**
   * Answer one request. Never throws into the read loop — a handler that blows up produces an
   * `err` frame, so the client's fetch rejects instead of waiting for a response that will not
   * come.
   */
  const dispatch = (header: RequestHeader, body: Buffer): void => {
    inFlight++;
    void (async () => {
      try {
        const res = await opts.handle(decodeRequest(header, body));
        const framed = await encodeResponse(header.id, res, maxBody);
        await writer.write(framed.header, framed.body);
      } catch (err) {
        const detail: ErrorHeader = {
          v: PROTOCOL_VERSION,
          t: "err",
          id: header.id,
          code: "sidecar_failed",
          message: err instanceof Error ? err.message : String(err),
        };
        // The frame's `message` goes on the WIRE, to the parent process that already owns this
        // pipe. It does not go in the LOG: `err` is reduced to class + code by the logger, and
        // `header.url` is replaced by its path (`describeRoute`) because a query string on this
        // API carries search terms, which on this product are mail. `header.id` is logged as
        // `requestId` — the census name for the thing an operator correlates on — and it is
        // structurally a number: `onData` refuses any frame whose `id` is not one before
        // `dispatch` is ever reached.
        log("request_failed", {
          requestId: header.id,
          method: describeMethod(header.method),
          route: describeRoute(header.url),
          err,
        });
        await writer.write(detail).catch(fatal);
      } finally {
        inFlight--;
        settleIfDone();
      }
    })();
  };

  const onData = (chunk: Buffer): void => {
    if (stopped) return;
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      fatal(err);
      return;
    }
    for (const f of frames) {
      const header = f.header as Partial<RequestHeader>;
      // Both messages quote the frame, and both errors reach `fatal`, which logs them — so both
      // carry a `code`. `describeError` reads `code` through an identifier grammar and emits it,
      // and the message is discarded: without the code the two failures would be one
      // indistinguishable `errorClass: "Error"` in the log. The message still travels to
      // `onFatal`'s caller, which is in-process and is where the frame detail belongs.
      if (header.t !== "req" || typeof header.id !== "number") {
        fatal(Object.assign(
          new Error(`unexpected frame on the host side: ${JSON.stringify(f.header).slice(0, 200)}`),
          { code: "frame_unexpected" },
        ));
        return;
      }
      if (header.v !== PROTOCOL_VERSION) {
        fatal(Object.assign(
          new Error(`frame protocol version ${String(header.v)}, expected ${PROTOCOL_VERSION}`),
          { code: "frame_version_mismatch" },
        ));
        return;
      }
      dispatch(header as RequestHeader, f.body);
    }
  };

  const onEnd = (): void => {
    ended = true;
    if (!decoder.idle) log("input_ended_mid_frame", { reason: "the peer closed with a partial frame buffered" });
    settleIfDone();
  };

  const onError = (err: Error): void => fatal(err);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    opts.input.removeListener("data", onData);
    opts.input.removeListener("end", onEnd);
    opts.input.removeListener("error", onError);
    ended = true;
    settleIfDone();
  }

  opts.input.on("data", onData);
  opts.input.on("end", onEnd);
  opts.input.on("error", onError);

  return {
    get inFlight() {
      return inFlight;
    },
    async ready(info) {
      const header: ReadyHeader = { v: PROTOCOL_VERSION, t: "ready", ...info };
      await writer.write(header);
    },
    finished: () => finished,
    stop,
  };
}
