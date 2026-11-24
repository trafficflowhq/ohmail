import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { attachments as attachmentsTbl, mailboxes as mailboxesTbl } from "@trafficflow/db";
import {
  AttachmentsService, DOWNLOAD_ALL_MAX_PARTS, DOWNLOAD_ALL_MAX_BYTES, type OpenAdapter,
} from "../src/attachments-service.js";
import { ServiceError } from "../src/errors.js";
import { dbFor } from "../src/context.js";
import { MessageGoneError } from "@trafficflow/core/adapters/imap";
import { makeCtx, seedMessage } from "./helpers.js";

const svc = new AttachmentsService();

interface SeedAtt {
  filename?: string | null; contentType?: string; sizeBytes?: number; inline?: boolean; partId?: string | null;
}
async function seedAttachment(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, messageId: string, o: SeedAtt = {},
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId,
    // `undefined` gets a generated name; an EXPLICIT null stays null — a nameless part is a
    // real wire state the fallback-naming tests below have to be able to seed.
    filename: o.filename === undefined ? `file-${randomUUID()}.txt` : o.filename,
    contentType: o.contentType ?? "text/plain",
    sizeBytes: o.sizeBytes ?? 10,
    inline: o.inline ?? false,
    partId: o.partId ?? "2",
  }).returning();
  return row!.id;
}


/** A SECOND (third, …) mailbox on the same account — the download-all fan-out shape. */
async function seedMailboxFor(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string,
): Promise<string> {
  const [mb] = await db.insert(mailboxesTbl).values({
    accountId, provider: "imap", address: `box-${randomUUID()}@example.com`,
  }).returning();
  return mb!.id;
}

describe("AttachmentsService.listForMessage / getMeta", () => {
  it("lists a message's attachments (metadata only, no bytes)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "a.txt", sizeBytes: 5 });
    await seedAttachment(db, accountId, messageId, { filename: "b.pdf", contentType: "application/pdf", sizeBytes: 500 });

    const items = await svc.listForMessage(ctx, messageId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.filename).sort()).toEqual(["a.txt", "b.pdf"]);
    expect(items[0]).toMatchObject({ messageId });
    // DTO carries no `content`/bytes field. `contentId` is METADATA, not bytes — it is the
    // part's Content-ID, which the client joins against the html body's `cid:` references to
    // render an embedded image in place (the engine's `loadInlineImages`).
    expect(Object.keys(items[0]!).sort()).toEqual(
      ["contentId", "contentType", "filename", "id", "inline", "messageId", "sizeBytes"],
    );
  });

  it("getMeta returns one attachment", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAttachment(db, accountId, messageId, { filename: "c.txt", sizeBytes: 7 });
    const dto = await svc.getMeta(ctx, id);
    expect(dto).toMatchObject({ id, filename: "c.txt", sizeBytes: 7, messageId });
  });

  it("getMeta is a 404 (not found) across accounts (IDOR via the messages join)", async () => {
    const a = await makeCtx();
    const messageId = await seedMessage(a.db, a.accountId, a.mailboxId);
    const id = await seedAttachment(a.db, a.accountId, messageId);

    // Another account's context querying account A's attachment id → 404.
    const other = randomUUID();
    const otherCtx = { ...a.ctx, accountId: other, db: dbFor(a.db, other) };
    await expect(svc.getMeta(otherCtx, id)).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.getMeta(otherCtx, id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("listForMessage 404s a message not owned by the account", async () => {
    const { ctx } = await makeCtx();
    await expect(svc.listForMessage(ctx, randomUUID())).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("AttachmentsService.listFiles (All Files / Big Files)", () => {
  it("All Files lists real (non-inline) attachments joined to the message header, account-scoped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const m1 = await seedMessage(db, accountId, mailboxId, { subject: "Invoice", from: "acct@x.example" });
    await seedAttachment(db, accountId, m1, { filename: "invoice.pdf", sizeBytes: 2000 });
    await seedAttachment(db, accountId, m1, { filename: "logo.png", inline: true, sizeBytes: 100 }); // inline: excluded

    // A different account's file must not leak.
    const other = randomUUID();
    const [mbOther] = await db.insert((await import("@trafficflow/db")).mailboxes)
      .values({ accountId: other, provider: "imap", address: "o@x-ch.example" }).returning();
    const mOther = await seedMessage(db, other, mbOther!.id);
    await seedAttachment(db, other, mOther, { filename: "secret.pdf", sizeBytes: 9000 });

    const page = await svc.listFiles(ctx, { type: "all" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ filename: "invoice.pdf" });
    expect(page.items[0]!.message.subject).toBe("Invoice");
    expect(page.items[0]!.message.from.address).toBe("acct@x.example");
  });

  it("Big Files applies a minSizeBytes floor", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const m1 = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, m1, { filename: "tiny.txt", sizeBytes: 100 });
    await seedAttachment(db, accountId, m1, { filename: "huge.zip", sizeBytes: 5_000_000 });

    const big = await svc.listFiles(ctx, { minSizeBytes: 1_000_000 });
    expect(big.items.map((i) => i.filename)).toEqual(["huge.zip"]);

    const all = await svc.listFiles(ctx, { type: "all" });
    expect(all.items).toHaveLength(2);
  });
});

describe("AttachmentsService.downloadAll (zip assembly + on-demand fetch)", () => {
  it("zips every attachment of a message; unzip yields both entries", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const a1 = await seedAttachment(db, accountId, messageId, { filename: "one.txt", partId: "2" });
    const a2 = await seedAttachment(db, accountId, messageId, { filename: "two.txt", partId: "3" });

    // Fake adapter: return the attachment id as the bytes so we can round-trip.
    const bytesFor = new Map<string, string>([[a1, "ONE"], [a2, "TWO"]]);
    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async (_loc, partId) => ({
        contentType: "text/plain",
        filename: partId === "2" ? "one.txt" : "two.txt",
        body: new TextEncoder().encode(partId === "2" ? bytesFor.get(a1)! : bytesFor.get(a2)!),
      }),
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files).sort()).toEqual(["one.txt", "two.txt"]);
    expect(await loaded.files["one.txt"]!.async("string")).toBe("ONE");
    expect(await loaded.files["two.txt"]!.async("string")).toBe("TWO");
  });

  /**
   * ── A ZIP ENTRY NAME IS A PATH, AND THE SENDER WROTE IT ─────────────────────────────────
   *
   * `filename` on a MIME part is attacker-controlled text. JSZip treats `/` in `file()` as a
   * folder separator and its documented traversal sanitisation applies to `loadAsync` (reading an
   * archive), NOT to `file()` (writing one) — so a part named `../../.ssh/authorized_keys` used
   * to become an entry at that path, and any extractor that honours relative components writes
   * outside the directory the user chose. The single-attachment download never had this: it goes
   * out as a `Content-Disposition` header, where a browser keeps the basename.
   *
   * The entry name is therefore a BASENAME with no separators and no control bytes, and the
   * de-duplication runs on the sanitised name so two hostile parts cannot collide into one.
   * (A literal NUL cannot get this far — Postgres refuses it in a `text` column, which is where
   * the filename is stored; the control bytes that CAN are the ones exercised here.)
   */
  it("a part named with a traversal path becomes a plain basename in the archive", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "../../.ssh/authorized_keys", partId: "2" });
    await seedAttachment(db, accountId, messageId, { filename: "..\\..\\windows\\system32\\evil.dll", partId: "3" });
    await seedAttachment(db, accountId, messageId, { filename: "re\u000Bport\u000A.pdf", partId: "4" });
    await seedAttachment(db, accountId, messageId, { filename: "..", partId: "5" });

    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async () => ({ contentType: "application/octet-stream", filename: null, body: new Uint8Array([1]) }),
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    const names = Object.keys(loaded.files);
    for (const n of names) {
      expect(n, `a zip entry carried a path separator: ${JSON.stringify(n)}`).not.toMatch(/[/\\]/);
      expect(n, `a zip entry carried a control byte: ${JSON.stringify(n)}`).not.toMatch(/[\u0000-\u001f]/);
      expect(n, `a zip entry was a relative path component: ${JSON.stringify(n)}`).not.toMatch(/^\.\.?$/);
    }
    // Four parts in, four DISTINCT entries out — sanitising must not collapse two names into one
    // and silently drop somebody's file.
    expect(new Set(names).size).toBe(4);
    // And JSZip must not have made any of them a folder.
    for (const f of Object.values(loaded.files)) expect(f.dir).toBe(false);
  });

  it("skips a part that fails to fetch (annotated in _errors.txt) rather than aborting", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "good.txt", partId: "2" });
    await seedAttachment(db, accountId, messageId, { filename: "bad.txt", partId: "3" });

    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async (_loc, partId) => {
        if (partId === "3") throw new Error("upstream boom");
        return { contentType: "text/plain", filename: "good.txt", body: new TextEncoder().encode("GOOD") };
      },
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    expect(await loaded.files["good.txt"]!.async("string")).toBe("GOOD");
    expect(loaded.files["_errors.txt"]).toBeTruthy();
    expect(await loaded.files["_errors.txt"]!.async("string")).toContain("bad.txt");
  });

  /**
   * the archive's copy. A stale locator used to fall into the generic arm and
   * read *"could not be fetched from the mail server"* — which blames a server that is working
   * fine, and sends the reader somewhere there is nothing to find. The condition is ours: the
   * message moved since the file list was built, and the fix is a refresh, because the next scan
   * repoints the locator by Message-ID.
   */
  it("names a gone message as MOVED, not as a mail-server fault — the archive's own words", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "good.txt", partId: "2" });
    await seedAttachment(db, accountId, messageId, { filename: "moved.txt", partId: "3" });

    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async (loc, partId) => {
        if (partId === "3") throw new MessageGoneError(loc);
        return { contentType: "text/plain", filename: "good.txt", body: new TextEncoder().encode("GOOD") };
      },
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    // The healthy part is still in the archive — one stale locator does not cost the rest.
    expect(await loaded.files["good.txt"]!.async("string")).toBe("GOOD");
    const errors = await loaded.files["_errors.txt"]!.async("string");
    expect(errors).toContain("moved.txt");
    expect(errors).toContain("no longer where the mailbox recorded it");
    // BOTH readings, because the refusal cannot tell them apart. An earlier version of this line
    // said only "has moved … refresh and download again", which promises a recovery that does not
    // exist for a message that was actually deleted — the case where the reader most needs to be
    // told the file is gone rather than sent to retry.
    expect(errors).toContain("may have moved");
    expect(errors).toContain("may have been deleted");
    // The sentence that was wrong must be gone, not merely joined by a better one.
    expect(errors).not.toContain("could not be fetched from the mail server");
  });

  it("404s when there are no attachments to download", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const openAdapter: OpenAdapter = async () => ({ fetchPart: async () => { throw new Error("unused"); }, close: async () => {} });
    await expect(svc.downloadAll(ctx, { messageId }, { openAdapter })).rejects.toMatchObject({ httpStatus: 404 });
  });

  /**
   * ── THE NAMELESS-PART NAMES, TYPE-AWARE ─────────────────────────────────────────────────
   *
   * A calendar invitation usually arrives as an UNNAMED `text/calendar` part (Google and
   * Outlook nest it under `multipart/alternative` with no filename — 305 of the live corpus's
   * 646 calendar parts). Served as `attachment-<uuid>.bin`, the one thing the file IS — an
   * event a calendar app can open — is hidden by its own name. So the fallback is type-aware:
   * `invite.ics` for calendar parts, the generic id-stem for everything else, in BOTH writers
   * (the zip entry here, the single-download filename below) — and the engine's
   * `toAttachmentItem` mirrors the pair so the strip shows the same name this serves.
   */
  it("a NAMELESS calendar part is served as invite.ics — zip entry and single download alike", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const ics = await seedAttachment(db, accountId, messageId, {
      filename: null, contentType: "text/calendar; charset=utf-8; method=REQUEST", partId: "2",
    });
    const bin = await seedAttachment(db, accountId, messageId, {
      filename: null, contentType: "application/octet-stream", partId: "3",
    });

    const openAdapter: OpenAdapter = async () => ({
      // IMAP reports no filename either — the double-nameless case the fallback exists for.
      fetchPart: async (_loc, partId) => ({
        contentType: partId === "2" ? "text/calendar" : "application/octet-stream",
        filename: null,
        body: new TextEncoder().encode(partId === "2" ? "BEGIN:VCALENDAR" : "BYTES"),
      }),
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files).sort()).toEqual([`attachment-${bin}.bin`, "invite.ics"]);

    const single = await svc.fetchBytes(ctx, ics, { openAdapter });
    expect(single.filename).toBe("invite.ics");
    const generic = await svc.fetchBytes(ctx, bin, { openAdapter });
    expect(generic.filename).toBe(`attachment-${bin}.bin`);
  });
});

/**
 * The serverless BOUNDS on `download-all`. The archive is built in memory and every part is
 * an IMAP round trip, so the two things that must be bounded are BYTES and CONNECTIONS. Neither
 * was: `POST /files/download-all` with no filter meant "zip my whole attachment history" (an OOM
 * kill, which the client cannot tell apart from a platform timeout), and one adapter was opened
 * per distinct mailbox and held open until the end (N simultaneous IMAP logins from one
 * invocation — the pattern providers throttle first).
 */
describe("AttachmentsService.downloadAll — serverless bounds", () => {
  it("opens ONE connection at a time and closes it before the next mailbox", async () => {
    const { db, accountId, ctx } = await makeCtx();
    // Three mailboxes, two attachments each: the shape a library-wide download takes.
    const boxes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const messageId = await seedMessage(db, accountId, await seedMailboxFor(db, accountId));
      await seedAttachment(db, accountId, messageId, { filename: `m${i}-a.txt`, partId: "2" });
      await seedAttachment(db, accountId, messageId, { filename: `m${i}-b.txt`, partId: "3" });
      boxes.push(messageId);
    }

    let open = 0;
    let maxOpen = 0;
    const opens: string[] = [];
    const openAdapter: OpenAdapter = async (mailboxId) => {
      open++; maxOpen = Math.max(maxOpen, open); opens.push(mailboxId);
      return {
        fetchPart: async () => ({ contentType: "text/plain", filename: null, body: new TextEncoder().encode("x") }),
        close: async () => { open--; },
      };
    };

    const { zip } = await svc.downloadAll(ctx, {}, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files)).toHaveLength(6);      // every part still archived
    expect(maxOpen).toBe(1);                                 // never two connections at once
    expect(opens).toHaveLength(3);                           // one login per mailbox, not per part
    expect(new Set(opens).size).toBe(3);
    expect(open).toBe(0);                                    // and all closed
  });

  it("413 when the selection exceeds the PART ceiling — before any connection is opened", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    for (let i = 0; i < DOWNLOAD_ALL_MAX_PARTS + 1; i++) {
      await seedAttachment(db, accountId, messageId, { filename: `f${i}.txt`, sizeBytes: 1 });
    }
    let opened = 0;
    const openAdapter: OpenAdapter = async () => {
      opened++;
      return { fetchPart: async () => { throw new Error("unreachable"); }, close: async () => {} };
    };
    await expect(svc.downloadAll(ctx, { messageId }, { openAdapter }))
      .rejects.toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(opened).toBe(0);                                  // refused before dialling anything
  });

  it("413 when the DECLARED bytes exceed the ceiling — the metadata is checked first", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "huge.bin", sizeBytes: DOWNLOAD_ALL_MAX_BYTES });
    await seedAttachment(db, accountId, messageId, { filename: "more.bin", sizeBytes: 1024 });
    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async () => { throw new Error("unreachable"); }, close: async () => {},
    });
    await expect(svc.downloadAll(ctx, { messageId }, { openAdapter }))
      .rejects.toMatchObject({ httpStatus: 413 });
  });

  it("enforces the byte ceiling on ACTUAL bytes too — metadata can lie", async () => {
    // Two 1-byte attachments by metadata that fetch as huge blobs. Without a running total the
    // pre-flight check is trivially bypassable by stale or hostile size metadata.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAttachment(db, accountId, messageId, { filename: "a.bin", sizeBytes: 1, partId: "2" });
    await seedAttachment(db, accountId, messageId, { filename: "b.bin", sizeBytes: 1, partId: "3" });

    const big = new Uint8Array(DOWNLOAD_ALL_MAX_BYTES);      // one part alone reaches the cap
    const openAdapter: OpenAdapter = async () => ({
      fetchPart: async () => ({ contentType: "application/octet-stream", filename: null, body: big }),
      close: async () => {},
    });

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    // The first part is in; the second is skipped and SAID SO rather than silently dropped.
    expect(Object.keys(loaded.files)).toContain("_errors.txt");
    expect(await loaded.files["_errors.txt"]!.async("string")).toMatch(/limit/i);
    expect(Object.keys(loaded.files).filter((n) => n.endsWith(".bin"))).toHaveLength(1);
  }, 30_000);

  it("a mailbox that will not connect costs its own parts, not the whole archive", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const goodMailbox = await seedMailboxFor(db, accountId);
    const badMailbox = await seedMailboxFor(db, accountId);
    const goodMsg = await seedMessage(db, accountId, goodMailbox);
    const badMsg = await seedMessage(db, accountId, badMailbox);
    await seedAttachment(db, accountId, goodMsg, { filename: "ok.txt", partId: "2" });
    await seedAttachment(db, accountId, badMsg, { filename: "unreachable.txt", partId: "2" });

    const openAdapter: OpenAdapter = async (mailboxId) => {
      if (mailboxId === badMailbox) throw new Error("IMAP login failed");
      return {
        fetchPart: async () => ({ contentType: "text/plain", filename: null, body: new TextEncoder().encode("OK") }),
        close: async () => {},
      };
    };

    const { zip } = await svc.downloadAll(ctx, {}, { openAdapter });
    const loaded = await JSZip.loadAsync(zip);
    expect(await loaded.files["ok.txt"]!.async("string")).toBe("OK");
    expect(await loaded.files["_errors.txt"]!.async("string")).toContain("unreachable.txt");
  });
});
