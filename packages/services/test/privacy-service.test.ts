import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accountSettings, mailboxes, messageBodies, trackerEvents } from "@trafficflow/db";
import { HELD_FOLDERS } from "@trafficflow/core/destinations";
import {
  makePrivacyService, makeNodeRemoteFetch, isBlockedAddress, ServiceError,
  PROXY_URL_MAX_CHARS,
  type HostResolver, type RemoteFetch,
} from "../src/index.js";
import { pinnedLookup } from "../src/pinned-fetch.js";
// Imported from the module rather than the barrel: `index.ts` is a shared file and a one-word
// export is not worth putting another lane's in-flight work into this commit.
import { isTransportFailure } from "../src/privacy-service.js";
import { makeCtx, seedMessage } from "./helpers.js";
import { GIF_2X3, JPEG_2X3, PNG_2X3 } from "../../core/test/fixtures/images.js";

/**
 * The SSRF gate's DNS port, INJECTED — required at construction precisely so
 * the permit branch is the one these tests run. `resolvesTo` is what makes the
 * mutation possible at all: an ordinary-looking public hostname whose answer is
 * `169.254.169.254`.
 */
function resolvesTo(...addrs: string[]): HostResolver & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    async resolve(hostname: string) { names.push(hostname); return addrs; },
  };
}

/** The default: every name is public. */
const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };

/** A 1×1 transparent GIF — parsed by imageDimensions as a pixel. */
const GIF_1x1 = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

/** A RemoteFetch mock that RECORDS every call and its full arg list (url + pin). */
function mockRemote(
  resp: { status?: number; contentType?: string | null; body: Uint8Array },
): RemoteFetch & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async fetch(...args: [string, readonly string[]]) {
      calls.push(args);
      return { status: resp.status ?? 200, contentType: resp.contentType ?? "image/gif", body: resp.body };
    },
  };
}

/**
 * THE READER HAS PRESSED "Show images" FOR THIS MESSAGE.
 *
 * `proxyImage` refuses a message whose `loaded_remote_content` is false (403), because a
 * blocker enforced only in the renderer is a client convention: anything that could reach
 * the endpoint would make the sender's server see a request, and `TrackerEventDTO.blocked`
 * (`!loadedRemoteContent`) would report an image we DID fetch as "blocked" in the feed whose
 * whole subject is who tried to spy on the reader.
 *
 * So every proxy test below is a test of the CONSENTED path and says so, and the refusal has
 * its own case rather than being the accidental state of the others.
 */
async function consented(db: Awaited<ReturnType<typeof makeCtx>>["db"], messageId: string): Promise<void> {
  await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: true });
}

describe("PrivacyService.proxyImage", () => {
  it("records a tracker_events row (kind 'pixel') for a 1×1 pixel and returns bytes", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example" });
    await consented(db, messageId);
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    const out = await svc.proxyImage(ctx, { messageId, url: "https://analytics.acme-com.example/o.gif" });
    expect(out.contentType).toBe("image/gif");
    expect(out.body.length).toBeGreaterThan(0);

    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("pixel");
    expect(rows[0]!.trackerHost).toBe("analytics.acme-com.example");
  });

  it("passes the url and the validated PIN to RemoteFetch — no IP/cookie/referer can ride along", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await svc.proxyImage(ctx, { messageId, url: "https://analytics.acme-com.example/o.gif" });
    // Structural guarantee: the url string, the addresses the SSRF gate resolved and cleared,
    // and NOTHING THAT CAME FROM THE CALLER. The pin is the gate's own output; the third
    // argument is the proxy's own redirect budget. There is still no headers bag and no request
    // object, so no client identity — IP, cookie, referer — has a parameter to travel through.
    //
    // The third argument's KEYS are asserted, not merely its presence: this test's whole job is
    // to fail if that slot ever grows something client-supplied, and `toHaveLength(2)` was doing
    // that job only by accident of the signature being narrow.
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]![0]).toBe("https://analytics.acme-com.example/o.gif");
    expect(remote.calls[0]![1]).toEqual(["93.184.216.34"]);
    expect(remote.calls[0]!.length).toBe(3);
    expect(Object.keys(remote.calls[0]![2] as object)).toEqual(["timeoutMs"]);
  });

  it("records kind 'remote_image' for a known-tracker host that is not a bare pixel", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // A tracker-classified url is only FETCHED once the account opted into pixels (mail 0072) —
    // the pre-flight refusal is asserted on its own above; this test is about the fetch path's
    // classification and relay, so the opt-in is part of its arrangement.
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    const realBytes = JPEG_2X3;   // a real 2×3 picture: sized, and not a pixel
    const remote = mockRemote({ contentType: "image/jpeg", body: realBytes });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    const out = await svc.proxyImage(ctx, { messageId, url: "https://ct.sendgrid.net/wf/open?x=1" });
    // Non-pixel → the fetched bytes + content-type are returned verbatim.
    expect(out.contentType).toBe("image/jpeg");
    expect(out.body).toEqual(realBytes);

    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("remote_image");
  });

  it("does NOT record an event for an ordinary remote image", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const realBytes = PNG_2X3;
    const svc = makePrivacyService({ remote: mockRemote({ contentType: "image/png", body: realBytes }), resolver: PUBLIC_DNS });

    await svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/photo.png" });
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it("a cross-account message id is a 404 (IDOR) — and never fetches", async () => {
    const { ctx } = await makeCtx();
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });
    await expect(
      svc.proxyImage({ ...ctx, accountId: randomUUID() }, { messageId: randomUUID(), url: "https://x.example/a.gif" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(remote.calls).toHaveLength(0);
  });

  /**
   * ── THE BLOCKER IS ENFORCED HERE, OR IT IS A CLIENT CONVENTION ──────────────────
   *
   * Until this check, `proxyImage` fetched any url for any message the caller owned,
   * authorized or not. The renderer's "Show images" was the only thing standing between
   * a sender's server and a request — and a renderer is not a boundary: a second
   * client, a replayed url, or a bug in the `pixel` branch all reach this endpoint.
   *
   * Since mail 0048 the gate has TWO grants — the per-message press, or the account's
   * auto mode — so the refused case is an account that OPTED OUT (`block_remote_images_at`
   * stamped) whose reader has not pressed. That row is seeded here; without it the account
   * is on the product default and the auto grant serves the image (the test below).
   *
   * The second assertion is the one that is easy to leave out and is the reason the
   * severity is not merely "a convention": nothing must be FETCHED. A 403 raised after
   * the fetch would refuse the caller and still have told the sender that this message
   * was open, which is the entire event the blocker exists to prevent.
   *
   * Mutation: delete the gate's throw. Real failure text:
   *   AssertionError: an unconsented image was fetched: expected 1 to be +0
   */
  it("refuses (403) an opted-out account's message without a press — and fetches nothing", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    // The account keeps the per-message flow, and the reader has NOT pressed "Show images".
    await db.insert(accountSettings).values({ accountId, blockRemoteImagesAt: new Date() });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/photo.png" }))
      .rejects.toMatchObject({ httpStatus: 403, code: "remote_content_not_loaded" });
    expect(remote.calls.length, "an unconsented image was fetched").toBe(0);
    expect(await db.select().from(trackerEvents)).toHaveLength(0);
  });

  /**
   * ── THE OTHER GRANT: THE ACCOUNT'S OWN DEFAULT IS AUTO, AND THE GATE MUST KNOW IT ──
   *
   * The client's auto mode points every image at this route with NO per-message press —
   * `loaded_remote_content` stays false — so a gate that only knew the press answered 403
   * to the shipped product default: every auto-mode image on every surface was a broken
   * box, found by review rather than by a reader because nothing server-side had ever
   * authorized what the client advertised. An ABSENT settings row is every account that
   * never changed anything and IS the default, so it is the case asserted.
   *
   * Mutation: revert the gate to `if (body?.loaded !== true) throw`. Real failure text:
   *   AssertionError: the product default was refused at the proxy: expected 403 to be
   *   undefined (the rejects assertion fires)
   */
  it("serves the account default (auto) without a press", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example", folder: "INBOX" });
    // No settings row, body present, nothing pressed: the product default, an ordinary picture.
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const realBytes = PNG_2X3;
    const remote = mockRemote({ contentType: "image/png", body: realBytes });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    const res = await svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/photo.png" });
    expect(remote.calls.length, "the product default was refused at the proxy").toBe(1);
    expect(res.body).toEqual(realBytes);
  });

  /**
   * ── THE PIXEL PREFERENCE HOLDS AT THE SERVER, FOR THE TRACKERS THE SERVER KNOWS ────
   *
   * The client refuses the pixels IT can classify (declared 1×1s, beacon-shaped urls);
   * an ESP's open-tracker serving an undeclared `r/abc.jpg` sails past that and arrives
   * here as "a picture". Classifying it after the fetch — which is where the server's
   * host list used to be consulted — refuses the caller the bytes AFTER telling the
   * sender about the open: the one event the default setting exists to prevent. So a
   * server-known tracker host or beacon-shaped url is refused the FETCH while the pixel
   * switch stands, and the reader gets the same invisible stub a fetched 1×1 gets.
   *
   * Mutation: delete the pre-fetch `trackerByUrl && !grants.pixels` branch. Real failure:
   *   AssertionError: a known tracker was fetched while pixel-blocking stands: expected 1 to be +0
   */
  it("refuses a server-known tracker the fetch itself while pixel-blocking stands", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example", folder: "INBOX" });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    // A known ESP tracker host, wearing no beacon path and declaring nothing.
    const res = await svc.proxyImage(ctx, { messageId, url: "https://ct.sendgrid.net/r/abc.jpg" });
    expect(remote.calls.length, "a known tracker was fetched while pixel-blocking stands").toBe(0);
    expect(res.contentType).toBe("image/gif"); // the stub, not a broken box

    // Recorded, so the feed can say who tried — and the posture it reports is BLOCKED.
    const page = await svc.listTrackerEvents(ctx, { messageId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.blocked, "a refused tracker was reported as loaded").toBe(true);
  });

  /**
   * A SIZE QUERY IS NOT A BEACON: a real picture at `p.png?w=120` is fetched while pixel-blocking
   * stands, and a beacon path beside it is still refused the fetch (the control).
   */
  it("fetches a sized picture whose url carries a size query, and still refuses a beacon path", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const realBytes = PNG_2X3;
    const remote = mockRemote({ contentType: "image/png", body: realBytes });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    const res = await svc.proxyImage(ctx, { messageId, url: "https://images.example/p.png?w=120" });
    expect(remote.calls.length, "a sized picture was refused as a tracker").toBe(1);
    expect(res.body).toEqual(realBytes);
    await svc.proxyImage(ctx, { messageId, url: "https://t.example/wf/open?u=abc" });
    expect(remote.calls.length, "a beacon path was fetched while pixel-blocking stands").toBe(1);
  });

  /**
   * The other position of the same switch: the account that ASKED for pixels gets the fetch —
   * the sender learns the open, which is what turning the switch off means — and the feed
   * stops calling that tracker blocked.
   */
  it("fetches the tracker once the account opted into pixels, and the feed says so", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example", folder: "INBOX" });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await svc.proxyImage(ctx, { messageId, url: "https://ct.sendgrid.net/r/abc.jpg" });
    expect(remote.calls.length, "the pixel opt-out did not fetch").toBe(1);
    const page = await svc.listTrackerEvents(ctx, { messageId });
    expect(page.items[0]!.blocked).toBe(false);
  });

  /** On an opted-out account a message with no body row is likewise unconsented — absence of
   *  the row is not a press. (On a DEFAULT account the auto grant serves it, deliberately: the
   *  grant is the ACCOUNT's, and whether a body row has landed yet says nothing about it.) */
  it("refuses a message with no body row rather than treating absence as consent", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await db.insert(accountSettings).values({ accountId, blockRemoteImagesAt: new Date() });
    const messageId = await seedMessage(db, accountId, mailboxId);
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/photo.png" }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect(remote.calls).toHaveLength(0);
  });

  /** A sender not let in (the Screener, Screened out, Spam) waits for the press on an auto account too. */
  it.each(HELD_FOLDERS)("refuses an auto account's letter held in %s until the press, then serves it", async (folder) => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const remote = mockRemote({ contentType: "image/png", body: PNG_2X3 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });
    const url = "https://cdn.acme-com.example/photo.png";
    await expect(svc.proxyImage(ctx, { messageId, url }))
      .rejects.toMatchObject({ httpStatus: 403, code: "remote_content_not_loaded", retryable: false });
    expect(remote.calls.length, "a held sender's picture was fetched before the press").toBe(0);
    await svc.loadRemote(ctx, messageId);
    expect((await svc.proxyImage(ctx, { messageId, url })).body).toEqual(PNG_2X3);
  });

  it("CONTROL: a letter let in at the press is served under auto before the mailbox files it", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "ohmail/Screener", desired: "INBOX" });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    const remote = mockRemote({ contentType: "image/png", body: PNG_2X3 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });
    await svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/photo.png" });
    expect(remote.calls.length, "the folder the letter is going to did not decide").toBe(1);
  });

  it("the feed calls a held letter's tracker blocked under auto with pixels on, until the press", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    const messageId = await seedMessage(db, accountId, mailboxId, { folder: "ohmail/Screener" });
    await db.insert(messageBodies).values({ messageId, text: "b", loadedRemoteContent: false });
    await db.insert(trackerEvents).values({ accountId, messageId, kind: "pixel", trackerHost: "spy.example" });
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    const blocked = async () => (await svc.listTrackerEvents(ctx, { messageId })).items[0]!.blocked;
    expect(await blocked(), "the feed called a refused fetch loaded").toBe(true);
    await svc.loadRemote(ctx, messageId);
    expect(await blocked()).toBe(false);
  });

  it("rejects a non-http url (400)", async () => {
    const { ctx } = await makeCtx();
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    await expect(svc.proxyImage(ctx, { messageId: randomUUID(), url: "javascript:alert(1)" }))
      .rejects.toBeInstanceOf(ServiceError);
  });
});

describe("PrivacyService.loadRemote", () => {
  it("flips message_bodies.loadedRemoteContent (idempotent-safe)", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    // NOT `consented()` — this is the test of the write that GRANTS consent, so the row must
    // start out unconsented or the assertion below proves nothing.
    await db.insert(messageBodies).values({ messageId, text: "body", html: "<p>body</p>" });
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });

    await svc.loadRemote(ctx, messageId);
    const [b1] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(b1!.loadedRemoteContent).toBe(true);

    // Second call is a safe no-op.
    await svc.loadRemote(ctx, messageId);
    const [b2] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(b2!.loadedRemoteContent).toBe(true);
  });

  it("cross-account message → 404", async () => {
    const { ctx } = await makeCtx();
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    await expect(svc.loadRemote({ ...ctx, accountId: randomUUID() }, randomUUID()))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("PrivacyService.listTrackerEvents", () => {
  it("lists an account's events, filters by message, and maps kind → wire kind", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    // Opted out: the manual account is the one whose unloaded rows read as "blocked".
    await db.insert(accountSettings).values({ accountId, blockRemoteImagesAt: new Date() });
    const mA = await seedMessage(db, accountId, mailboxId, { from: "a@sender.example" });
    const mB = await seedMessage(db, accountId, mailboxId, { from: "b@sender.example" });
    await db.insert(trackerEvents).values([
      { accountId, messageId: mA, kind: "pixel", trackerHost: "a.spy.com", detectedAt: new Date("2026-03-01T00:00:00Z") },
      { accountId, messageId: mB, kind: "remote_image", trackerHost: "b.spy.com", detectedAt: new Date("2026-03-02T00:00:00Z") },
    ]);

    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    const all = await svc.listTrackerEvents(ctx, {});
    expect(all.items.map((e) => e.messageId).sort()).toEqual([mA, mB].sort());
    // Newest first.
    expect(all.items[0]!.messageId).toBe(mB);
    expect(all.items[0]!.kind).toBe("remote_beacon");
    expect(all.items[0]!.sender.address).toBe("b@sender.example");
    expect(all.items[0]!.blocked).toBe(true);
    // ^ true because this account OPTED OUT below — `blocked` derives from the gate's two
    // grants (the press, the account's auto mode), and a default account has the second.

    const justA = await svc.listTrackerEvents(ctx, { messageId: mA });
    expect(justA.items).toHaveLength(1);
    expect(justA.items[0]!.kind).toBe("tracking_pixel");
    expect(justA.items[0]!.pixelHost).toBe("a.spy.com");
  });

  /**
   * THE JOIN'S OWN ACCOUNT PREDICATE, tested against the row that only it can refuse.
   *
   * The test directly below proves the OUTER scope: an event belonging to account A is invisible
   * to account B. That one passed before the join carried a predicate and passes after, because
   * it exercises `tracker_events.account_id` and nothing else.
   *
   * This one is the other half. The feed reads a COUNTERPARTY ADDRESS off the joined `messages`
   * row, and the query used to take that row by primary key alone on the argument that the outer
   * filter had already scoped it. That argument is about the WRITERS — both inserts sit behind
   * `requireOwnedMessage`, so the two account ids agree by construction today — and account
   * isolation is required to be structural rather than inherited from a writer's discipline. So
   * the row planted here is one no current writer creates: an event stamped with the READER's
   * account whose message belongs to somebody else. Schema-valid — the foreign key is to
   * `messages.id`, which exists, and `account_id` carries no cross-table constraint — and exactly
   * what a backfill, a restore or a future second writer could leave behind.
   *
   * BOTH ACCOUNTS LIVE IN ONE DATABASE HERE, and that detail is the test. `makeCtx()` builds its
   * own store per call, so a first draft that planted the row through a second `makeCtx()` could
   * not insert it at all (the foreign key had nothing to point at), the catch swallowed the
   * failure, and the assertion passed over an empty feed. It survived the mutation — removing
   * the predicate under test left it green — which is the whole reason this file says what it
   * watched go red. The second account is now a second mailbox in the SAME `db`.
   *
   * Watched red by removing `eq(messages.accountId, ctx.accountId)` from the join: the feed
   * returns two rows and one of them carries `victim-counterparty@example.com`.
   */
  it("a mismatched event cannot pull another account's sender through the join", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();

    // A SECOND account in the SAME store, so the cross-account row is representable.
    const otherAccountId = randomUUID();
    const [otherMb] = await db.insert(mailboxes)
      .values({ accountId: otherAccountId, provider: "imap", address: "victim@example.com" })
      .returning();
    const theirs = await seedMessage(db, otherAccountId, otherMb!.id,
      { from: "victim-counterparty@example.com" });
    const mine = await seedMessage(db, accountId, mailboxId, { from: "my-sender@example.com" });

    // Honest row: mine, and it must still be listed.
    await db.insert(trackerEvents).values({
      accountId, messageId: mine, kind: "pixel", trackerHost: "ok.spy.com",
      detectedAt: new Date("2026-03-01T00:00:00Z"),
    });
    /* THE INCONSISTENT ROW — my account id, their message — is UNREPRESENTABLE since mail 0118
       keyed `tracker_events` to `(message_id, account_id)`. That is a stronger guarantee than the
       join predicate ever gave, so it is asserted first; the predicate is then still driven,
       against a row planted with that ONE key dropped, so removing it from the join reddens here
       rather than passing for nothing. A one-word verdict, never `.rejects` on a live handle. */
    const bad = {
      accountId, messageId: theirs, kind: "pixel", trackerHost: "bad.spy.com",
      detectedAt: new Date("2026-03-02T00:00:00Z"),
    };
    const verdict = await db.insert(trackerEvents).values(bad).then(
      () => "admitted",
      (e: unknown) => (/tracker_events_message_id_account_fk/.test(String(e))
        ? "refused-by-the-key" : `refused-otherwise:${String(e)}`),
    );
    expect(verdict, "the mismatched event is representable again").toBe("refused-by-the-key");
    await db.execute(sql`alter table tracker_events
      drop constraint tracker_events_message_id_account_fk`);
    await db.insert(trackerEvents).values(bad);

    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    const page = await svc.listTrackerEvents(ctx, {});

    const addresses = page.items.map((e) => e.sender.address);
    expect(addresses, "no counterparty from another account reaches this feed")
      .not.toContain("victim-counterparty@example.com");
    expect(addresses, "and the account's own event is still listed")
      .toContain("my-sender@example.com");
    expect(page.items, "the mismatched row is dropped by the join, not merely unlabelled")
      .toHaveLength(1);
  });

  it("is account-scoped — another account sees none", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const m = await seedMessage(db, accountId, mailboxId);
    await db.insert(trackerEvents).values({ accountId, messageId: m, kind: "pixel", trackerHost: "spy.com" });
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });
    const other = await svc.listTrackerEvents({ ...ctx, accountId: randomUUID() }, {});
    expect(other.items).toHaveLength(0);
  });

  /**
   * `blocked` states the account's CURRENT posture toward the tracker, which is the gate's own
   * arithmetic: refused unless an images grant exists AND the pixel switch is off. An images
   * grant alone — here the per-message press — no longer reads as "loaded", because the gate
   * refuses a known tracker the fetch pre-flight while pixel-blocking stands (the default).
   * Only the account that also opted into pixels sees `false`.
   */
  it("blocked follows the pixel switch, not the images grant alone", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const m = await seedMessage(db, accountId, mailboxId);
    await db.insert(messageBodies).values({ messageId: m, text: "b", loadedRemoteContent: true });
    await db.insert(trackerEvents).values({ accountId, messageId: m, kind: "pixel", trackerHost: "spy.com" });
    const svc = makePrivacyService({ remote: mockRemote({ body: GIF_1x1 }), resolver: PUBLIC_DNS });

    // Pressed, pixel switch on its default: the tracker is still refused ⇒ blocked.
    const before = await svc.listTrackerEvents(ctx, { messageId: m });
    expect(before.items[0]!.blocked).toBe(true);

    // The account opts into pixels: the same row now reads as not blocked.
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    const after = await svc.listTrackerEvents(ctx, { messageId: m });
    expect(after.items[0]!.blocked).toBe(false);
  });
});

// ── the SSRF gate ──────────────────────────────────────────────────────────
//
// The route that reached `proxyImage` is UNMOUNTED (see `packages/api/src/routes/
// privacy.ts`), so nothing calls this today. These tests exist because the service
// comes back the moment the reading-path blocker is switched on, and a guard that
// arrives with the feature is a guard nobody has watched fail.

/** Start an http listener on loopback and count the CONNECTIONS it accepts. */
async function listener(
  handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; sockets: () => number; requests: () => number; close: () => Promise<void> }> {
  let sockets = 0;
  let requests = 0;
  const server: Server = createServer((req, res) => { requests++; handle(req, res); });
  server.on("connection", () => { sockets++; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    sockets: () => sockets,
    requests: () => requests,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

describe("proxyImage refuses an SSRF target BEFORE a socket is opened", () => {
  it("an ordinary public hostname that RESOLVES to 169.254.169.254 opens no socket", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const l = await listener((_req, res) => { res.writeHead(200, { "content-type": "image/gif" }); res.end(Buffer.from(GIF_2X3)); });

    // The port is a REAL fetch at a REAL listener, so "no socket opened" is a socket
    // count, not a mock's call count.
    const remote: RemoteFetch = {
      async fetch() {
        const r = await fetch(`${l.url}/pixel.gif`);
        return { status: r.status, contentType: "image/gif", body: new Uint8Array(await r.arrayBuffer()) };
      },
    };

    try {
      // CONTROL — the PERMIT branch. Without this the refusal below proves nothing:
      // a guard that refuses everything (which is what a defaulted node:dns resolver
      // would produce in this DNS-blocked sandbox) would pass the refusal assertion.
      const permitted = makePrivacyService({ remote, resolver: resolvesTo("93.184.216.34") });
      await permitted.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/hero.gif" });
      expect(l.sockets()).toBe(1);

      // THE MUTATION. Same hostname shape, same everything — only the resolver's
      // answer differs, and it is the cloud metadata address.
      const metadata = resolvesTo("169.254.169.254");
      const blocked = makePrivacyService({ remote, resolver: metadata });
      await expect(
        blocked.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/hero.gif" }),
      ).rejects.toMatchObject({ httpStatus: 400, message: /non-public address/ });

      // The gate DID run (the name was resolved) and then stopped: no second socket.
      expect(metadata.names).toEqual(["images.acme-cdn.com"]);
      expect(l.sockets()).toBe(1);
      expect(l.requests()).toBe(1);
    } finally {
      await l.close();
    }
  });

  it("refuses literals, userinfo, odd ports and the private name spaces without any DNS", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const remote = mockRemote({ body: GIF_1x1 });
    // A resolver that would ANSWER PUBLICLY for anything it is asked. If a case below
    // reaches it, the case was never refused on its own merits.
    const dns = resolvesTo("93.184.216.34");
    const svc = makePrivacyService({ remote, resolver: dns });

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",     // the metadata address, bare
      "http://127.0.0.1/",                            // loopback
      "http://[::1]/",                                // loopback, v6
      "http://[::ffff:169.254.169.254]/",             // v4-mapped metadata
      "http://[fd00::1]/",                            // unique-local
      "http://[fe80::1]/",                            // link-local, v6
      "http://10.0.0.5/",                             // private
      "http://172.16.0.1/",                           // private
      "http://192.168.1.1/",                          // private
      "http://100.64.0.1/",                           // CGNAT
      "https://user:pass@images.acme-cdn.com/x.gif",  // userinfo
      "https://images.acme-cdn.com:8080/x.gif",       // non-default port
      "http://localhost/x.gif",
      "https://internal.local/x.gif",
      "https://abcdefg.onion/x.gif",
      "http://2130706433/",                           // 127.0.0.1 as one integer
      "http://127.1/",                                // short form
      "http://0177.0.0.1/",                           // octal
    ]) {
      await expect(
        svc.proxyImage(ctx, { messageId, url }),
        `expected ${url} to be refused`,
      ).rejects.toBeInstanceOf(ServiceError);
    }

    expect(remote.calls).toHaveLength(0);   // nothing was ever fetched
    expect(dns.names).toHaveLength(0);      // and nothing needed DNS to be refused
  });

  /**
   * ── THE DNS-REBIND SHAPE ITSELF: public first answer, private second answer ──────────────
   *
   * A rebinding server's whole attack is answering the GUARD's lookup with a public address and
   * the FETCH's lookup with a private one. The fix is that there is no second lookup: the guard
   * resolves once, and the fetch is handed that answer as the pin. So the assertions are
   *  1. the resolver was consulted exactly ONCE — nothing downstream re-resolves, so the private
   *     second answer is never even fetched from DNS; and
   *  2. the pin the port received is the FIRST (validated, public) answer,
   * and `pinnedLookup`'s own describe proves the node port's socket goes to that pin and nowhere
   * else. Mutate the pin out (fetch the hostname again) and this resolver hands the fetch
   * `169.254.169.254`.
   */
  it("a resolver answering public-then-private cannot steer the fetch: one lookup, pinned to the first answer", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);

    let lookups = 0;
    const rebinding: HostResolver = {
      async resolve() {
        lookups += 1;
        return lookups === 1 ? ["93.184.216.34"] : ["169.254.169.254"];
      },
    };
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: rebinding });

    await svc.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/hero.gif" });

    expect(lookups, "something re-resolved the hostname after the gate").toBe(1);
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]![0]).toBe("https://images.acme-cdn.com/hero.gif");
    // ONE lookup, and the fetch pinned to the FIRST answer — a resolver that turns private on
    // its second call cannot steer the socket, because there is no second call.
    expect(remote.calls[0]![1]).toEqual(["93.184.216.34"]);
  });

  it("isBlockedAddress fails CLOSED on anything it cannot parse", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("nodeRemoteFetch: a 3xx is a refusal, never a second request", () => {
  it("does NOT follow a 302 to a private address", async () => {
    const target = await listener((_req, res) => { res.writeHead(200); res.end("METADATA"); });
    const hop = await listener((_req, res) => {
      res.writeHead(302, { location: `${target.url}/latest/meta-data/` });
      res.end();
    });
    try {
      const port = makeNodeRemoteFetch();
      const out = await port.fetch(`${hop.url}/tracking.gif`, ["127.0.0.1"]);

      // The 302 comes back AS a 302 with no body — and the redirect target was never
      // contacted. A redirect-following client returns 200/"METADATA" instead.
      expect(out.status).toBe(302);
      expect(out.body.length).toBe(0);
      expect(hop.requests()).toBe(1);
      expect(target.requests()).toBe(0);
      expect(target.sockets()).toBe(0);
      // The `Location` is REPORTED, not acted on. That split is the whole design: this port
      // hands the string up so `proxyImage` can put it through the SSRF gate, and remains
      // itself incapable of opening a socket to an address the gate has not cleared.
      expect(out.location).toBe(`${target.url}/latest/meta-data/`);
    } finally {
      await hop.close();
      await target.close();
    }
  });

  /**
   * ── THE DNS-REBIND PIN, ON THE REAL PORT ─────────────────────────────────────────────────
   *
   * The fetch connects through the PINNED lookup — it dials a NAME host (`localhost`) but the
   * socket is decided by the pin, not by a fresh resolution of that name. The environment-free
   * proof that the pin OVERRIDES the name lives in the `pinnedLookup` unit describe below (the
   * suite-wide egress trap blocks a non-loopback url host at `http.request` before any lookup
   * runs, so a rebind cannot be staged end-to-end here); this asserts the port actually wires the
   * pin into the request.
   */
  it("dials a NAME host through the pinned lookup and reaches the pinned listener", async () => {
    const intended = await listener((_req, res) => {
      res.writeHead(200, { "content-type": "image/gif" }); res.end("PINNED");
    });
    try {
      const { port: p } = new URL(intended.url);
      const out = await makeNodeRemoteFetch().fetch(`http://localhost:${p}/pixel.gif`, ["127.0.0.1"]);
      expect(out.status).toBe(200);
      expect(intended.requests()).toBe(1);
    } finally {
      await intended.close();
    }
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  FOLLOWING A REDIRECT — THE HOP GOES THROUGH THE GATE, OR IT DOES NOT HAPPEN
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * These exist because of a production incident on 2026-08-31: refusing every 3xx broke
   * every image in ordinary marketing mail (`http`→`https`, apex→`www`, brand→CDN) while
   * blocking no tracker at all. The remedy is to validate the hop, not to trust it — so the
   * first four cases here are the ADVERSARIAL half, and they are the reason the feature is
   * allowed to exist. `remoteScript` drives a scripted multi-hop mock and records every url
   * the port was actually asked to open, which is the only thing worth asserting: what we
   * REFUSED is proved by what we never fetched.
   */
  function remoteScript(
    steps: readonly { status?: number; location?: string; contentType?: string | null; body?: Uint8Array }[],
  ): RemoteFetch & { urls: string[]; pins: readonly string[][] } {
    const urls: string[] = [];
    const pins: string[][] = [];
    let i = 0;
    return {
      urls, pins,
      async fetch(url: string, pin: readonly string[]) {
        urls.push(url);
        pins.push([...pin]);
        const s = steps[Math.min(i++, steps.length - 1)]!;
        return {
          status: s.status ?? 200,
          contentType: s.contentType ?? "image/gif",
          body: s.body ?? GIF_1x1,
          location: s.location ?? null,
        };
      },
    };
  }

  it("REFUSES a redirect whose target resolves to a private address — and never fetches it", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // Hop 1 is a perfectly public host. Hop 2 is an ordinary-looking public NAME whose DNS
    // answer is the cloud metadata address — the exact shape the gate exists for, arriving
    // through a `Location` instead of through `u`.
    //
    // The resolver MUST be per-host: a blanket private resolver refuses hop 1 too, and the
    // test then passes for the wrong reason — it would prove the gate works on `u`, which is
    // already covered elsewhere, and say nothing about the hop. (It did exactly that on the
    // first run: `urls` came back empty because hop 1 never happened.)
    const perHost: HostResolver = {
      async resolve(hostname: string) {
        return hostname === "inner.acme-com.example" ? ["169.254.169.254"] : ["93.184.216.34"];
      },
    };
    const remote = remoteScript([{ status: 302, location: "https://inner.acme-com.example/latest/meta-data/" }]);
    const svc = makePrivacyService({ remote, resolver: perHost });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/x.gif" }))
      .rejects.toMatchObject({
        httpStatus: 400,
        // On a HOP the refusal names the redirect, never `u`: the gate's wording would blame the
        // query parameter for a Location the caller never sent. Hop 0 keeps the gate's words —
        // `img-route-ships-with-its-resolver.test.ts` pins them — so both spellings are watched.
        message: "the image redirected to an address this proxy will not follow",
      });

    // The proof is the absence: hop 1 was fetched, hop 2 never was. A version that followed
    // the Location without re-validating reaches `inner.acme-com.example` and this is length 2.
    expect(remote.urls).toEqual(["https://images.acme-cdn.com/x.gif"]);
  });

  it("REFUSES a redirect to a non-http(s) scheme", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const remote = remoteScript([{ status: 301, location: "file:///etc/passwd" }]);
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/x.gif" }))
      .rejects.toMatchObject({ httpStatus: 424 });
    expect(remote.urls).toHaveLength(1);
  });

  it("CAPS the redirect chain instead of following it forever", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // A server that redirects to itself for ever. Without the cap this never returns.
    const remote = remoteScript([{ status: 302, location: "https://loop.acme-com.example/next.gif" }]);
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://loop.acme-com.example/start.gif" }))
      .rejects.toMatchObject({ httpStatus: 424 });
    // MAX_REDIRECT_HOPS = 3, so four fetches happen: the original plus three hops.
    expect(remote.urls).toHaveLength(4);
  });

  it("a redirect INTO a known tracker is caught by the pixel switch — no bypass", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example" });
    await consented(db, messageId);
    // The account has NOT opted into tracking pixels, so a tracker host must be refused. The
    // sender hides it behind an innocuous first url: without a per-hop classification this is
    // a clean bypass of the switch, and the beacon gets fetched.
    const remote = remoteScript([{ status: 302, location: "https://ct.sendgrid.net/wf/open?x=1" }]);
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    const out = await svc.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/x.gif" });
    // The reader gets the transparent stub, and the beacon was never contacted.
    expect(out.contentType).toBe("image/gif");
    expect(remote.urls).toEqual(["https://images.acme-cdn.com/x.gif"]);

    // …and the feed records who tried, naming the host the chain LANDED on.
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trackerHost).toBe("ct.sendgrid.net");
  });

  it("names the host that CLASSIFIED as a tracker, not the one the chain landed on", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId, { from: "spy@sender.example" });
    await consented(db, messageId);
    // The account opted INTO pixels, so the tracker is fetched rather than stubbed — which is
    // the path where the landing host could be misrecorded. A sendgrid beacon that redirects
    // to a CDN is still a sendgrid beacon; recording `cdn.acme-com.example` would name the wrong
    // party in the feed whose entire subject is who tried to spy on the reader.
    await db.insert(accountSettings).values({ accountId, loadTrackingPixelsAt: new Date() });
    const remote = remoteScript([
      { status: 302, location: "https://cdn.acme-com.example/real.jpg" },
      { status: 200, contentType: "image/jpeg", body: JPEG_2X3 },
    ]);
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await svc.proxyImage(ctx, { messageId, url: "https://ct.sendgrid.net/wf/open?x=1" });
    const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trackerHost).toBe("ct.sendgrid.net");
    // The URL must name the same party as the host. Asserting only the host let the row keep
    // `url = https://cdn.acme-com.example/real.jpg` beside `trackerHost = ct.sendgrid.net`.
    expect(rows[0]!.url).toBe("https://ct.sendgrid.net/wf/open?x=1");
  });

  it("bounds the WHOLE chain in wall-clock time, not just each hop", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // Each hop is a redirect that takes its time. The hop cap bounds how many REQUESTS we
    // make; without a chain deadline it does not bound how long we hold the invocation, so a
    // chain of near-timeout stalls multiplies the intended budget by the hop count.
    let calls = 0;
    const slow: RemoteFetch = {
      async fetch() {
        calls++;
        await new Promise((r) => setTimeout(r, 40));
        return { status: 302, contentType: null, body: new Uint8Array(0), location: "https://slow.acme-com.example/next.gif" };
      },
    };
    // A tight budget against slower hops, so the deadline is watched actually firing rather
    // than waiting out the production value.
    const svc = makePrivacyService({ remote: slow, resolver: PUBLIC_DNS, redirectBudgetMs: 25 });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://slow.acme-com.example/a.gif" }))
      .rejects.toMatchObject({ httpStatus: 424 });
    // The CLOCK stopped it, not the hop cap: one hop's 40 ms already exceeds the 25 ms budget,
    // so the second hop never starts. With no deadline this reaches the cap's four fetches.
    expect(calls).toBe(1);
  });

  it("bounds the DNS LOOKUP too, not just the socket", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // The budget and the stalling lookup on a FAKE clock: once the lookup is asked only the
    // clock moves it, open one tick short of the budget and released at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The hop's fetch is instant; it is the RESOLVER that stalls. A deadline that only reaches
    // the socket never fires here, and the invocation is held for as long as the sender's DNS
    // cares to hang — a resource-exhaustion primitive handed to anyone who can put an `<img>`
    // in an email. Every earlier redirect test resolves instantly, so none of them can see it.
    let resolved = 0;
    const stallingDns: HostResolver = {
      async resolve() {
        resolved++;
        await new Promise((r) => setTimeout(r, 400));
        return ["93.184.216.34"];
      },
    };
    const remote = remoteScript([{ status: 200, contentType: "image/png", body: PNG_2X3 }]);
    const svc = makePrivacyService({ remote, resolver: stallingDns, redirectBudgetMs: 30 });

    try {
      const started = Date.now();
      let settled = false;
      const proxied = svc.proxyImage(ctx, { messageId, url: "https://slowdns.example/x.png" })
        .then(() => null, (e: unknown) => e).finally(() => { settled = true; });
      while (resolved === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(29);
      expect(settled, "the lookup was abandoned before the budget ran out").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await proxied).toMatchObject({ httpStatus: 424 });
      // Released on the deadline, not after the lookup finally answers.
      expect(Date.now() - started).toBeLessThan(350);
    } finally {
      vi.useRealTimers();
    }
    expect(resolved).toBe(1);
    expect(remote.urls).toHaveLength(0);
  });

  it("spends ONE clock across DNS and the socket — a slow lookup shortens the fetch", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // The sequence the earlier deadline guard cannot see: the resolver SUCCEEDS, just inside the
    // budget, and then the origin stalls. If the budget handed to the fetch is the one measured
    // before DNS, the socket gets a whole fresh allowance and the operation runs to nearly twice
    // the chain deadline. The fetch records what it was actually granted.
    const granted: number[] = [];
    const slowDns: HostResolver = {
      async resolve() { await new Promise((r) => setTimeout(r, 80)); return ["93.184.216.34"]; },
    };
    const recording: RemoteFetch = {
      async fetch(_u, _p, opts) {
        granted.push(opts?.timeoutMs ?? Infinity);
        return { status: 200, contentType: "image/png", body: PNG_2X3 };
      },
    };
    const svc = makePrivacyService({ remote: recording, resolver: slowDns, redirectBudgetMs: 200 });

    await svc.proxyImage(ctx, { messageId, url: "https://slow.example/x.png" });
    expect(granted).toHaveLength(1);
    // 200 ms budget minus ~80 ms of DNS: the socket must get the REMAINDER, not the full budget.
    expect(granted[0]!).toBeLessThan(160);
    expect(granted[0]!).toBeGreaterThan(0);
  });

  it("proxyImage itself has no broad catch — a programming fault propagates as itself", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const broken: RemoteFetch = { async fetch() { throw new TypeError("cannot read properties of undefined"); } };
    const svc = makePrivacyService({ remote: broken, resolver: PUBLIC_DNS });

    await expect(svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/x.png" }))
      .rejects.toThrow(TypeError);
  });

  /**
   * ── WHAT THE PORT IS ALLOWED TO CALL "SOMEBODY ELSE'S FAULT" ───────────────────────────
   *
   * This predicate is the whole of the 424-vs-500 decision inside `makeNodeRemoteFetch`, and
   * it decides whether a failure is visible to 5xx alerting. The first version of that catch
   * took EVERY non-`ServiceError`, which would have put a `TypeError` from our own response
   * handling into the "upstream" class — the exact incident this slice fixed, one layer down.
   * Asserted directly because the mock-port test above cannot reach it.
   */
  it("classifies transport failures apart from our own faults", () => {
    for (const code of ["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "CERT_HAS_EXPIRED", "ETIMEDOUT"]) {
      expect(isTransportFailure(Object.assign(new Error("boom"), { code }))).toBe(true);
    }
    expect(isTransportFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    // …and everything that is US.
    expect(isTransportFailure(new TypeError("cannot read properties of undefined"))).toBe(false);
    // Node gives PROGRAMMING faults string codes too. "Has a code" would put our own bug back
    // into the upstream class and hide it from 5xx alerting.
    for (const code of ["ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "ERR_ASSERTION", "ERR_UNKNOWN_THING"]) {
      expect(isTransportFailure(Object.assign(new Error("bug"), { code }))).toBe(false);
    }
    expect(isTransportFailure(new RangeError("out of range"))).toBe(false);
    expect(isTransportFailure(new Error("plain"))).toBe(false);
    expect(isTransportFailure(null)).toBe(false);
    expect(isTransportFailure("a string")).toBe(false);
  });

  it("the REAL port honours the per-call timeout it is handed", async () => {
    // Without this, `makeNodeRemoteFetch` could ignore `opts.timeoutMs` entirely and every
    // deadline test would stay green — they all assert against a MOCK. The chain deadline is
    // only real if the production port actually applies it.
    let reached = false;
    const stalling = await listener(() => { reached = true; /* accept, never respond */ });
    // The per-call timeout on a FAKE clock, the socket on real ones: once the request is on the
    // wire only the clock moves it, open one tick short of the timeout and refused at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      let settled = false;
      const fetched = makeNodeRemoteFetch().fetch(`${stalling.url}/slow.gif`, ["127.0.0.1"], { timeoutMs: 60 })
        .then(() => null, (e: unknown) => e).finally(() => { settled = true; });
      while (!reached) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(59);
      expect(settled, "the port gave up before the per-call timeout").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await fetched).toMatchObject({ httpStatus: 424 });
      // The port's own default is 8 s; the per-call value must win.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      vi.useRealTimers();
      await stalling.close();
    }
  });

  it("the REAL port turns a reset connection into a 424, not a crash", async () => {
    // A server that accepts and then destroys the socket: ECONNRESET from the stdlib client.
    const rude = await listener((_req, res) => { res.socket?.destroy(); });
    try {
      await expect(makeNodeRemoteFetch().fetch(`${rude.url}/x.gif`, ["127.0.0.1"]))
        .rejects.toMatchObject({ httpStatus: 424 });
    } finally {
      await rude.close();
    }
  });

  it("FOLLOWS an ordinary redirect and returns the image — the incident's own shape", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const png = PNG_2X3;
    // `http://services.google.com/...` → 301 → `https://services.google.com/...`, which is
    // one of the four shapes that produced 36 five-hundreds in five minutes on 2026-08-31.
    const remote = remoteScript([
      { status: 301, location: "https://services.google.com/fh/files/emails/logo.png" },
      { status: 200, contentType: "image/png", body: png },
    ]);
    // ── THE RESOLVER MUST ANSWER DIFFERENTLY PER HOST, OR THE PIN ASSERTION IS VACUOUS ──
    // `PUBLIC_DNS` returns 93.184.216.34 for everything, so "every hop carried a non-empty
    // pin" is equally true of an implementation that resolves once and reuses hop 0's pin for
    // the rest of the chain — which is exactly the stale-pin regression the per-hop invariant
    // forbids. Distinct addresses make the pins tell the hops apart.
    const perHost = {
      async resolve(hostname) {
        return hostname === "services.google.com" ? ["93.184.216.34"] : ["104.16.132.229"];
      },
    } satisfies HostResolver;
    const svc = makePrivacyService({ remote, resolver: perHost });

    const out = await svc.proxyImage(ctx, { messageId, url: "http://services.google.com/fh/files/emails/logo.png" });
    expect(out.contentType).toBe("image/png");
    expect(out.body).toEqual(png);
    expect(remote.urls).toEqual([
      "http://services.google.com/fh/files/emails/logo.png",
      "https://services.google.com/fh/files/emails/logo.png",
    ]);
    // Every hop carried a pin, so no hop was fetched on an unvalidated name.
    expect(remote.pins.every((p) => p.length > 0)).toBe(true);
  });

  it("re-resolves EVERY hop — a cached hop-0 pin does not survive this", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    // Three distinct public hosts, three distinct public addresses. If the implementation
    // resolved once and reused that pin, the pins would read [[A],[A],[A]] instead of
    // [[A],[B],[C]] — a socket opened to an address that was never validated for that host.
    // Genuinely public addresses: the documentation ranges (192.0.2.0/24, 198.51.100.0/24,
    // 203.0.113.0/24) are refused by the gate, as they should be.
    const addr: Record<string, string> = {
      "a.example": "93.184.216.34", "b.example": "104.16.132.229", "c.example": "142.250.185.78",
    };
    const perHost = { async resolve(h: string) { return [addr[h] ?? "93.184.216.34"]; } } satisfies HostResolver;
    const remote = remoteScript([
      { status: 302, location: "https://b.example/2.png" },
      { status: 302, location: "https://c.example/3.png" },
      { status: 200, contentType: "image/png", body: PNG_2X3 },
    ]);
    const svc = makePrivacyService({ remote, resolver: perHost });

    await svc.proxyImage(ctx, { messageId, url: "https://a.example/1.png" });
    expect(remote.urls).toEqual(["https://a.example/1.png", "https://b.example/2.png", "https://c.example/3.png"]);
    expect(remote.pins).toEqual([["93.184.216.34"], ["104.16.132.229"], ["142.250.185.78"]]);
  });

  it("resolves a RELATIVE Location against the url that sent it", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const remote = remoteScript([
      { status: 302, location: "/img/email/logo.png" },
      { status: 200, contentType: "image/png", body: PNG_2X3 },
    ]);
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });

    await svc.proxyImage(ctx, { messageId, url: "https://slack.com/x-a119/img/email/logo.png" });
    expect(remote.urls[1]).toBe("https://slack.com/img/email/logo.png");
  });

  /**
   * ── THE STATUS CLASS IS THE INCIDENT ────────────────────────────────────────────────────
   *
   * A 5xx here says "ohmail is broken". What actually happened is that somebody else's
   * server answered 404. Serving that as a 502 put 36 requests into Vercel's 5xx counter for
   * the catch-all route and paged the operator about an outage that did not exist.
   *
   * This asserts the class, not the digit, and both directions of it: an upstream failure is
   * a 4xx, and it is specifically NOT a 5xx. A future edit that "restores" 502 fails here.
   */
  it("reports an upstream failure as a 4xx, never a 5xx", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const svc = makePrivacyService({ remote: remoteScript([{ status: 404 }]), resolver: PUBLIC_DNS });

    const err = await svc.proxyImage(ctx, { messageId, url: "https://cdn.acme-com.example/gone.png" })
      .then(() => null, (e: unknown) => e as ServiceError);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err!.httpStatus).toBeGreaterThanOrEqual(400);
    expect(err!.httpStatus).toBeLessThan(500);
    expect(err!.httpStatus).toBe(424);
    // Not retryable: the sender's server said no, and asking again will not change it.
    expect(err!.retryable).toBe(false);
  });

  it("proxyImage refuses a 3xx that carries no Location — there is nothing to validate", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const svc = makePrivacyService({
      remote: { async fetch() { return { status: 302, contentType: null, body: new Uint8Array(0) }; } },
      resolver: PUBLIC_DNS,
    });
    await expect(svc.proxyImage(ctx, { messageId, url: "https://images.acme-cdn.com/x.gif" }))
      .rejects.toMatchObject({ httpStatus: 424 });
  });

  it("caps the response size — declared and undeclared", async () => {
    const big = Buffer.alloc(64 * 1024, 0x41);
    const declared = await listener((_req, res) => {
      res.writeHead(200, { "content-type": "image/gif", "content-length": String(big.length) });
      res.end(big);
    });
    const chunked = await listener((_req, res) => {
      res.writeHead(200, { "content-type": "image/gif" });   // no content-length
      res.end(big);
    });
    try {
      const port = makeNodeRemoteFetch({ maxBytes: 1024 });
      await expect(port.fetch(`${declared.url}/big.gif`, ["127.0.0.1"])).rejects.toMatchObject({ httpStatus: 424 });
      await expect(port.fetch(`${chunked.url}/big.gif`, ["127.0.0.1"])).rejects.toMatchObject({ httpStatus: 424 });
      // Under the cap still works, so the cap is a CAP and not a blanket refusal.
      const ok = await makeNodeRemoteFetch({ maxBytes: 1024 * 1024 }).fetch(`${chunked.url}/big.gif`, ["127.0.0.1"]);
      expect(ok.status).toBe(200);
      expect(ok.body.length).toBe(big.length);
    } finally {
      await declared.close();
      await chunked.close();
    }
  });

  it("times out instead of holding the socket open forever", async () => {
    const hang = await listener(() => { /* never responds */ });
    try {
      await expect(makeNodeRemoteFetch({ timeoutMs: 100 }).fetch(`${hang.url}/slow.gif`, ["127.0.0.1"])).rejects.toThrow();
    } finally {
      await hang.close();
    }
  });
});

/**
 * ── THE PIN OVERRIDE, PROVEN AT THE LOOKUP ────────────────────────────────────────────────────
 *
 * `pinnedLookup` is the whole reason a rebinding server cannot win: whatever hostname `net` hands
 * it, it returns the pre-validated addresses and NEVER consults DNS. This is the mutation the task
 * names — "mutate the pin out → connects to the second (private) address" — expressed at the one
 * function that decides it. If `pinnedLookup` resolved the hostname instead of returning the pin,
 * every assertion below goes red.
 */
describe("pinnedLookup — the socket goes to the pin, not to a resolution of the name", () => {
  const call = (
    fn: ReturnType<typeof pinnedLookup>, host: string, options: object,
  ): Promise<unknown[]> =>
    new Promise((resolve) => (fn as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      host, options, (...args: unknown[]) => resolve(args),
    ));

  it("ignores the hostname entirely and hands back the pinned addresses (all:true)", async () => {
    // The hostname `evil.rebind.example` would resolve to a private address in the attack; the
    // pin is a public one the gate already cleared, and it is what comes back.
    const args = await call(pinnedLookup(["93.184.216.34"]), "evil.rebind.example", { all: true });
    expect(args).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  it("returns (address, family) for the single-address (all:false) shape", async () => {
    const args = await call(pinnedLookup(["93.184.216.34"]), "anything.example", { all: false });
    expect(args).toEqual([null, "93.184.216.34", 4]);
  });

  it("tags an IPv6 pin as family 6 and honours a family filter", async () => {
    const both = pinnedLookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    expect(await call(both, "h", { all: true, family: 6 }))
      .toEqual([null, [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]]);
    expect(await call(both, "h", { all: true, family: 4 }))
      .toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});

/**
 * `?u=` is SENDER-CHOSEN and it reaches a DNS lookup and a socket.
 *
 * The value comes out of a stranger's HTML, and before this it had no application ceiling at all:
 * it went to `new URL()`, the SSRF gate's host resolution, a DNS query and an outbound fetch.
 * The input-bounds census recorded it as bounded by the request door, which is FALSE twice over —
 * `JSON_BODY_MAX_BYTES` bounds a request BODY and this arrives in a GET query string. What
 * actually bounded it was whatever request-line limit the host in front happened to impose: a
 * different number on every deployment and none on a direct socket.
 *
 * Watched fail and restored: delete the `url.length > PROXY_URL_MAX_CHARS` block and the first
 * case resolves and fetches instead of refusing; delete the redirect-hop checks and the second
 * follows an over-long `Location`.
 */
describe("proxyImage bounds the url before it resolves anything", () => {
  it("refuses an over-long url without a DNS lookup or a fetch", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    let resolved = 0;
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({
      remote,
      resolver: { async resolve() { resolved += 1; return ["93.184.216.34"]; } },
    });
    const url = `https://acme.example/${"a".repeat(PROXY_URL_MAX_CHARS)}`;

    const err = await svc.proxyImage(ctx, { messageId, url }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(400);
    expect((err as ServiceError).message).toContain(String(PROXY_URL_MAX_CHARS));
    // The whole value of putting the ceiling first: no name of the sender's choosing was looked
    // up, and no socket was opened.
    expect(resolved).toBe(0);
  });

  it("a url AT the ceiling is fetched — the bound refuses nothing a sender could really send", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await consented(db, messageId);
    const remote = mockRemote({ body: GIF_1x1 });
    const svc = makePrivacyService({ remote, resolver: PUBLIC_DNS });
    const prefix = "https://acme.example/";
    const url = prefix + "a".repeat(PROXY_URL_MAX_CHARS - prefix.length);
    expect(url.length).toBe(PROXY_URL_MAX_CHARS);

    const out = await svc.proxyImage(ctx, { messageId, url });

    expect(out.body.length).toBeGreaterThan(0);
  });
});
