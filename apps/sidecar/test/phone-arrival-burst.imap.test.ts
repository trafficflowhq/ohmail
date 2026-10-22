/**
 * A BURST OF ARRIVALS ON THE STANDALONE PHONE — each pass takes a page, never the whole pile.
 *
 * Driven through `startPhoneEngine` over `node:sqlite` against a real IMAP server, behind a relay
 * that charges the adapter's clock (`nowMs`, the shipped seam) for every KB the server sends: a
 * phone slower than this host, made deterministic. The burst lands while the phone is closed, and
 * the relay cuts the socket after any cycle that fails — the device reconnected three times. Before
 * the fix every pass dated the WHOLE burst before choosing its page, ran out of its 300 s clock,
 * and a fresh connection dated it all again: stuck. SQLite project, `phone-engine-boot`'s reason.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, IMAP_CYCLE_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import {
  PHONE_DATE_READ_COMMAND_SIZE, startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows,
} from "../src/mobile.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/engine.js";
import { serviceUp } from "@trafficflow/db/testing";

type Row = Record<string, unknown>;
const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      get(...p: unknown[]): unknown;
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);
const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

/** The phone's cost: 200 ms of its clock per KB received. The burst's dates alone outrun a pass. */
const MS_PER_KB = 200;
const BASE = 20;
const BURST = 4_000;
/** The adapter's default page. A pass that completes brings exactly this many in. */
const PAGE = 200;

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/** UIDs named by an IMAP sequence set — `1,2,5:9` is seven. */
function setSize(set: string): number {
  let n = 0;
  for (const part of set.split(",")) {
    const [a, b] = part.split(":");
    n += b === undefined ? 1 : Math.abs(Number(b) - Number(a)) + 1;
  }
  return n;
}

/**
 * The relay: forwards both ways, charges the phone's clock once armed, and measures the longest
 * DATE-LOOKUP RUN — UIDs asked by `UID FETCH … (… INTERNALDATE ENVELOPE)` with no body fetch in
 * between on that connection, which is one pass's ordering work. It can cut every live socket.
 * Commands are read line by line only to count; nothing is logged.
 */
interface CostRelay {
  port: number;
  clock(): number;
  arm(): void;
  cut(): void;
  /** The longest date-lookup run since `arm()`, and how many connections opened since. */
  readonly longestDateRun: number;
  readonly connectionsSinceArmed: number;
  close(): Promise<void>;
}

async function startCostRelay(target: { host: string; port: number }): Promise<CostRelay> {
  let charged = 0;
  let armed = false;
  let longest = 0;
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (armed) connections += 1;
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    let pending = "";
    let run = 0;
    upstream.on("data", (b: Buffer) => {
      if (armed) charged += (b.length / 1024) * MS_PER_KB;
      if (!client.destroyed) client.write(b);
    });
    client.on("data", (b: Buffer) => {
      const lines = (pending + b.toString("latin1")).split("\r\n");
      pending = (lines.pop() ?? "").slice(-65_536);
      for (const line of lines) {
        const m = /^\S+ UID FETCH (\S+) \(([^)]*)\)/i.exec(line);
        if (m === null) continue;
        if (/BODY|RFC822/i.test(m[2]!)) { run = 0; continue; }
        if (/INTERNALDATE/i.test(m[2]!) && /ENVELOPE/i.test(m[2]!)) run += setSize(m[1]!);
        if (armed) longest = Math.max(longest, run);
      }
      if (!upstream.destroyed) upstream.write(b);
    });
    const end = (): void => { client.destroy(); upstream.destroy(); };
    upstream.on("close", end); upstream.on("error", end);
    client.on("close", end); client.on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    clock: () => Date.now() + charged,
    arm: () => { armed = true; },
    cut: () => { for (const s of sockets) s.destroy(); sockets.clear(); },
    get longestDateRun() { return longest; },
    get connectionsSinceArmed() { return connections; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function nodeExecutor(file: string): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql, params): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Row[];
        const rows = columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql, params) { return serial(async () => { await yielded(); raw.prepare(sql).run(...params); }); },
    async batch(statements) {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...params);
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close() { try { raw.close(); } catch { /* already closed */ } },
  };
}

/** Old, read letters from one correspondent — the device's shape, past the Screener's cutline. */
async function deliver(user: string, n: number, tag: string): Promise<void> {
  const client = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await client.connect();
  try {
    for (let i = 0; i < n; i++) {
      const when = new Date(Date.now() - (100 + (i % 20)) * 86_400_000);
      const raw = [
        "From: Pal <pal@example.test>", `To: <${user}>`, `Subject: ${tag} ${i}`,
        `Message-ID: <${tag}-${i}-${randomUUID()}@example.test>`, `Date: ${when.toUTCString()}`,
        "Content-Type: text/plain; charset=utf-8", "", `${tag} ${i}`, "",
      ].join("\r\n");
      await client.append("INBOX", Buffer.from(raw, "utf8"), ["\\Seen"], when);
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

interface Line { event: string; detail: Record<string, unknown> }
const open: PhoneEngine[] = [];
const relays: CostRelay[] = [];
const dirs: string[] = [];

/* The case ends mid-drain, and a stop waits out the pass in flight for one drain interval before it
   ends the socket — longer than the default hook clock. */
afterEach(async () => {
  for (const e of open.splice(0)) await e.stop().catch(() => undefined);
  for (const r of relays.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 2 * DEFAULT_POLL_INTERVAL_MS);

async function bootPhone(o: {
  user: string; file: string; installId: string; relay: CostRelay; lines: Line[]; sizes?: (number | undefined)[];
}): Promise<PhoneEngine> {
  const engine = await startPhoneEngine({
    exec: nodeExecutor(o.file),
    imap: {
      host: "127.0.0.1", port: o.relay.port, secure: false,
      auth: { user: o.user, pass: "test" },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "a phone",
    installId: o.installId,
    keks: { 1: "d".repeat(64) },
    log: (event, detail) => {
      o.lines.push({ event, detail });
      /* The device's reconnects: a cycle that fails loses its socket. */
      if (event === "sync_cycle_failed") setImmediate(() => o.relay.cut());
    },
    /* The REAL adapter, dialled for real — only its clock is the relay's. */
    adapterFactory: (cfg, ctx) => {
      o.sizes?.push(cfg.dateReadCommandSize);
      return new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError, nowMs: o.relay.clock });
    },
  });
  open.push(engine);
  return engine;
}

/** Messages the phone's store holds, read beside the engine on a second, read-only handle. While the
 *  drain holds a page open (PERF-026: one commit per cycle page) the file refuses a second reader, so
 *  the reading is the last COMMITTED count — what a relaunch would read — and never a throw. The
 *  phone's own store has only the engine's one connection. */
let lastStored = 0;
function stored(file: string): number {
  let db: InstanceType<typeof sqlite.DatabaseSync>;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2_000 } as { readOnly: boolean });
    try { lastStored = Number((db.prepare("select count(*) as n from messages").get() as Row).n); } finally { db.close(); }
  } catch (err) {
    if (!/database is locked|SQLITE_BUSY/i.test(String(err))) throw err;
  }
  return lastStored;
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return test();
}

/** What went wrong, by event and error class — the evidence a red names. */
const faults = (lines: readonly Line[]): string => {
  const tally = new Map<string, number>();
  for (const l of lines) {
    if (!/failed|unavailable|reconnect/.test(l.event)) continue;
    const e = l.detail.err as { name?: unknown; bound?: unknown } | undefined;
    const key = `${l.event}${e ? `:${String(e.name)}${e.bound ? `/${String(e.bound)}` : ""}` : ""}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally].map(([k, n]) => `${k} x${n}`).join(", ");
};

/** Anything that ran out of one of the adapter's clocks — a cycle, a start or a re-dial's drain. */
const clockFailures = (lines: readonly Line[]): string[] => lines
  .map((l) => `${l.event}:${String((l.detail.err as { bound?: unknown } | undefined)?.bound ?? "")}`)
  .filter((k) => k.endsWith(":cycle_deadline") || k.endsWith(":read_deadline"));

describe.skipIf(!ON_DEVICE_STORE)("a burst of arrivals on the standalone phone", () => {
  it.skipIf(!SERVER_UP)(
    `drains a page per cycle and a re-dial asks only a window — needs IMAP on ${HOST}:${PORT}`,
    async () => {
      const user = `burst-${randomUUID()}@trafficflow.test`;
      const dir = mkdtempSync(join(tmpdir(), "ohmail-burst-"));
      dirs.push(dir);
      const file = join(dir, "engine.sqlite");
      const installId = randomUUID();
      const relay = await startCostRelay({ host: HOST, port: PORT });
      relays.push(relay);

      await deliver(user, BASE, "base");
      const first = await bootPhone({ user, file, installId, relay, lines: [] });
      expect(await first.claimHere({ by: "press" }), "the phone could not take its own free mailbox").toBe("claimed");
      expect(await until(() => stored(file) >= BASE, 60_000), "the first import never finished").toBe(true);
      await first.stop();
      open.splice(open.indexOf(first), 1);

      /* The burst lands while the phone is closed, so its first pass meets all of it at once. */
      await deliver(user, BURST, "burst");
      relay.arm();
      const lines: Line[] = [];
      const sizes: (number | undefined)[] = [];
      await bootPhone({ user, file, installId, relay, lines, sizes });

      /* One healthy pass loses its socket too, once, so a re-dial's own first pass is measured. The
         cut lands where the launch bound left the drain, and a page fetched before it still commits
         after it, so the drain across the re-dial is counted FROM the re-dial: a page the new
         connection brought in. Counted from the cut, the old socket's last page passed for it. */
      const firstPage = await until(() => stored(file) >= BASE + PAGE, 90_000);
      if (firstPage) relay.cut();
      const redialled = await until(() => relay.connectionsSinceArmed >= 2, 60_000);
      const atRedial = stored(file);
      const drained = redialled
        && await until(() => stored(file) >= Math.max(BASE + 3 * PAGE, atRedial + PAGE), 90_000);
      const why = `stored ${stored(file)} of ${BASE + BURST}, ${atRedial} at the re-dial; `
        + `clock failures [${clockFailures(lines).join(",")}]; `
        + `longest date lookup ${relay.longestDateRun} UIDs over ${relay.connectionsSinceArmed} connections; `
        + `faults [${faults(lines)}]`;
      /* The phone's composition sizes the date read for its link, and every dial carries it. */
      expect(PHONE_DATE_READ_COMMAND_SIZE).toBe(500);
      expect(new Set(sizes), `a dial without the phone's size — ${why}`).toEqual(new Set([PHONE_DATE_READ_COMMAND_SIZE]));
      expect(relay.longestDateRun, `a date command larger than the phone's — ${why}`).toBeLessThanOrEqual(PHONE_DATE_READ_COMMAND_SIZE);
      expect(clockFailures(lines), `a pass ran out of its clock — ${why}`).toEqual([]);
      expect(relay.connectionsSinceArmed, `the socket was never re-dialled — ${why}`).toBeGreaterThanOrEqual(2);
      expect(drained, `the burst did not drain a page per cycle across a re-dial — ${why}`).toBe(true);
      /* No pass, the re-dial's included, ordered the whole burst: a window, then the page. */
      expect(relay.longestDateRun, `a pass dated the whole burst — ${why}`).toBeLessThan(BURST);
      expect(IMAP_CYCLE_DEADLINE_MS, "the charge is calibrated against the shipped pass clock").toBe(300_000);
    },
    300_000,
  );
});

describe.skipIf(ON_DEVICE_STORE)("the premise this file runs under", () => {
  it("states that the default project does not substitute the device schema", () => {
    expect(EXPECTED_DIALECT, "the dialect expectation must be SET, or this says nothing").toBeDefined();
    expect(EXPECTED_DIALECT).not.toBe("sqlite");
  });
});
