import net from "node:net";

/**
 * postgres.js@3.4.9 WEDGES a connection that closes with a write still buffered: `closed()` clears
 * its flush timer but keeps the handle and the bytes (connection.js:436-457), so that connection's
 * next handshake queues behind stale bytes, is never flushed, and dies at `connect_timeout` until
 * the buffer passes 1024 bytes — 3 x 30 s on a plain URL, ~120 attempts behind an SSLRequest. No
 * release fixes it and a pnpm patch misses the self-host npm install, so long-lived pools dial
 * through this socket instead: it dials only when the driver writes, drops a first packet that is
 * not exactly one protocol opener (the stale bytes) without dialing, and closes a socket the driver
 * left silent for three loop turns. The driver re-dials at once with the same query either way.
 */

/** Protocol 3.0 startup, SSLRequest, GSSENCRequest, CancelRequest: all a connection may open with. */
const OPENER_CODES = new Set([196_608, 80_877_103, 80_877_104, 80_877_102]);

/** A healthy driver writes its opener in the turn it takes the socket; three turns is the margin. */
const SILENT_TURNS = 3;

/** Exactly one protocol opener: the length word covers the whole packet and the code is an opener's. */
export function isProtocolOpener(chunk: unknown): boolean {
  if (!(chunk instanceof Uint8Array) || chunk.length < 8) return false;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return view.getInt32(0) === chunk.length && OPENER_CODES.has(view.getInt32(4));
}

/** What postgres.js hands its `socket` option: its parsed options. */
interface DialOptions { host: string[]; port: number[]; path?: string | false }

/** Per pool, as the driver's own `hostIndex` rotates per connection over a multi-host URL. */
const rotation = new WeakMap<object, number>();

export function pgSocket(options: DialOptions): net.Socket {
  const socket = new net.Socket();
  const i = rotation.get(options) ?? 0;
  rotation.set(options, (i + 1) % Math.max(1, options.port.length));
  const host = options.host[i] ?? options.host[0];
  const port = options.port[i] ?? options.port[0];
  // The driver reads these off its own socket: `host` for TLS SNI, both for its error text.
  Object.assign(socket, { host, port });
  let dialed = false;
  const write = socket.write;
  socket.write = function (this: net.Socket, chunk: unknown, ...rest: unknown[]): boolean {
    if (!dialed) {
      dialed = true;
      if (!isProtocolOpener(chunk)) { socket.destroy(); return false; }
      if (options.path) socket.connect(options.path);
      else socket.connect(port!, host!);
    }
    return (write as (...a: unknown[]) => boolean).apply(this, [chunk, ...rest]);
  } as typeof socket.write;
  let turns = 0;
  const watch = (): void => {
    if (dialed || socket.destroyed) return;
    if (++turns >= SILENT_TURNS) socket.destroy();
    else setImmediate(watch);
  };
  setImmediate(watch);
  return socket;
}

/** Give a postgres.js options object the socket above (the driver's types do not declare `socket`). */
export function withPgSocket<T extends object>(options: T): T {
  return Object.assign(options, { socket: pgSocket });
}
