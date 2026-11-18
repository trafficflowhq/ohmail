import type { SyncChange, SyncResponse } from "@ohmail/wire";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountSettings } from "@trafficflow/db";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ THE SETTINGS DOORBELL CROSSES THE MIRROR — the web→desktop leg of settings propagation ═══
 *
 * A consent knob flipped in a browser appends a `settings` change on the HOSTED log
 * (`packages/services/test/settings-sync.test.ts` owns that half). For the flip to reach an OPEN
 * desktop window without a restart, this mirror must do two things with the pulled change:
 *
 *  1. RE-EMIT it into the LOCAL change log — the webview's engine drains the local `/sync`, and
 *     a change that stops at the mirror's tables is a doorbell nobody hears;
 *  2. move the local settings row's OWN stamp to the hosted one — the local
 *     `materializeSettings` answers `updated_at`, and the shell's re-ask keys on that stamp
 *     CHANGING, so a re-emission that kept a local `now()` would still work but a dropped or
 *     unmoved stamp is a flip the shell never learns about.
 *
 * And one thing it must NOT do: write `folders_enabled_at`. The local flag is DERIVED from what
 * the feed actually sent (`reconcileLocalFoldersFlag` — a folder page settles it in the same
 * transaction), and a second writer taking it from the hosted DTO would fight that derivation
 * exactly when they disagree — master on with zero participating folders.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const iso = (): string => new Date().toISOString();
const STAMP = "2026-08-26T07:00:00.000Z";

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64url");
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

const settingsChange = (seq: number): SyncChange => ({
  type: "settings", op: "update", id: CLOUD_ACCOUNT, seq, updatedAt: STAMP,
  entity: {
    accountId: CLOUD_ACCOUNT,
    dormancyDays: 45,
    autoSuggestAt: null,
    blockRemoteImagesAt: "2026-08-26T06:59:00.000Z",
    loadTrackingPixelsAt: null,
    blockAutoUnsubscribeAt: null,
    // Present ON PURPOSE: the apply must leave the LOCAL flag alone even when the wire says on.
    foldersEnabledAt: "2026-08-26T06:58:00.000Z",
    folderMailboxesOff: {},
    locale: null,
    updatedAt: STAMP,
  },
});

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-cloud-settings-");
  dirs.push(d);
  return d;
}

describe("a pulled settings change re-emits locally, stamp intact, flag untouched", () => {
  // A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
  it("lands in the local /sync with the hosted stamp; folders_enabled_at stays derived", { timeout: 30_000 }, async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        if (since === "0") return send(syncPage([settingsChange(1)], encodeCursor(1), false));
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

    // 1. THE RE-EMISSION: the local /sync — what the desktop webview's engine actually drains —
    //    carries the settings change, materialized from the LOCAL row.
    const drain = await sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: auth }));
    expect(drain.status).toBe(200);
    const page = (await drain.json()) as SyncResponse;
    const all = [
      ...page.changes.creates, ...page.changes.updates, ...page.changes.moves,
    ].filter((c) => c.type === "settings");
    const tombs = page.changes.deletes.filter((c) => c.type === "settings");
    expect(tombs).toHaveLength(0);
    // At LEAST one: the pull is at-least-once and a bootstrap replay may record the same change
    // twice, which the client's idempotent upsert absorbs — what may never happen is zero (the
    // doorbell dropped) or a tombstone (the doorbell mis-keyed to a foreign account id).
    expect(all.length, "the pulled settings change never re-emitted into the local log").toBeGreaterThan(0);

    // 2. THE STAMP MOVED WITH THE WIRE: the local row's updated_at is the hosted one, so the
    //    shell's stamp comparison sees a change, not a coincidence of local clocks.
    const entity = all[all.length - 1]!.entity as { updatedAt?: string; foldersEnabledAt?: string | null };
    expect(entity.updatedAt).toBe(STAMP);

    // 3. THE FLAG STAYS DERIVED: the wire said `foldersEnabledAt` non-null, but no folder entity
    //    was ever sent — the LOCAL column must still be null (reconcile's verdict), and the
    //    local materialization reports the same.
    const world = await sidecar.db.select({ at: accountSettings.foldersEnabledAt })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, sidecar.world.accountId));
    expect(world[0]?.at ?? null).toBeNull();
    expect(entity.foldersEnabledAt ?? null).toBeNull();
  });
});
