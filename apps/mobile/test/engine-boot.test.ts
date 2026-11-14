/**
 * THE ENGINE BOOTS ON THE MOBILE COMPOSITION AND REAL MAIL FLOWS.
 *
 * `bootEngine` is driven exactly as the connect screen drives it, with the platform half
 * swapped: `node:sqlite` behind the same `SqlExecutor` seam expo-sqlite implements, and the
 * adapter's default fetch talking to a REAL loopback HTTP server speaking the /sync contract
 * (snapshot bootstrap included). So the proof covers the whole substrate — composition → bearer
 * header → HttpAdapter → engine drain → SqlMirrorStore → sqlite — and the reopen at the end is
 * the phone's kill-and-relaunch: the mirror alone, no adapter, mail still there.
 *
 * The second suite is ruling risk 1: a dead sqlite host REFUSES, visibly. It must never fall
 * back to `MemoryMirrorStore` — that fallback boots, syncs and renders, and has silently turned
 * the app into a cold mirror that forgets everything on every kill. Reinstating such a fallback
 * in `boot.ts` turns these tests red (watched, not assumed).
 */
import { createServer, type Server } from "node:http";
import { sayRefusal } from "../src/refusal";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKLOG_PAGE_LIMIT,
  LAST_DRAIN_AT_META,
  NAMED_FEED_KINDS,
  STALE_RESUME_MS,
  SqlMirrorStore,
  decodeSeqCursor,
  encodeSeqCursor,
  mirrorDbName,
  ohboxView,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  MOBILE_SYNC_TYPES,
  bootEngine,
  dbFileName,
  mirrorOwnerKey,
  type MobileEngineDeps,
} from "../src/engine/boot";
import { logWithdrawUnsupported } from "../src/engine/engine-log";

/* ── node:sqlite behind the statement-runner seam ─────────────────────────────────────────────
 * Loaded through `createRequire` because vite 5.4's builtin list predates `node:sqlite` — a
 * static import gets the prefix stripped and dies resolving a package called `sqlite`. Same
 * shape as packages/client-engine/test/helpers/node-sql-executor.ts; duplicated because a test
 * may not import across workspace test trees. */
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function sqlWorld() {
  const dbs = new Map<string, DatabaseSync>();
  return {
    open: (name: string): SqlExecutor => {
      let db = dbs.get(name);
      if (!db) {
        db = new sqlite.DatabaseSync(":memory:");
        dbs.set(name, db);
      }
      return nodeSqlExecutor(db);
    },
    names: (): string[] => [...dbs.keys()],
    /**
     * DELETE the named database, the way a device does: the handle is closed and the file is
     * gone, so the next `open` of that name yields a NEW, EMPTY database. That last property is
     * what makes an absence assertion mean something — a double that merely emptied the tables
     * would let a forget "pass" while the physical database still existed under the same name.
     */
    drop: async (name: string): Promise<void> => {
      const db = dbs.get(name);
      dbs.delete(name);
      try {
        db?.close();
      } catch {
        /* already closed — the delete is what matters */
      }
    },
  };
}

/* ── a loopback server speaking the /sync contract ──────────────────────────────────────────── */

function messageDto(id: string, seq: number, subject: string, accountId = "acct-1", mailboxId = "mb-1") {
  return {
    id,
    accountId,
    mailboxId,
    threadId: null,
    messageIdHeader: `<${id}@fake>`,
    subject,
    from: { name: "Test Sender", address: "sender@fake.test" },
    to: [],
    cc: [],
    date: "2026-08-19T08:00:00Z",
    folder: "INBOX",
    snippet: subject,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-19T08:00:00Z",
    seqHint: seq,
  };
}

function fakeServer(opts: { accountId?: string; sessionRoute?: boolean } = {}) {
  const account = opts.accountId ?? "acct-1";
  // The desktop-host door mounts NO session read — `sessionRoute: false` is that composition.
  const sessionRoute = opts.sessionRoute !== false;
  // The change log — the server's one source of truth, exactly like the real SyncService.
  const log: SyncChange[] = [];
  const authSeen: Array<string | undefined> = [];
  const typesSeen: Array<string | null> = [];
  /** The `limit=` each /sync page asked for — `null` is "the server's own default". */
  const limitsSeen: Array<string | null> = [];
  let pullRings = 0;
  let seq = 0;

  const addMessage = (id: string, subject: string, mailboxId = "mb-1") => {
    seq += 1;
    log.push({
      type: "message",
      op: "create",
      id,
      seq,
      updatedAt: "2026-08-19T08:00:00Z",
      entity: messageDto(id, seq, subject, account, mailboxId),
    });
  };

  /**
   * THE RECEIPT A REMOVAL EMITS — one `mailbox` delete, no entity, exactly what `change-log.ts`
   * declares and what `SyncService` puts on the wire when a mailbox's mail comes off the store.
   */
  const removeMailbox = (mailboxId: string) => {
    seq += 1;
    log.push({ type: "mailbox", op: "delete", id: mailboxId, seq, updatedAt: "2026-08-19T08:05:00Z" });
  };

  /**
   * `?types=` IS HONOURED, because a fake that ignores it cannot fail the way the server does.
   * The filter is the client's whole contribution to what it receives: a phone whose list omits
   * a type is served nothing of that type, and a double answering everything would hand the
   * phone a receipt it never asked for and call the missing member fixed.
   */
  const visible = (raw: string | null): SyncChange[] => {
    if (raw === null) return log;
    const asked = new Set(raw.split(",").filter((t) => t !== ""));
    return log.filter((ch) => asked.has(ch.type as string));
  };

  const server: Server = createServer((req, res) => {
    authSeen.push(req.headers.authorization);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/auth/session") {
      if (!sessionRoute) {
        json(404, { error: { code: "not_found", message: "no such route" } });
        return;
      }
      json(200, { user: { accountId: account }, scope: "full" });
      return;
    }
    if (url.pathname === "/sync/pull" && req.method === "POST") {
      pullRings += 1;
      json(202, {
        requested: 1,
        requestedAt: "2026-08-19T09:00:00.000Z",
        mailboxes: [{ id: "mb-1", requestedAt: "2026-08-19T09:00:00.000Z" }],
      });
      return;
    }
    if (url.pathname === "/sync/snapshot") {
      /* Current state at one consistent point: every LIVE row as a create at `asOfSeq` — the
         windowed cold-connect path the phone takes (ruling risk 5's shape).
         LIVE, not the log: a snapshot is state, and the server answers a removed mailbox's rows
         with nothing at all rather than with a create followed by a receipt. Replaying the log
         here made a cold connect deliver the receipt whatever the `?types=` filter asked for —
         so a case about the filter passed with the filter broken, which is a fixture answering
         a question the server never answers. `?types=` is deliberately NOT read on this route:
         the engine sends none, because a snapshot carries state rather than vocabulary. */
      const goneMailboxes = new Set(
        log.filter((ch) => ch.type === "mailbox" && ch.op === "delete").map((ch) => ch.id),
      );
      const changes = log
        .filter((ch) => ch.type !== "mailbox")
        .filter((ch) => {
          const owner = (ch.entity as { mailboxId?: unknown } | undefined)?.mailboxId;
          return typeof owner !== "string" || !goneMailboxes.has(owner);
        })
        .map((ch) => ({ ...ch, seq }));
      json(200, { asOfSeq: seq, changes, nextCursor: null, window: { days: 90, minRows: 5000 } });
      return;
    }
    if (url.pathname === "/sync") {
      typesSeen.push(url.searchParams.get("types"));
      limitsSeen.push(url.searchParams.get("limit"));
      const since = url.searchParams.get("since") ?? "0";
      const from = since === "0" ? 0 : decodeSeqCursor(since);
      if (from === null) {
        json(410, { error: { code: "cursor_expired", message: "cursor expired" } });
        return;
      }
      const changes = visible(url.searchParams.get("types")).filter((ch) => ch.seq > from);
      json(200, {
        changes: { creates: changes, updates: [], moves: [], deletes: [] },
        cursor: encodeSeqCursor(Math.max(from, ...changes.map((c) => c.seq))),
        hasMore: false,
        serverTime: new Date().toISOString(),
      });
      return;
    }
    json(404, { error: { code: "not_found", message: "no such route" } });
  });

  return {
    server, addMessage, removeMailbox, authSeen, typesSeen, limitsSeen,
    currentSeq: () => seq, pullRings: () => pullRings,
  };
}

/** Listen on an ephemeral loopback port; answer the origin. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

/* ── the suites ─────────────────────────────────────────────────────────────────────────────── */

const world = sqlWorld();
const fake = fakeServer();
let origin = "";

beforeAll(async () => {
  origin = await listen(fake.server);
});

afterAll(() => {
  fake.server.close();
});

const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: () => "00000000-0000-4000-8000-000000000000",
};

describe("engine boot on the mobile composition", () => {
  it("wires the engine's unsupported-Cancel line to the phone's own engine log", async () => {
    const boot = await bootEngine(deps, { origin, token: "tok-wire", accountId: "acct-wire" });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;
    const said = (boot.engine as unknown as { withdrawUnsupported: unknown }).withdrawUnsupported;
    expect(said, "a server without the Cancel route goes unsaid on the phone").toBe(logWithdrawUnsupported);
  });

  it("bootstraps over the snapshot, applies a delta, and survives kill+relaunch", async () => {
    fake.addMessage("m1", "Welcome");
    fake.addMessage("m2", "Your invoice");

    const boot = await bootEngine(deps, { origin, token: "tok-123", accountId: "acct-1" });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;

    // The cold connect, in the app's own sequence: the identity verdict opens the drain
    // routes, then the snapshot bootstrap and the delta drain from asOfSeq.
    expect((await boot.verifyIdentity()).kind).toBe("verified");
    await boot.engine.start();
    const reader = boot.engine.read();
    expect(reader.list("message").length).toBe(2);
    expect(boot.store.getCursor()).toBe(encodeSeqCursor(2));

    // Real mail through the real selector — what the connect screen renders.
    const box = ohboxView(reader);
    expect(box.newForYou.map((m) => m.subject).sort()).toEqual(["Welcome", "Your invoice"].sort());

    // New mail lands server-side; one poll applies the DELTA — not a re-bootstrap.
    fake.addMessage("m3", "Fresh delta");
    await boot.engine.syncOnce();
    expect(reader.list("message").length).toBe(3);
    expect(boot.store.getCursor()).toBe(encodeSeqCursor(3));

    // Every request carried the bearer and nothing else was ever the credential.
    expect(fake.authSeen.length).toBeGreaterThan(0);
    for (const auth of fake.authSeen) expect(auth).toBe("Bearer tok-123");

    /* Every delta drain carried the client's complete type vocabulary (the cellular rule) —
       asserted against the DECLARATION, never against the filter itself. This read
       `toBe(MOBILE_SYNC_TYPES.join(","))`, which is the filter compared with the filter: green
       for every value it could possibly hold, including the one it held — a list missing
       `mailbox`, so the phone never asked for the receipt a removal emits. A guard that cannot
       name a wrong answer has no right one. */
    expect(fake.typesSeen.length).toBeGreaterThan(0);
    for (const t of fake.typesSeen) expect(t).toBe([...NAMED_FEED_KINDS].join(","));
    /* The settings record, by its wire name: it carries the calendar's switch, and a server sends
       the calendar only to a device that names it, so a phone without it would hold nothing of the
       calendar, and before that rule held what the switch and an erasure had taken away. */
    expect(MOBILE_SYNC_TYPES).toContain("settings");
    /* And the member the copy lost, by its WIRE name: the receipt that takes a removed mailbox
       off a phone. Spelled out rather than read from the declaration, because reading it from
       the thing under test is the tautology above wearing a different name. */
    expect(MOBILE_SYNC_TYPES).toContain("mailbox");
    /* The suggestion entity, the same way: the phone's badge (`screener.tsx`, `row.ai`) renders
       only what the drain asked for — a filter without this member is a phone that never shows
       a bought suggestion, with nothing red anywhere. */
    expect(MOBILE_SYNC_TYPES).toContain("screener_suggestion");

    // The mirror is named for (origin, account) through the SAME derivation the browser uses.
    const ownerKey = mirrorOwnerKey(origin, "acct-1");
    expect(boot.ownerKey).toBe(ownerKey);
    expect(world.names()).toContain(mirrorDbName(ownerKey));

    boot.store.close();

    // Kill + relaunch: the mirror ALONE — no adapter, no network — still holds the mailbox.
    const relaunched = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await relaunched.load();
    expect(relaunched.list("message").length).toBe(3);
    expect(relaunched.getCursor()).toBe(encodeSeqCursor(3));
    relaunched.close();
  });

  it("the doorbell survives the account guard — pull-to-refresh reaches `POST /sync/pull`", async () => {
    /* THE REGRESSION (2026-08-29, found live on the webapp's twin defect): `accountGuarded` is
       an explicit object literal — the whole surface the engine sees — and it shipped without
       forwarding `requestPull`. `OhmailEngine.requestPull` reads the absent capability as
       "this world has no worker to hurry" and returns null WITHOUT touching the wire, so every
       pull-to-refresh and Sync-now quietly degraded to the mirror drain — no error, no request,
       `boot-surface.test.ts` still green (it pins that the connection layer CALLS the ring,
       never that the ring can reach the wire). This drives the REAL boot and watches the
       server. Mutation-watched: deleting the `requestPull` forward from `accountGuarded`
       turned both assertions red; restored. */
    const boot = await bootEngine(deps, { origin, token: "tok-123", accountId: "acct-1" });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;
    expect((await boot.verifyIdentity()).kind).toBe("verified");

    expect(boot.engine.pullAvailable(), "the account guard dropped the doorbell").toBe(true);
    const before = fake.pullRings();
    const rang = await boot.engine.requestPull();
    expect(fake.pullRings(), "no POST /sync/pull reached the server").toBe(before + 1);
    expect(rang).not.toBeNull();
    expect(rang!.mailboxes).toEqual([{ id: "mb-1", requestedAt: "2026-08-19T09:00:00.000Z" }]);
    boot.store.close();
  });

  it("a STALE resume asks the engine's DENSE page — the backlog diet is inherited, not re-implemented", async () => {
    /* INSTANT-ARCH stage 3's client half reaches this app "automatically (one engine — the
       feedback-parity rule holds by construction)". That sentence is exactly the shape the
       pull-doorbell defect wore the day before it was written: one option on this app's own
       `new OhmailEngine({…})` — a `syncLimit` — suppresses the dense ask on the live path
       only, with every other suite green. So the inheritance is measured here rather than
       reasoned about: a mirror whose completion stamp is older than the threshold must ask
       `limit=2000` (`BACKLOG_PAGE_LIMIT`), and the steady-state drain before it must ask for
       no limit at all. Mutation-watched: `syncLimit: 500` in `bootEngine` turns this red. */
    const first = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    await first.verifyIdentity();
    await first.engine.start();
    // The steady-state ask: no `limit=`, the deployed page size.
    expect(fake.limitsSeen.every((l) => l === null)).toBe(true);
    // Age the mirror's own completion stamp past the shared threshold, on disk.
    await first.store.setMeta(
      LAST_DRAIN_AT_META,
      new Date(Date.now() - STALE_RESUME_MS - 60_000).toISOString(),
    );
    first.store.close();

    fake.limitsSeen.length = 0;
    const resumed = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    expect(resumed.kind).toBe("ready");
    if (resumed.kind !== "ready") return;
    await resumed.verifyIdentity();
    await resumed.engine.start();
    expect(fake.limitsSeen.length).toBeGreaterThan(0);
    for (const l of fake.limitsSeen) expect(l).toBe(String(BACKLOG_PAGE_LIMIT));
    resumed.store.close();
  });

  it("normalizes the origin into the mirror's owner key — one server, one mirror", () => {
    expect(mirrorOwnerKey("HTTP://Host.Example:8028/", "a1")).toBe(mirrorOwnerKey("http://host.example:8028", "a1"));
    expect(mirrorOwnerKey("http://host.example:8028", "a1")).not.toBe(mirrorOwnerKey("http://host.example:8028", "a2"));
    expect(mirrorOwnerKey("http://a.example", "a1")).not.toBe(mirrorOwnerKey("http://b.example", "a1"));
  });

  it("dbFileName is INJECTIVE — distinct owner keys can never share a file", () => {
    // A lossy sanitizer mapped these two onto one file; with two live handles on one collided
    // file, either engine can write after the other's __owner check — the stamp only referees
    // sequential opens. Injective encoding makes the collision unrepresentable.
    const a = dbFileName("ohmail-mirror:http://a-123::acct");
    const b = dbFileName("ohmail-mirror:http://a:123::acct");
    expect(a).not.toBe(b);
    // The escape character itself is escaped, so hand-crafted names cannot forge a collision…
    expect(dbFileName("x_3a_y")).not.toBe(dbFileName("x:y"));
    // …and the output stays a portable filename.
    for (const n of [a, b]) expect(n).toMatch(/^[A-Za-z0-9._-]+\.db$/);
  });
});

describe("the mirror is bound to the BEARER's account, not just the typed id", () => {
  /*
   * THE ASSERTION THAT USED TO STAND HERE — "no store is ever opened on a mismatch" — was an
   * ORDERING claim, not the merge guard, and boot-from-local (the ruling against the
   * network-blocked first frame) deliberately traded it: the boot now opens the device's own
   * mirror without asking the wire anything, and the identity probe answers AFTERWARDS through
   * `verifyIdentity`. The security property that actually protects the mailbox never moved and
   * is still pinned below twice over: the drain-time guard refuses every page naming another
   * account (so a mismatched bearer can render only what this device already stored under the
   * profile's own stamp, never merge anything), and the mismatch verdict still carries the
   * refusal sentence — the connection layer tears the live session down on it.
   */
  it("the boot NEVER waits on the wire — ready resolves while /auth/session hangs forever", async () => {
    // The load-order guarantee, as a race: a mutant that re-awaits the identity probe (or any
    // network call) before answering ready loses to the timeout and goes red here.
    const hang: MobileEngineDeps = {
      ...deps,
      fetch: () => new Promise<Response>(() => undefined),
    };
    const outcome = await Promise.race([
      bootEngine(hang, { origin, token: "tok-123", accountId: "acct-1" }),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(outcome).not.toBe("blocked");
    if (outcome === "blocked" || outcome.kind !== "ready") throw new Error("boot did not answer ready");
    // The deferred probe is pending against the hung wire — the boot did not consume it.
    outcome.store.close();
  });

  it("a bearer/id mismatch surfaces through verifyIdentity, and the drain still refuses the merge", async () => {
    // Account A's bearer beside account B's typed id: the boot opens B's stamped mirror (the
    // device's own data), the deferred probe answers the mismatch with the refusal sentence,
    // and the drain-time guard keeps A's pages out of B's mirror in the meantime.
    const boot = await bootEngine(deps, { origin, token: "tok-123", accountId: "acct-B" });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;
    const verdict = await boot.verifyIdentity();
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind !== "mismatch") return;
    expect(sayRefusal(verdict.reason)).toMatch(/belongs to account "acct-1", not "acct-B"/);
    // A mismatch NEVER opens the drain routes: no request the engine could make can move
    // this mirror — not even the entity-less pages (410s, deletes) the per-entity guard
    // cannot see. (The entity guard's own red line is pinned in the doorless test below.)
    await expect(boot.engine.start()).rejects.toThrow(/held until the account identity check settles/);
    expect(boot.store.getCursor()).toBe("0");
    boot.store.close();
  });

  it("NO drain can move the mirror before the identity verdict — early sync is refused loudly", async () => {
    // The structural half of the "Account isolation is absolute, and it binds staff too" invariant's cursor rule: a caller that forgets the
    // verify-then-drain sequence gets a refusal, never a mirror a wrong bearer could have
    // moved (410 wipe, entity-less cursor advance). A mutant that opens the drain routes
    // without the verdict — or drops the `cleared()` check — goes red here.
    const boot = await bootEngine(deps, { origin, token: "tok-123", accountId: "acct-1" });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;
    const cursorBefore = boot.store.getCursor(); // the warm mirror's resume point
    await expect(boot.engine.start()).rejects.toThrow(/held until the account identity check settles/);
    expect(boot.store.getCursor()).toBe(cursorBefore); // the refused drain moved NOTHING
    // The verdict settles ⇒ the routes open ⇒ the same drain now runs.
    expect((await boot.verifyIdentity()).kind).toBe("verified");
    await boot.engine.start();
    expect(boot.engine.read().list("message").length).toBeGreaterThan(0);
    boot.store.close();
  });

  it("a probe the server accepts and never answers times out into unverified — sync is never held hostage", async () => {
    // The deadline rule: every drain chains on the verdict, so an unanswered /auth/session
    // must not become a session that renders cached mail and never syncs. Only the probe
    // hangs here; the sync routes answer normally — and after the bounded verdict they run.
    const hangSession: MobileEngineDeps = {
      ...deps,
      fetch: (url, init) =>
        String(url).includes("/auth/session")
          ? new Promise<Response>(() => undefined)
          : (globalThis.fetch as typeof fetch)(url, init),
    };
    const boot = await bootEngine(hangSession, {
      origin, token: "tok-123", accountId: "acct-1", identityDeadlineMs: 60,
    });
    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;
    const verdict = await boot.verifyIdentity(); // a mutant that unbounds the probe hangs red here
    expect(verdict.kind).toBe("unverified");
    await boot.engine.start(); // the routes opened — the phone syncs
    expect(boot.engine.read().list("message").length).toBeGreaterThan(0);
    boot.store.close();
  });

  it("verifyIdentity answers verified where the session read agrees, unverified where none exists", async () => {
    const agree = await bootEngine(deps, { origin, token: "tok-123", accountId: "acct-1" });
    expect(agree.kind).toBe("ready");
    if (agree.kind !== "ready") return;
    expect((await agree.verifyIdentity()).kind).toBe("verified");
    agree.store.close();

    // The desktop-host door mounts no session read: unverified, never a judgment.
    const doorless = fakeServer({ sessionRoute: false });
    const doorlessOrigin = await listen(doorless.server);
    try {
      const boot = await bootEngine(deps, { origin: doorlessOrigin, token: "tok-123", accountId: "acct-1" });
      expect(boot.kind).toBe("ready");
      if (boot.kind !== "ready") return;
      expect((await boot.verifyIdentity()).kind).toBe("unverified");
      boot.store.close();
    } finally {
      doorless.server.close();
    }
  });

  it("a door with NO session read still cannot merge another account's mail — the drain refuses", async () => {
    // The desktop-host composition mounts no /auth/session. There the drain-time guard is the
    // rule: every /sync and snapshot page is checked against the mirror's named account BEFORE
    // the engine can apply it, so a foreign stream is a refused drain, never a merged mirror.
    const foreign = fakeServer({ accountId: "acct-EVIL", sessionRoute: false });
    const foreignOrigin = await listen(foreign.server);
    try {
      foreign.addMessage("f1", "Not your mail");
      const boot = await bootEngine(deps, { origin: foreignOrigin, token: "tok-123", accountId: "acct-mine" });
      expect(boot.kind).toBe("ready");
      if (boot.kind !== "ready") return;
      // No session read ⇒ unverified — which OPENS the drain routes (a LAN door must sync);
      // the per-entity guard is then the working rule, and here it fires.
      expect((await boot.verifyIdentity()).kind).toBe("unverified");
      await expect(boot.engine.start()).rejects.toThrow(/syncing mail for account "acct-EVIL"/);
      // Nothing merged and the cursor never moved: the mirror holds no foreign row.
      expect(boot.store.snapshot().size).toBe(0);
      expect(boot.store.getCursor()).toBe("0");
      boot.store.close();
    } finally {
      foreign.server.close();
    }
  });
});

describe("risk 1 — a dead sqlite host surfaces, never a silent memory mirror", () => {
  const killed: MobileEngineDeps = {
    openExecutor: () => {
      throw new Error("sqlite is dead");
    },
    deleteDatabase: async () => undefined,
    uuid: deps.uuid,
  };

  it("refuses the boot with the store's own failure, and hands back NO engine", async () => {
    const boot = await bootEngine(killed, { origin: "http://127.0.0.1:1", token: "t", accountId: "a" });
    // The load-bearing assertion: `kind` must be the refusal. A composition that caught the
    // store failure and quietly built the engine over `MemoryMirrorStore` would answer
    // `ready` here — which is exactly the mutation this line exists to catch.
    expect(boot.kind).toBe("refused");
    if (boot.kind !== "refused") return;
    expect(sayRefusal(boot.reason)).toMatch(/mirror could not open/);
    expect(sayRefusal(boot.reason)).toMatch(/sqlite is dead/);
  });

  it("refuses a non-origin and missing credentials without touching storage", async () => {
    let opened = 0;
    const counting: MobileEngineDeps = {
      openExecutor: (name) => {
        opened++;
        return world.open(name);
      },
      deleteDatabase: world.drop,
      uuid: deps.uuid,
    };
    expect((await bootEngine(counting, { origin: "host.example", token: "t", accountId: "a" })).kind).toBe("refused");
    expect((await bootEngine(counting, { origin: "http://h.example", token: " ", accountId: "a" })).kind).toBe("refused");
    expect((await bootEngine(counting, { origin: "http://h.example", token: "t", accountId: "" })).kind).toBe("refused");
    expect(opened).toBe(0);
  });
});

/**
 * ── A MAILBOX REMOVED ON THE PAIRED DESKTOP LEAVES THE PHONE ────────────────────────────────
 *
 * The same invariant as the phone's OWN removal, on the paired path: a removed mailbox leaves
 * nothing behind. The server emits one `mailbox` delete when a mailbox's mail comes off the
 * store and the engine has always known how to sweep from it
 * (`client-engine/store.ts#cascadeMailboxRemoval`) — but the phone's `?types=` filter was a
 * hand-copied list written before that type existed, so the phone never asked for the receipt
 * and was never sent one. Its messages, drafts and cached bodies stayed, and a reconnect added
 * them again beside the originals.
 *
 * Its own server and its own world: the suite above shares one change log across cases, and a
 * removal is not something to leave in it.
 *
 * MUTATION-WATCH (edit the source, watch, restore):
 *  · drop `"mailbox"` from `SYNC_ENTITY_TYPES` (`client-engine/types.ts`) → both cases go red
 *    with the removed mailbox's message still in the mirror;
 *  · point the filter guard back at `MOBILE_SYNC_TYPES` instead of the declaration → the
 *    declaration arm passes for every value, which is the guard this replaces.
 */
describe("a mailbox removed on the paired server leaves this phone", () => {
  it("sweeps that mailbox's rows on the drain, and keeps the other mailbox's", async () => {
    const own = sqlWorld();
    const server = fakeServer({ accountId: "acct-sweep" });
    const origin2 = await listen(server.server);
    try {
      const ownDeps: MobileEngineDeps = {
        openExecutor: own.open, deleteDatabase: own.drop, uuid: deps.uuid,
      };
      server.addMessage("s1", "Kept", "mb-keep");
      server.addMessage("s2", "Going", "mb-gone");
      server.addMessage("s3", "Going too", "mb-gone");

      const boot = await bootEngine(ownDeps, { origin: origin2, token: "tok-s", accountId: "acct-sweep" });
      expect(boot.kind).toBe("ready");
      if (boot.kind !== "ready") return;
      expect((await boot.verifyIdentity()).kind).toBe("verified");
      await boot.engine.start();
      const reader = boot.engine.read();
      expect(reader.list("message").length, "the phone starts with both mailboxes").toBe(3);

      /* THE REMOVAL, on the other machine. One row on the wire, and it is the whole receipt. */
      server.removeMailbox("mb-gone");
      await boot.engine.syncOnce();

      const left = reader.list("message") as Array<{ id: string; mailboxId: string }>;
      expect(left.map((m) => m.id), "the removed mailbox's mail is still on this phone")
        .toEqual(["s1"]);
      expect(left[0]?.mailboxId).toBe("mb-keep");

      boot.store.close();
    } finally {
      server.server.close();
    }
  });

  it("and a reconnect over the same mirror adds no copies back", async () => {
    /* THE SECOND HALF OF THE DEFECT: with no receipt the rows survived, and the next cold
       connect's snapshot created them AGAIN beside the ones already there — the count the
       person saw doubled. A relaunch here drains from scratch over the same mirror. */
    const own = sqlWorld();
    const server = fakeServer({ accountId: "acct-again" });
    const origin2 = await listen(server.server);
    try {
      const ownDeps: MobileEngineDeps = {
        openExecutor: own.open, deleteDatabase: own.drop, uuid: deps.uuid,
      };
      server.addMessage("a1", "Kept", "mb-keep");
      server.addMessage("a2", "Going", "mb-gone");

      const first = await bootEngine(ownDeps, { origin: origin2, token: "tok-a", accountId: "acct-again" });
      if (first.kind !== "ready") throw new Error("boot refused");
      expect((await first.verifyIdentity()).kind).toBe("verified");
      await first.engine.start();
      expect(first.engine.read().list("message").length).toBe(2);
      /* THE REMOVAL ARRIVES ON THE DELTA, which is the route `?types=` decides. A cold connect
         asks for state and a removed mailbox has none, so the snapshot cannot be what carries
         this — the receipt reaches the phone here or nowhere. */
      server.removeMailbox("mb-gone");
      await first.engine.syncOnce();
      expect(first.engine.read().list("message").map((m) => (m as { id: string }).id)).toEqual(["a1"]);
      first.store.close();

      const again = await bootEngine(ownDeps, { origin: origin2, token: "tok-a", accountId: "acct-again" });
      if (again.kind !== "ready") throw new Error("relaunch refused");
      expect((await again.verifyIdentity()).kind).toBe("verified");
      await again.engine.start();
      expect(
        again.engine.read().list("message").map((m) => (m as { id: string }).id),
        "the reconnect added the removed mailbox's mail back",
      ).toEqual(["a1"]);
      again.store.close();
    } finally {
      server.server.close();
    }
  });
});
