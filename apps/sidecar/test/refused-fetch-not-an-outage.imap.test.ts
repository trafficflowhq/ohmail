/**
 * A SERVER THAT SIGNS YOU IN AND REFUSES TO HAND OVER THE MAIL HAS NOT GONE AWAY.
 *
 * ── WHAT WAS MEASURED ─────────────────────────────────────────────────────────────────────
 *
 * `phone-first-sync-unreadable.imap.test.ts` arm (b) recorded a prediction its own measurement
 * contradicted: against a relay that answers the client's content FETCHes with a tagged `NO`, the
 * mailbox read `reachable: false` with `unreachableSince` stamped, so the app said "Connection
 * lost. Reconnecting…" over a login the server had just accepted — and sent somebody to look at
 * their network. Driven again here through the DESKTOP composition with the same relay, the
 * reading was identical, which is what put the fix in the shared engine rather than on one door.
 *
 * The refusal is not per-message, and that is worth stating because it is the half of the ruling
 * this file could not build. It lands on a FOLDER's batched read — the arrival-date pass
 * (`UID FETCH … (UID ENVELOPE INTERNALDATE)`), the `RFC822.SIZE` pre-fetch, the body fetch — all
 * of which name a whole UID set and none of which has a message identity to record anything on.
 * So the refusal is per ATTEMPT: `mailbox_fetch_unavailable`, one line per settled pass.
 *
 * ── THE TWO CLASSES, AND WHY BOTH ARE HERE ────────────────────────────────────────────────
 *
 * A tagged `NO` or `BAD` to a FETCH is the server ANSWERING and declining the work: the socket is
 * up, the login stands, the lease has been read. A socket that dies mid-FETCH is an outage, and
 * `unreachableSince` is its field. A guard that only watched the first would be satisfied by an
 * engine that had stopped recording outages altogether, so the killed-socket case runs beside it
 * on the same relay and the same composition — it is the positive control over the instrument.
 *
 * The heal case is what makes "the session is kept" a measurement rather than a claim: the relay
 * relents and the mail arrives over the SAME login, counted on the wire. A build that closed the
 * connection and re-dialled would pass every other assertion in this file.
 *
 * GreenMail cannot be made hostile, so the refusal is produced by a relay in front of a real
 * server: the greeting, CAPABILITY, LOGIN, LIST, SELECT and the lease's own reads in `ohmail/_meta`
 * are all the real server's, and exactly one command class is answered differently.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import { createSidecar, fetchRefusal, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serviceUp } from "@trafficflow/db/testing";

/** The compose fixture, by `phone-first-sync-unreadable.imap.test.ts`'s variables and reasoning. */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

/** What the relay does with one client command. */
type Verdict = "pass" | "refuse" | "kill";

interface Relay {
  port: number;
  /** How many content FETCHes were declined — the evidence that an arm exercised what it claims. */
  readonly refused: number;
  /** How many LOGINs crossed this relay. ONE across a whole arm is "the session was kept". */
  readonly logins: number;
  /** Stop refusing. Live connections honour it on their next command. */
  relent(): void;
  close(): Promise<void>;
}

/**
 * A relay that answers one command class differently, and REMEMBERS NOTHING A CLIENT SENT.
 *
 * Two counters and no lines: the wire carries a `LOGIN` with a password on it, so this keeps
 * verdict counts rather than text and there is nothing here for an assertion to print.
 *
 * Literals are consumed by LENGTH, so a message body carrying a line that looks like a tagged
 * command cannot be mistaken for one. Two exemptions, each the arm this file needs:
 *
 *  · the `ohmail/*` tree, because the organizer lease is READ by fetching `ohmail/_meta` —
 *    refusing that fails the connection by the lease's own class, a different defect;
 *  · a FETCH that asks only for UIDs, which is the scan the dial itself runs. What is under test
 *    is a pass that got as far as knowing the mail is there.
 */
async function startRelay(
  target: { host: string; port: number },
  opts: { status: "NO" | "BAD" } | { kill: true },
): Promise<Relay> {
  let refusing = true;
  let refused = 0;
  let logins = 0;
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
        if (verb === "LOGIN" || verb === "AUTHENTICATE") logins += 1;
        if (verb === "SELECT" || verb === "EXAMINE") {
          selected = parts.slice(2).join(" ").replace(/^"|"$/g, "");
        }
        const isFetch = verb === "FETCH"
          || (verb === "UID" && (parts[2] ?? "").toUpperCase() === "FETCH");
        const wantsContent = /\b(BODY|BODYSTRUCTURE|RFC822|ENVELOPE|BINARY)\b/i.test(line);
        const verdict: Verdict =
          refusing && isFetch && wantsContent && !selected.toLowerCase().startsWith("ohmail")
            ? ("kill" in opts ? "kill" : "refuse")
            : "pass";
        if (verdict === "kill") {
          refused += 1;
          client.destroy();
          upstream.destroy();
          return;
        }
        if (verdict === "refuse") {
          refused += 1;
          const body = "status" in opts && opts.status === "BAD"
            ? `${tag} BAD this fixture will not hand over mail\r\n`
            : `${tag} NO [UNAVAILABLE] this fixture will not hand over mail\r\n`;
          if (!client.destroyed) client.write(body);
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
    get logins() { return logins; },
    relent() { refusing = false; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Line { event: string; detail: Record<string, unknown> }

const dirs: string[] = [];
const running: Sidecar[] = [];
const relays: Relay[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => undefined);
  for (const r of relays.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
      await client.append("INBOX", Buffer.from([
        `From: sender${i} <sender${i}@example.test>`,
        `To: <${user}>`,
        `Subject: fixture message ${i}`,
        `Message-ID: <refused-${i}-${randomUUID()}@example.test>`,
        `Date: Thu, 11 Sep 2026 10:0${i % 10}:00 +0000`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `body ${i}`,
        "",
      ].join("\r\n"), "utf8"));
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * The engine over the relay. The poll interval is long on purpose: every pass in this file is
 * driven by an explicit `syncUntilQuiet()`, so a timer firing between the drive and the read
 * would make the refusal counts a race rather than a measurement.
 */
async function boot(user: string, port: number, lines: Line[]): Promise<Sidecar> {
  const dir = await freshDataDir("ohmail-refused-fetch-");
  dirs.push(dir);
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: HOST, port, secure: false, auth: { user, pass: "test" } },
    machineName: "a desktop",
    pollIntervalMs: 600_000,
    log: (event: string, detail: Record<string, unknown>) => { lines.push({ event, detail }); },
  });
  await grantOrganizeConsent(sidecar);
  running.push(sidecar);
  return sidecar;
}

/** The one mailbox this composition seeds, and what its connection reports. */
function connectionOf(sidecar: Sidecar): {
  reachable: boolean; unreachableSince: Date | null; signInRefused: boolean; firstSync: string;
} {
  const states = Object.values(sidecar.connectionStates());
  expect(states, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  const c = states[0]!;
  return {
    reachable: c.reachable, unreachableSince: c.unreachableSince,
    signInRefused: c.signInRefused, firstSync: c.firstSync,
  };
}

const eventsNamed = (lines: readonly Line[], event: string): Line[] =>
  lines.filter((l) => l.event === event);

/** `start()` with a throw recorded rather than propagated — `organizer-lease.e2e.test.ts`'s rule. */
async function startRecording(s: Sidecar): Promise<string | null> {
  try {
    await s.start();
    return null;
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

describe.skipIf(!SERVER_UP)(
  `a refused FETCH is not an outage — needs IMAP on ${HOST}:${PORT}`,
  () => {
    it("leaves the mailbox reachable, keeps the login, and says so once per attempt", async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const relay = await startRelay({ host: HOST, port: PORT }, { status: "NO" });
      relays.push(relay);

      const sidecar = await boot(user, relay.port, lines);
      /* THE LAUNCH DOES NOT FAIL, and that is the first half of the fix: a drain the server
         declined used to leave `dialAndGate` by its catch, which closes the login it opened. */
      expect(await startRecording(sidecar), "a refused FETCH is not a failed launch").toBeNull();
      /* AND THE DRAIN KEEPS GOING. Two more passes over the same connection, driven rather than
         waited for. A build that took the refusal as an outage never reaches the second. */
      await sidecar.syncUntilQuiet();
      await sidecar.syncUntilQuiet();

      expect(relay.refused, "the arm has to have refused something, or it measures nothing")
        .toBeGreaterThan(2);
      expect(relay.logins, "one login served every pass — the session was kept, not re-dialled")
        .toBe(1);

      const conn = connectionOf(sidecar);
      expect(conn.signInRefused, "the sign-in was accepted; this is not a password problem")
        .toBe(false);
      expect(conn.reachable, "the server answered every pass, so the link is not what failed")
        .toBe(true);
      expect(conn.unreachableSince, "and no clock was started against the person's connection")
        .toBeNull();
      /* THE STATE THAT BELONGS HERE, and it is only reachable because of the line above: the
         first-sync tracker arms on a drain that came BACK, and the launch used to end instead. */
      expect(conn.firstSync).toBe("produced_nothing_readable");

      expect(eventsNamed(lines, "mailbox_connection_unavailable"),
        "an answering server was filed as a dead connection").toEqual([]);
      const said = eventsNamed(lines, "mailbox_fetch_unavailable");
      expect(said.length, "one line per settled attempt").toBeGreaterThan(2);
      for (const l of said) {
        expect(l.detail.status, "the refusal names itself from our own two-member set").toBe("NO");
        expect(l.detail.mailboxId).toBe(Object.keys(sidecar.connectionStates())[0]);
      }
    }, 180_000);

    it("reads a BAD the same way — the refusal is the status, not the wording", async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const relay = await startRelay({ host: HOST, port: PORT }, { status: "BAD" });
      relays.push(relay);

      const sidecar = await boot(user, relay.port, lines);
      expect(await startRecording(sidecar)).toBeNull();

      expect(relay.refused).toBeGreaterThan(0);
      expect(connectionOf(sidecar).reachable).toBe(true);
      const said = eventsNamed(lines, "mailbox_fetch_unavailable");
      expect(said.length).toBeGreaterThan(0);
      expect(said[0]!.detail.status).toBe("BAD");
      expect(eventsNamed(lines, "mailbox_connection_unavailable")).toEqual([]);
    }, 180_000);

    it("still calls a socket that dies mid-FETCH an outage — the other class, unchanged", async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      /* THE SAME RELAY AND THE SAME COMMANDS, cut instead of declined. A guard that only watched
         the refusal would be satisfied by an engine that had stopped recording outages at all. */
      const relay = await startRelay({ host: HOST, port: PORT }, { kill: true });
      relays.push(relay);

      const sidecar = await boot(user, relay.port, lines);
      await startRecording(sidecar);

      expect(relay.refused, "the arm has to have cut something").toBeGreaterThan(0);
      const conn = connectionOf(sidecar);
      expect(conn.reachable, "the link really is gone").toBe(false);
      expect(conn.unreachableSince, "so the person's clock IS started").not.toBeNull();
      const dead = eventsNamed(lines, "mailbox_connection_unavailable");
      expect(dead.length).toBeGreaterThan(0);
      expect(dead[0]!.detail.detectedBy).toBe("event");
      expect(eventsNamed(lines, "mailbox_fetch_unavailable"),
        "a dead socket is not a refusal, and the two lines must not both fire").toEqual([]);
    }, 180_000);

    it("reads the mail as soon as the server relents, over the login it kept", async () => {
      const lines: Line[] = [];
      const user = freshUser();
      await seedInbox(user, 6);
      const relay = await startRelay({ host: HOST, port: PORT }, { status: "NO" });
      relays.push(relay);

      const sidecar = await boot(user, relay.port, lines);
      expect(await startRecording(sidecar)).toBeNull();
      await sidecar.syncUntilQuiet();
      expect(connectionOf(sidecar).firstSync).toBe("produced_nothing_readable");

      relay.relent();
      await sidecar.syncUntilQuiet();

      const conn = connectionOf(sidecar);
      expect(conn.reachable).toBe(true);
      expect(conn.firstSync, "a mailbox that later reads is finished").toBe("finished");
      /* THE WHOLE CLAIM OF THIS FILE IN ONE NUMBER. The mail arrived over the connection the
         refused launch opened: nothing was closed, nothing re-dialled, and a build that had
         handled the refusal by tearing the session down would read 2 here and still be green
         on every other assertion above. */
      expect(relay.logins, "one login, start to finish").toBe(1);
      expect(eventsNamed(lines, "mailbox_reconnected"),
        "a refusal must not put the mailbox through the outage heal").toEqual([]);
      expect(eventsNamed(lines, "mailbox_connection_unavailable")).toEqual([]);
    }, 180_000);
  },
);

/**
 * THE PREDICATE ON ITS OWN — the two classes, and the two exclusions that keep them apart. No
 * server: these are the shapes the driver hands the engine, written out, so the arms above name
 * a behaviour and this names the rule they rest on.
 */
describe("what counts as a refused FETCH", () => {
  const imapflowNo = (command: string, status: "NO" | "BAD" = "NO"): Error =>
    Object.assign(new Error("Command failed"), {
      responseStatus: status, executedCommand: command,
      responseText: "this fixture will not hand over mail",
    });

  it("is a tagged NO or BAD to a FETCH, wrapped or not", () => {
    expect(fetchRefusal(imapflowNo("2F UID FETCH 1,2,3 (UID ENVELOPE INTERNALDATE)"))).toBe("NO");
    expect(fetchRefusal(imapflowNo("30 FETCH 1:* (BODY[])", "BAD"))).toBe("BAD");
    /* The adapter wraps, so a predicate reading only the outermost error answers `null` for the
       shape that actually arrives — the same `cause` walk every sibling in `engine.ts` makes. */
    expect(fetchRefusal(new Error("wrapped", {
      cause: imapflowNo("45 UID FETCH 6,5,4 (UID RFC822.SIZE)"),
    }))).toBe("NO");
  });

  it("is NOT a refusal of anything else the server was asked", () => {
    /* The scope is the one class this was measured on. A declined write — the `ohmail/*` tree,
       a move, an append — keeps recording an outage rather than being widened on an argument
       nobody has watched fail. */
    expect(fetchRefusal(imapflowNo("21 CREATE ohmail.Screener"))).toBeNull();
    expect(fetchRefusal(imapflowNo("33 UID MOVE 4 ohmail.Screener"))).toBeNull();
    expect(fetchRefusal(imapflowNo("40 APPEND INBOX {12}"))).toBeNull();
  });

  it("is NOT a dead socket, which is the other class entirely", () => {
    expect(fetchRefusal(new ImapConnectionClosedError())).toBeNull();
    expect(fetchRefusal(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })))
      .toBeNull();
    expect(fetchRefusal(Object.assign(new Error("Connection not available"), {
      code: "NoConnection",
    }))).toBeNull();
  });

  it("is NOT a refused sign-in, which has an answer of its own", () => {
    /* A `LOGIN` the server declines carries `responseStatus: "NO"` too. `signInRefused` is that
       answer and it suspends the automatic re-dial; folding the two together would give a wrong
       password the refusal's "keep polling" behaviour, which is what providers lock accounts for. */
    expect(fetchRefusal(Object.assign(new Error("Invalid credentials"), {
      responseStatus: "NO", executedCommand: "1 UID FETCH 1 (UID ENVELOPE)",
      authenticationFailed: true,
    }))).toBeNull();
  });

  it("is NOT a bare error, a string, or nothing at all", () => {
    expect(fetchRefusal(new Error("a bug in our own pipeline"))).toBeNull();
    expect(fetchRefusal("thrown text")).toBeNull();
    expect(fetchRefusal(null)).toBeNull();
    expect(fetchRefusal(undefined)).toBeNull();
  });
});
