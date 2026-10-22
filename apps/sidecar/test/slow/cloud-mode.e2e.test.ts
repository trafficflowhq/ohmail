import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectOverStdio, type StdioClient } from "../../src/client.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * CLOUD MODE, END TO END THROUGH THE REAL PROCESS ENTRY POINT — with an IMAP CANARY.
 *
 * This is the runtime half of the structural safety `cloud-engine-census.test.ts` proves statically.
 * It spawns `main.ts` exactly as the desktop shell does — `node --import tsx/esm src/main.ts` — with
 * `OHMAIL_MODE=cloud`, against an in-process fake Cloud API, and watches TWO things:
 *
 *  1. the mirror actually fills: the child pulls the fake `/sync` + `/messages/bodies` feed and the
 *     Swift-facing local `/sync` (served over the same stdio bridge) surfaces the message; and
 *  2. NOTHING connects to the IMAP CANARY — a TCP listener planted where an IMAP host would be
 *     read. Any connection to it fails the test.
 *
 * ── THE CANARY, AND HOW TO WATCH IT BITE ──────────────────────────────────────────────────────
 *
 * The refusal case plants the canary's address in `OHMAIL_IMAP_HOST`/`OHMAIL_IMAP_PORT` and asserts
 * that `main.ts` REFUSES to start (Cloud mode does not open IMAP, by construction, not by the
 * absence of a value). Temporarily route Cloud mode through `createSidecar` (the IMAP path) instead
 * of `createCloudSidecar`, and that same env makes the engine build an `ImapAdapter` and dial the
 * canary — so `imapConnections` becomes non-zero and this test goes RED. Restore, and it is green.
 */

// `../..`, because this file is in `test/slow/`: a runtime path is not an import specifier and
// the move did not rewrite it — the spawn then looked for `test/src/main.ts` and every case
// failed on the child's own module resolution.
const SIDECAR_DIR = fileURLToPath(new URL("../..", import.meta.url));

interface FakeCloud {
  server: HttpServer;
  url: string;
  /** The message the feed carries — the test asserts the mirror surfaces exactly this id. */
  messageId: string;
  threadId: string;
  refreshes: number;
}

/** A fake hosted API: `/sync` returns one page then drains, `/messages/bodies` one body, `/auth/refresh` rotates. */
async function startFakeCloud(): Promise<FakeCloud> {
  const messageId = randomUUID();
  const threadId = randomUUID();
  const iso = new Date().toISOString();
  const fake: Partial<FakeCloud> = { messageId, threadId, refreshes: 0 };

  /* The account's ONE mailbox, named by the message and served by `GET /mailboxes`. It used to be
     a throwaway `randomUUID()` per DTO, which was harmless while the mirror re-attributed every
     message to the local placeholder row and is not now: the id on the wire is the id the row gets,
     so the feed and the mailbox list have to agree the way a real account's do. */
  const mailboxId = randomUUID();
  const messageDTO = {
    id: messageId, accountId: randomUUID(), mailboxId, threadId,
    messageIdHeader: `<${messageId}@sender.test>`, subject: "Hosted hello",
    from: { name: null, address: "stranger@nowhere.test" }, to: [], cc: [],
    date: iso, folder: "ohmail/Screener", snippet: "from the cloud", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso,
  };
  const threadDTO = {
    id: threadId, accountId: randomUUID(), subject: "Hosted hello", messageIds: [messageId],
    participants: [], lastMessageAt: iso, unreadCount: 1, muted: false, folder: "ohmail/Screener", updatedAt: iso,
  };

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // The mirror refreshes the account's mailboxes ahead of every drain and will not drain without
    // them — a message can only be filed under a mailbox row that exists.
    if (url.pathname === "/mailboxes") {
      return send(mailboxList([hostedMailbox(mailboxId, "me@ohmail.test")]));
    }
    if (url.pathname === "/sync") {
      const since = url.searchParams.get("since") ?? "0";
      // The bootstrap's rules-first pass asks `types=rule`, and the real route FILTERS. A fake that
      // answered the mixed page here would mirror the message during that pass — before the
      // opening window is even reached — so a poll for "mirrored" could return while the window
      // was still being refused and read `online` off a pull that then failed.
      if (url.searchParams.get("types") === "rule") {
        return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso });
      }
      if (since === "0") {
        send({
          changes: {
            creates: [
              { type: "thread", op: "create", id: threadId, seq: 1, updatedAt: iso, entity: threadDTO },
              { type: "message", op: "create", id: messageId, seq: 2, updatedAt: iso, entity: messageDTO },
            ],
            updates: [], moves: [], deletes: [],
          },
          cursor: "c2", hasMore: false, serverTime: iso,
        });
      } else {
        send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso });
      }
      return;
    }
    if (url.pathname === "/messages/bodies") {
      if (url.searchParams.get("after")) return send({ items: [], nextCursor: null });
      return send({ items: [{ messageId, text: "the full hosted body", html: "<p>the full hosted body</p>", loadedRemoteContent: false }], nextCursor: null });
    }
    if (url.pathname === "/auth/refresh" && req.method === "POST") {
      fake.refreshes = (fake.refreshes ?? 0) + 1;
      return send({ tokens: { accessToken: "rotated", refreshToken: "r2" } });
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { ...(fake as FakeCloud), server, url: `http://127.0.0.1:${port}` };
}

/**
 * A fake hosted API for the STALE-MIRROR TAG REPAIR, in two states it is switched between.
 *
 * `preFix`: `/sync` carries a message whose `labels` name a tag, and no `tag` change — the feed a
 * mirror was served while the drain still asked for eight of the feed's nine types. `/sync/snapshot`
 * is refused, which leaves the data directory in exactly the damaged shape (mail mirrored, zero
 * tags, a cursor advanced past the tags' own rows) and, on the way, proves a refused probe does not
 * stop the mirror from coming up and serving.
 *
 * `repaired`: `/sync` has nothing further to say — which is the whole problem, since the tag is old
 * and sits below that cursor for ever — and page 1 of `/sync/snapshot` carries the live state.
 */
interface TagCloud {
  server: HttpServer;
  url: string;
  messageId: string;
  threadId: string;
  tagId: string;
  /** Flip once the damaged directory exists, so the second launch meets a server that can repair it. */
  mode: "preFix" | "repaired";
  snapshotRequests: number;
}

async function startTagCloud(): Promise<TagCloud> {
  const messageId = randomUUID();
  const threadId = randomUUID();
  const tagId = randomUUID();
  const iso = new Date().toISOString();
  const state = { messageId, threadId, tagId, mode: "preFix", snapshotRequests: 0 } as TagCloud;

  const mailboxId = randomUUID();
  const messageDTO = {
    id: messageId, accountId: randomUUID(), mailboxId, threadId,
    messageIdHeader: `<${messageId}@sender.test>`, subject: "The invoice",
    from: { name: null, address: "billing@nowhere.test" }, to: [], cc: [],
    date: iso, folder: "ohmail/Paper Trail", snippet: "attached", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    // THE ASSIGNMENT, present on the wire the whole time. It was never the message that was
    // missing — it is that the tag it names was not asked for, so the apply had to drop it.
    triage: null, labels: [tagId], remoteContent: "none", updatedAt: iso,
  };
  const threadDTO = {
    id: threadId, accountId: randomUUID(), subject: "The invoice", messageIds: [messageId],
    participants: [], lastMessageAt: iso, unreadCount: 0, muted: false, folder: "ohmail/Paper Trail", updatedAt: iso,
  };
  const tagDTO = { id: tagId, name: "Invoices", hue: "clay", createdAt: iso, updatedAt: iso };

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/mailboxes") {
      return send(mailboxList([hostedMailbox(mailboxId, "me@ohmail.test")]));
    }
    if (url.pathname === "/sync/snapshot") {
      state.snapshotRequests++;
      if (state.mode === "preFix") { res.writeHead(503); res.end(); return; }
      return send({
        asOfSeq: 9,
        changes: [
          { type: "tag", op: "create", id: tagId, seq: 9, updatedAt: iso, entity: tagDTO },
          { type: "message", op: "create", id: messageId, seq: 9, updatedAt: iso, entity: messageDTO },
        ],
        nextCursor: null,
        window: { days: 90, minRows: 500 },
      });
    }
    if (url.pathname === "/sync") {
      const since = url.searchParams.get("since") ?? "0";
      // The bootstrap's rules-first pass asks `types=rule`, and the real route FILTERS. A fake that
      // answered the mixed page here would mirror the message during that pass — before the
      // opening window is even reached — so a poll for "mirrored" could return while the window
      // was still being refused and read `online` off a pull that then failed.
      if (url.searchParams.get("types") === "rule") {
        return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso });
      }
      if (since === "0") {
        return send({
          changes: {
            creates: [
              { type: "thread", op: "create", id: threadId, seq: 1, updatedAt: iso, entity: threadDTO },
              { type: "message", op: "create", id: messageId, seq: 2, updatedAt: iso, entity: messageDTO },
            ],
            updates: [], moves: [], deletes: [],
          },
          cursor: "c2", hasMore: false, serverTime: iso,
        });
      }
      return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso });
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/auth/refresh" && req.method === "POST") {
      return send({ tokens: { accessToken: "rotated", refreshToken: "r2" } });
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state.server = server;
  state.url = `http://127.0.0.1:${port}`;
  return state;
}

interface Canary {
  server: TcpServer;
  host: string;
  port: number;
  connections: number;
}

/** A TCP listener planted where an IMAP host would be read. Any connection is recorded. */
async function startCanary(): Promise<Canary> {
  const state: Canary = { server: undefined as unknown as TcpServer, host: "127.0.0.1", port: 0, connections: 0 };
  const server = createTcpServer((socket) => {
    state.connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  state.server = server;
  state.port = typeof addr === "object" && addr ? addr.port : 0;
  return state;
}

const KEK_HEX = "ab".repeat(32);
const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

const children: ChildProcessWithoutNullStreams[] = [];
const clients: StdioClient[] = [];
const servers: Array<{ close: () => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const cl of clients.splice(0)) cl.close();
  // Gone before its directory goes: on Windows a running engine's directory cannot be removed.
  for (const c of children.splice(0)) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    const gone = new Promise((r) => c.once("exit", r));
    c.kill("SIGKILL");
    await gone;
  }
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 50));
});

async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-cloud-e2e-");
  dirs.push(d);
  return d;
}

/** The base cloud environment — deliberately carries NO OHMAIL_IMAP_*. */
function cloudEnv(dataDir: string, cloudUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OHMAIL_MODE: "cloud",
    OHMAIL_DATA_DIR: dataDir,
    OHMAIL_CLOUD_URL: cloudUrl,
    OHMAIL_CLOUD_ACCESS_TOKEN: "access-first-launch",
    OHMAIL_CLOUD_REFRESH_TOKEN: "refresh-first-launch",
    OHMAIL_MAILBOX_ADDRESS: "me@ohmail.test",
    OHMAIL_KEK: KEK_HEX,
    OHMAIL_POLL_MS: "3600000", // never poll during the test; the first pull is the only one
  };
  // Guarantee the base case is genuinely free of any IMAP setting.
  for (const k of Object.keys(env)) if (k.startsWith("OHMAIL_IMAP_")) delete env[k];
  return env;
}

function launch(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  // `--import tsx`, NOT `tsx/esm`: the sidecar's graph mixes a CJS `sanitize-html` with an ESM
  // `htmlparser2` (via `@trafficflow/services`), and the pure-ESM loader throws
  // ERR_REQUIRE_CYCLE_MODULE on it under this Node; the `tsx` loader resolves the interop. It also
  // avoids the tsx CLI's IPC socket, which needs a writable TMPDIR sandboxed CI does not grant —
  // the same reason `apps/worker/test/cli.smoke.test.ts` spawns the loader rather than the CLI.
  const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", "src/main.ts"], {
    cwd: SIDECAR_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  return child;
}

describe("OHMAIL_MODE=cloud, spawned as the shell spawns it", () => {
  it(
    "pulls the hosted feed into the local mirror and never touches the IMAP canary",
    async () => {
      const cloud = await startFakeCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);

      const dataDir = await freshDir();
      const child = launch(cloudEnv(dataDir, cloud.url));
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
      clients.push(client);

      // The ready frame carries the per-launch bearer — it arrives once the bridge is serving.
      const ready = await client.ready();
      const token = ready.sessionToken;
      expect(token, `no ready frame. stderr:\n${stderr}`).toBeTruthy();

      // The pull runs after serving begins; poll the LOCAL /sync until the mirror holds the message.
      let seen = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !seen) {
        const res = await client.fetch("/sync?since=0", { headers: { authorization: `Bearer ${token}` } });
        if (res.status === 200) {
          const body = (await res.json()) as { changes: { creates: Array<{ type: string; id: string; entity?: { folder?: string } }> } };
          const msg = body.changes.creates.find((c) => c.type === "message" && c.id === cloud.messageId);
          if (msg) {
            expect(msg.entity?.folder).toBe("ohmail/Screener");
            seen = true;
          }
        }
        if (!seen) await new Promise((r) => setTimeout(r, 150));
      }
      expect(seen, `the mirror never surfaced the hosted message. stderr:\n${stderr}`).toBe(true);

      // An unauthenticated read is still refused — the bearer is the boundary, over stdio too.
      const anon = await client.fetch("/sync?since=0");
      expect(anon.status).toBe(401);

      // THE CANARY. A Cloud-mode pull opened no IMAP connection, because there is no IMAP path to open.
      expect(canary.connections, "cloud mode connected to the IMAP canary").toBe(0);
    },
    60_000,
  );

  it(
    "REFUSES to start when an OHMAIL_IMAP_* is present — the safe branch is chosen by construction",
    async () => {
      const cloud = await startFakeCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);

      const dataDir = await freshDir();
      const env = cloudEnv(dataDir, cloud.url);
      // Plant the canary exactly where an IMAP host would be read. If Cloud mode ever routed through
      // the IMAP engine, THIS is the socket it would dial — so the refusal below and the canary
      // assertion together are the load-bearing guarantee.
      env.OHMAIL_IMAP_HOST = canary.host;
      env.OHMAIL_IMAP_PORT = String(canary.port);

      const child = launch(env);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));

      // A non-zero exit, a structured refusal on stderr, and — the point — no dial of the canary.
      expect(code, `expected a non-zero exit. stderr:\n${stderr}`).not.toBe(0);
      const refusal = stderr.split("\n").flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
      }).find((e) => e.event === "cloud_start_failed");
      expect(refusal, `no structured cloud_start_failed. stderr:\n${stderr}`).toBeDefined();
      expect(canary.connections, "cloud mode dialed the IMAP canary — the safe branch was not chosen").toBe(0);
    },
    60_000,
  );

  it(
    "starts with NO token at all and serves the sign-in surface — still without dialling the canary",
    async () => {
      const cloud = await startFakeCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);

      const env = cloudEnv(await freshDir(), cloud.url);
      // The pre-auth launch: a URL and an address the shell knows, and no credential anywhere.
      delete env.OHMAIL_CLOUD_ACCESS_TOKEN;
      delete env.OHMAIL_CLOUD_REFRESH_TOKEN;

      const child = launch(env);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
      clients.push(client);

      // It SERVES. Before this it exited 1 with `cloud_start_failed`, which put "the engine did not
      // start" in front of somebody whose only problem was not having signed in yet.
      const ready = await client.ready();
      expect(ready.sessionToken, `a token-less cloud launch did not serve. stderr:\n${stderr}`).toBeTruthy();
      // And it says which state it is in, in the field the shell already reads for the local door.
      expect(ready.credentialState).toBe("absent");

      const health = await client.fetch("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ signedIn: false, online: false });

      const read = await client.fetch("/sync?since=0", {
        headers: { authorization: `Bearer ${ready.sessionToken}` },
      });
      expect(read.status).toBe(409);

      // THE CANARY. A launch with no session is the launch most likely to fall back to "well, try
      // the IMAP settings then" — it does not, because there is no IMAP path in this branch to fall
      // back to.
      expect(canary.connections, "a pre-auth cloud launch connected to the IMAP canary").toBe(0);
    },
    60_000,
  );

  it(
    "REFUSES a TOKEN-LESS cloud launch that carries an OHMAIL_IMAP_* — the separator is not relaxed",
    async () => {
      const cloud = await startFakeCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);

      const env = cloudEnv(await freshDir(), cloud.url);
      delete env.OHMAIL_CLOUD_ACCESS_TOKEN;
      delete env.OHMAIL_CLOUD_REFRESH_TOKEN;
      // The two conditions together, which is the combination the pre-auth surface introduced: no
      // hosted credential AND an IMAP setting in reach. "There is no session here anyway" is the
      // argument for letting this through, and it is exactly backwards — an install that fell
      // through to the IMAP path would become a second organizer of a mailbox Cloud already holds.
      env.OHMAIL_IMAP_HOST = canary.host;
      env.OHMAIL_IMAP_PORT = String(canary.port);

      const child = launch(env);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));

      expect(code, `expected a non-zero exit. stderr:\n${stderr}`).not.toBe(0);
      const refusal = stderr.split("\n").flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
      }).find((e) => e.event === "cloud_start_failed");
      expect(refusal, `no structured cloud_start_failed. stderr:\n${stderr}`).toBeDefined();
      expect(canary.connections, "a token-less cloud launch dialed the IMAP canary").toBe(0);
    },
    60_000,
  );

  it(
    "resumes from the SEALED token across a restart, with no environment token on the second launch",
    async () => {
      const cloud = await startFakeCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);
      void aKek; // the KEK is passed via env (KEK_HEX); this launch seals the first-launch token

      const dataDir = await freshDir();

      // ── LAUNCH ONE: first-launch tokens in the environment; the KEK seals them to disk. ──
      const first = launch(cloudEnv(dataDir, cloud.url));
      let firstErr = "";
      first.stderr.on("data", (d: Buffer) => { firstErr += d.toString(); });
      const c1 = connectOverStdio({ input: first.stdout, output: first.stdin, baseUrl: "http://sidecar" });
      clients.push(c1);
      const r1 = await c1.ready();
      expect(r1.sessionToken, `first launch did not serve. stderr:\n${firstErr}`).toBeTruthy();
      // Let the first pull run, then stop the launch the way the shell does.
      await new Promise((r) => setTimeout(r, 1500));
      c1.close();
      first.kill("SIGTERM");
      await new Promise<void>((resolve) => first.on("exit", () => resolve()));

      // ── LAUNCH TWO: NO environment token at all — the sealed pair is the only source. ──
      const env2 = cloudEnv(dataDir, cloud.url);
      delete env2.OHMAIL_CLOUD_ACCESS_TOKEN;
      delete env2.OHMAIL_CLOUD_REFRESH_TOKEN;
      const second = launch(env2);
      let secondErr = "";
      second.stderr.on("data", (d: Buffer) => { secondErr += d.toString(); });
      const c2 = connectOverStdio({ input: second.stdout, output: second.stdin, baseUrl: "http://sidecar" });
      clients.push(c2);
      const r2 = await c2.ready();
      // It came up and served — which it could only do by reading the sealed token.
      expect(r2.sessionToken, `second launch did not serve on the sealed token. stderr:\n${secondErr}`).toBeTruthy();
      const health = await c2.fetch("/health");
      expect(health.status).toBe(200);
      expect(canary.connections).toBe(0);
    },
    60_000,
  );

  it(
    "repairs a mirror that was bootstrapped before the drain asked for tags, on the next launch",
    async () => {
      const cloud = await startTagCloud();
      servers.push(cloud.server);
      const canary = await startCanary();
      servers.push(canary.server);
      const dataDir = await freshDir();

      // ── LAUNCH ONE — the damage, made rather than assumed. The message lands with its `labels` on
      //    the wire and no tag to hang them on, and the cursor advances past the point any future
      //    delta could carry one. This is the reported install.
      const first = launch(cloudEnv(dataDir, cloud.url));
      let firstErr = "";
      first.stderr.on("data", (d: Buffer) => { firstErr += d.toString(); });
      const c1 = connectOverStdio({ input: first.stdout, output: first.stdin, baseUrl: "http://sidecar" });
      clients.push(c1);
      const r1 = await c1.ready();
      expect(r1.sessionToken, `first launch did not serve. stderr:\n${firstErr}`).toBeTruthy();

      const auth1 = { headers: { authorization: `Bearer ${r1.sessionToken}` } };
      let mirrored = false;
      const seeded = Date.now() + 20_000;
      while (Date.now() < seeded && !mirrored) {
        const res = await c1.fetch("/sync?since=0", auth1);
        if (res.status === 200) {
          const body = (await res.json()) as { changes: { creates: Array<{ type: string; id: string }> } };
          mirrored = body.changes.creates.some((c) => c.type === "message" && c.id === cloud.messageId);
        }
        if (!mirrored) await new Promise((r) => setTimeout(r, 150));
      }
      expect(mirrored, `the first launch never mirrored the message. stderr:\n${firstErr}`).toBe(true);

      // The tag rail is EMPTY, and this is what was reported: mail present, no tag anywhere.
      const railBefore = await c1.fetch("/tags", auth1);
      expect(railBefore.status).toBe(200);
      expect((await railBefore.json() as { items: unknown[] }).items, "the pre-fix mirror should hold no tag").toHaveLength(0);
      // A probe that was refused did not stop the mirror serving — it is still online.
      expect(cloud.snapshotRequests, "the repair never probed").toBeGreaterThan(0);
      expect((await (await c1.fetch("/health")).json() as { online: boolean }).online).toBe(true);

      c1.close();
      first.kill("SIGTERM");
      await new Promise<void>((resolve) => first.on("exit", () => resolve()));

      // ── LAUNCH TWO — same data directory, and a hosted API that answers the probe. The delta has
      //    nothing to add and never will; everything below comes from the one-time repair.
      cloud.mode = "repaired";
      const env2 = cloudEnv(dataDir, cloud.url);
      delete env2.OHMAIL_CLOUD_ACCESS_TOKEN;
      delete env2.OHMAIL_CLOUD_REFRESH_TOKEN;
      const second = launch(env2);
      let secondErr = "";
      second.stderr.on("data", (d: Buffer) => { secondErr += d.toString(); });
      const c2 = connectOverStdio({ input: second.stdout, output: second.stdin, baseUrl: "http://sidecar" });
      clients.push(c2);
      const r2 = await c2.ready();
      expect(r2.sessionToken, `second launch did not serve. stderr:\n${secondErr}`).toBeTruthy();
      const auth2 = { headers: { authorization: `Bearer ${r2.sessionToken}` } };

      // THE RAIL, off the sidecar's own read surface — the route the window asks for its tags.
      let named: string | null = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && named === null) {
        const res = await c2.fetch("/tags", auth2);
        if (res.status === 200) {
          const items = (await res.json() as { items: Array<{ id: string; name: string }> }).items;
          const found = items.find((t) => t.id === cloud.tagId);
          if (found) named = found.name;
        }
        if (named === null) await new Promise((r) => setTimeout(r, 150));
      }
      expect(named, `the tag never came back. stderr:\n${secondErr}`).toBe("Invoices");

      // AND THE CHIP. A rail with no chips on any message is the half that would have been missed:
      // the assignments were dropped on the way in, so the tag alone lights nothing.
      const feed = await c2.fetch("/sync?since=0", auth2);
      const changes = (await feed.json() as { changes: { creates: Array<{ type: string; id: string; entity?: { labels?: string[] } }>; updates: Array<{ type: string; id: string; entity?: { labels?: string[] } }> } }).changes;
      const msg = [...changes.creates, ...changes.updates].find((c) => c.type === "message" && c.id === cloud.messageId);
      expect(msg?.entity?.labels, "the mirrored message did not regain its label").toEqual([cloud.tagId]);

      expect(canary.connections, "the repair dialed the IMAP canary").toBe(0);
    },
    90_000,
  );
});
