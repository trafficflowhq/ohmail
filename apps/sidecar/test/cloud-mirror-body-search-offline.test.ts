import type { MessageDTO, SyncChange, SyncResponse } from "@ohmail/wire";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, StoreSearchWalker } from "@ohmail/client-engine";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A MIRRORED LETTER IS FOUND BY A WORD OF ITS BODY WITH THE NETWORK OFF. A paired desktop's mirror
 * is filled from its account, and after an update it is filled again from nothing: the search over
 * it must find what the fill brought, not only subjects. The body arrives after the letter, by the
 * mirror's own fetch, and its words are written to the mirror's search document where the body is
 * stored. Driven through the paired engine over a fake account, and read back through the window's
 * own adapter, engine and walker with every request to the account failing.
 */

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LETTER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const iso = (): string => new Date().toISOString();

function dto(): MessageDTO {
  return {
    id: LETTER, accountId: ACCOUNT, mailboxId: MAILBOX, threadId: null, messageIdHeader: `<${LETTER}@x.test>`, subject: "Saturday",
    from: { name: null, address: "friend@birds.test" }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

const state = { down: false };
const hostedFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (state.down) throw new TypeError("fetch failed");
  const send = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
  if (url.pathname === "/sync") {
    const since = url.searchParams.get("since") ?? "0";
    const page: SyncResponse = {
      changes: {
        creates: since === "0" ? [{ type: "message", op: "create", id: LETTER, seq: 1, updatedAt: iso(), entity: dto() } as SyncChange] : [],
        updates: [], moves: [], deletes: [],
      },
      cursor: since === "0" ? Buffer.from("1").toString("base64url") : since, hasMore: false, serverTime: iso(),
    };
    return send(page);
  }
  // The body, which names a bird the subject does not.
  if (url.pathname === "/messages/bodies") {
    return send({ items: [{ messageId: LETTER, text: "the kingfisher waits by the weir", html: null, loadedRemoteContent: false }], nextCursor: null });
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

let sidecar: CloudSidecar;
let dataDir: string;
beforeAll(async () => {
  dataDir = await freshDataDir("ohmail-body-search-offline-");
  sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl: hostedFetch, pollIntervalMs: 3_600_000, accountFirstBoundMs: 200,
  });
  await sidecar.start();
}, 60_000);
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** One question through the walker the Search view reads, over this door, to its settled verdict. */
async function verdictOf(query: string): Promise<ReturnType<StoreSearchWalker["info"]>> {
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter = new HttpAdapter({
    baseUrl: "http://sidecar",
    fetch: (url: string, init?: RequestInit) => sidecar.handle(new Request(url, {
      ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${sidecar.sessionToken}` },
    })),
  });
  const walker = new StoreSearchWalker(new OhmailEngine({ adapter, store }));
  walker.start({ query }, () => [], 0);
  for (let i = 0; i < 300 && (walker.state() === "searching" || walker.info()?.totalExact === false); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const info = walker.info();
  walker.clear();
  return info;
}

describe("a paired desktop with the network off", () => {
  it("finds a mirrored letter by a word that stands only in its body", async () => {
    // The body has landed in the mirror: the fill fetched it after the letter.
    for (let i = 0; i < 500; i++) {
      const r = await sidecar.db.execute(sql`select count(*)::int as n from message_bodies where message_id = ${LETTER}`);
      if ((r.rows[0] as { n: number }).n === 1) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    state.down = true;
    expect(await verdictOf("kingfisher")).toMatchObject({ total: 1, fromMirror: true });
    // CONTROL: a word no letter holds finds nothing, from the same mirror.
    expect(await verdictOf("albatross")).toMatchObject({ total: 0, fromMirror: true });
  }, 60_000);
});
