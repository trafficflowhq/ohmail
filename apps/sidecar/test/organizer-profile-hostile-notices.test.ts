/**
 * THE SETTINGS COPY IN THE MAILBOX IS READ LIKE A LETTER. Whatever can write into the mailbox's
 * settings folder can write the key that carries what a person stated for every install: a
 * program holding the mailbox's password, a delegate, a server-side filter, and where a provider
 * files by a header a stranger's letter. So the key is read member by member, each by its own
 * name, as a word of its closed set with the instant the writer's own form writes, and built new.
 *
 * A copy is planted that puts everything else there: other types, a member reached through a
 * prototype, a wake's address and keys, a sentence, a switch for the pairing notice turned off,
 * titles turned on, numbers out of range, a date far ahead, an instant before 1970. Every member
 * reads as not stated, the copy itself is still read, and nothing stored moves: the account's own
 * statement, the device's choices (its master off, its pairing notice on, its titles hidden), and
 * the wake registrations. Through both ways a copy is taken in: the reader's pass and the
 * organizer's takeover, on a store that states something and on one that states nothing, where
 * the takeover still writes its own copy and keeps its settings. The copies are shared with the
 * twin on real mail servers (`organizer-profile-hostile-notices.imap.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  NOTICE_KINDS, decideNotices, noticeChoicesOf, noticeFields, type NoticeSample,
} from "@ohmail/client-engine";
import {
  accountSettings, accounts, folderState, mailboxProfileMirror, mailboxes, messages, statePreference, tags, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { formatProfileMessage, makeProfileDoc, makeProfileIo, readProfilePreferences } from "@trafficflow/core/adapters/organizer-profile";
import {
  PREFERENCES_ADOPTED_FREELY, adoptProfilePreferences, adoptableProfilePreferences, serializeOrganizerProfile,
} from "@trafficflow/core/adapters/organizer-profile-store";
import {
  ScreenerService, consentSettings, cutlineCounts, effectiveScreeningWindows, materialize, type ServiceContext,
} from "@trafficflow/services/mail";
import { OrganizerProfileSync, forgetMirrorCadence, syncProfileMirror } from "@ohmail/organizer/profile";
import { memoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import {
  BEFORE_1970, FAR_AHEAD, HOSTILE, MARK, NOW, PAYLOAD, PLANTED, SOMEONE_ELSE, STATED_AT, docOf, messageWith, pair,
} from "./_hostile-profile.js";

/** Two clocks may differ by this much before a statement is from the future: the lease's own bound. */
const SKEW_MS = 150_000;

describe("a hostile value under the key states nothing, and the copy is still read", () => {
  it.each(HOSTILE)("%s", (_name, json) => {
    expect(readProfilePreferences(JSON.parse(json))).toEqual({});
    const doc = docOf(messageWith(json, NOW));
    expect("preferences" in doc).toBe(false);
    // The rest of the copy is read as if the key were not there.
    expect({ tagNames: doc.tagNames, screener: doc.screener }).toEqual({ tagNames: PAYLOAD.tagNames, screener: PAYLOAD.screener });
    expect(JSON.stringify(doc)).not.toContain(MARK);
  });

  it("a readable member beside hostile ones is read alone, and built new", () => {
    const json = `{"subject":{"value":"head","at":"${STATED_AT}","note":"${MARK} a letter's words","__proto__":{"polluted":"${MARK}"}},` +
      `"endpoint":"https://collector.example/${MARK}","pairing":false,"__proto__":{"showTitles":true}}`;
    const raw = JSON.parse(json) as unknown;
    const read = readProfilePreferences(raw);
    expect(read).toEqual({ subject: { value: "head", at: STATED_AT } });
    expect(Object.keys(read)).toEqual(["subject"]);
    expect(Object.keys(read.subject!)).toEqual(["value", "at"]);
    expect(read.subject).not.toBe((raw as { subject: unknown }).subject);
    expect(JSON.stringify(docOf(messageWith(json, NOW)).preferences)).toBe(`{"subject":{"value":"head","at":"${STATED_AT}"}}`);
    // Nothing reached a prototype: an empty record still has none of the planted names.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).showTitles).toBeUndefined();
  });

  it("a member, a word or an instant only a real prototype answers for is not read", () => {
    // JSON makes `__proto__` an own member; these inherit for real.
    expect(readProfilePreferences(Object.create({ subject: { value: "each", at: STATED_AT } }) as object)).toEqual({});
    expect(readProfilePreferences({ subject: Object.create({ value: "each", at: STATED_AT }) as object })).toEqual({});
    expect(readProfilePreferences({ subject: Object.create({ value: "each", at: STATED_AT }) as object }, NOW.getTime() + SKEW_MS)).toEqual({});
  });

  it("a statement dated further ahead than two clocks may differ is not taken in", () => {
    const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
    const taken = (iso: string) => adoptableProfilePreferences(docOf(messageWith(pair("each", iso), NOW)), NOW);
    expect(taken(FAR_AHEAD)).toEqual({});
    expect(taken(at(SKEW_MS + 1))).toEqual({});
    expect(taken(at(SKEW_MS))).toEqual({ subject: { value: "each", at: at(SKEW_MS) } });
    expect(taken(at(-86_400_000))).toEqual({ subject: { value: "each", at: at(-86_400_000) } });
    // The same reader, handed the clock: one function says what is stated.
    expect(readProfilePreferences(JSON.parse(pair("each", FAR_AHEAD)), NOW.getTime() + SKEW_MS)).toEqual({});
  });

  it.each(BEFORE_1970)("%s, an instant before 1970, is not stated: not by the parser, not by a taker, not by the writer", (at) => {
    const json = pair("each", at);
    expect(readProfilePreferences(JSON.parse(json))).toEqual({});
    expect(readProfilePreferences(JSON.parse(json), NOW.getTime() + SKEW_MS)).toEqual({});
    expect("preferences" in docOf(messageWith(json, NOW))).toBe(false);
    expect(adoptableProfilePreferences({ preferences: { subject: { value: "each", at } } }, NOW)).toEqual({});
    const written = makeProfileDoc(PAYLOAD, { updatedAt: NOW, producer: { kind: "local", version: "test" }, preferences: { subject: { value: "each", at } } });
    expect("preferences" in written).toBe(false);
  });

  it("the first instant of 1970 is the earliest stated", () => {
    const epoch = "1970-01-01T00:00:00.000Z";
    expect(readProfilePreferences(JSON.parse(pair("each", epoch)))).toEqual({ subject: { value: "each", at: epoch } });
    expect(readProfilePreferences(JSON.parse(pair("each", "1969-12-31T23:59:59.999Z")))).toEqual({});
  });

  it("a member not on the closed list of those taken in with no question is not taken in", async () => {
    expect(PREFERENCES_ADOPTED_FREELY).toEqual(["subject"]);
    const doc = docOf(messageWith(pair("head", STATED_AT), NOW));
    expect(adoptableProfilePreferences(doc, NOW)).toEqual({ subject: { value: "head", at: STATED_AT } });
    expect(adoptableProfilePreferences(doc, NOW, [])).toEqual({});
    // Through the door itself, on a store that holds nothing: off the list, the statement moves nothing; on it, it does.
    const w = await world(false);
    const before = await w.settings();
    expect(await w.inTransaction((tx) => adoptProfilePreferences(tx, { accountId: w.accountId, doc, now: NOW, freely: [] }))).toEqual([]);
    expect(await w.settings()).toEqual(before);
    expect(await w.inTransaction((tx) => adoptProfilePreferences(tx, { accountId: w.accountId, doc, now: NOW }))).toEqual(["subject"]);
    expect(await w.settings()).toMatchObject({ subjectHeading: "head", subjectHeadingAt: new Date(STATED_AT) });
  });
});

const META = "INBOX.ohmail._meta";
const HERE = "this-install";

/**
 * One store with a wake registration and a device's own choices beside it, and its account's settings
 * row: stating "each" of its own, or nothing yet (every account until its first press).
 */
async function world(states: boolean = true) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const born = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(accounts).values({ id: accountId, name: "hostile", createdAt: born });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: born }).returning({ id: mailboxes.id });
  const mailboxId = mb!.id;
  await db.insert(tags).values({ accountId, name: "kiln", createdAt: born, updatedAt: born });
  const inTransaction = <T>(f: (tx: LedgerTx) => Promise<T>): Promise<T> =>
    (db as unknown as { transaction: (g: (tx: LedgerTx) => Promise<T>) => Promise<T> }).transaction(f);
  if (states) await inTransaction((tx) => statePreference(tx, accountId, "subject", "each", new Date(STATED_AT)));
  else await db.insert(accountSettings).values({ accountId, updatedAt: born });
  await db.insert(pushSubscriptions).values({
    accountId, transport: "webpush", endpoint: "https://push.example/the-device-own", p256dh: "own-key", auth: "own-auth", createdAt: born,
  });
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const io = (installId: string) => makeProfileIo(server, (c) => c.replace(/\//g, "."), { installId, mailboxId });
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const log = (event: string, detail: Record<string, unknown>): void => { events.push({ event, detail }); };
  const settings = async () => (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
  const registrations = () => db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId));
  /** Only this copy stands in the folder. */
  const plant = (raw: string): void => {
    const folder = server.tree.get(META)!;
    folder.messages.length = 0;
    server.seed(META, raw);
  };
  /** An organizer of this store taking the mailbox over, its clock at `start`. */
  const organizer = (start: number) => {
    const clock = { at: start };
    const sync = new OrganizerProfileSync({
      db, accountId, mailboxId, flushIntervalMs: 0, now: () => new Date(clock.at),
      adapter: { profileIo: (id: { installId: string; mailboxId: string }) => makeProfileIo(server, (c) => c.replace(/\//g, "."), id) } as unknown as MailboxAdapter,
      self: { installId: HERE, kind: "local" }, producerVersion: "test", log,
    });
    return { sync, ticks: async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { clock.at += 31_000; await sync.onOrganize(); } } };
  };
  return { db, accountId, mailboxId, server, io, events, log, settings, registrations, plant, organizer, inTransaction };
}

const adoptedLines = (events: Array<{ event: string }>): string[] => events.map((e) => e.event).filter((e) => e === "profile_preferences_adopted");

/** Each planted copy through the reader's pass, one store: every pass is written, and nothing stored moves. */
async function readerTakesEachIn(states: boolean): Promise<void> {
  const w = await world(states);
  const before = { settings: await w.settings(), registrations: await w.registrations() };
  expect(before.settings).toMatchObject(states
    ? { subjectHeading: "each", subjectHeadingAt: new Date(STATED_AT) } : { subjectHeading: null, subjectHeadingAt: null });
  let at = NOW.getTime();
  for (const [name, json] of PLANTED) {
    at += 6 * 60_000;
    forgetMirrorCadence();
    w.plant(messageWith(json, new Date(at)));
    const outcome = await syncProfileMirror({ db: w.db, accountId: w.accountId, mailboxId: w.mailboxId, io: w.io(HERE), now: new Date(at), log: w.log });
    expect(outcome.state, name).toBe("written");
    expect(await w.settings(), name).toEqual(before.settings);
    expect(await w.registrations(), name).toEqual(before.registrations);
    const [kept] = await w.db.select({ doc: mailboxProfileMirror.doc }).from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect(JSON.stringify(kept!.doc), name).not.toContain(MARK);
  }
  expect(adoptedLines(w.events)).toEqual([]);
}

/** Each planted copy met by an organizer's takeover, a store each: it writes its own copy, and nothing stored moves. */
async function organizerTakesEachOver(states: boolean): Promise<void> {
  for (const [name, json] of PLANTED) {
    const w = await world(states);
    const before = { settings: await w.settings(), registrations: await w.registrations() };
    w.plant(messageWith(json, new Date(NOW.getTime() - 60_000)));
    const { sync, ticks } = w.organizer(NOW.getTime());
    await ticks(3);
    expect(await w.settings(), name).toEqual(before.settings);
    expect(await w.registrations(), name).toEqual(before.registrations);
    expect(adoptedLines(w.events), name).toEqual([]);
    // The settings are kept: the mailbox's row says nothing of a refusal.
    expect(sync.profileBlock(), name).toBeNull();
    const own = w.server.tree.get(META)!.messages.map((m) => m.raw).filter((raw) => raw.includes(`X-Ohmail-Install-Id: ${HERE}`));
    expect(own.length, `${name}: the organizer wrote its own copy`).toBeGreaterThan(0);
    for (const raw of own) {
      expect(docOf(raw).preferences, name).toEqual(states ? { subject: { value: "each", at: STATED_AT } } : undefined);
      expect(raw, name).not.toContain(MARK);
    }
  }
}

describe("a hostile copy taken in moves nothing that is stored", () => {
  it("the reader's pass: the account's statement, its whole settings row and its wake registrations stand", async () => {
    await readerTakesEachIn(true);
  });

  it("the organizer's takeover: the same, and its own next copy states its own statement", async () => {
    await organizerTakesEachOver(true);
  }, 240_000);
});

describe("a hostile copy taken into a store that states nothing yet moves nothing and stops nothing", () => {
  it("the reader's pass is written, and the whole settings row and the wake registrations stand", async () => {
    await readerTakesEachIn(false);
  });

  it("the organizer's takeover writes its own copy, which states nothing, and keeps its settings", async () => {
    await organizerTakesEachOver(false);
  }, 240_000);
});

/** The store refuses its next update of the settings row once, with `code`: a trigger, whose count no rollback undoes. */
async function refuseSettingsOnce(db: Tx, code: string): Promise<void> {
  const run = (text: string) => (db as unknown as { execute: (q: SQL) => Promise<unknown> }).execute(sql.raw(text));
  await run("CREATE SEQUENCE refuse_settings_once");
  await run(`CREATE FUNCTION refuse_settings_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('refuse_settings_once') = 1 THEN RAISE EXCEPTION 'the store refused the settings row' USING ERRCODE = '${code}'; END IF;
      RETURN NEW;
    END $$`);
  await run("CREATE TRIGGER refuse_settings_once BEFORE UPDATE ON account_settings FOR EACH ROW EXECUTE FUNCTION refuse_settings_once()");
}

describe("a statement the store fails to take in once", () => {
  const LATER = "2026-11-10T08:30:00.000Z";

  /** A store that states "each", and in its folder another install's copy that says what it says and states "head" later. */
  async function found(code: string) {
    const w = await world(true);
    const doc = makeProfileDoc(await serializeOrganizerProfile(w.db, w.accountId, w.mailboxId), {
      updatedAt: new Date(NOW.getTime() - 60_000), producer: { kind: "local", version: "test" },
      preferences: { subject: { value: "head", at: LATER } },
    });
    const raw = formatProfileMessage(doc, { installId: SOMEONE_ELSE });
    w.plant(raw);
    await refuseSettingsOnce(w.db, code);
    const copies = (): string[] => w.server.tree.get(META)!.messages.map((m) => m.raw);
    const own = (): string[] => copies().filter((m) => m.includes(`X-Ohmail-Install-Id: ${HERE}`));
    return { w, raw, copies, own };
  }

  it("a value it refuses (22008) is not taken: said by name only, its own copy written, its settings kept, the row standing", async () => {
    const { w, own } = await found("22008");
    const before = await w.settings();
    const { sync, ticks } = w.organizer(NOW.getTime());
    await ticks(1);
    const said = w.events.filter((e) => e.event === "profile_preferences_not_taken").map((e) => e.detail);
    expect(said).toEqual([{ mailboxId: w.mailboxId, accountId: w.accountId, members: ["subject"] }]);
    expect(sync.profileBlock()).toBeNull();
    expect(own().length, "the organizer wrote its own copy").toBeGreaterThan(0);
    expect(docOf(own().at(-1)!).preferences).toEqual({ subject: { value: "each", at: STATED_AT } });
    expect(await w.settings()).toEqual(before);
  });

  it("a failure that passes (a connection, 08006) writes no copy over the found one, and the next tick takes the statement in", async () => {
    const { w, raw, copies, own } = await found("08006");
    const { ticks } = w.organizer(NOW.getTime());
    await ticks(1);
    expect(own(), "no copy of its own was written").toEqual([]);
    expect(copies(), "the found copy stands").toEqual([raw]);
    expect(w.events.map((e) => e.event)).not.toContain("profile_preferences_not_taken");
    await ticks(1);
    expect(await w.settings()).toMatchObject({ subjectHeading: "head", subjectHeadingAt: new Date(LATER) });
    expect(docOf(own().at(-1)!).preferences).toEqual({ subject: { value: "head", at: LATER } });
  });
});

describe("a window planted in the copy is no cutoff of the Screener", () => {
  const GATE = "ohmail/Screener";
  const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
  const RECENT = "recent@sender.test";
  const OLD = "only-old-letters@sender.test";
  /** The latest instant a date holds; no store holds a year past 9999. */
  const LATEST = "+275760-09-13T00:00:00.000Z";
  const windowOf = (baselineAt: string | null) => ({ baselineAt, dormancyDays: 30, scope: "window" as const });

  /**
   * A store that reads the mailbox, its own window stated, with a recent unread sender at the gate and one
   * whose letters there are read and old; the reader's pass over a copy stating `screening`, then the
   * Screener's queue and its count.
   */
  async function reading() {
    const w = await world(true);
    await w.db.update(mailboxes).set({ organizerRole: "reader", organizedByKind: "local", organizedByName: "Studio Mac" })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.db.update(accountSettings).set({ screeningBaselineAt: daysAgo(40), dormancyDays: 7, screeningScope: "window" })
      .where(eq(accountSettings.accountId, w.accountId));
    for (const [i, [from, at, unread]] of ([[RECENT, daysAgo(2), true], [OLD, daysAgo(150), false]] as const).entries()) {
      const [m] = await w.db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `window:${randomUUID()}`, subject: `Note ${i}`,
        snippet: "", fromAddress: from, date: at, arrivedAt: at, createdAt: at, unread, nativeLocator: { folder: GATE, ref: `1:${i}` },
      }).returning();
      await w.db.insert(folderState).values({
        messageId: m!.id, accountId: w.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
    }
    const ctx: ServiceContext = { db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null, now: () => NOW, requestId: "hostile-window" };
    const read = async (screening: ReturnType<typeof windowOf>) => {
      forgetMirrorCadence();
      w.plant(formatProfileMessage(makeProfileDoc(PAYLOAD, {
        updatedAt: daysAgo(0), producer: { kind: "local", version: "test" }, preferences: {}, screening,
      }), { installId: SOMEONE_ELSE }));
      return (await syncProfileMirror({ db: w.db, accountId: w.accountId, mailboxId: w.mailboxId, io: w.io(HERE), now: NOW, log: w.log })).state;
    };
    const queue = async () => {
      const page = await new ScreenerService({}).list(ctx, { limit: 50 });
      const counts = await cutlineCounts(ctx, { windows: await effectiveScreeningWindows(ctx) });
      return { senders: page.items.map((i) => i.sender.address).sort(), total: page.total, counted: counts.activeUndecidedSenders };
    };
    const source = async () => (await effectiveScreeningWindows(ctx)).get(w.mailboxId);
    return { w, read, queue, source };
  }

  it("CONTROL: the window the organizer states in its copy is the cutoff, and the old read sender is retired", async () => {
    const r = await reading();
    expect(await r.read(windowOf(daysAgo(1).toISOString()))).toBe("written");
    expect(await r.source()).toMatchObject({ source: "organizer", baselineAt: daysAgo(1).toISOString(), dormancyDays: 30 });
    expect(await r.queue()).toEqual({ senders: [RECENT], total: 1, counted: 1 });
  });

  it.each([...BEFORE_1970, FAR_AHEAD, LATEST])("a baseline of %s is no cutoff: the queue and its count run over the folder whole, and the account's own window stands", async (at) => {
    const r = await reading();
    const before = await r.w.settings();
    expect(await r.read(windowOf(at))).toBe("written");
    expect(await r.queue()).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
    expect(await r.source()).toMatchObject({ source: "unstated", baselineAt: null });
    expect(await r.w.settings()).toEqual(before);
    // The parser keeps no window dated before 1970; a later one it keeps, and the read that has a clock refuses it.
    const [kept] = await r.w.db.select({ doc: mailboxProfileMirror.doc }).from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, r.w.mailboxId));
    expect((kept!.doc as { screening?: unknown }).screening).toEqual(Date.parse(at) < 0 ? undefined : windowOf(at));
  });

  it("a window an earlier build kept in the mirror, dated before year 1, is no cutoff either", async () => {
    const r = await reading();
    expect(await r.read(windowOf(daysAgo(1).toISOString()))).toBe("written");
    const [kept] = await r.w.db.select({ doc: mailboxProfileMirror.doc }).from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, r.w.mailboxId));
    await r.w.db.update(mailboxProfileMirror).set({ doc: { ...(kept!.doc as object), screening: windowOf(BEFORE_1970[0]) } })
      .where(eq(mailboxProfileMirror.mailboxId, r.w.mailboxId));
    expect(await r.queue()).toEqual({ senders: [OLD, RECENT], total: 2, counted: 2 });
    expect(await r.source()).toMatchObject({ source: "unstated", baselineAt: null });
  });
});

describe("what this device rings and shows stays its own", () => {
  /** The device's two stored records: the master off, the pairing notice on, titles hidden. */
  const MAIL = { master: false, ohbox: true, screener: true, scheduled: true, pairing: true };
  const CALENDAR = { cal_alert: false, cal_invitation: true, cal_change: true, cal_answer: false, cal_found: false, cal_summary: false, showTitles: false, widgetTitles: false };
  const WHERE = { ohcalPhone: false };
  const quiet: NoticeSample = { ohboxUnread: 0, screenerWaiting: 0, sends: new Map(), devices: 1 };
  const busy: NoticeSample = { ohboxUnread: 2, screenerWaiting: 1, sends: new Map(), devices: 2 };

  it("a copy that turns the pairing notice off and titles on changes no choice and draws no word of its own", async () => {
    const w = await world();
    const ctx: ServiceContext = { db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null, now: () => NOW, requestId: "hostile" };
    /* THE ONLY WAYS THE PROFILE REACHES A DEVICE: the feed's settings record and the consent read, both
       read from the store. Each is read before the copy and again after both takers took it in. */
    const reach = async () => ({
      record: await materialize(w.db as unknown as Parameters<typeof materialize>[0], w.accountId, "settings", w.accountId),
      consent: await consentSettings(ctx),
    });
    const before = await reach();
    expect(before.consent).toMatchObject({ subjectHeading: "each" });
    w.plant(messageWith(HOSTILE[HOSTILE.length - 1]![1], NOW));
    forgetMirrorCadence();
    expect((await syncProfileMirror({ db: w.db, accountId: w.accountId, mailboxId: w.mailboxId, io: w.io(HERE), now: NOW, log: w.log })).state).toBe("written");
    await w.organizer(NOW.getTime()).ticks(3);
    const after = await reach();
    expect(after.record).toStrictEqual(before.record);
    expect(after.consent).toStrictEqual(before.consent);
    // The device's records are its own, and the gate reads them alone.
    const choices = noticeChoicesOf(MAIL, CALENDAR, WHERE);
    expect(choices).toMatchObject({ master: false, pairing: true, showTitles: false });
    expect(decideNotices(quiet, busy, choices, "granted", NOTICE_KINDS)).toEqual([]);
    // With the master on, by the person on this device: the pairing notice still rings, and no notice carries a planted word.
    const on = noticeChoicesOf({ ...MAIL, master: true }, CALENDAR, WHERE);
    const notices = decideNotices(quiet, busy, on, "granted", NOTICE_KINDS);
    expect(notices.map((n) => n.kind)).toContain("pairing");
    const drawn = notices.map((n) => noticeFields(n, {
      title: (facts) => `title ${JSON.stringify(facts)}`, body: (facts) => `body ${JSON.stringify(facts)}`, label: (as) => `label ${as}`,
    }));
    expect(JSON.stringify([notices, drawn]).toLowerCase()).not.toContain(MARK);
  });
});
