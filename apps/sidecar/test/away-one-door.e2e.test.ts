/**
 * THE AWAY PASS OVER A REAL SUBMISSION SERVER — the reservation's own row, and a release, measured
 * where the reply lands. The desktop's own store (`createSidecar`, never started) and the real
 * transport (`ImapAdapter`: SMTP to GreenMail, the Sent append over IMAP). The verdict is the
 * correspondent's INBOX, read by an independent client, beside the ledger and the throttle state.
 * GreenMail runs with authentication disabled and makes a user at first login; addresses are
 * synthetic, and nothing here prints a wire read.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { OutboundMessage } from "@trafficflow/core/adapters/imap";
import type { SendAdapter } from "@trafficflow/core/mail";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages, threads,
} from "@trafficflow/db";
import { runAwayResponderPass } from "@trafficflow/services";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
const PASS = "test";

const open: Sidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function withServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user, pass: PASS }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

/** How many copies of `subject` the correspondent's INBOX holds. */
const received = (user: string, subject: string): Promise<number> => withServer(user, async (c) => {
  const lock = await c.getMailboxLock("INBOX");
  try {
    const hits = await c.search({ header: { subject } }, { uid: true });
    return Array.isArray(hits) ? hits.length : 0;
  } finally { lock.release(); }
});

/** Reads until the count is `want` or the deadline — delivery is the server's, not ours. */
async function receivedWithin(user: string, subject: string, want: number, ms = 10_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const n = await received(user, subject);
    if (n >= want || Date.now() - t0 >= ms) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Desk { sidecar: Sidecar; owner: string; them: string }

/** The desktop's own store over a fresh account holder, organizing, with a live responder; the holder and
 *  the correspondent both exist on the server before anything is sent. */
async function desk(): Promise<Desk> {
  const owner = `away-owner-${randomUUID()}@trafficflow.test`;
  const them = `away-them-${randomUUID()}@trafficflow.test`;
  for (const u of [owner, them]) await withServer(u, async () => undefined);
  const dataDir = await freshDataDir("ohmail-away-one-door-");
  dirs.push(dataDir);
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: HOST, port: IMAP_PORT, secure: false, auth: { user: owner, pass: PASS },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
    },
    address: owner,
    machineName: "the desktop answering away mail",
    keks: { 1: randomBytes(32) },
    pollIntervalMs: 60 * 60 * 1000,
    log: () => {},
  });
  open.push(sidecar);
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(eq(mailboxes.id, sidecar.world.mailboxId));
  await sidecar.db.insert(awayResponders).values({
    accountId: sidecar.world.accountId, enabled: true, enabledAt: new Date(Date.now() - 60 * 60_000),
    body: "Back Monday.", audience: "everyone", throttle: "always", piles: ["INBOX"],
  });
  return { sidecar, owner, them };
}

/** A letter from the correspondent, as the ingest stores it, in the Ohbox. */
async function arrival(d: Desk, subject: string): Promise<string> {
  const key = randomUUID();
  const at = new Date(Date.now() - 60_000);
  const [t] = await d.sidecar.db.insert(threads).values({
    accountId: d.sidecar.world.accountId, rootMessageIdHeader: `<${key}@them.example>`,
  }).returning();
  const [m] = await d.sidecar.db.insert(messages).values({
    accountId: d.sidecar.world.accountId, mailboxId: d.sidecar.world.mailboxId, threadId: t!.id,
    messageIdHeader: `<${key}@them.example>`, bodyHash: `h-${key}`, dedupKey: `d-${key}`,
    subject, fromAddress: d.them, nativeLocator: { folder: "INBOX", ref: `1:${key.slice(0, 6)}` },
    date: at, createdAt: at,
  }).returning();
  await d.sidecar.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
  await d.sidecar.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, observedFolder: "INBOX", desiredFolder: "INBOX",
    lastSetBy: "us", reconcileStatus: "reconciled",
  });
  return m!.id;
}

/** The real transport, dialled per pass; `during` runs after SMTP accepted and before the finalize. */
function realSend(d: Desk, during?: () => Promise<void>) {
  let dials = 0;
  const factory = async (): Promise<SendAdapter> => {
    const real = new ImapAdapter({
      host: HOST, port: IMAP_PORT, secure: false, allowInsecure: true, auth: { user: d.owner, pass: PASS },
      smtp: { host: HOST, port: SMTP_PORT, secure: false, allowInsecure: true },
      sentDomain: "trafficflow.test",
    });
    await real.connect();
    return {
      send: async (m: OutboundMessage) => {
        dials += 1;
        const res = await real.send(m);
        if (during) await during();
        return res;
      },
      messageInSent: async () => false,
      close: () => real.close(),
    } as unknown as SendAdapter;
  };
  return { factory, get dials() { return dials; } };
}

const pass = (d: Desk, send: ReturnType<typeof realSend>, stillOrganizing?: () => Promise<boolean>) =>
  runAwayResponderPass(d.sidecar.db as never, {
    openSendAdapter: send.factory, mailboxIds: [d.sidecar.world.mailboxId],
    ...(stillOrganizing ? { stillOrganizing } : {}),
  });
const ledger = (d: Desk) => d.sidecar.db.select().from(awayReplies);
const throttle = (d: Desk) => d.sidecar.db.select().from(awaySenderState);
const answering = (...answers: boolean[]) => async (): Promise<boolean> => answers.shift() ?? true;

describe("the away pass on a real submission server", () => {
  it("(a) the letter expunged while its reply is on the wire: delivered once, and the row says `sent`", async () => {
    const d = await desk();
    const subject = `the roof ${randomUUID().slice(0, 8)}`;
    const id = await arrival(d, subject);
    // The delete a mirrored store performs (`cloud-mirror.ts`), dependents first, so mail 0118's
    // key sets the ledger's pointer NULL between the reservation and the finalize.
    const send = realSend(d, async () => {
      await d.sidecar.db.delete(folderState).where(eq(folderState.messageId, id));
      await d.sidecar.db.delete(messageBodies).where(eq(messageBodies.messageId, id));
      await d.sidecar.db.delete(messages).where(eq(messages.id, id));
    });

    const out = await pass(d, send);

    expect(out.sent).toBe(1);
    expect(await receivedWithin(d.them, `Re: ${subject}`, 1), "the reply never arrived").toBe(1);
    const [row] = await ledger(d);
    expect(row!.messageId, "the fixture did not null the pointer").toBeNull();
    expect(row!.outcome, "a delivered reply was left pending").toBe("sent");
    expect(row!.sentAt).not.toBeNull();
  }, 60_000);

  it("(b)+(c) a handover between the reservation and the dial: nothing sent, released, and sent once later", async () => {
    const d = await desk();
    const subject = `the drains ${randomUUID().slice(0, 8)}`;
    await arrival(d, subject);
    const refused = realSend(d);

    const out = await pass(d, refused, answering(true, false));

    expect(out).toMatchObject({ sent: 0, refusedNotOrganizer: 1 });
    expect(refused.dials, "the refused pass dialled").toBe(0);
    expect(await ledger(d), "the refusal kept a reservation").toEqual([]);
    expect(await throttle(d), "the refusal kept the person's throttle").toEqual([]);

    // (c) the mailbox is this install's again: the reply is still owed and goes exactly once.
    const later = realSend(d);
    expect((await pass(d, later, async () => true)).sent).toBe(1);
    expect((await pass(d, later, async () => true)).sent).toBe(0);
    expect(await receivedWithin(d.them, `Re: ${subject}`, 1)).toBe(1);
    // Nothing further arrives: the second pass had nothing left to answer.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await received(d.them, `Re: ${subject}`), "the correspondent was answered twice").toBe(1);
  }, 60_000);

  it("(b) a person answered before keeps, byte for byte, the throttle state that reply wrote", async () => {
    const d = await desk();
    const first = `the gutter ${randomUUID().slice(0, 8)}`;
    await arrival(d, first);
    expect((await pass(d, realSend(d))).sent).toBe(1);
    expect(await receivedWithin(d.them, `Re: ${first}`, 1)).toBe(1);
    const before = await throttle(d);
    expect(before).toHaveLength(1);
    const second = `the chimney ${randomUUID().slice(0, 8)}`;
    await arrival(d, second);
    const refused = realSend(d);

    await pass(d, refused, answering(true, false));

    expect(refused.dials).toBe(0);
    expect(await throttle(d), "the release did not put back the earlier reply's state").toEqual(before);
    expect((await ledger(d)).map((r) => r.outcome)).toEqual(["sent"]);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await received(d.them, `Re: ${second}`), "the refused reply reached the correspondent").toBe(0);
  }, 60_000);
});
