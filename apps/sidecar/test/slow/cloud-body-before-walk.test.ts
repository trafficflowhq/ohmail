import type { EngineMessage, MessageDTO, SyncChange, SyncResponse, ThreadDTO } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { PGLITE_STANDUP_BUDGET_MS } from "../pglite-budget.js";
import { freshDataDir } from "../_datadir.js";

/* Every test here stands up its own PGlite store inside the test body — see the budget module. */
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE FIRST LOAD THAT SHOWS A MAIL LIST AND NO MAIL — the cloud door's body read, asked in the
 * window between the list arriving and the body walk reaching it.
 *
 * ── THE SEQUENCE, WHICH IS ORDINARY AND NOT A RACE ANYBODY HAS TO LOSE ──────────────────────
 *
 * A mirrored install fills in two passes, and `cloud-mirror.ts` says so in its own header:
 * messages travel on `/sync` and BODIES DO NOT ("they are not a `/sync` entity — the client
 * hydrates them separately"), so `backfillBodies` runs only after `drainSync` has returned. The
 * window between the two is not an edge case, it is every first launch: the list is complete
 * before its bodies are, and on a large account the replay behind it runs for hours.
 *
 * In that window the window's engine — `createLocalEngine()` in `apps/desktop/src/bridge-fetch.ts`,
 * `eagerBodies: true` — asks this process for the newest messages' bodies. And this is what it was
 * told:
 *
 *   1. `GET /messages/:id/body` matches `cloud-read.ts`'s local table, so it is served from the
 *      mirror by `MessageService.getBody`;
 *   2. that service proves ownership through `messages` (the row IS mirrored — it is why the list
 *      renders) and then LEFT-JOINs `message_bodies`, which has no row yet;
 *   3. its documented answer for that shape is "a message with no ingested body yields an empty
 *      body" — `200 {text: "", html: null}`. Correct for the hosted server, where an absent row
 *      means the body was never ingested. FABRICATED here, where it means "not copied yet".
 *
 * The client cannot tell those apart, and it does not treat the answer as provisional: an answered
 * body is `ready`, and `OhmailEngine.bodyPlan` never re-fetches a `ready` record. The mirror fills
 * in a minute; the window's copy of the mail stays blank for the life of the process. It is the
 * desktop window that hides how bad this is — its mirror is in memory and is rebuilt on each
 * launch, so quitting and reopening the app "fixes" it, which is exactly the shape of a defect that
 * gets reported as flakiness.
 *
 * The rule that closes it is already written, one file over, and merely applied too narrowly.
 * `cloud-read.ts`: "a read whose QUESTION is about what the mirror does NOT hold must forward,
 * however read-shaped it looks." A body the mirror has not copied yet is precisely such a read.
 *
 * ── WHAT THIS TEST STANDS UP ────────────────────────────────────────────────────────────────
 *
 * Nothing is mocked below the transport, the same standard `sidecar.e2e.test.ts` sets: a REAL
 * cloud sidecar over on-disk PGlite (`createCloudSidecar`), a REAL `OhmailEngine` + `HttpAdapter`
 * composed exactly as the desktop window composes them, and an in-process hosted API that holds
 * the body — because a hosted account always does — while answering the mirror's body walk with
 * nothing, which is the walk's ordinary mid-flight state.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const iso = (): string => new Date().toISOString();
const encodeCursor = (seq: number): string => Buffer.from(String(seq), "utf8").toString("base64url");

/** The body the HOSTED account holds for the message — the mail the reader opened the app to read. */
const HOSTED_BODY_TEXT = "the real body, which the hosted account has had all along";
const HOSTED_BODY_HTML = `<p>${HOSTED_BODY_TEXT}</p>`;

function messageDTO(id: string, threadId: string): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "we have not met before", unread: true,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: ACCOUNT, subject: "Can we talk?", messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
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

interface World {
  sidecar: CloudSidecar;
  engine: OhmailEngine;
  msgId: string;
  /** A second mirrored message, so a keyset page can differ from what a caller asked for. */
  otherId: string;
  /** Every path the fake hosted API was asked for, in order. */
  calls: string[];
  /** How many times the WINDOW has asked this process for a body — the permanence claim's evidence. */
  bodyAsks(): number;
  /** Let the hosted body walk start answering — the mirror catching up, a minute later. */
  releaseWalk(): void;
}

/**
 * A mirrored install mid-first-import: the message is on `/sync`, the body walk answers nothing
 * yet, and the hosted account holds the body the whole time.
 */
async function standUp(): Promise<World> {
  const threadId = randomUUID();
  const msgId = randomUUID();
  const otherId = randomUUID();
  const calls: string[] = [];
  let walkOpen = false;

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    calls.push(`${url.pathname}${url.search}`);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

    if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
    if (url.pathname === "/sync") {
      const since = url.searchParams.get("since") ?? "0";
      if (since === "0") {
        return send(syncPage([
          change("thread", threadId, "create", 1, threadDTO(threadId)),
          change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
          change("message", otherId, "create", 3, messageDTO(otherId, threadId)),
        ], encodeCursor(3), false));
      }
      return send(syncPage([], since, false));
    }
    /* THE BODY WALK, MID-FLIGHT. `GET /messages/bodies` is the mirror's own backfill — both the
       keyset walk and the newest-first `?ids=` ask. Answering it with nothing is not a failure and
       not a fake being unhelpful: it is what the walk sees for every message it has not reached
       yet, which on a large account is most of them for most of the first import. */
    if (url.pathname === "/messages/bodies") {
      if (!walkOpen) return send({ items: [], nextCursor: null });
      return send({
        items: [{ messageId: msgId, text: HOSTED_BODY_TEXT, html: HOSTED_BODY_HTML, loadedRemoteContent: false }],
        nextCursor: null,
      });
    }
    /* THE HOSTED ACCOUNT HAS THE BODY THROUGHOUT. This is the route a forward would reach, and
       the reason a forward is the honest answer: the mail exists, one hop away, the entire time
       the mirror is rendering it blank. */
    if (url.pathname === `/messages/${msgId}/body`) {
      return send({
        messageId: msgId, text: HOSTED_BODY_TEXT, html: HOSTED_BODY_HTML,
        headers: {}, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const dataDir = await freshDataDir("ohmail-first-load-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl,
    pollIntervalMs: 3_600_000, // one pull only — every drain here is one the test asked for
  });
  sidecars.push(sidecar);
  await sidecar.start();

  /* THE WINDOW'S ENGINE, COMPOSED AS `createLocalEngine()` COMPOSES IT: the real client over the
     bridge's fetch, `eagerBodies: true`, and NO STORE — the desktop's mirror is in memory and is
     rebuilt on each launch, which is the detail that turns this defect into "restarting fixed it". */
  let bodyAsks = 0;
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({
      baseUrl: "http://sidecar",
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(href, "http://sidecar");
        if (url.pathname === `/messages/${msgId}/body` || url.pathname === "/messages/bodies") bodyAsks += 1;
        return sidecar.handle(new Request(url, init));
      }) as unknown as typeof fetch,
      headers: () => ({ authorization: `Bearer ${sidecar.sessionToken}` }),
    }),
    eagerBodies: true,
  });

  return {
    sidecar, engine, msgId, otherId, calls,
    bodyAsks: () => bodyAsks,
    releaseWalk: () => { walkOpen = true; },
  };
}

describe("the cloud door's first load, between the list arriving and the body walk reaching it", () => {
  // A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
  it("does not serve a fabricated empty body for a message whose body the mirror has not copied yet", { timeout: 30_000 }, async () => {
    const w = await standUp();
    const auth = { authorization: `Bearer ${w.sidecar.sessionToken}` };

    // THE LIST IS THERE. This is the state reported: mail on screen, nothing in it.
    const listed = await w.sidecar.handle(new Request(`http://sidecar/messages/${w.msgId}`, { headers: auth }));
    expect(listed.status, "the message row is mirrored — it is why a list renders at all").toBe(200);
    expect((await listed.json()).subject).toBe("Can we talk?");

    // AND THE BODY IS NOT. The mirror holds no `message_bodies` row for it yet.
    const body = await w.sidecar.handle(new Request(`http://sidecar/messages/${w.msgId}/body`, { headers: auth }));
    expect(body.status).toBe(200);
    const served = await body.json();

    /* THE DEFECT, AT THE WIRE. An absent body row means "never ingested" on the hosted server and
       "not copied yet" in a mirror, and this route answered the first when it meant the second —
       inventing an empty message for one the hosted account is holding in full. */
    expect(
      served.text,
      "the body read invented an empty message for a body the mirror has merely not copied yet",
    ).toBe(HOSTED_BODY_TEXT);
  });

  it("answers the batch body ask with the ids it was given, not a keyset page of somebody else's mail", { timeout: 30_000 }, async () => {
    const w = await standUp();
    const auth = { authorization: `Bearer ${w.sidecar.sessionToken}` };

    /* `HttpAdapter.fetchBodies` — the door a thread open and the eager pass both use — sends
       `GET /messages/bodies?ids=…`, and `MessageService.getBodies` selects that mode from the
       `ids` option. This door reads only `after` and `limit`, so the parameter is dropped and the
       ask is answered as the KEYSET WALK: a page of the account's bodies from the beginning,
       which is a page about other messages. The client matches rows by `messageId` and finds
       none of what it asked for. */
    const res = await w.sidecar.handle(new Request(
      `http://sidecar/messages/bodies?ids=${w.msgId}`,
      { headers: auth },
    ));
    expect(res.status).toBe(200);
    const items = (await res.json()).items as Array<{ messageId: string }>;
    expect(
      items.every((i) => i.messageId === w.msgId),
      `the batch ask was answered with rows it did not ask for: ${items.map((i) => i.messageId).join(", ")}`,
    ).toBe(true);
  });

  it("leaves the reader's copy blank for the life of the window, because a ready body is never re-asked", { timeout: 30_000 }, async () => {
    const w = await standUp();

    // The window bootstraps off the mirror and eagerly hydrates the newest bodies — the desktop's
    // own configuration, and the pass that asks for a body before the walk has delivered one.
    await w.engine.start();
    const mirrored = w.engine.store.get<EngineMessage>("message", w.msgId);
    expect(mirrored, "the message reached the window's mirror — the list is on screen").toBeTruthy();

    await w.engine.hydrateBody(w.msgId);
    const asksAfterFirstOpen = w.bodyAsks();
    expect(asksAfterFirstOpen, "the window did ask this process for the body").toBeGreaterThan(0);

    /* THE RECORD THE WINDOW WILL LIVE WITH. An answered body is `ready`, and `bodyPlan` never
       re-fetches a `ready` record — so whatever landed here is what this reader sees until the
       process is restarted and the in-memory mirror is rebuilt. The second open below is what
       makes that concrete rather than a claim about the code. */
    const held = w.engine.store.get<{ state: string; text: string }>("message_body", w.msgId);
    expect(held?.state).toBe("ready");

    await w.engine.hydrateBody(w.msgId);
    expect(
      w.bodyAsks(),
      "a ready record is never re-asked — so a body that arrived empty stays empty for the life of the window",
    ).toBe(asksAfterFirstOpen);

    expect(
      w.engine.store.get<{ text: string }>("message_body", w.msgId)?.text,
      "the reader's copy of a message the hosted account holds in full — blank, and permanently so",
    ).toBe(HOSTED_BODY_TEXT);
  });
});
