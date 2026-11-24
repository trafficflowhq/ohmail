import type { SyncChange, SyncResponse } from "@ohmail/wire";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * HISTORY ON A PAIRED DESKTOP. `GET /messages/timeline` is relayed; the mirror's `/messages/:id`
 * read used to take it with id "timeline", and the uuid column threw a plain error the window
 * logged as a failed request, so History showed nothing. Driven through `createCloudSidecar`
 * over a fake hosted account: the answer the window receives is the claim.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIMELINE = { items: [{ id: "hosted-row" }], nextCursor: null };

const asked: string[] = [];
let sidecar: CloudSidecar;
let dataDir: string;
beforeAll(async () => {
  dataDir = await freshDataDir("ohmail-paired-timeline-");
  sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl: hostedFetch(asked),
    pollIntervalMs: 3_600_000,
  });
  await sidecar.start();
  // A door's stand-up reads ~10 s under load, the hook default: red at base as at tip, so the bound is its own.
}, 30_000);
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});

function hostedFetch(asked: string[]): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    asked.push(url.pathname);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync") return send(emptyPage());
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/messages/timeline") return send(TIMELINE);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const get = (path: string): Promise<Response> =>
  sidecar.handle(new Request(`http://sidecar${path}`, {
    headers: { authorization: `Bearer ${sidecar.sessionToken}` },
  }));

describe("the paired door routes the timeline to the hosted account", () => {
  it("GET /messages/timeline answers the hosted page", async () => {
    const res = await get("/messages/timeline?limit=50");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TIMELINE);
    expect(asked).toContain("/messages/timeline");
  });

  it("CONTROL: a mirrored message id is still answered locally, not relayed", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const res = await get(`/messages/${id}`);
    expect(res.status).toBe(404);
    expect(asked).not.toContain(`/messages/${id}`);
  });

  it("a misshapen id is a 400 naming the parameter, not a thrown error", async () => {
    const res = await get("/messages/not-an-id");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", message: "id must be an id" } });
  });
});
