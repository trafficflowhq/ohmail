import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, latestProfileFoundMarker, mailboxes, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  SUBJECT_HEADINGS, formatProfileMessage, isMalformedProfile, makeProfileDoc, makeProfileIo, parseProfileMessage,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ParsedProfileMessage, type ProfilePreferences,
} from "@trafficflow/core/adapters/organizer-profile";
import { readStatedPreferences, serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { setSubjectHeading, type ServiceContext } from "@trafficflow/services/mail";
import { OrganizerProfileSync, syncProfileMirror } from "@ohmail/organizer/profile";
import type { OrganizerWriteAuthority } from "@ohmail/organizer/lease";
import { memoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";

/**
 * WHAT A PERSON STATES ONCE FOR EVERY INSTALL GOES ROUND THROUGH EVERY WRITER AND EVERY READER OF
 * THE SETTINGS COPY, AND COMES BACK THE SAME: the word and the instant of the press.
 *
 * Three stores share one mailbox folder. The first states a word through the real door and
 * organizes; its copy is written by the flush, rewritten by the one re-encode of a plain copy, and
 * written a last time before the mailbox is handed back. The second only reads the mailbox. The
 * third takes the mailbox over. Then a copy that states nothing arrives, as an organizer that does
 * not know the key writes it, and a copy with an earlier statement: neither changes what a store
 * holds, and the store that organizes states the pair again.
 *
 * The table is typed over the members a copy can carry, so a new member has no row here until it
 * is walked.
 */
type Member = keyof Required<ProfilePreferences>;
type Stated = { value: string; at: string };
const MEMBERS: { [M in Member]: { words: readonly string[]; press: (ctx: ServiceContext, word: string) => Promise<Stated> } } = {
  subject: {
    words: SUBJECT_HEADINGS,
    press: async (ctx, word) => {
      const stored = await setSubjectHeading(ctx, word);
      return { value: stored.subjectHeading, at: stored.subjectHeadingAt };
    },
  },
};
const WALKS = (Object.keys(MEMBERS) as Member[]).flatMap((member) =>
  MEMBERS[member].words.map((word, i, all) => ({ member, word, other: all[(i + 1) % all.length]! })));

const META = "INBOX.ohmail._meta";
const HELD: OrganizerWriteAuthority = { noLease: "not_supplied" } as OrganizerWriteAuthority;
const INTERVAL_MS = 5 * 60_000;

/** The plain form builds before the escapes wrote, and a server that stores other bytes hands back. */
function plainOf(raw: string): string {
  const doc = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as unknown;
  return `${raw.slice(0, raw.indexOf("{"))}${JSON.stringify(doc, null, 2)}\r\n`;
}

async function world() {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const clock = { at: new Date("2026-11-01T12:00:00.000Z") };
  const pass = (ms: number): void => { clock.at = new Date(clock.at.getTime() + ms); };
  const folder = () => server.tree.get(META)!;

  /** One install's own store on the shared mailbox, with the same one decision in each. */
  const store = async (installId: string) => {
    const db = (await makeTestDb()) as unknown as Tx;
    const accountId = randomUUID();
    const born = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(accounts).values({ id: accountId, name: installId, createdAt: born });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "shared@round-trip.example", createdAt: born })
      .returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    await db.insert(tags).values({ accountId, name: "kiln", createdAt: born, updatedAt: born });
    const events: string[] = [];
    const log = (event: string, detail: Record<string, unknown>): void => { events.push(`${event}${typeof detail.by === "string" ? `:${detail.by}` : ""}`); };
    const io = () => makeProfileIo(server, (c) => c.replace(/\//g, "."), { installId, mailboxId });
    const attach = (): OrganizerProfileSync => new OrganizerProfileSync({
      db, accountId, mailboxId, flushIntervalMs: INTERVAL_MS, now: () => clock.at,
      adapter: { profileIo: () => io() } as unknown as MailboxAdapter,
      self: { installId, kind: "local" }, producerVersion: "test", log,
    });
    const s = { sync: attach() };
    const ctx: ServiceContext = { db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => clock.at, requestId: "r" };
    return {
      installId, db, accountId, mailboxId, ctx, events,
      sync: () => s.sync,
      /** A new attachment of the same store: what a restart, or a mailbox taken back, starts from. */
      restart: (): void => { s.sync = attach(); },
      /** One pass of the organizer, a whole interval after the last. */
      tick: async (): Promise<void> => { pass(INTERVAL_MS + 60_000); await s.sync.onOrganize(); },
      /** One pass of an install that only reads the mailbox, a whole cadence after the last. */
      read: async () => {
        pass(INTERVAL_MS + 60_000);
        return syncProfileMirror({ db, accountId, mailboxId, io: io(), now: clock.at, log });
      },
      held: () => readStatedPreferences(db, accountId),
      rings: async (): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog)
        .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")))).length,
      asked: async (): Promise<boolean> => (await latestProfileFoundMarker(db, accountId, mailboxId))?.heldForImport === true,
      payload: () => serializeOrganizerProfile(db, accountId, mailboxId),
    };
  };

  const copies = (): Array<{ by: string | null; doc: OrganizerProfileDoc; encoded: boolean; uid: number }> =>
    folder().messages.map((m) => ({ parsed: parseProfileMessage(m.raw, m.uid), uid: m.uid }))
      .filter((x): x is { parsed: ParsedProfileMessage; uid: number } => x.parsed !== null && !isMalformedProfile(x.parsed) && x.parsed.status === "ok")
      .map((x) => ({ by: x.parsed.installId, doc: x.parsed.doc!, encoded: x.parsed.encoded === true, uid: x.uid }))
      .sort((a, b) => Date.parse(a.doc.updatedAt) - Date.parse(b.doc.updatedAt));
  const newestBy = (installId: string) => copies().filter((c) => c.by === installId).at(-1);
  /** A copy as another install would leave it: this payload, and exactly these statements. */
  const leave = (by: string, payload: OrganizerProfilePayload, preferences: ProfilePreferences): void => {
    pass(1_000);
    const doc = makeProfileDoc(payload, { updatedAt: clock.at, producer: { kind: "local", version: "test" }, preferences });
    server.seed(META, formatProfileMessage(doc, { installId: by }));
  };
  return { server, clock, pass, folder, store, copies, newestBy, leave };
}

describe.each(WALKS)("$member stated as $word, through every writer and reader of the settings copy", ({ member, word, other }) => {
  it("comes back the same: the word and the instant of the press", async () => {
    const w = await world();
    const first = await w.store("first-install");

    // THE FLUSH. A copy exists and states nothing; the press alone, with nothing else changed, is what writes again.
    await first.tick();
    const before = w.newestBy("first-install")!;
    expect(before.doc.preferences, "nothing stated writes no key").toBeUndefined();
    await first.tick();
    expect(w.newestBy("first-install")!.doc.updatedAt, "nothing changed: nothing is written").toBe(before.doc.updatedAt);
    w.pass(1_000);
    const pressed = await MEMBERS[member].press(first.ctx, word);
    expect(pressed).toEqual({ value: word, at: w.clock.at.toISOString() });
    await first.tick();
    expect(w.newestBy("first-install")!.doc.preferences, "the flush states the store's pair").toEqual({ [member]: pressed });
    expect(w.newestBy("first-install")!.doc.updatedAt).not.toBe(before.doc.updatedAt);
    expect(await first.held()).toEqual({ [member]: pressed });

    // THE RE-ENCODE. The server hands the copy back in the plain form; the holder's one rewrite still states the pair.
    const stored = w.folder().messages.find((m) => m.uid === w.newestBy("first-install")!.uid)!;
    stored.raw = plainOf(stored.raw);
    expect(w.newestBy("first-install")!.encoded).toBe(false);
    await first.tick();
    expect(first.events, "the plain copy was rewritten").toContain("profile_reencoded");
    expect(w.newestBy("first-install")!.encoded).toBe(true);
    expect(w.newestBy("first-install")!.doc.preferences, "the rewrite states the store's pair").toEqual({ [member]: pressed });

    // THE HAND-BACK. A change of mind inside the interval, and nothing else, reaches the mailbox before the claim leaves.
    w.pass(1_000);
    const changed = await MEMBERS[member].press(first.ctx, other);
    expect(await first.sync().flushBeforeLeaving(HELD)).toBe("saved");
    const last = w.newestBy("first-install")!;
    expect(last.doc.preferences, "the last write before the hand-back states the later pair").toEqual({ [member]: changed });
    expect(await first.sync().flushBeforeLeaving(HELD), "nothing new: no second write").toBe("saved");
    expect(w.newestBy("first-install")!.doc.updatedAt).toBe(last.doc.updatedAt);

    // THE READER. An install that only reads takes the pair into its own row, with the instant of the press.
    const reader = await w.store("reader-install");
    expect((await reader.read()).state).toBe("written");
    expect(await reader.held(), "the reader holds the pair as stated").toEqual({ [member]: changed });
    expect(await reader.rings(), "the reader's settings record rang once").toBe(1);
    expect(reader.events).toContain("profile_preferences_adopted:reader");
    // The same copy read again: nothing moves and nothing rings.
    expect((await reader.read()).state).toBe("written");
    expect(await reader.held()).toEqual({ [member]: changed });
    expect(await reader.rings()).toBe(1);

    // THE TAKEOVER. An install that says the same takes the mailbox over: no question, the pair in its row, and in its own copy.
    const next = await w.store("next-install");
    await next.tick();
    expect(await next.asked(), "a copy that differs only in what it states asks nothing").toBe(false);
    expect(await next.held(), "the next organizer holds the pair as stated").toEqual({ [member]: changed });
    expect(next.events).toContain("profile_preferences_adopted:organizer");
    expect(w.newestBy("next-install")!.doc.preferences, "its own copy states the pair with the first instant").toEqual({ [member]: changed });

    // A COPY THAT STATES NOTHING, as an organizer that does not know the key writes it: nothing is cleared anywhere.
    w.leave("an-older-ohmail", await next.payload(), {});
    expect("preferences" in w.copies().at(-1)!.doc).toBe(false);
    expect((await reader.read()).state).toBe("written");
    expect(await reader.held(), "absent is not stated: the reader's row stands").toEqual({ [member]: changed });
    expect(await reader.rings()).toBe(1);
    // The mailbox comes back to the install that held the statement, its runtime kept: it stands, and is stated again.
    next.sync().forgetOrganizerLife();
    await next.tick();
    expect(await next.held(), "absent is not stated: the organizer's row stands").toEqual({ [member]: changed });
    expect(w.newestBy("next-install")!.doc.preferences, "the pair is stated again, with its first instant").toEqual({ [member]: changed });
    expect(Date.parse(w.newestBy("next-install")!.doc.updatedAt)).toBeGreaterThan(Date.parse(w.copies().find((c) => c.by === "an-older-ohmail")?.doc.updatedAt ?? "1970-01-01T00:00:00.000Z"));

    // AN EARLIER STATEMENT, met again in a later copy, takes nothing back.
    w.leave("a-stale-install", await next.payload(), { [member]: pressed });
    expect((await reader.read()).state).toBe("written");
    expect(await reader.held(), "an earlier statement never replaces a later one (reader)").toEqual({ [member]: changed });
    next.restart();
    await next.tick();
    expect(await next.held(), "an earlier statement never replaces a later one (organizer)").toEqual({ [member]: changed });
    expect(w.newestBy("next-install")!.doc.preferences).toEqual({ [member]: changed });

    // A LATER STATEMENT from elsewhere is taken, by both.
    w.pass(1_000);
    const elsewhere: Stated = { value: word, at: w.clock.at.toISOString() };
    w.leave("another-install", await next.payload(), { [member]: elsewhere });
    expect((await reader.read()).state).toBe("written");
    expect(await reader.held()).toEqual({ [member]: elsewhere });
    expect(await reader.rings()).toBe(2);
    next.restart();
    await next.tick();
    expect(await next.held()).toEqual({ [member]: elsewhere });
    expect(w.newestBy("next-install")!.doc.preferences).toEqual({ [member]: elsewhere });
  }, 120_000);
});

/**
 * AN ORGANIZER THAT KEEPS ITS ORGANIZING LIFE (no hand-over it saw: the hosted worker, or an install that
 * won an overlap) meets another install's copy that says what its store says. It takes that copy's
 * statement in as every taker does, and writes when the copy states other than its row: a copy that
 * states nothing is stated again, and two such organizers end on the later statement and stop writing.
 */
describe.each(WALKS)("$member stated as $word, at an organizer that is never handed over", ({ member, word, other }) => {
  const writes = (s: { events: string[] }): number => s.events.filter((e) => e === "organizer_profile_written").length;

  it("a copy that states nothing, saying what the store says, is stated again", async () => {
    const w = await world();
    const held = await w.store("held-install");
    await held.tick();
    w.pass(1_000);
    const pressed = await MEMBERS[member].press(held.ctx, word);
    await held.tick();
    expect(w.newestBy("held-install")!.doc.preferences).toEqual({ [member]: pressed });
    // An organizer that does not know the key writes in between; this one saw no hand-over.
    w.leave("an-older-ohmail", await held.payload(), {});
    expect(w.copies().at(-1)!.by).toBe("an-older-ohmail");
    // The look that opens the dirty check, the write's own tidy of this store's older copy beside the newest, the write.
    for (let i = 0; i < 3; i++) await held.tick();
    expect(w.copies().at(-1)!.by, held.events.join(",")).toBe("held-install");
    expect(w.newestBy("held-install")!.doc.preferences, "stated again, with the instant of the press").toEqual({ [member]: pressed });
    expect(await held.held()).toEqual({ [member]: pressed });
    expect(await held.asked(), "a copy that differs only in what it states asks nothing").toBe(false);
  }, 120_000);

  it("two organizers that state different pairs end on the later one, and do not write in turns", async () => {
    const w = await world();
    const a = await w.store("install-a");
    const b = await w.store("install-b");
    w.pass(1_000);
    const earlier = await MEMBERS[member].press(a.ctx, word);
    w.pass(1_000);
    const later = await MEMBERS[member].press(b.ctx, other);
    // Ten turns, each organizer in turn, every one a whole interval after the last.
    const perTurn: number[] = [];
    for (let turn = 0; turn < 10; turn++) {
      const s = turn % 2 === 0 ? a : b;
      const was = writes(a) + writes(b);
      await s.tick();
      perTurn.push(writes(a) + writes(b) - was);
    }
    expect(earlier.at < later.at).toBe(true);
    expect(await a.held(), "the earlier organizer took the later statement").toEqual({ [member]: later });
    expect(await b.held()).toEqual({ [member]: later });
    expect(w.copies().at(-1)!.doc.preferences, "the newest copy states it").toEqual({ [member]: later });
    // One copy each, and one more from the organizer that took the later statement in: then nothing.
    expect(perTurn.reduce((n, x) => n + x, 0), perTurn.join(",")).toBeLessThanOrEqual(3);
    expect(perTurn.slice(5), perTurn.join(",")).toEqual([0, 0, 0, 0, 0]);
    expect(await a.asked()).toBe(false);
    expect(await b.asked()).toBe(false);
  }, 120_000);
});
