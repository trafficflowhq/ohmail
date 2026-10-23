import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { attachments, drafts, mailboxCredentials, messageBodies, messages } from "@trafficflow/db";
import * as imapModule from "@trafficflow/core/adapters/imap";
import {
  AttachmentTooLargeError, EpochUnknownError, ImapAdapter, ImapBoundConfigError, ImapBoundExceeded,
  ImapConnectionClosedError, MessageGoneError, MoveIncompleteError, MoveRefusedError, MoveVerifyError,
  RawMessageTooLargeError, SameFolderMoveError, UnsupportedAuthTypeError, WriteDeclinedError,
} from "@trafficflow/core/adapters/imap";
import type { MimeStructure, NativeLocator, OutboundMessage, SendAdapter } from "@trafficflow/core/mail";
import { sendService, type AttachmentAdapter, type ServiceContext } from "@trafficflow/services/mail";
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import type { ApiDeps } from "../src/deps.js";
import { FIXED_NOW, makeDeps, seedBody, seedMailbox, seedMessage, seedSession } from "./helpers.js";

/**
 * A GONE MESSAGE IS THE SERVER'S ANSWER, NOT A DEAD SOCKET. The factory destroyed its connection on
 * every throw, `MessageGoneError` included, so the forward's one retry against the re-resolved
 * locator ran on a closed socket: "could not be loaded" on the first press, a working second press.
 * The repair's tree read after a gone section and every later part of a download walk met the same
 * dead connection. Every class the adapter module exports is mapped here, latch or answer, and a
 * class nobody mapped is refused. The double fails as production does: the adapter's own class,
 * thrown unwrapped, and after a destroyed socket every command fails with imapflow's NoConnection.
 */

const STALE: NativeLocator = { folder: "INBOX", ref: "12:7" };
const FRESH: NativeLocator = { folder: "Archive", ref: "19:3" };
const PDF = new Uint8Array([1, 2, 3, 4]);
const RAW = Buffer.from(
  "From: Lena <lena@atelier.example>\r\nSubject: Q3 plan\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
    + "The plan, read from the mailbox.\r\n",
);
const STRUCTURE = { type: "text/plain", part: "1" } as unknown as MimeStructure;
const HANG = Symbol("hang");

/** What crossed the wire: dials, graceful LOGOUTs, destroyed sockets, and every read in order. */
interface Wire { dials: number; logouts: number; destroyed: number; reads: string[] }

/** The connection double; `first` is thrown (or hangs) on the first read, `gone` refs answer gone. */
function wireDouble(o: { first?: () => unknown; gone?: ReadonlySet<string>; onGone?: () => Promise<void> } = {}): Wire {
  const wire: Wire = { dials: 0, logouts: 0, destroyed: 0, reads: [] };
  const live = new WeakMap<object, boolean>();
  let firstSpent = false;
  let goneSaid = false;
  async function read<T>(self: object, op: string, loc: NativeLocator, value: T): Promise<T> {
    if (live.get(self) !== true) throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    wire.reads.push(`${op}:${loc.ref}`);
    if (o.first && !firstSpent) {
      firstSpent = true;
      const err = o.first();
      if (err === HANG) return new Promise<T>(() => { /* the server never answers */ });
      throw err;
    }
    if (o.gone?.has(loc.ref)) {
      if (!goneSaid && o.onGone) await o.onGone();
      goneSaid = true;
      throw new MessageGoneError(loc);
    }
    return value;
  }
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
    wire.dials += 1;
    live.set(this, true);
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async function (this: object) {
    if (live.get(this) === true) wire.logouts += 1;
    live.set(this, false);
  });
  vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(function (this: object) {
    wire.destroyed += 1;
    live.set(this, false);
  });
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockImplementation(async function (this: object, loc: NativeLocator) {
    return read(this, "part", loc, { contentType: "application/pdf", filename: "plan.pdf", body: PDF });
  });
  vi.spyOn(ImapAdapter.prototype, "fetchRaw").mockImplementation(async function (this: object, loc: NativeLocator) {
    return read(this, "raw", loc, new Uint8Array(RAW));
  });
  vi.spyOn(ImapAdapter.prototype, "fetchStructure").mockImplementation(async function (this: object, loc: NativeLocator) {
    return read(this, "tree", loc, STRUCTURE);
  });
  return wire;
}

/** The credential read and an always-admitting counter whose releases are counted. */
function fakeDeps(): { deps: ApiDeps; released: () => number } {
  let released = 0;
  const row = {
    transport: "imap", secretEnc: Buffer.from("enc"), keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid" },
  };
  const deps = {
    db: { select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }) },
    keyProvider: { decrypt: async () => "secret-not-printed" },
    services: { imapAdmission: { acquire: async () => true, release: async () => { released += 1; } } },
  } as unknown as ApiDeps;
  return { deps, released: () => released };
}

type Read = "fetchPart" | "fetchRaw" | "fetchStructure";
const READS: readonly Read[] = ["fetchPart", "fetchRaw", "fetchStructure"];
const call = (h: AttachmentAdapter, read: Read, loc: NativeLocator): Promise<unknown> =>
  read === "fetchPart" ? h.fetchPart(loc, "2") : read === "fetchRaw" ? h.fetchRaw!(loc) : h.fetchStructure!(loc);

type Verdict = "latch" | "answer";
/** EVERY ERROR CLASS THE ADAPTER MODULE EXPORTS, and what it says about the socket it came from. */
const MODULE_CLASSES: Record<string, { verdict: Verdict; make: () => unknown }> = {
  MessageGoneError: { verdict: "answer", make: () => new MessageGoneError(STALE) },
  EpochUnknownError: { verdict: "latch", make: () => new EpochUnknownError(STALE) },
  AttachmentTooLargeError: { verdict: "latch", make: () => new AttachmentTooLargeError(STALE, 10, 11) },
  RawMessageTooLargeError: { verdict: "latch", make: () => new RawMessageTooLargeError(STALE, 10, 11) },
  ImapConnectionClosedError: { verdict: "latch", make: () => new ImapConnectionClosedError() },
  ImapBoundExceeded: { verdict: "latch", make: () => new ImapBoundExceeded("list_folders", 1, 2) },
  ImapBoundConfigError: { verdict: "latch", make: () => new ImapBoundConfigError("TF_X", "not a number") },
  MoveVerifyError: { verdict: "latch", make: () => new MoveVerifyError(STALE, "Archive") },
  MoveIncompleteError: { verdict: "latch", make: () => new MoveIncompleteError(STALE, "Archive", "refused") },
  MoveRefusedError: { verdict: "latch", make: () => new MoveRefusedError(STALE, "Archive", "refused") },
  SameFolderMoveError: { verdict: "latch", make: () => new SameFolderMoveError(STALE, "INBOX") },
  WriteDeclinedError: { verdict: "latch", make: () => new WriteDeclinedError("move", "claim_stale") },
  UnsupportedAuthTypeError: { verdict: "latch", make: () => new UnsupportedAuthTypeError("kerberos") },
};
/** The throws that are no class of the module: the door's own clock, the driver's, a bug. */
const OUTSIDE: Record<string, { verdict: Verdict; make: () => unknown }> = {
  "the per-operation deadline": { verdict: "latch", make: () => HANG },
  "the driver's closed connection": {
    verdict: "latch", make: () => Object.assign(new Error("Connection not available"), { code: "NoConnection" }),
  },
  "a socket reset": { verdict: "latch", make: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) },
  "an unnamed throw": { verdict: "latch", make: () => new TypeError("x is undefined") },
};

afterEach(() => { vi.restoreAllMocks(); });

describe("the census of throws the attachment door can see", () => {
  it("names every Error class the adapter module exports: a new one is refused until it is mapped", () => {
    const exported = Object.entries(imapModule)
      .filter(([, v]) => typeof v === "function" && (v as { prototype?: unknown }).prototype instanceof Error)
      .map(([name]) => name)
      .sort();
    expect(exported.length, "the enumeration read no class at all").toBeGreaterThan(5);
    expect(Object.keys(MODULE_CLASSES).sort()).toEqual(exported);
  });

  it("only the gone answer keeps the connection", () => {
    const answers = Object.entries({ ...MODULE_CLASSES, ...OUTSIDE })
      .filter(([, e]) => e.verdict === "answer").map(([name]) => name);
    expect(answers).toEqual(["MessageGoneError"]);
  });

  for (const [name, entry] of Object.entries({ ...MODULE_CLASSES, ...OUTSIDE })) {
    for (const read of READS) {
      it(`${name} on ${read}: ${entry.verdict}`, async () => {
        const thrown = entry.make();
        const wire = wireDouble({ first: () => thrown });
        const { deps, released } = fakeDeps();
        const handle = await makeOpenAdapter(deps, { operationBudgetMs: 20 })(randomUUID());
        const first = await call(handle, read, STALE).then(() => null, (e: unknown) => e);
        if (thrown !== HANG) expect(first, "the throw crosses the door unwrapped").toBe(thrown);
        if (entry.verdict === "answer") {
          expect(wire.destroyed, "an answer destroyed the socket").toBe(0);
          for (const next of READS) await expect(call(handle, next, FRESH)).resolves.toBeTruthy();
          await handle.close();
          expect(wire.logouts, "the connection ends with its LOGOUT").toBe(1);
        } else {
          expect(wire.destroyed, "a dead socket was left open").toBe(1);
          await handle.close();
          expect(wire.logouts, "close() after a latch queued a LOGOUT").toBe(0);
        }
        expect(wire.dials).toBe(1);
        expect(released(), "both slots go back exactly once").toBe(1);
      });
    }
  }
});

describe("a forward whose original moved goes out on the first press", () => {
  async function world(o: { husk: boolean }) {
    const { db, deps } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@atelier.example" });
    const sealed = await deps.keyProvider.encrypt("imap-fixture");
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion,
      meta: { host: "imap.atelier.example", port: 993, secure: true, user: "me@atelier.example" },
    });
    const orig = await seedMessage(db, {
      accountId: s.accountId, mailboxId, subject: "Q3 plan", fromAddress: "lena@atelier.example",
      date: FIXED_NOW, nativeLocator: STALE,
    });
    await seedBody(db, { messageId: orig.id, text: o.husk ? "" : "Here is the plan.", html: null });
    if (o.husk) {
      await db.update(messageBodies).set({ withheldReason: "storage_cap" }).where(eq(messageBodies.messageId, orig.id));
    } else {
      await db.insert(attachments).values({
        accountId: s.accountId, messageId: orig.id, filename: "plan.pdf",
        contentType: "application/pdf", sizeBytes: 4, partId: "2", inline: false,
      });
    }
    const [draft] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "Fwd: Q3 plan", body: "Passing this along.",
      to: [{ name: null, address: "sam@example.test" }], cc: [], bcc: [], status: "draft",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    const ctx: ServiceContext = {
      db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "fwd-moved",
    };
    // The worker's adoption, landing while the first read is refused: the mirror now names FRESH.
    const repoint = async (): Promise<void> => {
      await db.update(messages).set({ nativeLocator: FRESH }).where(eq(messages.id, orig.id));
    };
    return { deps, ctx, draftId: draft!.id, originalId: orig.id, repoint };
  }

  function smtpSpy(): { sent: OutboundMessage[]; open: () => Promise<SendAdapter> } {
    const sent: OutboundMessage[] = [];
    return {
      sent,
      open: async () => ({
        async send(msg: OutboundMessage) { sent.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
        async messageInSent() { return false; },
        async close() { /* nothing */ },
      }),
    };
  }

  it("its file: the gone answer keeps the socket and the re-resolved read runs on it", async () => {
    const w = await world({ husk: false });
    const wire = wireDouble({ gone: new Set([STALE.ref]), onGone: w.repoint });
    const smtp = smtpSpy();
    const res = await sendService.send(
      w.ctx, w.draftId, "key-moved-part",
      { openSendAdapter: smtp.open, openFetchAdapter: makeOpenAdapter(w.deps) },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");
    expect(wire.reads).toEqual(["part:12:7", "part:19:3"]);
    expect({ dials: wire.dials, destroyed: wire.destroyed, logouts: wire.logouts }).toEqual({ dials: 1, destroyed: 0, logouts: 1 });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.attachments?.map((a) => a.filename)).toEqual(["plan.pdf"]);
  });

  it("its words read from the mailbox: the same, through the whole-message read", async () => {
    const w = await world({ husk: true });
    const wire = wireDouble({ gone: new Set([STALE.ref]), onGone: w.repoint });
    const smtp = smtpSpy();
    const res = await sendService.send(
      w.ctx, w.draftId, "key-moved-raw",
      { openSendAdapter: smtp.open, openFetchAdapter: makeOpenAdapter(w.deps) },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");
    expect(wire.reads).toEqual(["raw:12:7", "raw:19:3"]);
    expect({ dials: wire.dials, destroyed: wire.destroyed, logouts: wire.logouts }).toEqual({ dials: 1, destroyed: 0, logouts: 1 });
    expect(smtp.sent[0]!.text).toContain("The plan, read from the mailbox.");
  });
});
