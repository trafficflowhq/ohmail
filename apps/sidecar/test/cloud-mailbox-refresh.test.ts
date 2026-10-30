import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drafts, mailboxes, messageBodies, messages, threads } from "@trafficflow/db/mail";
import { mailboxService } from "@trafficflow/services/mail";
import type {
  DraftDTO, MailboxDTO, MessageBodyBatchItem, MessageDTO, Page, ServiceContext, SnapshotResponse,
  SyncChange, SyncResponse, ThreadDTO,
} from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CURSOR_VERSION } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

// Every test here boots its own PGlite in `standUp()` — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE MIRROR CARRIES THE ACCOUNT'S OWN MAILBOXES — the fix for a Cloud door that could not send.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────
 *
 * `identity.ts` mints ONE mailbox row to satisfy the schema: a random uuid, addressed with the
 * account LOGIN. The mirror attributed every message and every draft to it. Nothing about the
 * mirror looked broken — mail arrived, threads read, search worked — and three things downstream
 * were:
 *
 *  · a send carries `mailboxId`, the hosted API checks it belongs to the account, and a random
 *    local uuid never does: `400 mailboxId does not belong to this account`, every time;
 *  · the From selector is built from `GET /mailboxes`, which answered that one row, so it offered
 *    a single option with the wrong address and an account with two addresses could not choose;
 *  · a reply inherits its parent's `mailboxId`, which named nothing in the option list, so the
 *    surface announced a SUBSTITUTION on every reply.
 *
 * ── WHAT IS ASSERTED HERE ─────────────────────────────────────────────────────────────────────
 *
 * Against real PGlite and the real migrated schema, with a fake hosted API answering `/mailboxes`,
 * `/sync` and `/messages/bodies`. The properties, each of which has been watched fail:
 *
 *  1. the refresh runs BEFORE the drain, so a first pull can file its mail at all;
 *  2. a mirrored message keeps the HOSTED mailbox id, and never another mailbox's;
 *  3. the retire-and-upsert is ONE transaction, so a signed-in `GET /mailboxes` is never empty;
 *  4. the hosted account's own import stamp is never copied, or the body walk would resolve
 *     finished before it started and every message would open blank;
 *  5. an UPGRADED mirror re-keys itself — the cursor's absent `version` is what selects it.
 */

const HOSTED_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOGIN = "me@ohmail.test";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(address = LOGIN): Promise<{
  opened: OpenLocalDb; db: LocalDb; world: LocalWorld; dataDir: string; cursorPath: string;
}> {
  const dataDir = await freshDataDir("ohmail-mailbox-refresh-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address, now: new Date() });
  return { opened, db: opened.db, world, dataDir, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();

const ctxFor = (db: LocalDb, world: LocalWorld): ServiceContext => ({
  db, accountId: world.accountId, userId: world.userId, sessionId: null,
  now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined,
});

function change(type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) };
}

function syncPage(changes: SyncChange[], cursor: string, hasMore = false): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore, serverTime: iso(),
  };
}

function messageDTO(id: string, threadId: string | null, mailboxId: string, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: LOGIN }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "ohmail/Screener", snippet: "we have not met", unread: true,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
    ...over,
  };
}

function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, subject: "Can we talk?", messageIds: [],
    participants: [], lastMessageAt: iso(), unreadCount: 1, muted: false,
    folder: "ohmail/Screener", updatedAt: iso(),
  };
}

function draftDTO(id: string, mailboxId: string): DraftDTO {
  return {
    id, mailboxId, threadId: null, inReplyToMessageId: null, forwardOfMessageId: null,
    subject: "About that", body: "shortly", html: null,
    to: [{ name: null, address: "them@nowhere.test" }], cc: [], bcc: [],
    rationale: null, status: "draft", sendAt: null, sendError: null,
    createdAt: iso(), updatedAt: iso(),
    // The row's own version — the server mints it and a send carries it back. A fixture value
    // stands in: nothing on this path reads it, and the mirror carries it like any other field.
    contentRevision: "0".repeat(64),
  };
}

const NO_TAGS: SnapshotResponse = {
  asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 },
};

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

interface FakeOpts {
  /** The `/sync` pages, in call order. Exhausted ⇒ an empty drained page. */
  sync?: SyncResponse[];
  /** What `GET /mailboxes` answers. A FUNCTION so a test can change the account mid-run. */
  boxes?: () => readonly MailboxDTO[];
  bodies?: readonly MessageBodyBatchItem[];
  /** Every path asked for, in order — the ORDERING assertions read this. */
  asked?: string[];
  /** Make `/mailboxes` fail, to prove a failed refresh fails the pull. */
  mailboxStatus?: number;
}

function fakeAuth(opts: FakeOpts = {}): CloudAuth {
  let s = 0;
  const empty = syncPage([], "end", false);
  const corpus = opts.bodies ?? [];
  return {
    authedFetch: async (path: string) => {
      opts.asked?.push(path);
      if (path.startsWith("/mailboxes")) {
        if (opts.mailboxStatus && opts.mailboxStatus !== 200) {
          return new Response("no", { status: opts.mailboxStatus });
        }
        return json(mailboxList(opts.boxes?.() ?? [hostedMailbox(HOSTED_A, LOGIN)]));
      }
      if (path.startsWith("/sync/snapshot")) return json(NO_TAGS);
      // The bootstrap's rules-first pass (`types=rule`): these feeds carry no rule changes, so
      // the honest filtered answer is an empty page — and it must not eat a mixed page above.
      if (path.startsWith("/sync")
          && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(empty);
      }
      if (path.startsWith("/sync")) return json(opts.sync?.[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) {
        const q = new URLSearchParams(path.split("?")[1] ?? "");
        const ids = q.get("ids");
        if (ids !== null) {
          const wanted = new Set(ids.split(",").filter((x) => x !== ""));
          return json({ items: corpus.filter((i) => wanted.has(i.messageId)), nextCursor: null } satisfies Page<MessageBodyBatchItem>);
        }
        const after = q.get("after");
        const sorted = [...corpus].sort((a, b) => (a.messageId < b.messageId ? -1 : 1));
        const rest = after ? sorted.filter((i) => i.messageId > after) : sorted;
        return json({ items: rest, nextCursor: null } satisfies Page<MessageBodyBatchItem>);
      }
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

/** Every mailbox id this database holds, whatever its status. */
const localIds = async (db: LocalDb): Promise<string[]> =>
  (await db.select({ id: mailboxes.id }).from(mailboxes)).map((r) => r.id).sort();

describe("the provider's own Junk folder survives the mirror (JUNK-INVISIBLE)", () => {
  /**
   * ohmail never mirrors `\Junk`, so a Cloud-mirror install would have no way to NAME the folder
   * junked mail went to — its own column stays NULL, because this install never attaches IMAP.
   * The path therefore rides the hosted `MailboxDTO` and is written into the local row, and the
   * local `GET /mailboxes` hands it back to the rail and to search. One round trip, three lines:
   * the DTO field, `toDTO`'s projection, and `mailboxRow`'s carry.
   */
  it("a hosted row's junk path reaches the local row and the local DTO, path intact", async () => {
    const { db, world, cursorPath } = await standUp();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => [hostedMailbox(HOSTED_A, LOGIN, { junkFolder: "INBOX/Spamverdacht" })],
      }),
    }).pullOnce();

    // The column, and then the read every client actually makes. NOT the leaf: the clients
    // derive that themselves, and a mirror that normalised the path would ship two spellings.
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, HOSTED_A));
    expect(row!.junkFolder).toBe("INBOX/Spamverdacht");
    const [dto] = await mailboxService.list(ctxFor(db, world));
    expect(dto!.junkFolder).toBe("INBOX/Spamverdacht");
  });

  it("a hosted account with no Junk folder mirrors a null, and the DTO says null", async () => {
    // `null` is a fact — the mailbox has none — and it must not arrive as an empty string or as
    // an absent key, either of which a client would have to guess about.
    const { db, world, cursorPath } = await standUp();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({ boxes: () => [hostedMailbox(HOSTED_A, LOGIN)] }),
    }).pullOnce();

    const [dto] = await mailboxService.list(ctxFor(db, world));
    expect(dto!.junkFolder).toBeNull();
  });
});

describe("the recorded Sent folder survives the mirror (mail 0132)", () => {
  // Nothing attaches here on a Cloud account, so without the carry the engine knows Sent by name only.
  it("a hosted 'Envoyés' lands in the local row and DTO; a hosted null clears it", async () => {
    const { db, world, cursorPath } = await standUp();
    let boxes = [hostedMailbox(HOSTED_A, LOGIN, { sentFolder: "Envoyés" })];
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth({ boxes: () => boxes }),
    });
    await mirror.pullOnce();
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, HOSTED_A));
    expect(row!.sentFolder).toBe("Envoyés");
    expect((await mailboxService.list(ctxFor(db, world)))[0]!.sentFolder).toBe("Envoyés");
    boxes = [hostedMailbox(HOSTED_A, LOGIN, { sentFolder: null })];
    await mirror.pullOnce();
    expect((await mailboxService.list(ctxFor(db, world)))[0]!.sentFolder).toBeNull();
  });
});

describe("the wall's pause survives the mirror (mail 0135)", () => {
  // Without it a Cloud desktop reads a paused row as one this account released ("You stopped…").
  const PARKED = "2026-09-23T02:15:07.000Z";
  const paused = () => hostedMailbox(HOSTED_A, LOGIN, {
    organizerRole: "reader", organizerReleasedAt: PARKED, organizerParkedAt: PARKED,
  });

  it("a hosted row's marker reaches the local row and the local DTO", async () => {
    const { db, world, cursorPath } = await standUp();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth({ boxes: () => [paused()] }),
    }).pullOnce();
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, HOSTED_A));
    expect(row!.organizerParkedAt?.toISOString()).toBe(PARKED);
    const [dto] = await mailboxService.list(ctxFor(db, world));
    expect(dto!.organizerParkedAt).toBe(PARKED);
  });

  it("the resume clears it here too — the upsert carries the hosted null", async () => {
    const { db, world, cursorPath } = await standUp();
    let boxes = [paused()];
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth({ boxes: () => boxes }),
    });
    await mirror.pullOnce();
    boxes = [hostedMailbox(HOSTED_A, LOGIN)];
    await mirror.pullOnce();
    const [dto] = await mailboxService.list(ctxFor(db, world));
    expect(dto!.organizerParkedAt, "a resumed mailbox kept its pause on this desktop").toBeNull();
  });
});

describe("a first pull mirrors the account's mailboxes and files its mail under them", () => {
  it("replaces the local placeholder with the account's own rows, and attributes the mail to them", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const mA = randomUUID();
    const mB = randomUUID();
    const boxes = [hostedMailbox(HOSTED_A, LOGIN), hostedMailbox(HOSTED_B, "second@ohmail.test")];

    const applied = await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => boxes,
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", mA, "create", 2, messageDTO(mA, t, HOSTED_A)),
          change("message", mB, "create", 3, messageDTO(mB, t, HOSTED_B)),
        ], "c3")],
      }),
    }).pullOnce();

    // A TWO-MAILBOX ACCOUNT LOSES NOTHING ON ITS FIRST PULL. This is the ordering assertion in the
    // form a user would notice: a refresh that ran after the drain would skip both messages.
    expect(applied).toBe(3);
    expect(await db.select().from(messages)).toHaveLength(2);

    // The placeholder is GONE — not disabled beside them, gone. Nothing referenced it, because the
    // refresh precedes the first drain.
    expect(await localIds(db)).toEqual([HOSTED_A, HOSTED_B].sort());
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId))).toHaveLength(0);

    // EACH MESSAGE UNDER ITS OWN MAILBOX. Never re-attributed to the other one, which is the
    // wrong-sender failure the From rules exist to prevent.
    const rows = await db.select().from(messages);
    expect(rows.find((r) => r.id === mA)!.mailboxId).toBe(HOSTED_A);
    expect(rows.find((r) => r.id === mB)!.mailboxId).toBe(HOSTED_B);

    // AND THE READ THE FROM SELECTOR IS BUILT ON. Two options, the account's own addresses, in
    // `createdAt` order — the order `compose-from.ts` reads as "the oldest connected mailbox".
    const listed = await mailboxService.list(ctxFor(db, world));
    expect(listed.map((m) => m.id).sort()).toEqual([HOSTED_A, HOSTED_B].sort());
    expect(listed.map((m) => m.address).sort()).toEqual([LOGIN, "second@ohmail.test"].sort());
  });

  it("asks for the mailboxes BEFORE it drains — the ordering, read off the call log", async () => {
    const { db, world, cursorPath } = await standUp();
    const asked: string[] = [];
    const t = randomUUID();
    const m = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        asked,
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", m, "create", 2, messageDTO(m, t, HOSTED_A)),
        ], "c2")],
      }),
    }).pullOnce();

    const firstMailboxes = asked.findIndex((p) => p.startsWith("/mailboxes"));
    const firstDrain = asked.findIndex((p) => p.startsWith("/sync") && !p.startsWith("/sync/snapshot"));
    expect(firstMailboxes, "the mirror never asked for the account's mailboxes").toBeGreaterThanOrEqual(0);
    expect(firstMailboxes, "the drain ran before the mailboxes were known").toBeLessThan(firstDrain);
  });

  it("keeps the local mailbox list non-empty THROUGHOUT — the probe may never answer []", async () => {
    const { db, world, cursorPath } = await standUp();

    /* THE WINDOW THIS CLOSES. `DesktopMailboxes.tsx` states the rule from the client side: the
       mailbox probe must reject rather than answer with an empty list, because "there are none"
       renders as "No mailbox connected, so nothing can arrive". This read is served locally and
       cannot reject, so the state has to be unreachable instead — retire and upsert are ONE
       transaction.

       IT IS THE **ACTIVE** COUNT THAT MATTERS, not the row count, and that distinction is the
       whole assertion. `MailboxService.list` returns tombstones too, so a table holding nothing but
       the retired placeholder is a non-empty list of disconnected mailboxes — which renders as the
       same sentence, about an account whose mail is arriving normally. Counting rows would let a
       split-transaction refresh pass.

       Sampled from a concurrent reader while the refresh runs, which is the shape a window polling
       `GET /mailboxes` every ten seconds has. */
    const samples: Array<{ rows: number; active: number }> = [];
    let sampling = true;
    const poll = (async (): Promise<void> => {
      while (sampling) {
        const listed = await mailboxService.list(ctxFor(db, world));
        samples.push({ rows: listed.length, active: listed.filter((m) => m.status !== "disabled").length });
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({ boxes: () => [hostedMailbox(HOSTED_A, LOGIN)] }),
    }).pullOnce();
    sampling = false;
    await poll;

    expect(samples.length, "nothing was sampled, so this proves nothing").toBeGreaterThan(0);
    expect(samples.filter((s) => s.rows === 0), "a reader saw an account with no mailboxes at all").toEqual([]);
    expect(
      samples.filter((s) => s.active === 0),
      "a reader caught the account mid-refresh with every mailbox disconnected",
    ).toEqual([]);
    // And the row it ends on is the account's, not the placeholder's.
    expect((await mailboxService.list(ctxFor(db, world))).map((m) => m.id)).toEqual([HOSTED_A]);
  });

  it("every mirrored message names a local mailbox, and every local mailbox is one the account named", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const boxes = [hostedMailbox(HOSTED_A, LOGIN), hostedMailbox(HOSTED_B, "second@ohmail.test")];

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => boxes,
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          ...ids.map((id, i) => change("message", id, "create", i + 2, messageDTO(id, t, i === 0 ? HOSTED_B : HOSTED_A))),
        ], "c4")],
      }),
    }).pullOnce();

    // messages.mailbox_id ⊆ mailboxes.id ⊆ the hosted ids. The middle set is the foreign key; the
    // outer one is what makes a send acceptable to the hosted API.
    const local = new Set(await localIds(db));
    const hosted = new Set(boxes.map((b) => b.id));
    for (const row of await db.select().from(messages)) {
      expect(local.has(row.mailboxId), `message ${row.id} names a mailbox this database does not hold`).toBe(true);
      expect(hosted.has(row.mailboxId), `message ${row.id} names a mailbox the account does not have`).toBe(true);
    }
    for (const id of local) expect(hosted.has(id), `${id} is a local mailbox the account never named`).toBe(true);
  });

  it("files a DRAFT under its own sending mailbox, which is what makes it sendable", async () => {
    const { db, world, cursorPath } = await standUp();
    const d = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => [hostedMailbox(HOSTED_A, LOGIN), hostedMailbox(HOSTED_B, "second@ohmail.test")],
        sync: [syncPage([change("draft", d, "create", 1, draftDTO(d, HOSTED_B))], "c1")],
      }),
    }).pullOnce();

    const [row] = await db.select().from(drafts).where(eq(drafts.id, d));
    expect(row, "the draft was not mirrored").toBeDefined();
    expect(row!.mailboxId, "a draft under the placeholder id is a draft the hosted API refuses to send").toBe(HOSTED_B);
  });
});

describe("the mirror never copies the hosted account's own progress", () => {
  it("leaves the import stamp NULL on a fresh mirror, so the body walk still runs", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const m = randomUUID();
    const asked: string[] = [];

    /* The hosted mailbox carries `initialImportCompletedAt` — it finished importing months ago.
       Copying it would resolve THIS mirror's body walk as complete before it had fetched a body,
       and `fetchMissingBodies` only asks about messages already held, so every message would open
       blank for ever. The stamp is about the mirror's own progress and is written by nothing but a
       pull of this process. */
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        asked,
        boxes: () => [hostedMailbox(HOSTED_A, LOGIN, { initialImportCompletedAt: "2020-01-01T00:00:00.000Z", lastSyncAt: "2020-01-01T00:00:00.000Z" })],
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", m, "create", 2, messageDTO(m, t, HOSTED_A)),
        ], "c2")],
        bodies: [{ messageId: m, text: "the body it had to go and fetch", html: null, loadedRemoteContent: false }],
      }),
    }).pullOnce();

    // The walk RAN — a keyset page (no `ids=`), whose first ask carries no `after=`: the walk
    // starting at the first message. Found by SHAPE rather than by position, because since the
    // newest-first fill the FIRST bodies request of a pull is deliberately a bounded `?ids=`
    // prefetch of the list's top (`backfillBodies` in cloud-mirror.ts); what this test pins is
    // that the copied hosted stamp did not resolve the walk `complete` before it ever started.
    const walked = asked.filter((p) => p.startsWith("/messages/bodies"));
    expect(walked.length, "the body walk never ran; the mirror believed the hosted import was its own").toBeGreaterThan(0);
    const walkPages = walked.filter((p) => !p.includes("ids="));
    expect(walkPages.length,
      "only the newest-first prefetch ran and the keyset walk never started; the mirror believed the hosted import was its own")
      .toBeGreaterThan(0);
    expect(walkPages[0]).not.toContain("after=");
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, m));
    expect(body, "the message has no body, so it would open blank").toBeDefined();
    expect(body!.text).toBe("the body it had to go and fetch");
  });

  it("stamps every ACTIVE mirrored row when a pull drains, and never a retired one", async () => {
    const { db, world, cursorPath } = await standUp();
    const boxes: MailboxDTO[] = [
      hostedMailbox(HOSTED_A, LOGIN),
      hostedMailbox(HOSTED_B, "second@ohmail.test"),
    ];
    const t = randomUUID();
    const m = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => boxes,
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", m, "create", 2, messageDTO(m, t, HOSTED_B)),
        ], "c2")],
      }),
    }).pullOnce();

    for (const row of await db.select().from(mailboxes)) {
      expect(row.lastSyncAt, `${row.address} was never stamped, so its sync line says "Syncing your mail" for ever`).not.toBeNull();
      expect(row.initialImportCompletedAt, `${row.address} did not record its first import finishing`).not.toBeNull();
    }

    // The second mailbox is removed on Cloud. Its mail is still here, so the row is TOMBSTONED —
    // and a tombstone has no import to finish, so the next pull must not stamp it.
    boxes.pop();
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c2", bodies: "complete", bootstrapping: false, tagBackfill: true }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({ boxes: () => boxes }),
    }).pullOnce();

    const [gone] = await db.select().from(mailboxes).where(eq(mailboxes.id, HOSTED_B));
    expect(gone, "a mailbox its mail still points at was DELETED rather than tombstoned").toBeDefined();
    expect(gone!.status).toBe("disabled");
    // Never deleted while a message names it — the foreign key, and the mail, both say so.
    expect(await db.select().from(messages).where(eq(messages.mailboxId, HOSTED_B))).toHaveLength(1);
  });
});

describe("an upgraded mirror re-keys itself", () => {
  /**
   * A MIRROR AS THE SHIPPED BUILD LEFT IT: every message filed under the local placeholder, bodies
   * against those messages, and a cursor file with NO `version` field — which is the whole of the
   * migration signal.
   */
  async function shippedMirror(): Promise<{
    db: LocalDb; world: LocalWorld; cursorPath: string; msgIds: string[]; threadId: string;
  }> {
    const { db, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const msgIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(threads).values({ id: threadId, accountId: world.accountId, subject: "Old mail", updatedAt: new Date() });
    for (const id of msgIds) {
      await db.insert(messages).values({
        id, accountId: world.accountId,
        // THE DEFECT, reproduced: the local placeholder rather than the account's own mailbox.
        mailboxId: world.mailboxId,
        bodyHash: "", dedupKey: `cloud:${id}`, subject: "Old mail",
        fromAddress: "stranger@nowhere.test", threadId, updatedAt: new Date(),
      });
      await db.insert(messageBodies).values({ messageId: id, text: `body of ${id}`, html: null });
    }
    /* THE 0.9.3 CURSOR, VERBATIM. Four keys, no `version`. If an absent version ever reads as
       "current", this file is the population that silently keeps the defect while every fresh
       install comes up green — which is why the fixture is written out rather than derived. */
    writeFileSync(cursorPath, JSON.stringify({
      sync: "c9", bodies: "complete", bootstrapping: false, tagBackfill: true,
    }));
    return { db, world, cursorPath, msgIds, threadId };
  }

  it("re-pulls from zero and moves every message onto the account's own mailbox, keeping the bodies", async () => {
    const { db, world, cursorPath, msgIds, threadId } = await shippedMirror();
    const placeholder = world.mailboxId;
    const bodiesBefore = (await db.select().from(messageBodies)).length;
    expect(bodiesBefore).toBe(3);

    const asked: string[] = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        asked,
        boxes: () => [hostedMailbox(HOSTED_A, LOGIN)],
        // The re-pull the forced `since=0` asks for: the same entities, with their real mailbox.
        sync: [syncPage([
          change("thread", threadId, "create", 1, threadDTO(threadId)),
          ...msgIds.map((id, i) => change("message", id, "create", i + 2, messageDTO(id, threadId, HOSTED_A))),
        ], "c12")],
      }),
    }).pullOnce();

    // THE DRAIN RESTARTED FROM ZERO rather than resuming from "c9".
    const drain = asked.find((p) => p.startsWith("/sync?"));
    expect(drain, "no drain happened").toBeDefined();
    expect(new URLSearchParams(drain!.split("?")[1]).get("since")).toBe("0");

    // Zero messages left on the placeholder, and the placeholder itself is gone.
    expect(await db.select().from(messages).where(eq(messages.mailboxId, placeholder))).toHaveLength(0);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, placeholder))).toHaveLength(0);
    expect(await localIds(db)).toEqual([HOSTED_A]);
    for (const row of await db.select().from(messages)) expect(row.mailboxId).toBe(HOSTED_A);

    // THE BODY STORE SURVIVED. `message_bodies` is keyed on `message_id` alone and the entity ids
    // are preserved by the feed's contract, so a re-key is not a re-download of the mailbox.
    expect((await db.select().from(messageBodies)).length, "the re-key threw the bodies away").toBe(bodiesBefore);

    // And it is written down, so the next launch resumes incrementally.
    const onDisk = JSON.parse(readFileSync(cursorPath, "utf8")) as { version?: number; sync?: string };
    expect(onDisk.version).toBe(CURSOR_VERSION);
    expect(onDisk.sync).toBe("c12");
  });

  it("does NOT re-key a cursor that already carries the current version", async () => {
    const { db, world, cursorPath } = await standUp();
    writeFileSync(cursorPath, JSON.stringify({
      version: CURSOR_VERSION, sync: "c9", bodies: "complete", bootstrapping: false, tagBackfill: true,
    }));
    const asked: string[] = [];
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth({ asked }) }).pullOnce();

    const drain = asked.find((p) => p.startsWith("/sync?"));
    expect(
      new URLSearchParams(drain!.split("?")[1]).get("since"),
      "a current mirror re-bootstrapped, which costs every install a full re-pull",
    ).toBe("c9");
  });
});

describe("the mailbox refresh is convergent, and honest when it cannot run", () => {
  it("applies twice to the same rows — the cursor is written after the commit, so a page replays", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const m = randomUUID();
    const page = syncPage([
      change("thread", t, "create", 1, threadDTO(t)),
      change("message", m, "create", 2, messageDTO(m, t, HOSTED_A)),
    ], "c2");
    const auth = (): CloudAuth => fakeAuth({ boxes: () => [hostedMailbox(HOSTED_A, LOGIN)], sync: [page] });

    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: auth() }).pullOnce();
    const first = await db.select().from(mailboxes);
    // The crash-before-the-cursor-write case: the same page, applied again from zero.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: "complete" }));
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: auth() }).pullOnce();

    const second = await db.select().from(mailboxes);
    expect(second).toHaveLength(first.length);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(await db.select().from(messages)).toHaveLength(1);
    expect((await db.select().from(messages))[0]!.mailboxId).toBe(HOSTED_A);
  });

  it("fails the whole pull when the account's mailboxes cannot be read, and sweeps nothing", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const m = randomUUID();
    // A mirror with mail in it already.
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        boxes: () => [hostedMailbox(HOSTED_A, LOGIN)],
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", m, "create", 2, messageDTO(m, t, HOSTED_A)),
        ], "c2")],
      }),
    }).pullOnce();
    expect(await db.select().from(messages)).toHaveLength(1);

    /* The route 500s. Continuing would be the dangerous option: a drain with no mailbox set skips
       every message, and on a bootstrap the mark-and-sweep then deletes the ones it skipped. So
       the pull fails, the mirror goes offline, and every row it holds is untouched. */
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: "complete" }));
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({ mailboxStatus: 500 }),
    });
    await expect(mirror.pullOnce()).rejects.toThrow(/mailboxes/);
    expect(mirror.online(), "a mirror that cannot read the account is not online").toBe(false);
    expect(await db.select().from(messages), "a failed refresh emptied the mirror").toHaveLength(1);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, HOSTED_A))).toHaveLength(1);
  });

  it("refetches ONCE for a mailbox added mid-drain, and skips mail it still cannot place", async () => {
    const { db, world, cursorPath } = await standUp();
    const t = randomUUID();
    const known = randomUUID();
    const newcomer = randomUUID();
    const orphan = randomUUID();
    const asked: string[] = [];
    // The account gains a mailbox between the pull's first refresh and the page that names it.
    let listed: MailboxDTO[] = [hostedMailbox(HOSTED_A, LOGIN)];

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({
        asked,
        boxes: () => {
          const answer = listed;
          listed = [hostedMailbox(HOSTED_A, LOGIN), hostedMailbox(HOSTED_B, "second@ohmail.test")];
          return answer;
        },
        sync: [syncPage([
          change("thread", t, "create", 1, threadDTO(t)),
          change("message", known, "create", 2, messageDTO(known, t, HOSTED_A)),
          change("message", newcomer, "create", 3, messageDTO(newcomer, t, HOSTED_B)),
          // A mailbox no refresh will ever name. Skipped rather than filed under somebody else's
          // address — a message the mirror cannot place honestly is better absent.
          change("message", orphan, "create", 4, messageDTO(orphan, t, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")),
        ], "c4")],
      }),
    }).pullOnce();

    expect(asked.filter((p) => p.startsWith("/mailboxes")).length, "the refetch did not happen once and only once").toBe(2);
    const rows = await db.select().from(messages);
    expect(rows.map((r) => r.id).sort()).toEqual([known, newcomer].sort());
    expect(rows.find((r) => r.id === newcomer)!.mailboxId).toBe(HOSTED_B);
  });
});

describe("a login that names no mailbox settles rather than piling up rows", () => {
  it("re-mints and retires on every launch without a duplicate active address or a unique violation", async () => {
    // The account logs in as `owner@example.test` and its mailbox is `work@elsewhere.test`, so
    // `ensureLocalWorld` can never find an existing row by address and mints a fresh placeholder on
    // every launch. The refresh retires it on the same pull: a mint/retire loop that converges.
    const { opened, db, cursorPath } = await standUp("owner@example.test");
    const boxes = [hostedMailbox(HOSTED_A, "work@elsewhere.test")];
    const seen: string[] = [];

    for (let launch = 0; launch < 3; launch++) {
      const world = await ensureLocalWorld(db, { address: "owner@example.test", now: new Date() });
      seen.push(world.mailboxId);
      await createCloudMirror({
        db, world, cursorPath, now: () => new Date(),
        auth: fakeAuth({ boxes: () => boxes }),
      }).pullOnce();

      // Settled WITHIN THE PULL: one mailbox, the account's, and no placeholder beside it.
      expect(await localIds(db), `launch ${launch} left rows behind`).toEqual([HOSTED_A]);
    }

    // Each launch really did mint a new placeholder — otherwise this proves nothing about the loop.
    expect(new Set(seen).size, "no placeholder was ever minted, so the loop was not exercised").toBe(3);
    expect(opened.db).toBe(db);
  });

  it("survives sign-out, sign-in and relaunch cycles with one active row per address", async () => {
    const { db, cursorPath } = await standUp();
    const boxes = [hostedMailbox(HOSTED_A, LOGIN)];

    for (let launch = 0; launch < 3; launch++) {
      const world = await ensureLocalWorld(db, { address: LOGIN, now: new Date() });
      await createCloudMirror({
        db, world, cursorPath, now: () => new Date(),
        auth: fakeAuth({ boxes: () => boxes }),
      }).pullOnce();
      const active = (await db.select().from(mailboxes)).filter((r) => r.status !== "disabled");
      expect(active.map((r) => r.address), `launch ${launch}`).toEqual([LOGIN]);
      expect(active.map((r) => r.id), `launch ${launch}`).toEqual([HOSTED_A]);
    }
  });
});
