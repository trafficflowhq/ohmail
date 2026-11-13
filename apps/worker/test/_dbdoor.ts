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
 * Sessions are ENDED, not destroyed: postgres.js defers writes and a socket destroyed with one still
 * buffered makes it throw from a timer (`src/driver-write-race.ts`).
 */
export class DbDoor {
  port = 0;
  /** Dials this door has accepted. */
  dials = 0;
  closeAfter: number | null = null;
  mute: (dial: number) => boolean = () => false;
  muted = 0;
  private server: net.Server | null = null;
  private readonly sessions: Array<{ client: net.Socket; upstream: net.Socket; mute: boolean }> = [];
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
    for (const s of this.sessions) if (!s.mute) { s.client.resume(); s.upstream.resume(); }
    if (this.server) return;
    const server = net.createServer((client) => {
      this.dials++;
      const upstream = net.createConnection(this.target);
      const session = { client, upstream, mute: false };
      this.sessions.push(session);
      const end = (): void => {
        const at = this.sessions.indexOf(session);
        if (at >= 0) this.sessions.splice(at, 1);
        if (session.mute) { session.mute = false; this.muted--; }
        client.destroy();
        upstream.destroy();
      };
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
      } else {
        client.pipe(upstream);
      }
      if (this.stalled) { client.pause(); upstream.pause(); }
      if (this.closeAfter !== null && this.dials >= this.closeAfter) { server.close(); this.server = null; }
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
