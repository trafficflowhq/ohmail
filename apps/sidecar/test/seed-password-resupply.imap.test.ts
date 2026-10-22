import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { serviceUp } from "@trafficflow/db/testing";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX WHOSE PASSWORD CHANGED IS RECOVERED WITHOUT REMOVING IT — the seed, end to end
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the 0.19.6 desktop: a mailbox the server had started refusing offered no way to
 * give ohmail the new password. The seal route re-points every mailbox it seals by detaching and
 * re-attaching it, and it EXCLUDES the seed — so on a one-mailbox install the new password was
 * stored while the runtime went on dialling the old one, with `signInRefused` suspending the
 * re-dial for good. Remove-and-add was the only way back, and on a large mailbox that is hours of
 * re-import to recover from a password change.
 *
 * ── A REAL ADAPTER, A REAL SERVER, AND ONE GATE IN FRONT OF IT ────────────────────────────
 *
 * No adapter double: `ImapAdapter` and imapflow throughout, against the compose fixture. The
 * fixture has authentication disabled and cannot refuse anybody, so the one thing this case is
 * about — a server that refuses the OLD password and admits the NEW — is expressed by a gate in
 * front of it, the same seam `phone-first-sync-unreadable.imap.test.ts` refuses FETCHes at. The
 * gate never logs a line and never keeps one: it compares and forwards.
 */

const HOST = process.env.OHMAIL_FIX020_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_FIX020_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_FIX020_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

interface PasswordGate {
  port: number;
  /** How many sign-ins this gate turned away — the fixture's own evidence that it fired. */
  readonly refused: number;
  close: () => Promise<void>;
}

/**
 * A SERVER THAT ADMITS EXACTLY ONE PASSWORD — every other sign-in is refused in the server's own
 * grammar, and everything that is not a sign-in is the real server's.
 *
 * Both mechanisms, because which one imapflow picks is the server's advertisement to make:
 * `LOGIN`, and `AUTHENTICATE PLAIN` with its payload on the continuation line. The secret is
 * compared and dropped — never logged, never stored, never put in a refusal.
 */
async function startPasswordGate(
  target: { host: string; port: number }, admits: string,
): Promise<PasswordGate> {
  let refused = 0;
  const sockets = new Set<net.Socket>();
  const unquote = (s: string): string => s.replace(/^"(.*)"$/, "$1");

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    let pending = Buffer.alloc(0);
    /** The tag of an `AUTHENTICATE PLAIN` whose payload is the next line this client sends. */
    let saslTag: string | null = null;

    upstream.on("data", (chunk: Buffer) => {
      /* The continuation the gate itself answers: the client must be told to send the payload,
         and forwarding the real server's `+` would put the exchange one step ahead of us. */
      if (saslTag !== null) return;
      if (!client.destroyed) client.write(chunk);
    });
    upstream.on("close", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());

    const refuse = (tag: string): void => {
      refused += 1;
      if (!client.destroyed) client.write(`${tag} NO [AUTHENTICATIONFAILED] wrong password\r\n`);
    };

    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const nl = pending.indexOf("\r\n");
        if (nl === -1) return;
        const raw = pending.subarray(0, nl + 2);
        const line = pending.subarray(0, nl).toString("latin1");
        pending = pending.subarray(nl + 2);

        if (saslTag !== null) {
          const tag = saslTag;
          saslTag = null;
          const fields = Buffer.from(line, "base64").toString("utf8").split("\0");
          if (fields[2] === admits) {
            /* ADMITTED, so the real exchange has to happen: the upstream never saw the verb, so
               the gate replays it as a LOGIN with the same identity it just read. */
            if (!upstream.destroyed) {
              upstream.write(`${tag} LOGIN "${fields[1] ?? ""}" "${fields[2]}"\r\n`);
            }
          } else refuse(tag);
          continue;
        }

        const parts = line.split(" ");
        const tag = parts[0] ?? "";
        const verb = (parts[1] ?? "").toUpperCase();
        if (verb === "LOGIN") {
          if (unquote(parts[3] ?? "") !== admits) { refuse(tag); continue; }
        } else if (verb === "AUTHENTICATE" && (parts[2] ?? "").toUpperCase() === "PLAIN") {
          if (parts.length > 3) {
            const fields = Buffer.from(parts[3]!, "base64").toString("utf8").split("\0");
            if (fields[2] !== admits) { refuse(tag); continue; }
          } else {
            saslTag = tag;
            if (!client.destroyed) client.write("+ \r\n");
            continue;
          }
        }
        if (!upstream.destroyed) upstream.write(raw);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    get refused() { return refused; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A relay that forwards everything and counts the connections it was asked for. */
async function startCountingRelay(
  target: { host: string; port: number },
): Promise<{ port: number; readonly dials: number; close: () => Promise<void> }> {
  let dials = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    dials += 1;
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get dials() { return dials; },
    close: async () => {
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(!SERVER_UP)("the seed's password can be replaced without removing the mailbox", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Refused {
    sidecar: Sidecar;
    mailboxId: string;
    /** How many sign-ins the gate turned away. */
    readonly refused: number;
    /** How many times the submission server was dialled through the relay; `null` without one. */
    readonly submissionDials: number | null;
    auth: Record<string, string>;
    events: { event: string }[];
    newPassword: string;
    connections: () => Promise<Record<string, unknown>[]>;
  }

  /**
   * An install whose seed the server now refuses — the state a password change leaves behind.
   * `withSubmission` decides whether this mailbox also has an outgoing server, which is the one
   * thing that decides whether a pass-only re-supply has a second row to carry the secret onto.
   */
  async function refusedInstall({ withSubmission }: { withSubmission: boolean }): Promise<Refused> {
    /* Generated here and never printed — the fixture's own credential rule. */
    const OLD = randomUUID();
    const NEW = randomUUID();
    const address = `t-${randomUUID()}@trafficflow.test`;

    const gate = await startPasswordGate({ host: HOST, port: PORT }, NEW);
    cleanups.push(() => gate.close());
    const relay = withSubmission
      ? await startCountingRelay({ host: HOST, port: SMTP_PORT })
      : null;
    if (relay) cleanups.push(() => relay.close());

    const dataDir = await freshDataDir("ohmail-resupply-");
    const events: { event: string }[] = [];
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "127.0.0.1", port: gate.port, secure: false,
        auth: { user: address, pass: OLD },
        ...(relay ? { smtp: { host: "127.0.0.1", port: relay.port, secure: false } } : {}),
      },
      address,
      machineName: "the computer whose password changed",
      // Long enough that every pass here is one this case asked for.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      /* A DURABLE KEY, because sealing a password is the whole case: without one the route
         refuses `install_key_absent` and nothing would be measured. */
      keks: { 1: randomBytes(32) },
      log: (event) => { events.push({ event }); },
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    /* THE LAUNCH IS REFUSED AND THE ENGINE STAYS UP — `start()` rethrows so the shell learns,
       and the mirror is served meanwhile. */
    await sidecar.start().catch(() => undefined);

    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const connections = async (): Promise<Record<string, unknown>[]> => {
      const res = await sidecar.handle(
        new Request("http://local/local/mailboxes/connections", { headers: auth }),
      );
      const parsed = await res.json() as { items?: Record<string, unknown>[] };
      return parsed.items ?? [];
    };
    const rows = await connections();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signInRefused).toBe(true);
    expect(gate.refused).toBeGreaterThan(0);

    return {
      sidecar,
      mailboxId: String(rows[0]!.mailboxId ?? rows[0]!.id),
      get refused() { return gate.refused; },
      get submissionDials() { return relay === null ? null : relay.dials; },
      auth, events, newPassword: NEW, connections,
    };
  }

  /** The re-supply, as the pane sends it: the password and nothing else. */
  async function resupply(run: Refused): Promise<Response> {
    return run.sidecar.handle(new Request(
      `http://local/local/mailboxes/${run.mailboxId}`,
      {
        method: "PATCH",
        headers: { ...run.auth, "content-type": "application/json" },
        body: JSON.stringify({ imap: { pass: run.newPassword } }),
      },
    ));
  }

  it("refuses the old password, takes the new one, and dials again", async () => {
    const run = await refusedInstall({ withSubmission: false });
    expect((await resupply(run)).status).toBe(200);

    const after = await run.connections();
    expect(after[0]!.signInRefused).toBe(false);
    expect(after[0]!.reachable).toBe(true);
    /* AND THE REFUSAL WAS CLEARED BY THE ACT, not by a relaunch: this engine never restarted. */
    expect(run.events.some((e) => e.event === "mailbox_sign_in_retry_armed")).toBe(true);
  });

  it("carries the same password onto the submission server this mailbox already has", async () => {
    const run = await refusedInstall({ withSubmission: true });
    const before = run.submissionDials!;
    expect((await resupply(run)).status).toBe(200);
    /* THE PATH BESIDE THE ONE THIS LANE IS ABOUT. The body names no outgoing server — the pane
       does not know it — so a route that took it literally would leave the `smtp` row on the old
       password and break sending one fix away from the fix. The relay counts the re-probe. */
    expect(run.submissionDials! - before).toBeGreaterThan(0);
    expect((await run.connections())[0]!.signInRefused).toBe(false);
  });
});
