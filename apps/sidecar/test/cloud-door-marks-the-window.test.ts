import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { windowIsQuiet } from "../src/store-lanes.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE CLOUD DOOR MARKS A PERSON AT THE WINDOW, so its mirror's checkpoint waits for them as the local
 * door's does (`store-checkpoint-waits-for-the-window.test.ts`). A poll and the window's own `/local/`
 * routes (the outbox, its reports) do not mark: they run on the window's clock, not a person's.
 * WATCHED FAILING: drop `forWindow` from `cloud-engine.ts`'s `queued`, or its `/local/` exclusion.
 */

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
  if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
  if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

/** Long enough that a mark made anywhere in this file still reads. */
const SINCE_THE_START_MS = 60 * 60 * 1000;

describe("the Cloud door and the window", () => {
  it("marks a person's request, and neither a poll nor the window's own outbox", { timeout: 30_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-cloud-window-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", fetchImpl, pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    const ask = (path: string, method = "GET"): Promise<Response> => sidecar.handle(new Request(`http://sidecar${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    }));

    expect(windowIsQuiet(SINCE_THE_START_MS), "a request marked the window before this case").toBe(true);
    await (await ask("/messages/bodies")).text();
    expect(windowIsQuiet(SINCE_THE_START_MS), "the body prefetch marked the window").toBe(true);
    await (await ask("/local/window/outbox", "POST")).text();
    expect(windowIsQuiet(SINCE_THE_START_MS), "the window's outbox marked the window").toBe(true);
    await (await ask("/messages/x")).text();
    expect(windowIsQuiet(SINCE_THE_START_MS), "opening a message did not mark the window").toBe(false);
  });
});
