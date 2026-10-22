import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

/**
 * THE PHONE'S PLATFORM SOCKET, OFF-DEVICE — `react-native-tcp-socket` as the shims meet it, over
 * real node sockets. The rules kept are the ones the device showed: ONE receiver per connection
 * whose bytes reach EVERY JavaScript socket on that connection (an upgrade adds a second one), a
 * pause from ANY of them pauses that shared receiver, and a STARTTLS upgrade announces nothing —
 * its peer certificate answers only once the handshake is done.
 */
interface Conn {
  raw: net.Socket; paused: boolean; held: Buffer[]; sockets: Set<PlatformSocket>; pauses: number;
  readonly options: DoubleOptions;
}

/**
 * HOW THE PLATFORM ENDS A REFUSED UPGRADE, when a case asks. Absent, the double behaves as before.
 *
 * `unregisterOnClose`: the library's JavaScript socket drops every native listener on `close`
 * (react-native-tcp-socket 6.4.2 `Socket.js` `_setDisconnected`), so an event after it is unheard.
 * `refusedUpgrade`: the order a refused handshake's two events arrive in — `close-first` is Android
 * before the transport patch carried the reason, `error-first` is iOS and the patched Android.
 * `say`: the platform's own words for node's refusal.
 * `refusedDial`: the platform's words for a refused implicit-TLS handshake, reported the way
 * Android's module reports a failed `connect`: the `error` alone, no `close` after it.
 */
export interface DoubleOptions {
  unregisterOnClose?: boolean;
  refusedUpgrade?: "close-first" | "error-first";
  say?: (err: Error) => string;
  refusedDial?: (err: Error) => string;
}

export class PlatformSocket extends EventEmitter {
  _paused = false;
  private own: Buffer[] = [];
  constructor(readonly conn: Conn) {
    super();
    conn.sockets.add(this);
  }
  deliver(b: Buffer): void {
    if (this._paused) this.own.push(b);
    else this.emit("data", b);
  }
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this.conn.paused = true;
    this.conn.pauses += 1;
    this.conn.raw.pause();
  }
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    for (const b of this.own.splice(0)) this.emit("data", b);
    this.conn.paused = false;
    for (const b of this.conn.held.splice(0)) dispatch(this.conn, b);
    this.conn.raw.resume();
  }
  write(chunk: Buffer, _enc: unknown, cb?: (e?: Error) => void): boolean {
    return this.conn.raw.write(chunk, (e) => cb?.(e ?? undefined));
  }
  end(): void { this.conn.raw.end(); }
  destroy(): void { this.conn.raw.destroy(); }
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(): this { return this; }
  address(): object { return {}; }
  getPeerCertificate(): Promise<object> { return Promise.resolve({}); }
}

/** Over a SNAPSHOT, as React Native's emitter does: a socket joining mid-delivery gets later bytes. */
function dispatch(conn: Conn, b: Buffer): void {
  if (conn.paused) { conn.held.push(b); return; }
  for (const s of [...conn.sockets]) s.deliver(b);
}

/** A native event to every socket registered on the connection; a `close` unregisters where asked. */
function report(conn: Conn, event: "error" | "close", payload: unknown): void {
  for (const s of [...conn.sockets]) {
    if (event === "close" && conn.options.unregisterOnClose === true) conn.sockets.delete(s);
    s.emit(event, payload);
  }
}

function wire(conn: Conn, raw: net.Socket): void {
  raw.on("data", (b: Buffer) => dispatch(conn, b));
  raw.on("error", (e) => report(conn, "error", e.message));
  raw.on("close", () => report(conn, "close", false));
}

/**
 * `wire`, for an implicit-TLS dial whose refusal is said as Android says a failed `connect`:
 * `TcpSocketModule.connect`'s catch sends the failure's message as `error`, and the socket is
 * already closed when the library's destroy reaches it, so no `close` follows. After the
 * handshake the connection reports as `wire` does.
 */
function wireRefusingDial(conn: Conn, raw: net.Socket, words: (err: Error) => string): void {
  let secured = false;
  raw.once("secureConnect", () => { secured = true; });
  raw.on("data", (b: Buffer) => dispatch(conn, b));
  raw.on("error", (e: Error) => report(conn, "error", secured ? e.message : words(e)));
  raw.on("close", () => { if (secured) report(conn, "close", false); });
}

/** The TLS socket an upgrade hands back: the SAME connection, a second JavaScript socket on it. */
class UpgradedSocket extends PlatformSocket {
  private readonly done: Promise<object>;
  constructor(under: PlatformSocket, options: { servername?: string; ca?: string }, ca: string) {
    super(under.conn);
    const conn = under.conn;
    const plain = conn.raw;
    plain.removeAllListeners("data");
    const order = conn.options.refusedUpgrade;
    /* The upgrade's end is reported once, by the platform's rule, so the plain socket says nothing. */
    if (order !== undefined) { plain.removeAllListeners("error"); plain.removeAllListeners("close"); }
    const secure = tls.connect({ socket: plain, servername: options.servername ?? "localhost", ca, rejectUnauthorized: true });
    conn.raw = secure;
    this.done = new Promise((resolve) => {
      secure.once("secureConnect", () => resolve(secure.getPeerCertificate() as object));
      secure.once("error", () => resolve({}));
    });
    if (order === undefined) { wire(conn, secure); return; }
    let secured = false;
    secure.once("secureConnect", () => { secured = true; wire(conn, secure); });
    secure.once("error", (e: Error) => {
      if (secured) return;
      const said = conn.options.say ? conn.options.say(e) : e.message;
      if (order === "close-first") { report(conn, "close", false); report(conn, "error", said); }
      else { report(conn, "error", said); report(conn, "close", true); }
      plain.destroy();
    });
  }
  override getPeerCertificate(): Promise<object> { return this.done; }
}

/**
 * The module the shims `require`, bound to a test CA. `conns` is every connection it opened.
 * `options` is read at each connection, so a case may change it between dials.
 */
export function platformDouble(ca: string, options: DoubleOptions = {}): { module: object; conns: Conn[] } {
  const conns: Conn[] = [];
  const open = (raw: net.Socket, wireIt: (conn: Conn, raw: net.Socket) => void = wire): PlatformSocket => {
    const conn: Conn = { raw, paused: false, held: [], sockets: new Set(), pauses: 0, options: { ...options } };
    conns.push(conn);
    wireIt(conn, raw);
    return new PlatformSocket(conn);
  };
  return {
    conns,
    module: {
      createConnection: (o: { host: string; port: number }) => {
        const s = open(net.connect(o.port, o.host));
        s.conn.raw.once("connect", () => s.emit("connect"));
        return s;
      },
      connectTLS: (o: { host: string; port: number; servername?: string }) => {
        const raw = tls.connect({ host: o.host, port: o.port, servername: o.servername ?? "localhost", ca, rejectUnauthorized: true });
        const words = options.refusedDial;
        const s = open(raw, words === undefined ? wire : (conn, r) => wireRefusingDial(conn, r, words));
        raw.once("secureConnect", () => { s.emit("connect"); s.emit("secureConnect"); });
        return s;
      },
      TLSSocket: class { constructor(under: PlatformSocket, o: { servername?: string }) { return new UpgradedSocket(under, o, ca) as never; } },
      isIP: (h: string) => net.isIP(h), isIPv4: (h: string) => net.isIPv4(h), isIPv6: (h: string) => net.isIPv6(h),
    },
  };
}
