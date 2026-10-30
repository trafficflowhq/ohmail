import { recordSentMessage, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, folderState, mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo, recordSpecialFolders } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { SyncService, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore, ohboxView } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A LETTER THE PERSON SENT THEMSELVES, IN INBOX AND IN SENT. One logical row per fingerprint, so
 * the question is which copy the row answers for: INBOX is received mail with its own `\Seen`,
 * whatever order the sync met the two copies in. The real adapter over a recording server, the
 * worker's own cycle, the real repo on the store under test, and a client mirror fed from
 * `/sync` — the Ohbox's "New for you" is the unread count every surface renders.
 */

interface FakeMsg { uid: number; raw: Buffer; messageId: string; seen: boolean }
interface FolderSpec { path: string; specialUse?: string; noselect?: boolean }
export interface Shape {
  name: string;
  delimiter: string;
  folders: FolderSpec[];
  /** Server paths, as the LIST spells them. */
  inbox: string;
  sent: string;
  /** Gmail's extra homes of one message: `\All` (never read) and a label (a customer folder). */
  allMail?: string;
  label?: string;
}

export const PLAIN: Shape = {
  name: "a name-matched Sent", delimiter: "/", inbox: "INBOX", sent: "Sent",
  folders: [{ path: "INBOX" }, { path: "Sent" }],
};
export const DOVECOT: Shape = {
  name: "Dovecot's INBOX.Sent", delimiter: ".", inbox: "INBOX", sent: "INBOX.Sent",
  folders: [{ path: "INBOX" }, { path: "INBOX.Sent" }],
};
export const GMAIL: Shape = {
  name: "a Gmail-like server", delimiter: "/", inbox: "INBOX", sent: "[Gmail]/Sent Mail",
  allMail: "[Gmail]/All Mail", label: "Work",
  folders: [
    { path: "INBOX" }, { path: "[Gmail]", noselect: true },
    { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" }, { path: "[Gmail]/All Mail", specialUse: "\\All" },
    { path: "Work" },
  ],
};

/** A SPECIAL-USE Sent under a name the Sent-shaped belt does not know: only the mailbox's record says it is Sent. */
export const LOCALIZED: Shape = {
  name: "a SPECIAL-USE Sent named Envoyés", delimiter: "/", inbox: "INBOX", sent: "Envoyés",
  folders: [{ path: "INBOX" }, { path: "Envoyés", specialUse: "\\Sent" }],
};
export const LOCALIZED_DOVECOT: Shape = {
  name: "a SPECIAL-USE Sent named INBOX.Verzonden", delimiter: ".", inbox: "INBOX", sent: "INBOX.Verzonden",
  folders: [{ path: "INBOX" }, { path: "INBOX.Verzonden", specialUse: "\\Sent" }],
};

const ARRIVED = new Date("2026-09-25T07:46:00Z");

/** One letter's bytes. `received` adds the headers a delivery writes; identity ignores them. */
function rawOf(
  l: { messageId: string; from: string; to: string; subject: string }, received: boolean,
  date = "Fri, 25 Sep 2026 07:46:00 +0000",
): Buffer {
  return Buffer.from([
    ...(received ? ["Received: from mx.example.test by imap.example.test", `Delivered-To: ${l.to}`] : []),
    `Message-ID: <${l.messageId}>`, `From: ${l.from}`, `To: ${l.to}`, `Subject: ${l.subject}`,
    `Date: ${date}`, "Content-Type: text/plain; charset=utf-8", "",
    "the whole text of the letter",
  ].join("\r\n"));
}

/** A server whose folders hold numbered copies with a per-copy `\Seen`. No CONDSTORE. A server that
 *  marks a folder's role advertises SPECIAL-USE and XLIST and sends the role in its LIST flags, as
 *  Gmail does: no imapflow reports `\All` any other way. */
function fakeServer(shape: Shape) {
  const marksRoles = shape.folders.some((f) => f.specialUse);
  const folders = new Map<string, FakeMsg[]>(shape.folders.filter((f) => !f.noselect).map((f) => [f.path, []]));
  const nextUid = new Map<string, number>();
  const UIDVALIDITY = 100n;
  const box = (path: string) => {
    const list = folders.get(path) ?? [];
    const uids = list.map((m) => m.uid);
    return { path, uidValidity: UIDVALIDITY, uidNext: (nextUid.get(path) ?? 1), highestModseq: 0n, exists: uids.length };
  };
  const client = {
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true],
      ...(marksRoles ? [["SPECIAL-USE", true], ["XLIST", true]] as Array<[string, boolean]> : [])]),
    mailbox: box(shape.inbox) as ReturnType<typeof box>,
    _path: shape.inbox,
    async list() {
      return shape.folders.map((f) => ({
        path: f.path, name: f.path, delimiter: shape.delimiter,
        flags: new Set<string>([...(f.noselect ? ["\\Noselect"] : []), ...(f.specialUse ? [f.specialUse] : [])]),
        ...(f.specialUse ? { specialUse: f.specialUse } : {}),
      }));
    },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = box(path);
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const list = folders.get(this._path) ?? [];
      if (list.length === 0) return;
      let picked: FakeMsg[];
      if (Array.isArray(range)) picked = list.filter((m) => (range as number[]).includes(m.uid));
      else {
        const start = Number(String(range).split(":")[0]);
        const up = list.filter((m) => m.uid >= start);
        picked = options?.uid ? (up.length > 0 ? up : [list[list.length - 1]!]) : list.slice(Math.max(0, start - 1));
      }
      for (const m of picked) {
        yield {
          uid: m.uid,
          ...(query?.flags ? { flags: new Set<string>(m.seen ? ["\\Seen"] : []) } : {}),
          ...(query?.size ? { size: m.raw.length } : {}),
          ...(query?.envelope ? { envelope: { messageId: `<${m.messageId}>` } } : {}),
          ...(query?.source ? { source: m.raw } : {}),
          ...(query?.internalDate ? { internalDate: ARRIVED } : {}),
        };
      }
    },
  };
  /** Another client (or the delivery) puts a copy into a folder; the server numbers it. */
  const put = (path: string, raw: Buffer, messageId: string, seen: boolean): number => {
    const uid = nextUid.get(path) ?? 1;
    nextUid.set(path, uid + 1);
    folders.get(path)!.push({ uid, raw, messageId, seen });
    return uid;
  };
  /** The epoch as the server answers it — read back, never derived by the caller. */
  const uidValidityOf = (path: string): string => String(box(path).uidValidity);
  const unseenIn = (path: string): number => (folders.get(path) ?? []).filter((m) => !m.seen).length;
  return { client, put, uidValidityOf, unseenIn };
}

type MakeDb = () => Promise<Tx>;

async function world(makeDb: MakeDb, shape: Shape) {
  const db = await makeDb();
  const tag = randomUUID().slice(0, 8);
  const me = `me-${tag}@example.test`;
  const [a] = await db.insert(accounts).values({ name: `self-sent-${tag}` }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  const mailboxId = mb!.id;
  const imap = fakeServer(shape);
  const adapter = new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: me, pass: "p" } }, { client: imap.client as never },
  );
  await adapter.connect();
  const repo = makeDrizzleRepo(db);
  // The attach's discovery, as both attach paths write it: the Sent folder lands in `mailboxes.sent_folder`.
  await recordSpecialFolders(adapter, repo, mailboxId);
  // A known correspondent, so the INBOX-only control stays in the Ohbox rather than the Screener.
  await repo.upsertContacts(accountId, ["anna@example.test"], "person");
  const cycle = () => runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo, adapter, role: "organizer",
    accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
  });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: `self-sent-${tag}` };
  const store = new MemoryMirrorStore();
  await store.load();
  let cursor: string | undefined;
  const drain = async (): Promise<void> => {
    const sync = new SyncService();
    for (;;) {
      const resp = await sync.getChanges(ctx, cursor === undefined ? {} : { since: cursor });
      await store.applyResponse(resp);
      cursor = resp.cursor;
      if (!resp.hasMore) return;
    }
  };
  const letter = (name: string, from = me) =>
    ({ messageId: `${name}-${tag}@example.test`, from, to: me, subject: `ohmail-fixture ${name}` });
  /** Every row this mailbox stores for one Message-ID, with where each says it is. */
  const rowsOf = async (messageId: string) => {
    const rows = await db.select({ id: messages.id, unread: messages.unread, locator: messages.nativeLocator })
      .from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageId)));
    return Promise.all(rows.map(async (r) => {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, r.id));
      const inst = await db.select().from(messageInstances).where(eq(messageInstances.messageId, r.id));
      return {
        id: r.id, unread: r.unread, primary: (r.locator as { folder: string }).folder,
        desired: fs?.desiredFolder ?? null,
        instances: inst.map((i) => `${i.folder}${i.isPrimary ? "*" : ""}`).sort(),
      };
    }));
  };
  const newForYou = () => ohboxView(store).newForYou.map((m) => m.id);
  return { db, repo, imap, adapter, cycle, drain, store, letter, rowsOf, newForYou, accountId, mailboxId, shape };
}

/** Canonical spelling of a server path, as the adapter stores it. */
const canonical = (shape: Shape, path: string): string =>
  shape.delimiter === "/" ? path : path.split(shape.delimiter).join("/");

type World = Awaited<ReturnType<typeof world>>;

/** The two controls every world carries: a letter only in Sent, a letter only in INBOX. */
function seedControls(w: World) {
  const onlySent = w.letter("only-sent");
  onlySent.to = "bob@example.test";
  const onlyInbox = w.letter("only-inbox", "anna@example.test");
  w.imap.put(w.shape.sent, rawOf(onlySent, false), onlySent.messageId, true);
  w.imap.put(w.shape.inbox, rawOf(onlyInbox, true), onlyInbox.messageId, false);
  return { onlySent, onlyInbox };
}

async function expectControls(w: World, c: ReturnType<typeof seedControls>) {
  const [sent] = await w.rowsOf(c.onlySent.messageId);
  expect(sent!.primary, "a letter only in Sent left Sent").toBe(canonical(w.shape, w.shape.sent));
  expect(w.newForYou(), "a letter only in Sent reached the Ohbox").not.toContain(sent!.id);
  const [inbox] = await w.rowsOf(c.onlyInbox.messageId);
  expect([inbox!.primary, inbox!.unread], "a letter only in INBOX changed").toEqual(["INBOX", true]);
  expect(w.newForYou(), "a letter only in INBOX left the Ohbox").toContain(inbox!.id);
}

/** The whole claim about one self-sent letter: one row, INBOX's, unread as INBOX holds it. */
async function expectInboxInstance(w: World, messageId: string) {
  const rows = await w.rowsOf(messageId);
  expect(rows, "a self-sent letter must stay ONE row").toHaveLength(1);
  const r = rows[0]!;
  expect({ primary: r.primary, desired: r.desired, unread: r.unread }, "the row answers for the Sent copy")
    .toEqual({ primary: "INBOX", desired: "INBOX", unread: true });
  expect(r.instances, "both copies stay known").toContain("INBOX*");
  expect(r.instances).toContain(canonical(w.shape, w.shape.sent));
  expect(w.newForYou(), "the unread INBOX letter is missing from the Ohbox").toContain(r.id);
  expect(w.newForYou().length, "the Ohbox's unread count disagrees with the mailbox's INBOX")
    .toBe(w.imap.unseenIn(w.shape.inbox));
}

export function describeSelfSent(store: string, makeDb: MakeDb, order: "forward" | "reverse" = "forward"): void {
  const cases: Array<[string, () => Promise<void>]> = [];

  for (const shape of [PLAIN, DOVECOT, LOCALIZED, LOCALIZED_DOVECOT]) {
    cases.push([`Sent copy first, then the INBOX copy — ${shape.name}`, async () => {
      const w = await world(makeDb, shape);
      const c = seedControls(w);
      const l = w.letter("to-myself");
      w.imap.put(shape.sent, rawOf(l, false), l.messageId, true);
      await w.cycle();
      await w.cycle();
      w.imap.put(shape.inbox, rawOf(l, true), l.messageId, false);
      await w.cycle();
      await w.drain();
      await expectInboxInstance(w, l.messageId);
      await expectControls(w, c);
    }]);
    cases.push([`INBOX copy first, then the Sent copy — ${shape.name}`, async () => {
      const w = await world(makeDb, shape);
      const c = seedControls(w);
      const l = w.letter("to-myself");
      w.imap.put(shape.inbox, rawOf(l, true), l.messageId, false);
      await w.cycle();
      await w.cycle();
      w.imap.put(shape.sent, rawOf(l, false), l.messageId, true);
      await w.cycle();
      await w.drain();
      await expectInboxInstance(w, l.messageId);
      await expectControls(w, c);
    }]);
  }

  const recordAtSend = async (w: World, raw: Buffer, uid: number) =>
    recordSentMessage({ locator: { folder: w.shape.sent, ref: `${w.imap.uidValidityOf(w.shape.sent)}:${uid}` }, raw }, {
      accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP, repo: w.repo,
      withTx: (run) => w.repo.transaction((tx) => run(tx)),
    });

  /* THE CLOUD'S OWN ORDER for a letter written in ohmail: the send projects the Sent copy at once
     (`recordSentMessage`, the record-at-send door) and the delivery reaches INBOX a cycle later. */
  for (const shape of [PLAIN, LOCALIZED]) {
    cases.push([`a letter sent from ohmail: the Sent copy is recorded at send, the INBOX copy after — ${shape.name}`, async () => {
      const w = await world(makeDb, shape);
      const c = seedControls(w);
      const l = w.letter("sent-from-ohmail");
      const raw = rawOf(l, false);
      const uid = w.imap.put(shape.sent, raw, l.messageId, true);
      await recordAtSend(w, raw, uid);
      await w.cycle();
      await w.cycle();
      w.imap.put(shape.inbox, rawOf(l, true), l.messageId, false);
      await w.cycle();
      await w.drain();
      await expectInboxInstance(w, l.messageId);
      await expectControls(w, c);
    }]);
  }

  /* A SUBMISSION THAT SPANNED SECONDS: each copy carried its own compile time, the Sent copy
     dated after the delivered one. Still one letter, in every order the copies can reach the store. */
  const DELIVERED = "Thu, 29 Oct 2026 18:54:31 +0000";
  const FILED = "Thu, 29 Oct 2026 18:54:38 +0000";
  for (const shape of [PLAIN, LOCALIZED]) for (const [name, sentFirst, recorded] of [
    ["the Sent copy synced, then the INBOX copy", true, false],
    ["the INBOX copy synced, then the Sent copy", false, false],
    ["the Sent copy recorded at send, then the INBOX copy", true, true],
    ["the INBOX copy synced, then the owed Sent copy filed and recorded late", false, true],
  ] as const) {
    cases.push([`copies dated seven seconds apart are one letter — ${name} — ${shape.name}`, async () => {
      const w = await world(makeDb, shape);
      const c = seedControls(w);
      const l = w.letter("dated-apart");
      const putSent = async () => {
        const raw = rawOf(l, false, FILED);
        const uid = w.imap.put(shape.sent, raw, l.messageId, true);
        if (recorded) await recordAtSend(w, raw, uid);
      };
      const putInbox = () => w.imap.put(shape.inbox, rawOf(l, true, DELIVERED), l.messageId, false);
      if (sentFirst) await putSent(); else putInbox();
      await w.cycle();
      await w.cycle();
      if (sentFirst) putInbox(); else await putSent();
      await w.cycle();
      await w.drain();
      await expectInboxInstance(w, l.messageId);
      await expectControls(w, c);
    }]);
  }

  cases.push(["both copies in one cycle", async () => {
    const w = await world(makeDb, PLAIN);
    const c = seedControls(w);
    const l = w.letter("to-myself");
    w.imap.put(PLAIN.sent, rawOf(l, false), l.messageId, true);
    w.imap.put(PLAIN.inbox, rawOf(l, true), l.messageId, false);
    await w.cycle();
    await w.drain();
    await expectInboxInstance(w, l.messageId);
    await expectControls(w, c);
  }]);

  /* THE MIRROR THAT ALREADY COLLAPSED. The state the old ingest wrote for an INBOX copy that met a
     Sent row: the copy recorded as a second, non-primary instance, the conflict flag raised —
     seeded through the repo's own two writes. The next cycle must repair it with no manual step. */
  for (const shape of [PLAIN, LOCALIZED, LOCALIZED_DOVECOT]) cases.push([`a mirror that already collapsed repairs itself at the next cycle — ${shape.name}`, async () => {
    const w = await world(makeDb, shape);
    const c = seedControls(w);
    const l = w.letter("collapsed");
    w.imap.put(shape.sent, rawOf(l, false), l.messageId, true);
    await w.cycle();
    await w.cycle();
    const [row] = await w.rowsOf(l.messageId);
    const uid = w.imap.put(shape.inbox, rawOf(l, true), l.messageId, false);
    await w.repo.recordInstance(row!.id, { folder: "INBOX", ref: `${w.imap.uidValidityOf(shape.inbox)}:${uid}` });
    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    await w.repo.setFolderConflict(row!.id, {
      desiredFolder: fs!.desiredFolder, observedFolder: fs!.observedFolder, lastSetBy: fs!.lastSetBy as "us",
    });
    const [before] = await w.rowsOf(l.messageId);
    expect(before!.instances, "the premise: the collapsed shape").toEqual(["INBOX", `${canonical(shape, shape.sent)}*`].sort());
    await w.cycle();
    await w.drain();
    await expectInboxInstance(w, l.messageId);
    await expectControls(w, c);
  }]);

  /* THE REPAIR'S EDGE: only a row still desired in Sent re-reads its INBOX copy. A move of ours
     into INBOX in flight (the copy landed, the source not yet expunged) keeps the copy known, or
     every cycle would fetch its body again until the move converged. */
  for (const shape of [PLAIN, LOCALIZED, LOCALIZED_DOVECOT]) cases.push([`the known-set keeps an INBOX copy whose row is moving out of Sent — ${shape.name}`, async () => {
    const w = await world(makeDb, shape);
    const l = w.letter("moving");
    w.imap.put(shape.sent, rawOf(l, false), l.messageId, true);
    await w.cycle();
    const [row] = await w.rowsOf(l.messageId);
    const uid = w.imap.put(shape.inbox, rawOf(l, false), l.messageId, true);
    await w.repo.recordInstance(row!.id, { folder: "INBOX", ref: `${w.imap.uidValidityOf(shape.inbox)}:${uid}` });
    const knowsInbox = async () =>
      (await w.repo.listKnownLocators(w.mailboxId)).some((k) => k.folder === "INBOX" && k.uid === uid);
    expect(await knowsInbox(), "a collapsed row's INBOX copy stayed known — nothing re-reads it").toBe(false);
    await w.repo.upsertFolderState(row!.id, { desiredFolder: "INBOX", observedFolder: canonical(shape, shape.sent), lastSetBy: "us" });
    expect(await knowsInbox(), "a copy our move just made is fetched again every cycle").toBe(true);
  }]);

  /* GMAIL: one message, many homes. `\All` is never read and a label is a customer folder, so
     neither may become a row of its own or take the row out of the Ohbox. Gmail's `\Seen` is one
     flag across every home, so each copy carries the same one. */
  cases.push(["Gmail's All Mail and label copies add no Ohbox row — Sent copy first", async () => {
    const w = await world(makeDb, GMAIL);
    const c = seedControls(w);
    const l = w.letter("to-myself");
    w.imap.put(GMAIL.sent, rawOf(l, false), l.messageId, false);
    w.imap.put(GMAIL.allMail!, rawOf(l, false), l.messageId, false);
    w.imap.put(GMAIL.label!, rawOf(l, false), l.messageId, false);
    await w.cycle();
    await w.cycle();
    w.imap.put(GMAIL.inbox, rawOf(l, false), l.messageId, false);
    await w.cycle();
    await w.drain();
    await expectInboxInstance(w, l.messageId);
    const [r] = await w.rowsOf(l.messageId);
    expect(r!.instances, "All Mail was read, or the label copy was lost").toEqual(["INBOX*", "Work", "[Gmail]/Sent Mail"]);
    expect(w.newForYou().filter((id) => id === r!.id), "one letter, one Ohbox row").toHaveLength(1);
    await expectControls(w, c);
  }]);
  cases.push(["Gmail's All Mail and label copies add no Ohbox row — every copy at once", async () => {
    const w = await world(makeDb, GMAIL);
    const c = seedControls(w);
    const l = w.letter("to-myself");
    for (const p of [GMAIL.inbox, GMAIL.sent, GMAIL.allMail!, GMAIL.label!]) {
      w.imap.put(p, rawOf(l, false), l.messageId, false);
    }
    await w.cycle();
    await w.drain();
    await expectInboxInstance(w, l.messageId);
    const [r] = await w.rowsOf(l.messageId);
    expect(r!.instances, "All Mail was read, or the label copy was lost").toEqual(["INBOX*", "Work", "[Gmail]/Sent Mail"]);
    await expectControls(w, c);
  }]);

  describe(`a letter to yourself reaches the Ohbox — ${store}${order === "reverse" ? " (reverse order)" : ""}`, () => {
    for (const [name, run] of order === "reverse" ? [...cases].reverse() : cases) it(name, run, 30_000);
  });
}
