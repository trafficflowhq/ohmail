import type {
  Folder,
  MailboxDTO,
  MessageBodyBatchItem,
  MessageDTO,
  Page,
  RuleDTO,
  SyncChange,
  SyncResponse,
  ThreadDTO,
} from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * THE CLOUD-MODE LOCAL READ SURFACE SERVES FROM THE MIRROR — no IMAP barrel, no forward for a read.
 *
 * PGlite is production-truth in the sidecar, so this stands up a REAL Cloud sidecar
 * (`createCloudSidecar`) against an in-process fake hosted API, pulls one feed into the mirror, and
 * then exercises the local read surface — `GET /messages/:id`, `/messages/:id/body`,
 * `/messages/bodies`, `/threads/:id`, `/mailboxes`, `/tags`, `/rules` — over the same
 * `handle` the stdio host calls. Two things are proven together:
 *
 *  1. every read returns the mirrored row out of the local database; and
 *  2. NOT ONE of them forwards to Cloud — the fake's call log does not grow across the reads, which
 *     is the runtime shadow of the static census: the read surface reaches read services and the
 *     mirror, never the hosted API and never the IMAP adapter behind `packages/api`'s route table.
 *
 * The LIST route (`GET /messages`) is deliberately the OTHER way round — it is the reach-past
 * door, a page of mail beyond what the mirror kept, and the mirror cannot answer that question
 * truthfully (it would re-serve its own window and then claim the mail ends there; for folders it
 * refused outright, which is the defect the tests below pin). The same boundary gives the body
 * read a fall-through: a mirrored message's body is served locally, and a reach-past row's body —
 * a message the mirror never held — forwards to the hosted account instead of dying as a local 404.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** What `GET /mailboxes` answers on the hosted side, and what the mirror mirrors. */
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const iso = (): string => new Date().toISOString();

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64url");
}

function messageDTO(id: string, threadId: string, folder: Folder, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder, snippet: "we have not met before", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(), ...over,
  };
}
function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, subject: "Can we talk?", messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
  };
}
function ruleDTO(id: string): RuleDTO {
  return {
    id, kind: "sender", match: "stranger@nowhere.test", destination: "ohmail/Screened",
    priority: 0, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null,
    stats: { hits: 3, lastHitAt: iso(), demotions: 0 }, createdAt: iso(), updatedAt: iso(),
    retro: { requestedAt: null, doneAt: null },
    byOhmail: false,
  };
}
function syncPage(changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse {
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
function change(type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) };
}

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-cloud-read-");
  dirs.push(d);
  return d;
}

describe("cloud mode serves the full mail READ surface from the local mirror", () => {
  // A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
  it("pulls a feed, then answers every read locally without forwarding to Cloud", { timeout: 30_000 }, async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    const ruleId = randomUUID();
    const bodyText = "the full hosted body, mirrored locally";

    // ── A fake hosted API: one /sync page, one body, and a call log so a forwarded READ is caught. ──
    const calls: string[] = [];
    const drained = new Set<string>();
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      calls.push(`${url.pathname}${url.search}`);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      // The account's mailboxes. The mirror refreshes these ahead of every drain, so a fake that
      // 404s here has an install that cannot attribute a single message.
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        if (since === "0") {
          return send(syncPage([
            change("thread", threadId, "create", 1, threadDTO(threadId)),
            change("message", msgId, "create", 2, messageDTO(msgId, threadId, "INBOX")),
            change("rule", ruleId, "create", 3, ruleDTO(ruleId)),
          ], encodeCursor(3), false));
        }
        return send(syncPage([], since, false));
      }
      if (url.pathname === "/messages/bodies") {
        if (drained.has("bodies")) return send({ items: [], nextCursor: null });
        drained.add("bodies");
        return send({
          items: [{ messageId: msgId, text: bodyText, html: `<p>${bodyText}</p>`, loadedRemoteContent: false }],
          nextCursor: null,
        } satisfies Page<MessageBodyBatchItem>);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000, // one pull only
    });
    sidecars.push(sidecar);

    await sidecar.start(); // pulls the feed into the mirror
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const readsBefore = calls.length; // any growth here means a read forwarded to Cloud
    const jsonOf = async (r: Response): Promise<any> => r.json();

    // GET /messages (the LIST route) is deliberately NOT here: it is the reach-past door — a
    // page of mail beyond the local window — and forwards to the hosted account. Its own test
    // is below ("the reach-past list forwards to Cloud with its folder address intact").

    // GET /messages/:id
    const one = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}`, { headers: auth }));
    expect(one.status).toBe(200);
    expect((await jsonOf(one)).subject).toBe("Can we talk?");

    // GET /messages/:id/body — the backfilled body.
    const body = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}/body`, { headers: auth }));
    expect(body.status).toBe(200);
    expect((await jsonOf(body)).text).toBe(bodyText);

    // GET /messages/bodies — the batch text pull, served locally (STATIC beats /messages/:id).
    const bodies = await sidecar.handle(new Request("http://sidecar/messages/bodies?limit=10", { headers: auth }));
    expect(bodies.status).toBe(200);
    expect((await jsonOf(bodies)).items.map((b: MessageBodyBatchItem) => b.messageId)).toContain(msgId);

    // GET /threads/:id
    const thread = await sidecar.handle(new Request(`http://sidecar/threads/${threadId}`, { headers: auth }));
    expect(thread.status).toBe(200);
    expect((await jsonOf(thread)).id).toBe(threadId);

    // GET /search is not here: the account answers it whenever it can be reached, and the mirror
    // only while it cannot (`cloud-paired-search.test.ts` drives both arms through this door).

    /* GET /mailboxes — THE ACCOUNT'S OWN MAILBOX, not the local placeholder.
       This is the read the From selector and the sync line are both built on. It used to answer the
       row `identity.ts` mints — a random id addressed with the account LOGIN — so a send carrying
       that id was refused by the hosted API and the selector offered one wrong label. One row,
       because the account has one, and it is the HOSTED one. */
    const mailboxes = await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: auth }));
    expect(mailboxes.status).toBe(200);
    const boxes = (await jsonOf(mailboxes)).items as MailboxDTO[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.id, "the local placeholder mailbox is still what this door serves").toBe(CLOUD_MAILBOX);
    expect(boxes[0]!.address).toBe("me@ohmail.test");

    // GET /tags — empty but wired.
    const tags = await sidecar.handle(new Request("http://sidecar/tags", { headers: auth }));
    expect(tags.status).toBe(200);
    expect((await jsonOf(tags)).items).toEqual([]);

    // GET /rules — the mirrored rule.
    const rules = await sidecar.handle(new Request("http://sidecar/rules", { headers: auth }));
    expect(rules.status).toBe(200);
    expect((await jsonOf(rules)).items.map((r: RuleDTO) => r.id)).toContain(ruleId);

    // GET /rules/:id
    const rule = await sidecar.handle(new Request(`http://sidecar/rules/${ruleId}`, { headers: auth }));
    expect(rule.status).toBe(200);
    expect((await jsonOf(rule)).destination).toBe("ohmail/Screened");

    // THE POINT: every read above was served from the mirror. The fake's call log did not grow —
    // not one read forwarded to the hosted API.
    expect(calls.length, `a read forwarded to Cloud: ${calls.slice(readsBefore).join(", ")}`).toBe(readsBefore);

    // An unauthenticated read is refused before any of this — the bearer is the boundary.
    const anon = await sidecar.handle(new Request(`http://sidecar/messages/${msgId}`));
    expect(anon.status).toBe(401);

    // A missing message is a 404 from the read service, not a forward.
    const missing = await sidecar.handle(new Request(`http://sidecar/messages/${randomUUID()}`, { headers: auth }));
    expect(missing.status).toBe(404);
    expect(calls.length).toBe(readsBefore);

    // /health carries the live online flag.
    const health = await sidecar.handle(new Request("http://sidecar/health"));
    expect(health.status).toBe(200);
    const h = await jsonOf(health);
    expect(h).toMatchObject({ mode: "cloud", online: true });
  });

  /**
   * THE LOCAL `/sync` REFUSES A CURSOR AHEAD OF THE LOCAL LOG — the desktop half of the ceiling.
   *
   * A mirrored install has TWO unrelated sequences (see the `/sync/snapshot` note in
   * `cloud-read.ts`): the hosted account's `change_log`, which the mirror's own pull is counted
   * in, and THIS database's `change_log`, which is what the local `GET /sync` is answered from.
   * A client that ever presents a cursor from the wrong one — or from a mirror rebuilt beneath it
   * — names a seq the local log does not have, and before the ceiling check that was answered 200
   * with an empty delta on every poll, for ever. Nothing errored and no surface could show it.
   *
   * `syncService.getChanges` is shared by both surfaces, so the fix reaches the desktop through
   * the same code as Cloud. What this pins is that the answer SURVIVES THE LOCAL TRANSPORT: the
   * `ServiceError` is mapped to its own status by `cloud-engine.ts` rather than becoming a 500 —
   * the engine's re-bootstrap branch keys on 410 specifically, and a 500 would surface as a sync
   * failure the user is asked to look at instead of a mirror that quietly heals itself.
   */
  it("the LOCAL /sync 410s a cursor above the local log, and still serves the one at it", { timeout: 30_000 }, async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      // The account's mailboxes. The mirror refreshes these ahead of every drain, so a fake that
      // 404s here has an install that cannot attribute a single message.
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        if (since === "0") {
          const threadId = randomUUID();
          return send(syncPage([
            change("thread", threadId, "create", 1, threadDTO(threadId)),
            change("message", randomUUID(), "create", 2, messageDTO(randomUUID(), threadId, "INBOX")),
          ], encodeCursor(2), false));
        }
        return send(syncPage([], since, false));
      }
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    // Drain the LOCAL feed to find this database's own ceiling. It is not the hosted one.
    const drain = await sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: auth }));
    expect(drain.status).toBe(200);
    const localCursor = ((await drain.json()) as SyncResponse).cursor;
    const localMax = Number(Buffer.from(localCursor, "base64url").toString("utf8"));
    expect(localMax).toBeGreaterThan(0);

    // AT the ceiling — the steady state of a caught-up desktop mirror. Must stay a 200.
    const idle = await sidecar.handle(
      new Request(`http://sidecar/sync?since=${localCursor}`, { headers: auth }),
    );
    expect(idle.status).toBe(200);
    expect(((await idle.json()) as SyncResponse).cursor).toBe(localCursor);

    // ABOVE it — the incident. 410, with the code the engine's re-bootstrap branch keys on.
    const ahead = encodeCursor(localMax + 489);
    const res = await sidecar.handle(new Request(`http://sidecar/sync?since=${ahead}`, { headers: auth }));
    expect(res.status).toBe(410);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("cursor_expired");
  });

  /**
   * THE REACH-PAST LIST FORWARDS — the desktop folder-contents fix, pinned from the outside.
   *
   * `GET /messages?view=folder&folderId=…&beforeDate=…&beforeId=…` is the ask FolderView makes
   * when a folder's mail lives beyond what this device kept. The mirror cannot answer it: this
   * table's old handler dropped `folderId` on the floor and the service refused with
   * `400 view=folder requires folderId`, which is exactly the "older mail could not be loaded"
   * line the desktop rendered over every folder. The honest answer lives on the hosted account,
   * so the ask must travel the proxy — with its whole address intact, because a forward that
   * re-derived the query would be this bug once removed.
   */
  it("the reach-past list forwards to Cloud with its folder address intact", { timeout: 30_000 }, async () => {
    const folderId = randomUUID();
    const reachPastId = randomUUID();
    const forwarded: string[] = [];
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        return send(syncPage([], url.searchParams.get("since") ?? "0", false));
      }
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      if (url.pathname === "/messages") {
        forwarded.push(`${url.pathname}${url.search}`);
        return send({
          items: [messageDTO(reachPastId, randomUUID(), "ohmail/Receipts")],
          nextCursor: "next-page-token",
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const ask = `/messages?view=folder&folderId=${folderId}&beforeDate=2024-01-01T00%3A00%3A00.000Z&beforeId=${reachPastId}&limit=50`;
    const res = await sidecar.handle(new Request(`http://sidecar${ask}`, { headers: auth }));
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: MessageDTO[]; nextCursor: string | null };
    expect(page.items.map((m) => m.id)).toEqual([reachPastId]);
    expect(page.nextCursor).toBe("next-page-token");
    // The whole address traveled: the folder ENTITY id and the mirror-boundary keyset both
    // reached the hosted route — a forward that dropped either would re-create the defect.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain(`folderId=${folderId}`);
    expect(forwarded[0]).toContain(`beforeId=${reachPastId}`);
    expect(forwarded[0]).toContain("beforeDate=2024-01-01");
    expect(forwarded[0]).toContain("view=folder");
  });

  /**
   * THE REACH-PAST BODY FALLS THROUGH — a message the mirror never held answers with the hosted
   * body instead of a local 404. A mirrored message's body stays a LOCAL read (the first test
   * pins that with its call log); a thread/rule/message-row `not_found` stays a local 404 (also
   * pinned above) — the fall-through is scoped to `GET /messages/:id/body` alone, because the
   * reach-past list is the only thing that hands this client ids from beyond the mirror.
   */
  it("a reach-past row's body forwards to Cloud instead of 404ing locally", { timeout: 30_000 }, async () => {
    const reachPastId = randomUUID();
    const forwarded: string[] = [];
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        return send(syncPage([], url.searchParams.get("since") ?? "0", false));
      }
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      if (url.pathname === `/messages/${reachPastId}/body`) {
        forwarded.push(url.pathname);
        return send({
          messageId: reachPastId, text: "the hosted body of a reach-past row", html: null,
          headers: {}, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const res = await sidecar.handle(new Request(`http://sidecar/messages/${reachPastId}/body`, { headers: auth }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe("the hosted body of a reach-past row");
    expect(forwarded).toEqual([`/messages/${reachPastId}/body`]);
  });
});
