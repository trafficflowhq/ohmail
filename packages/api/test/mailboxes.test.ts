import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxFolders } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("mailboxes (read + resync)", () => {
  it("GET /mailboxes lists items with a folder summary and NO credentials field", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedMailbox(db, {
      accountId: s.accountId, address: "mila@lichtgrat.example",
      folders: [{ folder: "INBOX", highestmodseq: 42n }, { folder: "ohmail/News", highestmodseq: null }],
    });

    const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items).toHaveLength(1);
    const mb = items[0];
    expect(mb.address).toBe("mila@lichtgrat.example");
    expect(mb.provider).toBe("imap");
    expect(mb.status).toBe("connected");
    // No credential leakage of any kind.
    expect(mb.credentials).toBeUndefined();
    expect(mb.password).toBeUndefined();
    // Folder summary reflects sync-cursor presence.
    const inbox = mb.folders.find((f: { folder: string }) => f.folder === "INBOX");
    expect(inbox.hasSyncCursor).toBe(true);
    const feed = mb.folders.find((f: { folder: string }) => f.folder === "ohmail/News");
    expect(feed.hasSyncCursor).toBe(false);
    // Each folder's own count as the server stated it, null before a cycle opened it.
    expect([inbox.serverExists, feed.serverExists]).toEqual([null, null]);
    await db.update(mailboxFolders).set({ serverExists: 3_412 }).where(eq(mailboxFolders.folder, "INBOX"));
    const again = (await (await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).json()).items[0];
    expect(again.folders.find((f: { folder: string }) => f.folder === "INBOX").serverExists).toBe(3_412);
  });

  it("GET /mailboxes/:id returns the DTO; a cross-account id → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await seedMailbox(db, { accountId: owner.accountId });

    const ok = await H(req("GET", `/mailboxes/${id}`, { bearer: owner.token }), deps);
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe(id);

    const cross = await H(req("GET", `/mailboxes/${id}`, { bearer: other.token }), deps);
    expect(cross.status).toBe(404);
  });

  it("POST /mailboxes/:id/resync → 202: queued, and clears the folder sync cursors", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedMailbox(db, {
      accountId: s.accountId, folders: [{ folder: "INBOX", highestmodseq: 99n }],
    });

    const res = await H(req("POST", `/mailboxes/${id}/resync`, { bearer: s.token }), deps);
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("queued");

    // The worker re-scans because the CONDSTORE cursor was reset.
    const [folder] = await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, id));
    expect(folder!.highestmodseq).toBeNull();
  });

  it("resync of another account's mailbox → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await seedMailbox(db, { accountId: owner.accountId });
    expect((await H(req("POST", `/mailboxes/${id}/resync`, { bearer: other.token }), deps)).status).toBe(404);
  });

  // ── The forwarding-detection notice's dismissal (mail 0078). Same pipeline as resync —
  //    FULL_PIPELINE (no `raw`): session required, cookie sessions carry CSRF, `work` class
  //    refused unverified (the spend-gate census pins that side). What is proven HERE is the
  //    wire: the press stamps the dismissal and answers the fresh DTO, and a foreign mailbox
  //    id is the same 404 a missing one is. ──
  it("POST /mailboxes/:id/inbound-quiet/dismiss → 200 with the stamped DTO; anonymous → 401; cross-account → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await seedMailbox(db, { accountId: owner.accountId });

    // No session at all: refused before any handler runs.
    expect((await H(req("POST", `/mailboxes/${id}/inbound-quiet/dismiss`, {}), deps)).status).toBe(401);
    // Somebody else's mailbox: indistinguishable from a mailbox that does not exist.
    expect((await H(req("POST", `/mailboxes/${id}/inbound-quiet/dismiss`, { bearer: other.token }), deps)).status).toBe(404);

    const res = await H(req("POST", `/mailboxes/${id}/inbound-quiet/dismiss`, { bearer: owner.token }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.id).toBe(id);
    // The dismissal is stamped with the SERVER's clock and rides the DTO — the pressing client
    // settles on the answer instead of waiting a poll tick.
    expect(dto.inboundQuietDismissedAt).toBe(FIXED_NOW.toISOString());
    // Both notice fields are on the wire unconditionally; no episode stands here, so `since`
    // is null — and the dismissal must not have invented one.
    expect(dto.inboundQuietSince).toBeNull();
  });
});
