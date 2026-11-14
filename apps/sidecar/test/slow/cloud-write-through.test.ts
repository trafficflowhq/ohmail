import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeLog, folderState, messageStates, messageTags, messages, rules, tags, threads } from "@trafficflow/db/mail";
import { DESTINATIONS } from "@trafficflow/core/destinations";
import type { Folder, MessageDTO, SyncChange, SyncResponse, ThreadDTO } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { createCloudMirror as makeCloudMirror } from "../../src/cloud-mirror.js";
import { openLocalDb, type OpenLocalDb } from "../../src/db.js";
import { ensureLocalWorld } from "../../src/identity.js";
import type { CloudAuth } from "../../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { PGLITE_STANDUP_BUDGET_MS } from "../pglite-budget.js";
import { freshDataDir } from "../_datadir.js";
import { idleSession } from "../fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "../_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

// Every test here boots its own PGlite (standUpSidecar/standUpMirror) — see pglite-budget.ts.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE WRITE-THROUGH PROXY — the echo-await that keeps a write from flickering, and the offline
 * refusal that writes nothing.
 *
 * All against a REAL Cloud sidecar (`createCloudSidecar`) over on-disk PGlite, driven by an
 * in-process fake hosted API. The three properties the Cloud write-through exists to hold:
 *
 *  1. a 2xx mutation is not answered until the mirror has pulled its echoed `X-Sync-Seq` — so the
 *     client's immediate local `/sync` re-drain already holds its own write;
 *  2. while offline every forwarded route answers `503 offline_read_only` and touches NO local row;
 *  3. the mirror's `online` flag is the pull's own verdict — a failed pull flips it, a good pull
 *     restores it.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** The hosted `message_states` row id — the wire keys the state by it, not by the message. */
const STATE_ROW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** The account's own mailbox — mirrored under its HOSTED id, which is what the messages name. */
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const iso = (): string => new Date().toISOString();
const encodeCursor = (seq: number): string => Buffer.from(String(seq), "utf8").toString("base64url");
const decodeCursor = (c: string): number => {
  if (!c || c === "0") return 0;
  const n = Number(Buffer.from(c, "base64url").toString("utf8"));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The hosted server only ever files a message into one of the six destinations, so the double
 * cannot hand back a folder outside that set without modelling a server that does not exist.
 */
const asFolder = (v: unknown): Folder | null =>
  typeof v === "string" && (DESTINATIONS as readonly string[]).includes(v) ? (v as Folder) : null;

function messageDTO(id: string, threadId: string, folder: Folder): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder, snippet: "hello", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, subject: "Can we talk?", messageIds: [],
    participants: [], lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
  };
}
function syncPageFrom(changes: SyncChange[], cursor: string): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore: false, serverTime: iso(),
  };
}

/**
 * A stateful fake hosted API. `/sync` replays a growing change log by seq; a mutation "commits" —
 * it bumps the server seq, appends the resulting change, and echoes `X-Sync-Seq`. `offline` makes
 * every call REJECT, exactly as a dead network does.
 */
function makeFakeCloud(threadId: string, msgId: string) {
  const state = { serverSeq: 2, offline: false, mutations: 0 };
  /** The hosted account's own screening preference — the value both verbs below act on. */
  const screening: { ohboxPolicy: string | null; ohboxBar: string | null } =
    { ohboxPolicy: null, ohboxBar: null };
  const log: SyncChange[] = [
    { type: "thread", op: "create", id: threadId, seq: 1, updatedAt: iso(), entity: threadDTO(threadId) },
    { type: "message", op: "create", id: msgId, seq: 2, updatedAt: iso(), entity: messageDTO(msgId, threadId, "INBOX") },
  ];
  const json = (v: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json", ...headers } });

  /**
   * The forwarded body, as TEXT — and this is not a convenience.
   *
   * The proxy relays what it was given as an `ArrayBuffer`, because it must carry attachment bytes
   * as faithfully as it carries JSON. `JSON.parse(buffer)` does not fail in a way anybody notices:
   * it stringifies to `[object ArrayBuffer]` and throws a SyntaxError, which inside this fake looks
   * exactly like the hosted account being unreachable — the forward rejects, the mirror is marked
   * offline, and the caller gets `503 offline_read_only` for a request that was perfectly fine.
   */
  const bodyText = (init?: RequestInit): string => {
    const b = init?.body;
    if (b === undefined || b === null) return "";
    if (typeof b === "string") return b;
    if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b));
    if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b as Uint8Array);
    return String(b);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (state.offline) throw new TypeError("fetch failed: the hosted account is unreachable");
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    /* THE OPENING WINDOW'S READ. The bootstrap pages `/sync/snapshot` before the replay and refuses
       a body that is not a snapshot, so this answers the route's real (empty) shape rather than
       falling through to the catch-all's message DTO — which would count as a forwarded write AND
       put the whole install offline. */
    if (path === "/sync/snapshot") return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (path === "/sync") {
      const since = decodeCursor(url.searchParams.get("since") ?? "0");
      const matching = log.filter((c) => c.seq > since);
      const cursorSeq = matching.length ? Math.max(...matching.map((c) => c.seq)) : since;
      return json(syncPageFrom(matching, encodeCursor(cursorSeq)));
    }
    if (path === "/messages/bodies") return json({ items: [], nextCursor: null });
    if (path === "/auth/refresh") return json({ tokens: { accessToken: "a2", refreshToken: "r2" } });
    /* THE ACCOUNT'S MAILBOXES. Matched on the exact path AND the method, because the one mailbox
       mutation a desktop install may make — `POST /mailboxes/:id/resync` — has to keep falling
       through to the catch-all below and be counted as the forwarded write it is. The mirror reads
       this at the start of every pull and refuses to drain without it, so a fake that let it reach
       the catch-all would answer a message DTO and put the whole install offline. */
    if (path === "/mailboxes" && method === "GET") return json(mailboxList([HOSTED_MAILBOX]));

    /* THE ACCOUNT'S SCREENING PREFERENCE, kept where a hosted account keeps everything: here.
       Answered as the hosted API answers it, and NOT counted as one of the mutations above —
       it emits no change-log row, so there is no `X-Sync-Seq` to echo and nothing for the mirror
       to catch up to. Modelled as real state so the read after the write is a read of what the
       write did, rather than of a constant. */
    if (path === "/account/screening") {
      if (method === "PATCH") {
        const patch = JSON.parse(bodyText(init) || "{}") as { ohboxBar?: string | null };
        if ("ohboxBar" in patch) screening.ohboxBar = patch.ohboxBar ?? null;
      }
      return json({ ...screening, defaultBar: "Keep my Ohbox for real people." });
    }

    // Any other path is a MUTATION (or an attachment/media byte read). A move commits a folder
    // change; everything else commits a bare message update. Both echo the new seq.
    state.mutations++;
    state.serverSeq++;
    const seq = state.serverSeq;
    /* TRIAGE ANSWERS AS THE HOSTED ROUTE DOES: the state DTO and NO `X-Sync-Seq`
       (`routes/triage.ts`), so there is no seq for the proxy to wait for. */
    const triageMatch = /^\/messages\/([^/]+)\/triage$/.exec(path);
    if (triageMatch && method === "POST") {
      const body = JSON.parse(bodyText(init) || "{}") as { state?: string; bubbleUpAt?: string };
      const dto = { messageId: msgId, state: body.state ?? "none", bubbleUpAt: body.bubbleUpAt ?? null, setAt: iso(), updatedAt: iso() };
      log.push({ type: "message_state", op: "update", id: STATE_ROW, seq, updatedAt: iso(), entity: dto } as unknown as SyncChange);
      return json(dto);
    }
    const moveMatch = /^\/messages\/([^/]+)\/move$/.exec(path);
    if (moveMatch && method === "POST") {
      let folder: Folder = "ohmail/News";
      try {
        folder = asFolder((JSON.parse(bodyText(init) || "{}") as { folder?: unknown }).folder) ?? folder;
      } catch { /* keep default */ }
      const dto = messageDTO(msgId, threadId, folder);
      log.push({ type: "message", op: "update", id: msgId, seq, updatedAt: iso(), entity: dto });
      return json(dto, { "x-sync-seq": String(seq) });
    }
    const dto = messageDTO(msgId, threadId, "INBOX");
    log.push({ type: "message", op: "update", id: msgId, seq, updatedAt: iso(), entity: dto });
    return json(dto, { "x-sync-seq": String(seq) });
  }) as unknown as typeof fetch;

  return { fetchImpl, state };
}

const sidecars: CloudSidecar[] = [];
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars, mirrors], close: opens, remove: dirs }));
async function freshDir(prefix: string): Promise<string> {
  const d = await freshDataDir(prefix);
  dirs.push(d);
  return d;
}
async function standUpSidecar(fetchImpl: typeof fetch, address = "me@ohmail.test"): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir: await freshDir("ohmail-cloud-wt-"),
    cloudUrl: "https://cloud.test",
    address,
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl,
    pollIntervalMs: 3_600_000, // no background poll during the test
  });
  sidecars.push(sidecar);
  return sidecar;
}

describe("the write-through proxy forwards, echoes, and refuses offline", () => {
  it("AWAITS the mirror pulling the echoed X-Sync-Seq before answering a mutation", async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    const { fetchImpl } = makeFakeCloud(threadId, msgId);
    const sidecar = await standUpSidecar(fetchImpl);
    await sidecar.start(); // seed: message in INBOX, mirror cursor at seq 2
    const auth = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };

    // Before the move, the mirror holds the message in INBOX.
    const [before] = await sidecar.db.select().from(folderState).where(eq(folderState.messageId, msgId));
    expect(before?.desiredFolder).toBe("INBOX");

    const res = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}/move`, {
      method: "POST", headers: auth, body: JSON.stringify({ folder: "ohmail/News" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe("ohmail/News"); // the hosted answer, relayed verbatim

    // THE ECHO-AWAIT BITES HERE. The instant `handle` returned, the mirror had ALREADY pulled the
    // move's change — so the client's immediate local /sync re-drain sees its own write. Remove the
    // `await mirror.awaitCloudSeq(...)` in cloud-proxy.ts and this reads "INBOX": the poll interval
    // is an hour, so nothing else could have applied it.
    const [after] = await sidecar.db.select().from(folderState).where(eq(folderState.messageId, msgId));
    expect(after?.desiredFolder).toBe("ohmail/News");

    // And the local /sync (a DIFFERENT sequence from the cloud one we waited on) now carries it.
    const sync = await sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: auth }));
    const body = (await sync.json()) as { changes: { updates: Array<{ id: string; entity?: { folder?: string } }> } };
    const upd = body.changes.updates.find((c) => c.id === msgId);
    expect(upd?.entity?.folder).toBe("ohmail/News");
  });

  /* THE WRITE WHOSE ANSWER NAMES NO SEQ. Triage and a Screener decision answer without
     `X-Sync-Seq`, and the proxy used to answer them at once: the client's immediate local /sync
     read the mirror before its pull, the optimistic row was dropped, and the acted-on row came
     back until the next poll (measured on a Cloud-paired desktop, 2026-09-23). */
  it("AWAITS one pull begun after a write whose answer carries no X-Sync-Seq", async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    const { fetchImpl } = makeFakeCloud(threadId, msgId);
    const sidecar = await standUpSidecar(fetchImpl);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };
    const bubbleUpAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const res = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}/triage`, {
      method: "POST", headers: auth, body: JSON.stringify({ state: "bubbled_up", bubbleUpAt }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sync-seq")).toBeNull(); // the hosted shape: nothing to wait on

    // The poll is an hour away, so only the proxy's own pull can have put this here.
    const [st] = await sidecar.db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
    expect(st?.state).toBe("bubbled_up");
  });

  it("refuses EVERY forwarded route with 503 offline_read_only and writes NOTHING locally", async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    const { fetchImpl, state } = makeFakeCloud(threadId, msgId);
    const sidecar = await standUpSidecar(fetchImpl);
    await sidecar.start(); // seed while online
    const auth = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };

    // BITE REFERENCE: online, a mutation forwards and is NOT a 503 — so the 503s below are the
    // offline gate doing something, not every request failing.
    const onlineMove = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}/move`, {
      method: "POST", headers: auth, body: JSON.stringify({ folder: "ohmail/News" }),
    }));
    expect(onlineMove.status).toBe(200);

    // ── GO OFFLINE. Snapshot every table the mutations below could touch. ──
    state.offline = true;
    const snapshot = async (): Promise<Record<string, number>> => ({
      messages: (await sidecar.db.select().from(messages)).length,
      folderState: (await sidecar.db.select().from(folderState)).length,
      messageStates: (await sidecar.db.select().from(messageStates)).length,
      rules: (await sidecar.db.select().from(rules)).length,
      threads: (await sidecar.db.select().from(threads)).length,
      tags: (await sidecar.db.select().from(tags)).length,
      messageTags: (await sidecar.db.select().from(messageTags)).length,
      changeLog: (await sidecar.db.select().from(changeLog)).length,
    });
    const before = await snapshot();
    const mutationsBefore = state.mutations;

    const routes: Array<[string, RequestInit]> = [
      [`/messages/${msgId}/move`, { method: "POST", body: JSON.stringify({ folder: "ohmail/Screened" }) }],
      [`/messages/${msgId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }],
      [`/messages`, { method: "PATCH", body: JSON.stringify({ ids: [msgId], unread: false }) }],
      [`/messages/${msgId}/tags`, { method: "POST", body: JSON.stringify({ tagId: randomUUID(), assigned: true, name: "later" }) }],
      [`/rules`, { method: "POST", body: JSON.stringify({ kind: "sender", match: "x@y.test", destination: "ohmail/Screened" }) }],
      [`/rules/${randomUUID()}`, { method: "DELETE" }],
      [`/threads/${threadId}/rename`, { method: "POST", body: JSON.stringify({ title: "Renamed" }) }],
      [`/threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ muted: true }) }],
      [`/tags`, { method: "POST", body: JSON.stringify({ name: "urgent", hue: "moss" }) }],
      [`/attachments/${randomUUID()}`, { method: "GET" }], // a byte read the mirror does not hold
    ];

    for (const [path, init] of routes) {
      const res = await sidecar.handle(new Request(`http://sidecar${path}`, { headers: auth, ...init }));
      expect(res.status, `${init.method} ${path} should be 503 while offline`).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${init.method} ${path} should carry offline_read_only`).toBe("offline_read_only");
    }

    // OFFLINE WROTE NOTHING — every table is byte-for-byte what it was before the offline mutations.
    expect(await snapshot()).toEqual(before);
    // And the proxy did not even forward once it knew it was offline (the first forward's rejection
    // flipped the flag; the rest short-circuited). At most one reached the fake before the flip.
    expect(state.mutations - mutationsBefore).toBeLessThanOrEqual(1);

    // /health and the online accessor both report offline now.
    expect(sidecar.online()).toBe(false);
    const health = await sidecar.handle(new Request("http://sidecar/health"));
    expect((await health.json()).online).toBe(false);
  });
});

/**
 * THE SCREENING PREFERENCE ON THE HOSTED DOOR — forwarded, both verbs, to where it lives.
 *
 * The desktop window offers this editor on both doors, and on this one the words are a property of
 * the ACCOUNT: the hosted worker that files this mailbox's mail is what reads them, so an install
 * that stored them locally would be writing into a database nothing consults. Nothing here mounts
 * that route — the read table is the mirror's, and `screeningRoutes` is in the standalone table —
 * so both verbs land in the proxy by falling through, which is the arrangement this asserts.
 *
 * It is worth a guard precisely BECAUSE it is a fall-through: the correct behaviour comes from an
 * absence, and an absence is not something anybody edits deliberately. Adding a screening entry to
 * `cloud-read.ts` would answer the GET out of a mirror that holds no such row, and the editor would
 * quietly start showing an empty sentence over an account that has one.
 */
describe("the hosted door's screening preference is the ACCOUNT's", () => {
  it("forwards both the read and the write, and reads back what the write left", async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    const { fetchImpl } = makeFakeCloud(threadId, msgId);
    const sidecar = await standUpSidecar(fetchImpl);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };

    const before = await sidecar.handle(new Request("http://sidecar/account/screening", { headers: auth }));
    expect(before.status, await before.clone().text()).toBe(200);
    expect((await before.json()).ohboxBar, "a fresh account already had words").toBeNull();

    const words = "Only people who write to me by hand, and anything from my bank.";
    const wrote = await sidecar.handle(new Request("http://sidecar/account/screening", {
      method: "PATCH", headers: auth, body: JSON.stringify({ ohboxBar: words }),
    }));
    expect(wrote.status, await wrote.clone().text()).toBe(200);
    expect((await wrote.json()).ohboxBar, "the PATCH was not forwarded").toBe(words);

    /* THE READ IS THE ACCOUNT'S, not this install's. A build that answered the GET locally would
       pass the write assertion above and fail here, which is the whole reason the read is repeated
       rather than trusted from the write's own answer. */
    const after = await sidecar.handle(new Request("http://sidecar/account/screening", { headers: auth }));
    expect((await after.json()).ohboxBar).toBe(words);
  });
});

describe("the mirror's online flag is the pull's own verdict", () => {
  async function standUpMirror() {
    const dataDir = await freshDir("ohmail-cloud-flag-");
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
    return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
  }

  it("a failed pull flips online false; a good pull flips it true and advances cloudSeq", async () => {
    const { db, world, cursorPath } = await standUpMirror();

    const failing: CloudAuth = {
      authedFetch: async () => { throw new TypeError("fetch failed"); },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const failMirror = createCloudMirror({ db, world, auth: failing, cursorPath, now: () => new Date() });
    expect(failMirror.online()).toBe(true); // optimistic at construction
    await expect(failMirror.pullOnce()).rejects.toThrow();
    expect(failMirror.online()).toBe(false); // the pull's verdict
    expect(failMirror.cloudSeq()).toBe(0n);

    // A good auth: one /sync page at seq 5, then drained. The pull restores online and cloudSeq.
    const good: CloudAuth = {
      authedFetch: async (path: string) => {
        const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
        if (path.startsWith("/mailboxes")) return json(mailboxList([HOSTED_MAILBOX]));
        if (path.startsWith("/sync/snapshot")) return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
        if (path.startsWith("/sync")) {
          const since = decodeCursor(new URL(`http://x${path}`).searchParams.get("since") ?? "0");
          if (since < 5) return json(syncPageFrom([{ type: "thread", op: "create", id: randomUUID(), seq: 5, updatedAt: iso(), entity: threadDTO(randomUUID()) }], encodeCursor(5)));
          return json(syncPageFrom([], encodeCursor(since)));
        }
        return json({ items: [], nextCursor: null });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const goodMirror = createCloudMirror({ db, world, auth: good, cursorPath, now: () => new Date() });
    await goodMirror.pullOnce();
    expect(goodMirror.online()).toBe(true);
    expect(goodMirror.cloudSeq()).toBe(5n);

    // awaitCloudSeq returns true when covered, and false (bounded) for a seq that never arrives.
    expect(await goodMirror.awaitCloudSeq(5n, 1_000)).toBe(true);
    expect(await goodMirror.awaitCloudSeq(9n, 150)).toBe(false);
  });

  /* A PULL IN FLIGHT PROVES NOTHING ABOUT A WRITE THAT ANSWERED AFTER IT BEGAN — the proxy's echo
     for a seq-less write. Joining it would read a page minted before the write. */
  it("awaitFreshPull waits out the pull in flight and brings in the write", async () => {
    const { db, world, cursorPath } = await standUpMirror();
    const log: SyncChange[] = [{ type: "thread", op: "create", id: randomUUID(), seq: 5, updatedAt: iso(), entity: threadDTO(randomUUID()) }];
    let hold: Promise<void> | null = null;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
        if (path.startsWith("/mailboxes")) return json(mailboxList([HOSTED_MAILBOX]));
        if (path.startsWith("/sync/snapshot")) return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
        if (path.startsWith("/sync")) {
          const since = decodeCursor(new URL(`http://x${path}`).searchParams.get("since") ?? "0");
          const rows = log.filter((c) => c.seq > since);
          const body = syncPageFrom(rows, encodeCursor(rows.length ? rows[rows.length - 1]!.seq : since));
          const gate = hold;
          if (gate) await gate; // the page was read BEFORE the gate opened
          return json(body);
        }
        return json({ items: [], nextCursor: null });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce();
    expect(mirror.cloudSeq()).toBe(5n);

    let open!: () => void;
    hold = new Promise<void>((r) => { open = r; });
    const early = mirror.pullOnce(); // in flight, its page already read
    await new Promise((r) => setTimeout(r, 50));
    log.push({ type: "thread", op: "create", id: randomUUID(), seq: 6, updatedAt: iso(), entity: threadDTO(randomUUID()) });
    const fresh = mirror.awaitFreshPull(5_000);
    hold = null;
    open();
    await early;
    expect(await fresh).toBe(true);
    expect(mirror.cloudSeq(), "the pull that began before the write was counted as its echo").toBe(6n);
  });
});
