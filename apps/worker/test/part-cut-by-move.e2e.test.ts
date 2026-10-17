import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP, type NativeLocator } from "@trafficflow/core/mail";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { attachments, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { AttachmentsService, ServiceError, type ServiceContext } from "@trafficflow/services";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { byMessageId, DB_URL, makeHarness, rawClient } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";
import { startFaultProxy, type FaultProxy } from "../../../packages/core/test/adapters/_fault-proxy.js";

/**
 * A PICTURE OPENED WHILE THE ORGANIZER FILES ITS MESSAGE (GreenMail + Postgres, the real door).
 * The proxy parks the door's second chunk FETCH while another session moves the message, so the
 * part read is cut on every run, as the 11/12 desktop walks were. The door reads the moved
 * message's locator once the mover writes it and serves the part whole from there; a mirror that
 * never learns where it went answers gone (404), never "a different part" (409), never short.
 * Mutations watched: the UID check in `ImapAdapter.streamPart` removed ⇒ 409 and a blank picture;
 * `followingMove`'s retry removed ⇒ 404 and a blank picture; `MOVED_LOCATOR_SETTLE_MS` 0 ⇒ the
 * late-write case 404.
 */

const DEST = "Archive";
const PICTURE = randomBytes(300 * 1024);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const svc = new AttachmentsService();

function letter(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: anna@x.example", "To: mila@lichtgrat.example", "Subject: pictures",
    "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="B"', "",
    "--B", "Content-Type: text/html; charset=utf-8", "", '<p>look</p><p><img src="cid:p1@x"></p>',
    "--B", "Content-Type: image/png", "Content-ID: <p1@x>", "Content-Disposition: inline; filename=\"p1.png\"",
    "Content-Transfer-Encoding: base64", "", PICTURE.toString("base64").replace(/.{76}/g, "$&\r\n"), "--B--", "",
  ].join("\r\n");
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => { /* already down */ }); });

/** The mirror's catch-up after the move: now, after `ms`, or never (`null`). */
type MirrorWrite = number | null;

async function world() {
  const h = await makeHarness();
  closers.push(() => h.adapter.close());
  const other: ImapFlow = await rawClient(h.cfg);
  closers.push(() => other.logout());
  await other.mailboxCreate(DEST).catch(() => { /* there already */ });
  const mid = `${randomUUID()}@x.example`;
  await other.append("INBOX", letter(mid));
  await runSyncCycle({
    repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
    storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
    role: "organizer", trustedAuthservIds: new Set<string>(),
  });
  const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, mid));
  const [part] = await h.db.select().from(attachments).where(eq(attachments.messageId, msg!.id));
  expect(part!.contentSha256).toBe(sha(PICTURE));
  const stale = msg!.nativeLocator as NativeLocator;

  const proxy: FaultProxy = await startFaultProxy({ host: h.cfg.host, port: h.cfg.port });
  closers.push(() => proxy.close());
  const openAdapter = async () => {
    const a = new ImapAdapter({ ...h.cfg, host: "127.0.0.1", port: proxy.port });
    await a.connect();
    return a;
  };
  const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };

  /** Park the door's second chunk while the message moves; the mirror learns where per `write`. */
  const moveMidRead = (write: MirrorWrite): void => {
    proxy.hold = {
      when: (command, args) => command === "UID FETCH" && /<[1-9]\d*\./.test(args),
      run: async () => {
        const l = await other.getMailboxLock("INBOX");
        let to: number | undefined;
        try {
          const uid = Number(stale.ref.split(":")[1]);
          const r = await other.messageMove(String(uid), DEST, { uid: true });
          to = r && r.uidMap ? r.uidMap.get(uid) : undefined;
        } finally { l.release(); }
        const dl = await other.getMailboxLock(DEST);
        const epoch = String((other.mailbox as { uidValidity: bigint }).uidValidity);
        dl.release();
        const moved: NativeLocator = { folder: DEST, ref: `${epoch}:${to}` };
        if (write === null) return;
        const land = () => h.repo.updateLocator(msg!.id, moved, stale);
        if (write === 0) await land();
        else setTimeout(() => { void land(); }, write);
      },
    };
  };
  /** The park matched: the cut really landed between two chunks. */
  const parked = (): boolean => proxy.hold === null;
  return { h, ctx, part: part!, msg: msg!, openAdapter, moveMidRead, parked };
}

describe("a part read while the organizer files its message (the door)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });

  it("the control: an unmoved part is served whole", async () => {
    const w = await world();
    const got = await svc.fetchBytes(w.ctx, w.part.id, { openAdapter: w.openAdapter });
    expect(sha(got.body)).toBe(sha(PICTURE));
  }, 30_000);

  it("the mirror writes the new place at once: the part is served whole from where it went", async () => {
    const w = await world();
    w.moveMidRead(0);
    const got = await svc.fetchBytes(w.ctx, w.part.id, { openAdapter: w.openAdapter });
    expect(sha(got.body)).toBe(sha(PICTURE));
    expect(w.parked()).toBe(true);
  }, 30_000);

  it("the mirror's write lands after the refusal: the door waits for it and serves the part whole", async () => {
    const w = await world();
    w.moveMidRead(400);
    const got = await svc.fetchBytes(w.ctx, w.part.id, { openAdapter: w.openAdapter });
    expect(sha(got.body)).toBe(sha(PICTURE));
    expect(w.parked()).toBe(true);
  }, 30_000);

  it("the streamed save (the desktop's) follows the move the same way", async () => {
    const w = await world();
    w.moveMidRead(0);
    const chunks: Uint8Array[] = [];
    const saved = await svc.fetchToSink(w.ctx, w.part.id, { openAdapter: w.openAdapter }, {
      write: async (c) => { chunks.push(c); },
      reset: async () => { chunks.length = 0; },
    });
    expect(saved.sha256).toBe(sha(PICTURE));
    expect(sha(Buffer.concat(chunks))).toBe(sha(PICTURE));
    expect(w.parked()).toBe(true);
  }, 30_000);

  it("a mirror that never learns where it went: gone (404), never a different part, never short", async () => {
    const w = await world();
    w.moveMidRead(null);
    const err = await svc.fetchBytes(w.ctx, w.part.id, { openAdapter: w.openAdapter }).then((b) => b.body.byteLength, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("not_found");
    expect((err as ServiceError).httpStatus).toBe(404);
    expect(w.parked()).toBe(true);
  }, 30_000);

  it("the inline pass draws the picture after the move (the 11/12 case)", async () => {
    const w = await world();
    const adapter: EngineAdapter = {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async (id: string) => svc.listForMessage(w.ctx, id),
      fetchAttachment: async (id: string) => {
        const got = await svc.fetchBytes(w.ctx, id, { openAdapter: w.openAdapter });
        return new Blob([got.body as Uint8Array<ArrayBuffer>], { type: got.contentType });
      },
    };
    const engine = new OhmailEngine({ adapter });
    w.moveMidRead(0);
    await engine.loadInlineImages(w.msg.id, ["p1@x"]);
    const drawn = engine.inlineImagesOf(w.msg.id).get("p1@x");
    expect(drawn, "the picture stays blank").toBeDefined();
    const blob = engine.attachmentBlobOf(w.msg.id, w.part.id);
    expect(sha(new Uint8Array(await blob!.arrayBuffer()))).toBe(sha(PICTURE));
    expect(w.parked()).toBe(true);
  }, 30_000);
});
