/**
 * A MAILBOX NOTHING COULD BE READ FROM IS NOT A QUIET MAILBOX — the phone's first sync, four arms.
 *
 * ── WHAT WAS MEASURED, AND WHY A THIRD ANSWER EXISTS ──────────────────────────────────────
 *
 * Driven through the phone's real composition (`startPhoneEngine` over `node:sqlite`, the
 * platform's own sockets, no adapter double) against a real IMAP server, the engine's honest-state
 * surface could not tell these apart:
 *
 *   · an EMPTY mailbox — `reachable: true`, `unreachableSince: null`, `signInRefused: false`,
 *     `first_sync_finished` in the log, nothing on screen;
 *   · a mailbox whose first sync materialised NOTHING — not one row in the mirror, ever — where
 *     the app showed the same empty screen under a hint promising that mail "lands here as it
 *     syncs". The failure rendered as its own healthy state.
 *
 * So the connection record carries a third answer, `firstSync`, derived from the engine's own two
 * facts — the import stamp the drain writes, and what the mirror holds for this mailbox — and
 * never from a clock.
 *
 * ── THE ARMS, AND THE ONE THE BRIEF PREDICTED WRONG ───────────────────────────────────────
 *
 *   (a) EMPTY — LOGIN accepted, LIST and SELECT answered, no mail. The import closes on the first
 *       drain: `finished`. An empty mailbox is a fact about the mailbox, not a failure.
 *   (b) UNREADABLE — the mail is there and every FETCH of it is refused, by a relay in front of
 *       the same server ({@link startFetchRefusingProxy}). `produced_nothing_readable`.
 *   (c) WORKS — the same mailbox, dialled directly: `finished`. The POSITIVE CONTROL over the
 *       instrument the others read — a rule whose ordinary case is not admitted measures nothing.
 *   (d) SETTLED, THEN THE LINK DIES — (c)'s mailbox with its relay destroyed under it. `reachable`
 *       goes false and `firstSync` STAYS `finished`, which is the control that makes this field
 *       something other than `!reachable` spelled twice.
 *
 * Arm (b) was expected to read `reachable: true`, and when this file was written it did NOT: a
 * FETCH refusal took the launch with it, so the engine recorded a dead connection and the app said
 * "Connection lost" over a server that had just signed it in. That reading was kept here as a
 * measurement, filed as its own defect, and has since been fixed in the shared engine — a tagged
 * `NO` or `BAD` to a FETCH is the server ANSWERING, so the launch keeps its login, the drain goes
 * on, and only a dead socket stamps `unreachableSince`. Arm (b) now reads what the brief predicted;
 * `refused-fetch-not-an-outage.imap.test.ts` holds the two classes and the heal.
 *
 * What the correction did NOT change is why this state's sentence is rendered BESIDE the link's
 * rather than ranked against it: arm (d) is a settled mailbox whose link then dies, where both
 * facts are true at once and neither is the other.
 *
 * And the last case is the heal — arm (b)'s relay stops refusing and the same engine drains again.
 * A mailbox that later reads becomes `finished`, so the state is a reading and not a verdict
 * recorded once.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT ──────────────────────────────────────────────────────
 *
 * `phone-engine-boot.test.ts`'s reason verbatim: this composes the whole engine over the DEVICE
 * store, so it needs `vitest.sqlite.config.ts`'s schema substitution. Under the default project it
 * states the premise rather than skipping silently, and it names the closed port rather than
 * skipping in silence when the fixture server is down.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { serviceUp } from "@trafficflow/db/testing";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** The compose fixture, by `phone-claim-own.imap.test.ts`'s reasoning and its variables. */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);

const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/**
 * A SERVER THAT SIGNS YOU IN AND THEN WILL NOT HAND OVER THE MAIL — a relay in front of the real
 * one, refusing the client's own content FETCHes with the server's own grammar.
 *
 * A relay rather than a hand-written IMAP server: the greeting, CAPABILITY, LOGIN, LIST, SELECT
 * and the lease's own reads and writes in `ohmail/_meta` are all the real server's, and exactly
 * one command class is answered differently. The refusal is a tagged `NO`, which is what a mailbox
 * over quota, a corrupted backend or a provider throttling body fetches actually sends. GreenMail
 * cannot be made hostile, so a bound like this is proved at a fake seam by construction.
 *
 * TWO EXEMPTIONS, and each is the arm this file needs rather than a simplification:
 *
 *   · the `ohmail/*` tree, because the organizer lease is READ by fetching `ohmail/_meta`.
 *     Refusing that makes the connection fail by the lease's own class and the mailbox reads
 *     unreachable for a different reason — a defect with a sentence of its own.
 *   · a FETCH that asks only for UIDs, which is the scan the dial itself runs. Refusing it means
 *     nothing ever reaches the ingest at all, and what is under test is a first sync that got as
 *     far as knowing the mail is there.
 *
 * Literals are consumed by length, so a message body carrying a line that looks like a tagged
 * command cannot be mistaken for one.
 */
interface FetchRefusingProxy {
  port: number;
  /** How many content FETCHes were refused — the evidence that the arm exercised what it claims. */
  readonly refused: number;
  /** Stop refusing, for the heal arm. Live connections honour it on their next command. */
  relent(): void;
  close(): Promise<void>;
}

async function startFetchRefusingProxy(target: { host: string; port: number }): Promise<FetchRefusingProxy> {
  let refusing = true;
  let refused = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    let pending = Buffer.alloc(0);
    let literalLeft = 0;
    /** The folder this connection last SELECTed — the `ohmail/*` exemption is keyed on it. */
    let selected = "";

    upstream.on("data", (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
    upstream.on("close", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());

    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (literalLeft > 0) {
          const take = Math.min(literalLeft, pending.length);
          if (take === 0) return;
          if (!upstream.destroyed) upstream.write(pending.subarray(0, take));
          pending = pending.subarray(take);
          literalLeft -= take;
          continue;
        }
        const nl = pending.indexOf("\r\n");
        if (nl === -1) return;
        const raw = pending.subarray(0, nl + 2);
        const line = pending.subarray(0, nl).toString("latin1");
        pending = pending.subarray(nl + 2);
        const literal = /\{(\d+)\+?\}$/.exec(line);
        const parts = line.split(" ");
        const tag = parts[0] ?? "";
        const verb = (parts[1] ?? "").toUpperCase();
        if (verb === "SELECT" || verb === "EXAMINE") {
          selected = parts.slice(2).join(" ").replace(/^"|"$/g, "");
        }
        const isFetch = verb === "FETCH" || (verb === "UID" && (parts[2] ?? "").toUpperCase() === "FETCH");
        const wantsContent = /\b(BODY|BODYSTRUCTURE|RFC822|ENVELOPE|BINARY)\b/i.test(line);
        if (refusing && isFetch && wantsContent && !selected.toLowerCase().startsWith("ohmail")) {
          refused += 1;
          if (!client.destroyed) client.write(`${tag} NO [UNAVAILABLE] this fixture will not hand over mail\r\n`);
          if (literal !== null) literalLeft = Number(literal[1]);
          continue;
        }
        if (!upstream.destroyed) upstream.write(raw);
        if (literal !== null) literalLeft = Number(literal[1]);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    get refused() { return refused; },
    relent() { refusing = false; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `node:sqlite` behind the phone's statement-runner contract, with a real yield in every call. */
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
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.prepare(sql).run(...params);
      });
    },
    async batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void> {
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
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
  };
}

interface Line { event: string; detail: Record<string, unknown> }

const open: PhoneEngine[] = [];
const dirs: string[] = [];
const proxies: FetchRefusingProxy[] = [];

/** A throwaway account on the fixture server — `auth.disabled` creates it on LOGIN. */
const freshUser = (): string => `t-${randomUUID()}@trafficflow.test`;

/** Put N messages in the account's INBOX, over a plain IMAP client this file owns. */
async function seedInbox(user: string, n: number): Promise<void> {
  const client = new ImapFlow({
    host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false,
  });
  await client.connect();
  try {
    for (let i = 0; i < n; i++) {
      const raw = [
        `From: sender${i} <sender${i}@example.test>`,
        `To: <${user}>`,
        `Subject: fixture message ${i}`,
        `Message-ID: <fixture-${i}-${randomUUID()}@example.test>`,
        `Date: Thu, 11 Sep 2026 10:0${i % 10}:00 +0000`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `body ${i}`,
        "",
      ].join("\r\n");
      await client.append("INBOX", Buffer.from(raw, "utf8"));
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function bootPhone(o: { user: string; port: number; lines: Line[] }): Promise<PhoneEngine> {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-first-sync-"));
  dirs.push(dir);
  const engine = await startPhoneEngine({
    exec: nodeExecutor(join(dir, "engine.sqlite")),
    imap: {
      host: HOST, port: o.port, secure: false,
      auth: { user: o.user, pass: "test" },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "a phone",
    installId: randomUUID(),
    keks: { 1: "c".repeat(64) },
    log: (event, detail) => { o.lines.push({ event, detail }); },
  });
  open.push(engine);
  return engine;
}

/** The one mailbox this composition seeded, and what its connection reports. */
function connectionOf(engine: PhoneEngine): {
  reachable: boolean; signInRefused: boolean; firstSync: string;
} {
  const states = Object.values(engine.runtimes().connection);
  expect(states, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  const c = states[0]!;
  return { reachable: c.reachable, signInRefused: c.signInRefused, firstSync: c.firstSync };
}

/** Every state this launch announced, in order — the once-per-CHANGE rule's evidence. */
const announced = (lines: readonly Line[]): unknown[] =>
  lines.filter((l) => l.event === "mailbox_first_sync_state").map((l) => l.detail.state);

afterEach(async () => {
  for (const e of open.splice(0)) await e.stop().catch(() => undefined);
  for (const p of proxies.splice(0)) await p.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!ON_DEVICE_STORE)("the phone's first sync, measured through the door", () => {
  it.skipIf(!SERVER_UP)(
    `(a) an EMPTY mailbox is finished, never unreadable — needs IMAP on ${HOST}:${PORT}`,
    async () => {
      const lines: Line[] = [];
      const engine = await bootPhone({ user: freshUser(), port: PORT, lines });
      await engine.resume();

      const conn = connectionOf(engine);
      expect(conn.reachable, "the server answered and signed this launch in").toBe(true);
      expect(conn.signInRefused).toBe(false);
      /* An empty mailbox HAS no mail, and the drain that finds none closes the import — so the
         Ohbox's ordinary empty state is the true one here. */
      expect(conn.firstSync).toBe("finished");
      expect(announced(lines)).toEqual(["finished"]);
    },
    120_000,
  );

  it.skipIf(!SERVER_UP)(
    "(b) a mailbox whose mail the server will not hand over reads produced_nothing_readable",
    async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const proxy = await startFetchRefusingProxy({ host: HOST, port: PORT });
      proxies.push(proxy);

      const engine = await bootPhone({ user, port: proxy.port, lines });
      await engine.resume();

      expect(proxy.refused, "the arm has to have refused something, or it measures nothing")
        .toBeGreaterThan(0);
      const conn = connectionOf(engine);
      expect(conn.signInRefused, "the sign-in was accepted; this is not a password problem").toBe(false);
      expect(conn.firstSync).toBe("produced_nothing_readable");
      /* AND THE LINK IS NOT BLAMED FOR IT. This read `false` when the file was written, which is
         what put the defect on the board; the engine now tells a refused FETCH from a dead socket,
         so `connectionSaid` is silent here and only the mailbox's own sentence is shown. The phone
         is asserted beside the desktop because the fix is in the shared engine, and a door-shaped
         fix would pass one of them. */
      expect(conn.reachable, "the server answered this pass and refused it; it did not go away")
        .toBe(true);
      expect(announced(lines)).toEqual(["produced_nothing_readable"]);
    },
    120_000,
  );

  it.skipIf(!SERVER_UP)(
    "(c) a mailbox that reads is finished — the positive control over the instrument",
    async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const engine = await bootPhone({ user, port: PORT, lines });
      await engine.resume();

      const conn = connectionOf(engine);
      expect(conn.reachable).toBe(true);
      expect(conn.firstSync).toBe("finished");
      expect(announced(lines)).toEqual(["finished"]);
    },
    120_000,
  );

  it.skipIf(!SERVER_UP)(
    "(d) a settled mailbox whose link then dies stays finished — this is not `!reachable` twice",
    async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const proxy = await startFetchRefusingProxy({ host: HOST, port: PORT });
      proxy.relent();
      proxies.push(proxy);

      const engine = await bootPhone({ user, port: proxy.port, lines });
      await engine.resume();
      expect(connectionOf(engine).firstSync).toBe("finished");

      /* The server goes away under a mailbox that has already been read to the end. */
      await proxy.close();
      await engine.resume().catch(() => undefined);
      const conn = connectionOf(engine);
      expect(conn.reachable, "the link is gone").toBe(false);
      expect(conn.firstSync, "and the first sync still finished — the Ohbox says nothing new")
        .toBe("finished");
      expect(announced(lines), "a link dying is not a first-sync state change").toEqual(["finished"]);
    },
    120_000,
  );

  it.skipIf(!SERVER_UP)(
    "a mailbox that later reads becomes finished — the state is a reading, not a verdict",
    async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const proxy = await startFetchRefusingProxy({ host: HOST, port: PORT });
      proxies.push(proxy);

      const engine = await bootPhone({ user, port: proxy.port, lines });
      await engine.resume();
      expect(connectionOf(engine).firstSync).toBe("produced_nothing_readable");

      proxy.relent();
      /* THE RE-DIAL LADDER IS WHAT STANDS BETWEEN THE ENGINE AND ITS NEXT CYCLE, and a press is
         honoured at most once per its first step — so pressing four times in a row dials once.
         The loop waits that step out between presses rather than pressing harder, which is the
         thing the floor exists to refuse. */
      for (let i = 0; i < 8 && connectionOf(engine).firstSync !== "finished"; i++) {
        await new Promise((r) => setTimeout(r, 6_000));
        await engine.resume().catch(() => undefined);
      }
      expect(connectionOf(engine).firstSync).toBe("finished");
      expect(announced(lines)).toEqual(["produced_nothing_readable", "finished"]);
    },
    120_000,
  );
});

describe.skipIf(ON_DEVICE_STORE)("the premise this file runs under", () => {
  it("states that the default project does not substitute the device schema", () => {
    expect(EXPECTED_DIALECT, "the dialect expectation must be SET, or this says nothing")
      .toBeDefined();
    expect(EXPECTED_DIALECT).not.toBe("sqlite");
  });
});
