import net from "node:net";
import { isDriverWriteRace } from "../src/driver-write-race.js";

/**
 * A DATABASE THAT CAN GO AWAY AND COME BACK: a loopback pass-through in front of the real Postgres,
 * for the supervisor's cases (the two cycle-level files keep their own smaller one).
 *
 * `down()` stops listening and ends every session: new dials are refused (ECONNREFUSED) and open
 * statements die, which is what a pooler falling over looks like. `down({ keepFirst: true })` leaves
 * the first session of this door standing — the supervisor's first contact is its lock session, so
 * the lock stays held while every pool connection is gone. `stall()` keeps every session open and
 * forwards nothing in either direction: a statement that is neither answered nor refused, the shape of
 * 12 November 2026. `up()` listens again on the same port and lets stalled sessions run on.
 *
 * `closeAfter` stops listening once that many dials were accepted and keeps their sessions: the lock's
 * dial is answered and the pool's is refused. `mute` picks sessions by their dial number (1 is the
 * first): such a session is served its handshake and goes mute at its first statement, which never
 * reaches the database. Nothing passes either way from then on and the door never closes it, not even
 * when the driver ends its side. `muted` counts those still open.
 *
 * `freeze(dial)` takes ONE ESTABLISHED session, by its dial number, and holds it: nothing passes
 * either way and neither side's close reaches the other, so the database can end its half (a
 * `pg_terminate_backend`) and the driver is never told. What is written meanwhile is kept, and
 * `thaw(dial)` lets it through late. `frozen` counts the sessions held. `cutAllAt` is the dial at
 * which the whole database goes away: the door stops listening and ends every session, that one
 * included.
 *
 * `holdAt` holds a session from a STATEMENT on. It is asked about everything a client writes, with the
 * text as written (a statement's first run on a session carries its text) and the session's dial; on a
 * yes the session is frozen with that write kept back, and `thaw` delivers it. `held` lists the dials
 * held that way. Read when a session is dialled.
 *
 * Sessions are ENDED, not destroyed: postgres.js defers writes and a socket destroyed with one still
 * buffered makes it throw from a timer (`src/driver-write-race.ts`).
 */
interface Session {
  dial: number; client: net.Socket; upstream: net.Socket;
  mute: boolean; frozen: boolean;
  /** Ended by the door itself (`down`), which a freeze does not hold back. */
  cut: boolean;
  /** Read by `holdAt`, so the door forwards its client's writes itself; `kept` is the one it held back. */
  watched: boolean; kept: Buffer | null;
  end: () => void;
}

export class DbDoor {
  port = 0;
  /** Dials this door has accepted. */
  dials = 0;
  closeAfter: number | null = null;
  mute: (dial: number) => boolean = () => false;
  muted = 0;
  frozen = 0;
  cutAllAt: number | null = null;
  holdAt: ((text: string, dial: number) => boolean) | null = null;
  readonly held: number[] = [];
  private server: net.Server | null = null;
  private readonly sessions: Session[] = [];
  private stalled = false;

  constructor(private readonly target: { host: string; port: number }) {}

  /** A door in front of the database `url` names. Not listening yet. */
  static to(url: string): DbDoor {
    const u = new URL(url);
    return new DbDoor({ host: u.hostname, port: Number(u.port || 5432) });
  }

  /** `url` with its host and port replaced by this door's. */
  via(url: string): string {
    const u = new URL(url);
    u.hostname = "127.0.0.1";
    u.port = String(this.port);
    return u.toString();
  }

  /** Take a port and stay closed: every dial is refused until `up()`. */
  async reserve(): Promise<this> {
    await this.up();
    this.down();
    return this;
  }

  async up(): Promise<void> {
    this.stalled = false;
    for (const s of this.sessions) if (!s.mute && !s.frozen) { s.client.resume(); s.upstream.resume(); }
    if (this.server) return;
    const server = net.createServer((client) => {
      this.dials++;
      const upstream = net.createConnection(this.target);
      const end = (): void => {
        // A frozen session outlives either side's close; only the door's own `down()` ends it.
        if (session.frozen && !session.cut) return;
        const at = this.sessions.indexOf(session);
        if (at >= 0) this.sessions.splice(at, 1);
        if (session.mute) { session.mute = false; this.muted--; }
        if (session.frozen) { session.frozen = false; this.frozen--; }
        client.destroy();
        upstream.destroy();
      };
      const session: Session = {
        dial: this.dials, client, upstream, mute: false, frozen: false, cut: false, watched: this.holdAt !== null, kept: null, end,
      };
      this.sessions.push(session);
      for (const s of [client, upstream]) { s.on("error", end); s.on("close", end); }
      upstream.pipe(client);
      if (this.mute(this.dials)) {
        client.on("data", (buf: Buffer) => {
          // Parse or Query: the first statement after the handshake. Paused, so the driver's own
          // close is never read and the session stays open.
          if (session.mute) return;
          if (buf[0] === 0x50 || buf[0] === 0x51) {
            session.mute = true;
            this.muted++;
            upstream.unpipe(client);
            client.pause();
            upstream.pause();
            return;
          }
          upstream.write(buf);
        });
      } else if (session.watched) {
        client.on("data", (buf: Buffer) => {
          if (!this.holdAt?.(buf.toString("latin1"), session.dial)) { upstream.write(buf); return; }
          session.kept = buf;
          this.held.push(session.dial);
          this.freeze(session.dial);
        });
      } else {
        client.pipe(upstream);
      }
      if (this.stalled) { client.pause(); upstream.pause(); }
      if (this.closeAfter !== null && this.dials >= this.closeAfter) { server.close(); this.server = null; }
      if (this.cutAllAt !== null && this.dials >= this.cutAllAt) { this.cutAllAt = null; this.down(); }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : this.port;
    this.server = server;
  }

  down(opts: { keepFirst?: boolean } = {}): void {
    this.server?.close();
    this.server = null;
    for (const s of this.sessions.slice(opts.keepFirst ? 1 : 0)) {
      s.cut = true;
      for (const sock of [s.client, s.upstream]) {
        sock.end();
        setTimeout(() => { sock.destroy(); }, 50).unref();
      }
    }
  }

  stall(): void {
    this.stalled = true;
    for (const s of this.sessions) { s.client.pause(); s.upstream.pause(); }
  }

  /** Hold the open session of that dial. Throws when there is none: a freeze of nothing proves nothing. */
  freeze(dial: number): void {
    const s = this.session(dial);
    if (s.frozen) return;
    s.frozen = true;
    this.frozen++;
    s.client.unpipe(s.upstream);
    s.upstream.unpipe(s.client);
    s.client.pause();
    s.upstream.pause();
  }

  /** Let a frozen session run on, with what was written to it meanwhile. One whose far side has gone is ended. */
  thaw(dial: number): void {
    const s = this.session(dial);
    if (!s.frozen) return;
    s.frozen = false;
    this.frozen--;
    if (s.client.destroyed || s.upstream.destroyed) { s.end(); return; }
    if (s.kept) { s.upstream.write(s.kept); s.kept = null; }
    if (s.watched) s.client.resume(); else s.client.pipe(s.upstream);
    s.upstream.pipe(s.client);
  }

  private session(dial: number): Session {
    const s = this.sessions.find((x) => x.dial === dial && !x.mute);
    if (!s) throw new Error(`the door has no open session of dial ${dial}`);
    return s;
  }
}

/**
 * A Postgres that answers every startup with one FATAL of `code` and closes: a refused credential
 * (28P01), a database that does not exist (3D000). Protocol 3's ErrorResponse, nothing more.
 */
export async function refusingPostgres(code: string): Promise<{ port: number; dials: () => number; close: () => void }> {
  const body = Buffer.from(`SFATAL\0VFATAL\0C${code}\0Mrefused\0\0`);
  const answer = Buffer.alloc(5 + body.length);
  answer.write("E", 0);
  answer.writeInt32BE(4 + body.length, 1);
  body.copy(answer, 5);
  let dials = 0;
  const server = net.createServer((s) => {
    dials++;
    s.on("error", () => { /* the driver's side may vanish */ });
    s.once("data", () => { s.end(answer); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr !== null ? addr.port : 0,
    dials: () => dials,
    close: () => { server.close(); },
  };
}

/**
 * postgres.js can throw from a timer when a session closes with a write still buffered; the deployed
 * process survives exactly that shape (`src/driver-write-race.ts`). A case that closes sessions lets
 * the same throw pass and hands every other one to the runner. Returns the undo.
 */
export function surviveDriverWriteRace(): () => void {
  const parked = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (err, origin) => {
    if (isDriverWriteRace(err)) return;
    for (const l of parked) l(err, origin);
  });
  return () => {
    process.removeAllListeners("uncaughtException");
    for (const l of parked) process.on("uncaughtException", l);
  };
}
