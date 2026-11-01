import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE STORE-STUCK DISCLOSURE REACHES THE WINDOW. A cloud mirror that cannot STORE what it
 * pulls serves mailbox rows whose status is the HOSTED account's — healthy — so the released
 * 0.20.0's wedged first sync looked settled on every surface. When the mirror holds quarantined
 * rows, `GET /mailboxes` overlays `status: "error", errorCode: "storage"`: the strip's
 * mailbox-error arm and Settings → Mailboxes disclose it through affordances that exist, and
 * "Sync now" ends in `pullOnce`, the retry that re-applies the quarantine. Driven through
 * `createCloudSidecar` because the overlay lives at the mount point: a unit test of the map
 * proves nothing about what the window receives (the counts test's reason, next door).
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});

const poisonedPage = (): SyncResponse => ({
  changes: {
    creates: [{
      type: "tag", op: "create", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", seq: 1,
      updatedAt: new Date().toISOString(),
      entity: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", accountId: "unused",
        name: "quarantine-me", hue: "moss",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }] as SyncChange[],
    updates: [], moves: [], deletes: [],
  },
  cursor: "c1", hasMore: false, serverTime: new Date().toISOString(),
});

function hostedFetch(page: SyncResponse, address = "me@ohmail.test"): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, address)]));
    if (url.pathname === "/sync") {
      return send(url.searchParams.get("types") === "rule" ? emptyPage() : page);
    }
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function standUp(page: SyncResponse, address?: string): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-store-stuck-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl: hostedFetch(page, address),
    pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  return sidecar;
}

async function mailboxRows(sidecar: CloudSidecar): Promise<Array<Record<string, unknown>>> {
  const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
    headers: { authorization: `Bearer ${sidecar.sessionToken}` },
  }));
  expect(res.status).toBe(200);
  return (await res.json() as { items: Array<Record<string, unknown>> }).items;
}

describe("the window's mailbox list discloses a store that cannot keep up", () => {
  // A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
  it("CONTROL: a healthy pull leaves the mirrored status untouched", { timeout: 30_000 }, async () => {
    const sidecar = await standUp(emptyPage());
    await sidecar.start();
    const [row] = await mailboxRows(sidecar);
    expect(row!.status, "a healthy mirror invented a failure").not.toBe("error");
  });

  it("a quarantined row overlays status=error, errorCode=storage on every served row", { timeout: 30_000 }, async () => {
    const sidecar = await standUp(poisonedPage());
    // The NEXT constraint the apply has not been taught — the quarantine's whole population.
    await sidecar.db.execute(sql.raw(
      "ALTER TABLE tags ADD CONSTRAINT tags_quarantine_probe CHECK (name <> 'quarantine-me')",
    ));
    await sidecar.start();

    const [row] = await mailboxRows(sidecar);
    expect(row!.status, "the wedge stayed invisible — the released 0.20.0 shape").toBe("error");
    expect(row!.errorCode, "the strip's sentence key: err_storage — 'ohmail could not store this mail'")
      .toBe("storage");
  });

  it("a pull the store refuses outside the quarantine overlays every live row with the copy's own detail", { timeout: 30_000 }, async () => {
    const sidecar = await standUp(emptyPage(), "refused@ohmail.test");
    await sidecar.db.execute(sql.raw("ALTER TABLE mailboxes ADD CONSTRAINT refresh_probe CHECK (address <> 'refused@ohmail.test')"));
    await sidecar.start();
    // The poll retries on its backoff (1 s, 2 s): the third refusal is the stuck copy.
    const end = Date.now() + 15_000;
    let rows = await mailboxRows(sidecar);
    while (!rows.some((r) => r.errorDetail === "MIRROR_STORE_REFUSED") && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 250));
      rows = await mailboxRows(sidecar);
    }
    const live = rows.filter((r) => r.status !== "disabled");
    expect(live.length).toBeGreaterThan(0);
    expect(live.map((r) => [r.status, r.errorCode, r.errorDetail]), "a copy that cannot store its pull looked healthy")
      .toEqual(live.map(() => ["error", "storage", "MIRROR_STORE_REFUSED"]));
  });
});
