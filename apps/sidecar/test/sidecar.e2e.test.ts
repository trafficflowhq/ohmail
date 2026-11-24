import type { EngineMessage } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { approvals, changeLog, folderState, mailboxCredentials, messages, routingDecisions } from "@trafficflow/db";
import { and, eq, sql } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * THE HEADLESS END-TO-END — the project's design notes, step 4.
 *
 * "Start with the headless end-to-end: sidecar assembly (`createApp` + on-disk PGlite +
 * `ImapAdapter` + the sync loop) against **GreenMail**, which de-risks PGlite and the whole
 * assembly before any UI or packaging."
 *
 * This is that test, and it is the one that decides whether the desktop tier is a real mail client
 * or an interface preview. Nothing here is mocked below the transport:
 *
 *  · a real IMAP server (GreenMail on 3143, `docker-compose.yml`), reached over a real socket;
 *  · a real message, appended by a separate ImapFlow client, as a stranger would send it;
 *  · the real pipeline — `runSyncCycle` from the worker, `planChange`/`commitChange`, the Screener
 *    rule that files first contact — writing to a real on-disk PGlite;
 *  · the real `createApp(apiRoutes)` behind the real stdio frame codec;
 *  · the real `HttpAdapter` + `OhmailEngine`, unmodified, given nothing but a `fetch`.
 *
 * The assertions that matter are the ones about the SERVER. Organize-in-place (the "Organize-in-place" invariant)
 * means the organization is not a row in our database, it is where the message physically sits in
 * the user's mailbox — so this checks the folder with a second, independent IMAP client, the way a
 * user checking in Apple Mail would.
 *
 * Docker is a hard requirement, deliberately and consistently with
 * `packages/core/test/adapters/imap.changes.test.ts`: a skip here would let the whole slice go
 * quietly unexercised, which is the state the project's design notes describes the desktop apps as
 * having been in all along.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);

/** A fresh GreenMail user per test → a mailbox nothing else has touched. */
function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" } };
}

function eml(o: { from: string; to: string; subject: string; messageId: string; body?: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Hello — we have not met before.",
  ].join("\r\n");
}

/** GreenMail exposes the tree with a `.` delimiter, so `ohmail/Screener` is `ohmail.Screener`. */
async function uidsIn(c: ImapFlow, serverPath: string, messageId: string): Promise<number[]> {
  const lock = await c.getMailboxLock(serverPath);
  try {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(r) ? r : [];
  } finally {
    lock.release();
  }
}

interface World {
  sidecar: Sidecar;
  host: StdioHost;
  client: StdioClient;
  dataDir: string;
  raw: ImapFlow;
  cfg: ReturnType<typeof greenmail>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.client.close();
    w.host.stop();
    await w.raw.logout().catch(() => undefined);
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
});

/**
 * Stand up the whole thing: on-disk PGlite, a live IMAP connection, the app behind the frame
 * codec, and a client on the other end of a pipe pair.
 *
 * `PassThrough`s stand in for the pipes a spawned child would get. What travels over them is byte
 * for byte what would travel over stdio — see `bridge.test.ts`'s header for why the process
 * boundary itself belongs to the packaging slice.
 */
async function standUp(): Promise<World> {
  const cfg = greenmail();
  const dataDir = await freshDataDir("ohmail-sidecar-e2e-");
  const sidecar = await createSidecar({
    dataDir,
    imap: cfg,
    address: cfg.auth.user,
    displayName: "This Mac",
    // Long enough that the poll never fires during a test — every cycle here is one the test
    // asked for, so a passing assertion is never a coincidence of timing.
    pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);

  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });

  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await raw.connect();

  const w: World = { sidecar, host, client, dataDir, raw, cfg };
  worlds.push(w);
  return w;
}

/** The UI tier, exactly as the shell would build it: `HttpAdapter` over the bridge's fetch. */
function clientEngine(w: World, store = new MemoryMirrorStore()): OhmailEngine {
  const adapter = new HttpAdapter({
    baseUrl: "http://sidecar",
    fetch: w.client.fetch,
    headers: () => ({ authorization: `Bearer ${w.sidecar.sessionToken}` }),
  });
  return new OhmailEngine({ adapter, store });
}

describe("the LOCAL engine, end to end against a real IMAP server", () => {
  it(
    "connect → sync → the Screener files first contact into a real ohmail/ folder → the client engine sees it through the bridge",
    async () => {
      const w = await standUp();

      // ── 1. A stranger writes. Appended by an INDEPENDENT client, so nothing about how the
      //       message got there involves the code under test.
      const messageId = `first-contact-${randomUUID()}@stranger.test`;
      await w.raw.append(
        "INBOX",
        eml({ from: "stranger@nowhere.test", to: w.cfg.auth.user, subject: "Can we talk?", messageId }),
      );

      // ── 2. The engine starts: connect, ensure the ohmail/* tree, drain the mailbox.
      await w.sidecar.start();

      // ── 3. THE SERVER IS THE PROOF. Organize-in-place (the "Organize-in-place" invariant): the message has physically
      //       MOVED on the user's own mailbox — out of INBOX, into a real folder any other mail
      //       client can see. This is the assertion that separates a mail client from a demo.
      expect(await uidsIn(w.raw, "ohmail.Screener", messageId), "the message is not in ohmail/Screener on the server").toHaveLength(1);
      expect(await uidsIn(w.raw, "INBOX", messageId), "the message is still in INBOX — nothing was organized").toHaveLength(0);

      // ── 4. …and the local mirror agrees with the server rather than merely intending to.
      // By `message_id_header`, not by `dedup_key`: since that change slice 2 the key is `fp1:<sha256>`
      // over every field a sender chooses, and this assertion is about the message this test
      // appended rather than about the key format.
      const [row] = await w.sidecar.db.select().from(messages)
        .where(eq(messages.messageIdHeader, messageId));
      expect(row, "the message was never ingested").toBeDefined();
      expect(row!.subject).toBe("Can we talk?");
      expect((row!.nativeLocator as { folder: string }).folder).toBe("ohmail/Screener");
      const [fs] = await w.sidecar.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
      expect(fs).toMatchObject({
        desiredFolder: "ohmail/Screener",
        observedFolder: "ohmail/Screener",
        reconcileStatus: "reconciled",
      });

      // ── 5. THE BRIDGE. The client engine is given nothing but a `fetch` that goes down a pipe;
      //       it does its ordinary bootstrap drain of `/sync` and ends up holding the message.
      const engine = clientEngine(w);
      await engine.start();
      const mirrored = engine.store.get<EngineMessage>("message", row!.id);
      expect(mirrored, "the client engine did not see the message through the stdio bridge").toBeDefined();
      expect(mirrored!.subject).toBe("Can we talk?");
      expect(mirrored!.folder).toBe("ohmail/Screener");
      expect(mirrored!.from.address).toBe("stranger@nowhere.test");

      // ── 6. RULES-ONLY, and provably so. No model is configured on this tier, so the Screener
      //       verdict came from `evaluateRules`' unknown-sender branch alone: no `routing_decision`
      //       (the pipeline writes one only on the AI branch), no `approval` waiting on the user,
      //       and — the "No API cost without revenue behind it" invariant, no API cost without revenue — not a single ledger row.
      expect(await w.sidecar.db.select().from(routingDecisions).where(eq(routingDecisions.messageId, row!.id))).toEqual([]);
      expect(await w.sidecar.db.select().from(approvals).where(eq(approvals.messageId, row!.id))).toEqual([]);
      // "not a single ledger row" is asserted as THE TABLE DOES NOT EXIST, which is the stronger
      // form and the only one a local install can make. `credit_ledger` is created by the CLOUD
      // journal; `openLocalDb` replays the MAIL journal and nothing else, so there is no ledger
      // here to be empty. Selecting from it used to pass because the barrel handed every consumer
      // both halves of the schema and the test database was built from both; once the desktop
      // engine stopped carrying the hosted half, the select failed with `relation "credit_ledger"
      // does not exist` — which is the guarantee arriving, not a regression.
      //
      // Read from the CATALOG rather than by catching an error: a query that throws proves only
      // that something went wrong, and this assertion has to fail if the table ever APPEARS.
      const ledgerRelation = await w.sidecar.db.execute(sql`
        select count(*)::int as n from information_schema.tables
          where table_schema = 'public' and table_name = 'credit_ledger'`);
      // The driver hands back `{ rows }` here and a bare array elsewhere; read either, and assert
      // a row came back BEFORE reading it — an absent row would otherwise make this pass without
      // the catalog ever having been asked.
      const ledgerRows = ((ledgerRelation as unknown as { rows?: Array<{ n: number }> }).rows
        ?? (ledgerRelation as unknown as Array<{ n: number }>));
      expect(ledgerRows.length, "the catalog query returned nothing — this check read no answer").toBe(1);
      expect(
        Number(ledgerRows[0]!.n),
        "the local database grew a credit_ledger — the desktop tier is free and runs the mail journal alone",
      ).toBe(0);

      // ── 7. ONE decision, not two. The whole reason the sidecar imports `runSyncCycle` instead of
      //       reimplementing it is that two engines file mail differently; a second driver racing
      //       this one would show up here as a second move in the change log.
      const moves = await w.sidecar.db
        .select()
        .from(changeLog)
        .where(and(eq(changeLog.entityId, row!.id), eq(changeLog.op, "move")));
      expect(moves).toHaveLength(1);
      expect(moves[0]!.meta).toMatchObject({ from: "INBOX", to: "ohmail/Screener" });
    },
    120_000,
  );

  it(
    "a second cycle neither re-ingests nor thrashes the folder",
    async () => {
      // The move is observed on the next pass as an `own_move`. Getting this wrong means a message
      // that ping-pongs between folders forever on somebody's real mailbox.
      const w = await standUp();
      const messageId = `idempotent-${randomUUID()}@stranger.test`;
      await w.raw.append("INBOX", eml({ from: "someone@else.test", to: w.cfg.auth.user, subject: "Twice?", messageId }));
      await w.sidecar.start();

      const cycles = await w.sidecar.syncUntilQuiet();
      expect(cycles).toBeGreaterThanOrEqual(1);

      const rows = await w.sidecar.db.select().from(messages)
        .where(eq(messages.messageIdHeader, messageId));
      expect(rows, "the message was ingested twice").toHaveLength(1);
      expect(await uidsIn(w.raw, "ohmail.Screener", messageId)).toHaveLength(1);
      expect(await uidsIn(w.raw, "INBOX", messageId)).toHaveLength(0);
    },
    120_000,
  );

  it(
    "the bridge serves the REAL API — an unauthenticated call is refused and `/events` cannot wedge it",
    async () => {
      const w = await standUp();

      // No bearer: the same `withSession` that guards Cloud guards the local engine. The desktop
      // tier skips the signup ceremony, not the authorization.
      const anon = await w.client.fetch("/sync?since=0");
      expect(anon.status).toBe(401);

      const authed = await w.client.fetch("/sync?since=0", {
        headers: { authorization: `Bearer ${w.sidecar.sessionToken}` },
      });
      expect(authed.status).toBe(200);

      /**
       * SSE MUST ANSWER AND STOP. A frame carries a COMPLETE response, and `GET /events` streams
       * forever — with `DEFAULT_SSE.enabled` (true) it would buffer until the process died, taking
       * the whole bridge with it. The sidecar disables it, so this returns a finite 503 and the
       * connection is still usable on the next line.
       */
      const sse = await w.client.fetch("/events", { headers: { authorization: `Bearer ${w.sidecar.sessionToken}` } });
      expect(sse.status).toBe(503);
      expect((await sse.json() as { error: { code: string } }).error.code).toBe("sse_disabled");
      expect((await w.client.fetch("/health")).status).toBeLessThan(500);
    },
    120_000,
  );

  it(
    "an install with no per-install key stores no credential, so a restart finds nothing it cannot read",
    async () => {
      /**
       * ── THIS PIN WAS FLIPPED ON PURPOSE, AND HERE IS WHAT IT USED TO SAY ──────────────────
       *
       * It used to assert that `mailbox_credentials` is empty FULL STOP, because the engine minted
       * a key per launch and a credential sealed under such a key is a mailbox the user cannot
       * reconnect to after a restart. It was written as a tripwire: "the day somebody persists one,
       * it is a red test rather than silent data loss." That day arrived — the shell now holds a
       * per-install key and credentials are persisted — so the tripwire fired as designed and this
       * is the change it was demanding, not a workaround for it.
       *
       * What replaces it is NARROWER and stronger. The rule is no longer "nothing is ever stored";
       * it is **a key that dies with the process may never seal anything to disk**. This launch is
       * exactly that case — `standUp()` passes no key — so the table must still be empty here, and
       * the write is refused loudly rather than skipped silently.
       *
       * The other half, the one that only exists because of this change, is
       * `apps/sidecar/test/restart.e2e.test.ts`: with a key supplied, the credential IS stored, its
       * ciphertext is not the password, and a second engine on the same directory opens the mailbox
       * with no password in its environment at all.
       */
      const w = await standUp();
      await w.sidecar.start();

      // Refused at the moment of the write, which is while the user is still looking at the
      // password field — not on the next launch, as a mailbox that mysteriously will not open.
      const res = await w.client.fetch(`/mailboxes/${w.sidecar.world.mailboxId}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${w.sidecar.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ imap: { ...w.cfg, user: w.cfg.auth.user, pass: w.cfg.auth.pass } }),
      });
      expect(res.status).toBe(503);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("install_key_absent");

      expect(await w.sidecar.db.select().from(mailboxCredentials)).toEqual([]);
    },
    120_000,
  );
});
