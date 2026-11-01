import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, contacts, fencedAccountWrite, latestProfileFoundMarker, lockAccountRuleKeys, mailboxes, recordImportAsk,
  auditLog, recordProfileImportResolution, tags, type LedgerTx, type Tx,
} from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ParsedProfileMessage, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { OrganizerProfileSync, serializeOrganizerProfile, writtenByABuildThatRecordsNothing } from "../src/profile.js";
import type { OrganizerWriteAuthority } from "../src/lease.js";

/**
 * A NEW ORGANIZER PUBLISHES ITS OWN SETTINGS BESIDE THE ONE IT ASKS ABOUT. Taking over a mailbox
 * whose settings another install left, the organizer holds that document for the person's answer
 * and writes its own beside it; the question stays open across that write (routing and the hold
 * both), a decline keeps both, and an answer lets the new document replace the old. Before, nothing
 * of the new organizer's reached the mailbox until the person answered.
 */

class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  private uid = 1;
  private lists = 0;
  /** A document that lands on the folder's Nth listing, between a read and the write after it. */
  landOn: { n: number; raw: string } | null = null;
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    this.lists += 1;
    if (this.landOn?.n === this.lists) await this.appendProfile(this.landOn.raw);
    return this.messages.map((m) => ({ ...m, generation: 1 }));
  }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.uid++, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { this.messages = this.messages.filter((m) => !refs.includes(m.ref)); }
  writers(): string[] { return this.messages.map((m) => /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim() ?? "?").sort(); }
  copies(): Array<{ by: string | null; screener: number; rules: number; tags: string[] }> {
    return this.messages.map((m) => parseProfileMessage(m.raw, m.ref))
      .filter((p): p is ParsedProfileMessage => p !== null && !isMalformedProfile(p))
      .map((p) => ({ by: p.installId, screener: p.doc!.screener.length, rules: p.doc!.rules.length, tags: [...p.doc!.tagNames].sort() }));
  }
  parsed(): ParsedProfileMessage[] {
    return this.messages.map((m) => parseProfileMessage(m.raw, m.ref))
      .filter((p): p is ParsedProfileMessage => p !== null && !isMalformedProfile(p));
  }
  holds(doc: OrganizerProfileDoc): boolean { return this.parsed().some((p) => profileFingerprint(p.doc!) === profileFingerprint(doc)); }
  /** The newest copy under an install id. */
  docBy(installId: string): OrganizerProfileDoc {
    return this.parsed().filter((p) => p.installId === installId)
      .sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt))[0]!.doc!;
  }
  tagsOf(installId: string): string[][] {
    return this.parsed().filter((p) => p.installId === installId).map((p) => [...p.doc!.tagNames].sort());
  }
  /** The copy a reader takes: the newest by its write stamp. */
  newest(): { by: string | null; screener: number; rules: number; tags: string[] } | null {
    const all = this.messages.map((m) => parseProfileMessage(m.raw, m.ref))
      .filter((p): p is ParsedProfileMessage => p !== null && !isMalformedProfile(p))
      .sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt));
    const p = all[0];
    return p === undefined ? null
      : { by: p.installId, screener: p.doc!.screener.length, rules: p.doc!.rules.length, tags: [...p.doc!.tagNames].sort() };
  }
}

const THEIRS = makeProfileDoc({
  screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date("2026-09-10T08:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
const THEIRS_RAW = formatProfileMessage(THEIRS, { installId: "w-old" });

/** The store's database refusing every insert while `refuse()` says so, inside its transactions too. */
function refusingInserts(db: Tx, refuse: () => boolean): Tx {
  const wrap = <T extends object>(handle: T): T => new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === "insert" && refuse()) return () => { throw new Error("the database refused the insert"); };
      if (prop === "transaction") {
        const open = Reflect.get(target, prop, receiver) as (cb: (t: object) => unknown, ...rest: unknown[]) => unknown;
        return (cb: (t: object) => unknown, ...rest: unknown[]) => open.call(target, (t: object) => cb(wrap(t)), ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return wrap(db);
}

/**
 * `by` writes the planted document (another install by default); `rowAt` dates this store's rows;
 * `refusing` makes the organizers' database refuse inserts while it says so.
 */
async function rig(o: {
  planted: boolean; theirs?: OrganizerProfileDoc; by?: string; rowAt?: Date; baseline?: true; flushIntervalMs?: number; version?: string;
  refusing?: () => boolean;
}) {
  const theirs = o.theirs ?? THEIRS;
  const rowAt = o.rowAt ?? new Date("2026-01-01T00:00:00.000Z");
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "beside", createdAt: rowAt });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: rowAt })
    .returning({ id: mailboxes.id });
  if (o.baseline) await db.insert(accountSettings).values({ accountId, updatedAt: rowAt, screeningBaselineAt: rowAt, dormancyDays: 30 });
  const folder = new Folder();
  if (o.planted) await folder.appendProfile(formatProfileMessage(theirs, { installId: o.by ?? "w-old" }));
  const clock = { at: new Date("2026-09-28T12:00:00.000Z") };
  const organizer = (installId: string, at: { accountId: string; mailboxId: string }): OrganizerProfileSync => new OrganizerProfileSync({
    db: o.refusing === undefined ? db : refusingInserts(db, o.refusing), ...at, adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId, kind: "local" }, producerVersion: o.version ?? "test", flushIntervalMs: o.flushIntervalMs ?? 0,
    now: () => clock.at,
  });
  /** One attachment's sync; a second call is the same install after a restart. */
  const attach = (): OrganizerProfileSync => organizer("w-new", { accountId, mailboxId: mb!.id });
  /** Another organizer of this folder, its store made now: an install id's next store, or another install. */
  const store = async (installId: string) => {
    const next = { accountId: randomUUID(), mailboxId: "" };
    await db.insert(accounts).values({ id: next.accountId, name: "next", createdAt: clock.at });
    const [row] = await db.insert(mailboxes).values({ accountId: next.accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: clock.at })
      .returning({ id: mailboxes.id });
    next.mailboxId = row!.id;
    return { ...next, sync: organizer(installId, next) };
  };
  const sync = attach();
  const later = (ms: number): void => { clock.at = new Date(clock.at.getTime() + ms); };
  // Dated by the rig's clock, as a store's rows are by the clock its organizer reads.
  const decide = (name: string) => db.insert(tags).values({ accountId, name, createdAt: clock.at, updatedAt: clock.at });
  const answer = (decision: "declined" | "replaced") => recordProfileImportResolution(db, {
    accountId, mailboxId: mb!.id, decision, fingerprint: profileFingerprint(theirs),
  });
  const ticks = async (n: number, s = sync): Promise<void> => {
    for (let i = 0; i < n; i++) { later(31_000); await s.onOrganize(); }
  };
  const routing = async (s = sync): Promise<string> => (await s.importHoldNow())?.kind ?? "closed";
  /** Import pressed where the store is, not handed to the organizer. */
  const importInline = (doc: OrganizerProfileDoc) => fencedAccountWrite(db, { accountId }, async (tx) => {
    await lockAccountRuleKeys(tx as Tx, accountId);
    await applyOrganizerProfile(tx as LedgerTx, { accountId, mailboxId: mb!.id, doc, fingerprint: profileFingerprint(doc), now: clock.at });
  });
  return { db, sync, folder, decide, answer, later, attach, store, ticks, routing, importInline, clock, accountId, mailboxId: mb!.id };
}

describe("the takeover's own settings reach the mailbox beside the held document", () => {
  it("the first tick holds theirs, writes ours beside it, and the question stays open", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers()).toEqual(["w-new", "w-old"]);
    expect(r.folder.messages.find((m) => m.raw.includes("w-old"))?.raw, "the held document changed").toBe(THEIRS_RAW);
    expect({ hold: r.sync.importDecisionOpen(), routing: (await r.sync.importHoldNow())?.kind ?? "closed" })
      .toEqual({ hold: true, routing: "document" });

    // The next ticks find the held record by its locator: the hold stands, nothing is pruned.
    await r.decide("more");
    await r.sync.onOrganize();
    await r.sync.onOrganize();
    expect(r.folder.writers()).toEqual(["w-new", "w-old"]);
    expect(r.sync.importDecisionOpen()).toBe(true);
  });

  it("a document that lands after the seed is held and ours is written beside it in the same tick", async () => {
    const r = await rig({ planted: false });
    await r.sync.onOrganize(); // seed: nothing there, an empty store writes nothing
    await r.folder.appendProfile(THEIRS_RAW);
    await r.decide("mine");
    await r.sync.onOrganize();
    expect({ writers: r.folder.writers(), hold: r.sync.importDecisionOpen() })
      .toEqual({ writers: ["w-new", "w-old"], hold: true });
  });

  it("\"Not now\" keeps both; a replace lets ours stand alone", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    await r.answer("declined");
    for (let i = 0; i < 3; i++) await r.sync.onOrganize();
    expect(r.folder.writers(), "a decline pruned the other install's settings").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    // Released, the old document is ordinary residue: the tidy removes it on its own spacing.
    for (let i = 0; i < 3; i++) { r.later(31_000); await r.sync.onOrganize(); }
    expect(r.sync.importDecisionOpen()).toBe(false);
    expect(r.folder.writers()).toEqual(["w-new"]);
  });

  /* THE RELEASE OWES A TIDY AT ONCE. Answered, the other install's document is residue beside
     ours; without the release asking for a tidy it waited out the tidy's spacing (30 s) in the
     mailbox. The clock does not move here, so only the release can be what removes it. To watch
     it fail: drop the `tidyOwed` line from `commitNextHold`. */
  it("an answer's release lets the next tick remove the other install's document, with no wait", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    await r.sync.onOrganize(); // the release
    await r.sync.onOrganize(); // the tidy it owes
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });

  /* AN ANSWERED DOCUMENT GOES WHATEVER ITS AGE. Written a minute before ours, the other install's
     document is too fresh for the tidy's ten-minute rule, and a replace wrote nothing new of ours:
     the answer is the only thing that can remove it. To watch it fail: drop `released` from the
     tidy call in `onOrganize`. */
  it("a replace removes the other install's document written a minute before ours", async () => {
    const fresh = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
      tagNames: ["fresh"], signature: null,
    },
      { updatedAt: new Date("2026-09-28T11:59:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
    const r = await rig({ planted: true, theirs: fresh });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    for (let i = 0; i < 3; i++) { r.later(31_000); await r.sync.onOrganize(); }
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });

  /* THE RESTART SHAPE. Our own document is the folder's newest now, and the held one sits beside
     it: the seed and the preflight re-arm the question from the durable marker, which names it,
     rather than reading our own document as the answer and lapsing it. To watch it fail: drop
     `markerQuestion` from the preflight and the seed in `profile.ts`. */
  it("a restart while the question stands re-arms it, keeps the held document and keeps the question open", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    const again = r.attach();
    await again.armHoldFromFolder();
    for (let i = 0; i < 3; i++) { r.later(31_000); await again.onOrganize(); }
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      hold: again.importDecisionOpen(),
      routing: (await again.importHoldNow())?.kind ?? "closed",
      writers: r.folder.writers(),
      held: r.folder.messages.find((m) => m.raw.includes("w-old"))?.raw === THEIRS_RAW,
      marker: marker === null ? null : [marker.state, marker.heldForImport],
    }).toEqual({ hold: true, routing: "document", writers: ["w-new", "w-old"], held: true, marker: ["found", true] });
  });

  it("the held document removed by hand lapses the question on the next tick", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    r.folder.messages = r.folder.messages.filter((m) => !m.raw.includes("w-old"));
    await r.sync.onOrganize();
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });
});

/* THE SAME INSTALL ID, A NEW STORE: a phone's Stop and remove drops its store and keeps its install
   id, and a server keeps one id across accounts and databases. A copy under this install's id dated
   before this store's mailbox row is the removed store's: kept and asked about like another
   install's, never replaced by the new store's empty settings. */
const PREVIOUS = makeProfileDoc({
  screener: [{ address: "anna@example.test", source: "person" }, { address: "ben@example.test", source: "person" }],
  rules: [{ kind: "sender", match: "letters@example.test", destination: "ohmail/News", priority: 0, enabled: true, provenance: "promoted" }],
  notifyRules: [], awayResponder: null, tagNames: ["kept"], signature: null,
}, { updatedAt: new Date("2026-09-28T11:00:00.000Z"), producer: { kind: "mobile", version: "0.30.16" } });
const PREVIOUS_RAW = formatProfileMessage(PREVIOUS, { installId: "w-new" });
/** The new store's rows, made after its install's previous store wrote {@link PREVIOUS}. */
const RECONNECTED = new Date("2026-09-28T11:30:00.000Z");
const HELD = { noLease: "not_supplied" } as OrganizerWriteAuthority;

describe("a new store under the same install id keeps the settings the removed store left", () => {
  const reconnect = (o: { baseline?: true } = {}) => rig({ planted: true, theirs: PREVIOUS, by: "w-new", rowAt: RECONNECTED, ...o });
  const kept = (r: { folder: Folder }): boolean => r.folder.messages.some((m) => m.raw === PREVIOUS_RAW);

  it("an empty store keeps the copy, holds routing for it and marks the question for the card", async () => {
    const r = await reconnect();
    await r.sync.armHoldFromFolder();
    await r.ticks(3);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ kept: kept(r), copies: r.folder.messages.length, routing: await r.routing(), marker: [marker?.state, marker?.heldForImport] })
      .toEqual({ kept: true, copies: 1, routing: "document", marker: ["found", true] });
  });

  it("a consented empty store publishes nothing beside it: readers would take an empty copy as the newest", async () => {
    const r = await reconnect({ baseline: true });
    await r.sync.armHoldFromFolder();
    await r.ticks(3);
    expect({ kept: kept(r), copies: r.folder.messages.length }).toEqual({ kept: true, copies: 1 });
  });

  /* NOTHING BESIDE IT UNTIL THE ANSWER: published beside it, the new store's copy would be the newest,
     the one the next store or another install asks about, and their tidy would remove this one. A
     hand-back before the answer says the store's settings stayed with it. To watch it fail: drop the
     removed-store return at the top of `publish` in `profile.ts`. */
  it("a decision on the new store waits for the answer, which then publishes it", async () => {
    const r = await reconnect();
    await r.decide("fresh");
    await r.ticks(3);
    const waiting = { kept: kept(r), copies: r.folder.messages.length, routing: await r.routing(), left: await r.sync.flushBeforeLeaving(HELD) };
    await r.answer("replaced");
    await r.ticks(3);
    expect({ waiting, answered: r.folder.copies() }).toEqual({
      waiting: { kept: true, copies: 1, routing: "document", left: "not_saved" },
      answered: [{ by: "w-new", screener: 0, rules: 0, tags: ["fresh"] }],
    });
  });

  // Before any answer, the next organizer finds the removed store's copy itself, never a newer one of ours beside it.
  it("another install taking over after a decision still asks about it, holds its senders and keeps it", async () => {
    const r = await reconnect();
    await r.decide("fresh");
    await r.ticks(3);
    r.later(20 * 60_000);
    const next = await r.store("w-desk");
    await next.sync.armHoldFromFolder();
    await r.ticks(3, next.sync);
    const hold = await next.sync.importHoldNow();
    const marker = await latestProfileFoundMarker(r.db, next.accountId, next.mailboxId);
    expect({
      kept: kept(r), copies: r.folder.messages.length, asked: marker?.fingerprint === profileFingerprint(PREVIOUS),
      senders: hold?.kind === "document" ? [...hold.knownSenders.addresses].sort() : hold,
    }).toEqual({ kept: true, copies: 1, asked: true, senders: ["anna@example.test", "ben@example.test"] });
  });

  /* NOT NOW IS AN ANSWER: from then on the store's decisions reach the mailbox beside the removed store's
     copy, which stays there to import, across a restart; a hand-back says the settings were saved. */
  it("after Not now a decision is published beside it, which stays, across a restart", async () => {
    const r = await reconnect();
    await r.ticks(2);
    await r.answer("declined");
    await r.decide("fresh");
    await r.ticks(3);
    const published = { kept: kept(r), newest: r.folder.newest(), left: await r.sync.flushBeforeLeaving(HELD) };
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.decide("again");
    await r.ticks(3, again);
    expect({ published, restarted: { kept: kept(r), newest: r.folder.newest(), copies: r.folder.messages.length } }).toEqual({
      published: { kept: true, newest: { by: "w-new", screener: 0, rules: 0, tags: ["fresh"] }, left: "saved" },
      restarted: { kept: true, newest: { by: "w-new", screener: 0, rules: 0, tags: ["again", "fresh"] }, copies: 2 },
    });
  });

  it("Not now keeps it, across ticks and a restart", async () => {
    const r = await reconnect();
    await r.decide("fresh");
    await r.ticks(2);
    await recordProfileImportResolution(r.db, {
      accountId: r.accountId, mailboxId: r.mailboxId, decision: "declined", fingerprint: profileFingerprint(PREVIOUS),
    });
    await r.ticks(3);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    expect({ kept: kept(r), open: again.importDecisionOpen() }).toEqual({ kept: true, open: true });
  });

  it("a restart while unanswered asks again from the marker and keeps the copy", async () => {
    const r = await reconnect();
    await r.decide("fresh");
    await r.ticks(2);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    expect({ kept: kept(r), open: again.importDecisionOpen(), routing: await r.routing(again) })
      .toEqual({ kept: true, open: true, routing: "document" });
  });

  it("Import brings its settings into the store, and then one copy says them all", async () => {
    const r = await reconnect();
    await r.ticks(1);
    await recordImportAsk(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, fingerprint: profileFingerprint(PREVIOUS), now: r.clock.at });
    await r.ticks(3);
    const people = (await r.db.select({ a: contacts.address }).from(contacts)).map((c) => c.a).sort();
    expect({ people, open: r.sync.importDecisionOpen() }).toEqual({ people: ["anna@example.test", "ben@example.test"], open: false });
    await r.decide("after");
    await r.ticks(3);
    expect(r.folder.copies()).toEqual([{ by: "w-new", screener: 2, rules: 1, tags: ["after", "kept"] }]);
  });

  /* A CLOCK SET BACK BEFORE THE STORE'S ROW dates this store's own copies before it too; the held
     record stays the question all the same, and across a restart. To watch it fail: drop the
     retained re-read from `readQuestion`, or the marker's look at a copy under our id from the seed
     and the preflight. */
  it("a clock set back before the store's row never lapses another install's held question", async () => {
    const r = await rig({ planted: true, rowAt: RECONNECTED });
    await r.decide("mine");
    r.clock.at = new Date(RECONNECTED.getTime() - 600_000);
    await r.ticks(5);
    const during = { held: r.folder.writers().includes("w-old"), open: r.sync.importDecisionOpen() };
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    expect({ during, restarted: { held: r.folder.writers().includes("w-old"), open: again.importDecisionOpen() } })
      .toEqual({ during: { held: true, open: true }, restarted: { held: true, open: true } });
  });

  /* Dated before the store's row and never recorded by it, a copy under its id that lands beside the
     question it asks is a gone store's, never the copy its next write replaces: kept, and asked about next. */
  it("a gone store's copy landing beside the question it asks is kept, and asked about next", async () => {
    const r = await rig({ planted: true, rowAt: RECONNECTED });
    await r.ticks(1);
    await r.folder.appendProfile(PREVIOUS_RAW);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.decide("fresh");
    await r.ticks(3, again);
    const waiting = kept(r);
    await r.answer("declined");
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ waiting, kept: kept(r), asking: marker?.fingerprint === profileFingerprint(PREVIOUS) && marker.heldForImport })
      .toEqual({ waiting: true, kept: true, asking: true });
  });

  it("the store that wrote the copy replaces it: with a newer decision, and with nothing once emptied", async () => {
    const changed = await rig({ planted: true, theirs: PREVIOUS, by: "w-new" });
    await changed.decide("newer");
    await changed.ticks(3);
    const emptied = await rig({ planted: true, theirs: PREVIOUS, by: "w-new" });
    await emptied.ticks(3);
    expect({ changed: changed.folder.copies(), emptied: emptied.folder.copies() }).toEqual({
      changed: [{ by: "w-new", screener: 0, rules: 0, tags: ["newer"] }],
      emptied: [{ by: "w-new", screener: 0, rules: 0, tags: [] }],
    });
  });
});

/* A STORE RESTORED FROM A BACKUP keeps its mailbox row and install id, but not the copies it wrote
   after the backup. The newer copy under its id is not its own: kept, held and asked about, never
   rolled back to the store's older settings or replaced by an empty copy. */
describe("a store restored from a backup never rolls the mailbox's settings back", () => {
  /** The copy the store's later life wrote, an hour after the backup: a person in the screener, a tag. */
  const later = (at: Date): OrganizerProfileDoc => makeProfileDoc({
    screener: [{ address: "anna@example.test", source: "person" }], rules: [], notifyRules: [], awayResponder: null,
    tagNames: ["after", "before"], signature: null,
  }, { updatedAt: new Date(at.getTime() + 3_600_000), producer: { kind: "local", version: "0.31.0" } });
  /** Back up after `before` ticks, let the later life write (and `then` another install after it), then attach the restored store. */
  const restore = async (r: Awaited<ReturnType<typeof rig>>, then?: (doc: OrganizerProfileDoc) => OrganizerProfileDoc) => {
    r.folder.messages = r.folder.messages.filter((m) => !m.raw.includes("X-Ohmail-Install-Id: w-new"));
    const doc = later(r.clock.at);
    await r.folder.appendProfile(formatProfileMessage(doc, { installId: "w-new" }));
    if (then !== undefined) await r.folder.appendProfile(formatProfileMessage(then(doc), { installId: "w-cloud" }));
    r.later(2 * 3_600_000);
    const restored = r.attach();
    await restored.armHoldFromFolder();
    await r.ticks(3, restored);
    return Object.assign(restored, { asked: doc });
  };

  it("keeps its install's newer copy, holds routing for its senders and marks the question", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const wrote = r.folder.copies();
    const restored = await restore(r);
    const hold = await restored.importHoldNow();
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      wrote, after: r.folder.copies(), senders: hold?.kind === "document" ? [...hold.knownSenders.addresses] : hold,
      marker: marker === null ? null : [marker.state, marker.heldForImport],
    }).toEqual({
      wrote: [{ by: "w-new", screener: 0, rules: 0, tags: ["before"] }],
      after: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }],
      senders: ["anna@example.test"], marker: ["found", true],
    });
  });

  it("a restored store that never wrote keeps the copy its install wrote later", async () => {
    const r = await rig({ planted: false });
    await r.ticks(1);
    const wrote = r.folder.copies();
    await restore(r);
    expect({ wrote, after: r.folder.copies() })
      .toEqual({ wrote: [], after: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }] });
  });

  it("Import then leaves one copy that says everything", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    await recordImportAsk(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, fingerprint: profileFingerprint(restored.asked), now: r.clock.at });
    await r.ticks(3, restored);
    await r.decide("later");
    await r.ticks(3, restored);
    expect({ open: restored.importDecisionOpen(), copies: r.folder.copies() })
      .toEqual({ open: false, copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before", "later"] }] });
  });

  /* Restored while it asked about another install's settings: the marker still names that question,
     and the later life's copy beside it is not the restored store's to replace. It is asked next. */
  it("restored while it asked about another install's settings, keeps its later copy and asks about it next", async () => {
    const r = await rig({ planted: true });
    await r.decide("before");
    await r.ticks(1);
    const beside = r.folder.writers();
    const restored = await restore(r);
    const asking = async (): Promise<string | null | undefined> => {
      const fp = (await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId))?.fingerprint;
      return fp === profileFingerprint(restored.asked) ? "later" : fp === profileFingerprint(THEIRS) ? "theirs" : fp;
    };
    const restoredAsks = { copies: r.folder.copies(), asking: await asking(), open: restored.importDecisionOpen() };
    await r.answer("replaced");
    await r.ticks(3, restored);
    expect({ beside, restoredAsks, answered: { copies: r.folder.copies(), asking: await asking(), open: restored.importDecisionOpen() } }).toEqual({
      beside: ["w-new", "w-old"],
      restoredAsks: {
        copies: [{ by: "w-old", screener: 1, rules: 0, tags: ["theirs"] }, { by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }],
        asking: "theirs", open: true,
      },
      answered: { copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }], asking: "later", open: true },
    });
  });

  /* IMPORT OF THOSE SETTINGS, pressed where an empty store is, makes it say exactly what they say: the later
     copy beside them is asked about next, never replaced by them unasked, and after Not now on it the
     imported settings are published beside it. The press handed to the organizer and a store with a
     decision of its own end the same way. */
  it.each([
    ["pressed where an empty store is", "inline", null],
    ["handed to the organizer", "handed", null],
    ["pressed where a store with a decision of its own is", "inline", "before"],
  ] as const)("restored while it asked about another install's settings, Import of them %s: the later copy is asked about next", async (_, via, decided) => {
    const r = await rig({ planted: true });
    if (decided !== null) await r.decide(decided);
    await r.ticks(1);
    const restored = await restore(r);
    if (via === "inline") await r.importInline(THEIRS);
    else await recordImportAsk(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, fingerprint: profileFingerprint(THEIRS), now: r.clock.at });
    await r.ticks(1, restored);
    // From the pass that reads the answer, routing holds the later copy's senders.
    const routing = await r.routing(restored);
    await r.ticks(3, restored);
    const kept = (): boolean => r.folder.messages.some((m) => m.raw === formatProfileMessage(restored.asked, { installId: "w-new" }));
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    const asked = {
      kept: kept(), asking: marker?.fingerprint === profileFingerprint(restored.asked) && marker.heldForImport,
      routing, left: await restored.flushBeforeLeaving(HELD),
    };
    await recordProfileImportResolution(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, decision: "declined", fingerprint: profileFingerprint(restored.asked) });
    await r.ticks(3, restored);
    expect({ asked, published: { kept: kept(), newest: r.folder.newest(), left: await restored.flushBeforeLeaving(HELD) } }).toEqual({
      asked: { kept: true, asking: true, routing: "document", left: "not_saved" },
      published: { kept: true, newest: { by: "w-new", screener: 1, rules: 0, tags: decided === null ? ["theirs"] : ["before", "theirs"] }, left: "saved" },
    });
  });

  /* A COPY UNDER ITS ID THAT IT NEVER RECORDED, landing beside an established store's own (its data running
     from a second copy, a later life's late write): found settings, asked about and never replaced unasked,
     whether the store meets it at a write or while it has nothing to write. */
  it.each([["at a write", "b"], ["with nothing to write", null]] as const)("an established store meets a copy under its id it never recorded %s: kept and asked about", async (_, decision) => {
    const r = await rig({ planted: false, version: "0.31.0" });
    await r.decide("a");
    await r.ticks(1);
    const L = later(r.clock.at);
    await r.folder.appendProfile(formatProfileMessage(L, { installId: "w-new" }));
    if (decision !== null) await r.decide(decision);
    await r.ticks(4);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      kept: r.folder.messages.some((m) => m.raw === formatProfileMessage(L, { installId: "w-new" })),
      asking: marker?.fingerprint === profileFingerprint(L) && marker.heldForImport, routing: await r.routing(),
      left: await r.sync.flushBeforeLeaving(HELD),
    }).toEqual({ kept: true, asking: true, routing: "document", left: "not_saved" });
  });

  /* The same after an Import made the store say exactly what another install's settings say: readers read the
     later copy, so nothing of the store's is said to stand in the mailbox until the person answers it. */
  it("an Import made the store say what another install's settings say, then a copy under its id it never recorded lands: kept and asked about", async () => {
    const r = await rig({ planted: true });
    await r.ticks(1);
    await r.importInline(THEIRS);
    await r.ticks(1);
    const L = later(r.clock.at);
    await r.folder.appendProfile(formatProfileMessage(L, { installId: "w-new" }));
    await r.ticks(4);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      kept: r.folder.messages.some((m) => m.raw === formatProfileMessage(L, { installId: "w-new" })),
      asking: marker?.fingerprint === profileFingerprint(L) && marker.heldForImport, left: await r.sync.flushBeforeLeaving(HELD),
    }).toEqual({ kept: true, asking: true, left: "not_saved" });
  });

  /* Another install's settings, newer than the later copy the restored store asks about, are asked about
     first; the later copy stays in the mailbox, never released unanswered. */
  it("restored, another install's settings land while it asks about the later copy: theirs asked first, the later copy kept", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    const cloud = makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["cloud"], signature: null },
      { updatedAt: r.clock.at, producer: { kind: "cloud", version: "0.31.0+abc1234" } });
    await r.folder.appendProfile(formatProfileMessage(cloud, { installId: "w-cloud" }));
    await r.ticks(3, restored);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      kept: r.folder.messages.some((m) => m.raw === formatProfileMessage(restored.asked, { installId: "w-new" })),
      asking: marker?.fingerprint === profileFingerprint(cloud) && marker.heldForImport,
    }).toEqual({ kept: true, asking: true });
  });

  /* A ROLLBACK AND FORWARD AGAIN, A DOWNGRADE to a build that records nothing: its copy under this store's
     id has no record and is the store's own, replaced by the store's later settings and never asked about.
     A server image before 0.30.21 names its commit alone, an app or a source build its release. */
  const COMMIT = "52a56a5fc5b2b1d8f9d4a1b7e0c3d2f1a9b8c7d6";
  const BEFORE = "1a6b4fb238dd859dc93235c8692b435843322ad4";
  const ROLLBACKS = [
    ["a release before the first that records", "0.31.2", "0.30.20"],
    ["a server image named by its commit alone", `0.31.2+${COMMIT}`, BEFORE],
    ["a build named by its commit", COMMIT, BEFORE],
  ] as const;
  /* A LATER LIFE: every build that records names a release from 0.30.21 on (a server's with its build label
     beside it, an engine run unbundled 0.0.0), so a copy one of them wrote under our id that this store has
     no record of was written after its backup. Found settings: kept, held, asked about. */
  const LATER_LIVES = [
    ["an older release that records (a downgrade)", "0.31.2", "0.31.1"],
    ["another build of the same release", "0.31.2", "0.31.2"],
    ["another server build of the same release", `0.31.2+${COMMIT}`, `0.31.2+${BEFORE}`],
    ["an engine run unbundled", "0.0.0", "0.0.0"],
  ] as const;
  /** What the store says now, written under its id by the build `version`, in place of its newer copies. */
  const olderBuildWrites = async (r: Awaited<ReturnType<typeof rig>>, version: string): Promise<void> => {
    const doc = makeProfileDoc(await serializeOrganizerProfile(r.db, r.accountId, r.mailboxId), { updatedAt: r.clock.at, producer: { kind: "cloud", version } });
    r.folder.messages = r.folder.messages.filter((m) => !m.raw.includes("X-Ohmail-Install-Id: w-new"));
    await r.folder.appendProfile(formatProfileMessage(doc, { installId: "w-new" }));
  };

  it.each(ROLLBACKS)("a copy %s wrote, then a decision, then a restart: the store's own", async (_, version, older) => {
    const r = await rig({ planted: false, version });
    await r.decide("a");
    await r.ticks(1);
    await r.decide("b");
    r.later(10 * 60_000);
    await olderBuildWrites(r, older);
    r.later(60_000);
    await r.decide("c");
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      open: again.importDecisionOpen(), routing: await r.routing(again), marker: marker?.heldForImport ?? null,
      copies: r.folder.copies(), left: await again.flushBeforeLeaving(HELD),
    }).toEqual({ open: false, routing: "closed", marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a", "b", "c"] }], left: "saved" });
  });

  /* Beside another install's question: the store asks about that one only, and once it is answered the
     store's later decision reaches the mailbox. */
  it.each(ROLLBACKS)("a copy %s wrote beside another install's question is the store's own", async (_, version, older) => {
    const r = await rig({ planted: true, version });
    await r.decide("mine");
    await r.ticks(1);
    await r.decide("rollback-window");
    r.later(10 * 60_000);
    await olderBuildWrites(r, older);
    r.later(60_000);
    await r.decide("after-forward");
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const asking = (await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId))?.fingerprint === profileFingerprint(THEIRS);
    await r.answer("replaced");
    await r.ticks(4, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ asking, open: again.importDecisionOpen(), marker: marker === null ? null : [marker.state, marker.installId], copies: r.folder.copies() })
      .toEqual({ asking: true, open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["after-forward", "mine", "rollback-window"] }] });
  });

  /* Met at a write with no restart between, after Not now on another install's settings: the same, never the next question. */
  it.each(ROLLBACKS)("a copy %s wrote, met at a write beside another install's declined settings, is the store's own", async (_, version, older) => {
    const r = await rig({ planted: true, version });
    await r.decide("mine");
    await r.ticks(1);
    await r.answer("declined");
    await r.ticks(2);
    await r.decide("rollback-window");
    await olderBuildWrites(r, older);
    await r.decide("after-forward");
    await r.ticks(4);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ asking: marker?.fingerprint === profileFingerprint(THEIRS), newest: r.folder.newest() })
      .toEqual({ asking: true, newest: { by: "w-new", screener: 0, rules: 0, tags: ["after-forward", "mine", "rollback-window"] } });
  });

  /* A removal leaves no time in the store: the older build alone says the copy is the store's own. */
  it.each(ROLLBACKS.slice(0, 3))("a copy %s wrote is the store's own when the store only removed something since", async (_, version, older) => {
    const r = await rig({ planted: false, version });
    await r.decide("a");
    await r.decide("b");
    await r.ticks(1);
    r.later(10 * 60_000);
    await olderBuildWrites(r, older);
    r.later(60_000);
    await r.db.delete(tags).where(and(eq(tags.accountId, r.accountId), eq(tags.name, "b")));
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ open: again.importDecisionOpen(), marker: marker?.heldForImport ?? null, copies: r.folder.copies() })
      .toEqual({ open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a"] }] });
  });

  /* A WRITE WHOSE RECORD THE DATABASE REFUSED APPENDS NOTHING: no copy of the store's is ever in the
     mailbox unrecorded. The next write-due tick writes it once the database takes the record, and a
     restart after that asks about nothing. */
  it.each([
    ["nothing decided since", null],
    ["a screener decision since", "anna@example.test"],
  ] as const)("a write whose record the database refused appends nothing, and the next tick writes it (%s)", async (_, since) => {
    let refusing = false;
    const r = await rig({ planted: false, refusing: () => refusing });
    await r.decide("a");
    await r.ticks(1);
    await r.decide("b");
    refusing = true;
    await r.ticks(1);
    const refused = { copies: r.folder.copies(), block: r.sync.profileBlock() !== null };
    refusing = false;
    r.later(60_000);
    if (since !== null) await r.db.insert(contacts).values({ accountId: r.accountId, address: since, source: "person", createdAt: r.clock.at });
    await r.ticks(1);
    const written = r.folder.copies();
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    const screener = since === null ? 0 : 1;
    expect({ refused, written, restarted: { open: again.importDecisionOpen(), marker: marker?.heldForImport ?? null, left: await again.flushBeforeLeaving(HELD) } }).toEqual({
      refused: { copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a"] }], block: false },
      written: [{ by: "w-new", screener, rules: 0, tags: ["a", "b"] }],
      restarted: { open: false, marker: null, left: "saved" },
    });
  });

  /* A removal leaves no time behind it, so nothing the store holds could vouch for an unrecorded copy:
     there is none to vouch for. */
  it("a refused record, then only a removal, then a restart: no question, the removal reaches the mailbox", async () => {
    let refusing = false;
    const r = await rig({ planted: false, refusing: () => refusing });
    await r.decide("a");
    await r.ticks(1);
    await r.decide("b");
    refusing = true;
    await r.ticks(1);
    refusing = false;
    r.later(60_000);
    await r.db.delete(tags).where(and(eq(tags.accountId, r.accountId), eq(tags.name, "b")));
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ open: again.importDecisionOpen(), marker: marker?.heldForImport ?? null, copies: r.folder.copies(), left: await again.flushBeforeLeaving(HELD) })
      .toEqual({ open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a"] }], left: "saved" });
  });

  it("beside another install's question, a refused record appends nothing and the next tick publishes", async () => {
    let refusing = false;
    const r = await rig({ planted: true, refusing: () => refusing });
    await r.decide("mine");
    await r.ticks(1);
    await r.decide("more");
    refusing = true;
    await r.ticks(1);
    const refused = r.folder.copies();
    refusing = false;
    await r.ticks(1);
    const beside = r.folder.copies();
    await r.answer("replaced");
    await r.ticks(3);
    expect({ refused, beside, open: r.sync.importDecisionOpen(), copies: r.folder.copies() }).toEqual({
      refused: [{ by: "w-old", screener: 1, rules: 0, tags: ["theirs"] }, { by: "w-new", screener: 0, rules: 0, tags: ["mine"] }],
      beside: [{ by: "w-old", screener: 1, rules: 0, tags: ["theirs"] }, { by: "w-new", screener: 0, rules: 0, tags: ["mine", "more"] }],
      open: false, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["mine", "more"] }],
    });
  });

  /* A LATER LIFE'S COPY IS FOUND SETTINGS, whatever the restored store decides before it first reads the
     folder (a laptop opened offline), and whichever build the later life ran. */
  it.each(LATER_LIVES)("a copy %s wrote after the backup, a decision before the first read: kept and asked about", async (_, version, laterVersion) => {
    const r = await rig({ planted: false, version });
    await r.decide("before");
    await r.ticks(1);
    const L = makeProfileDoc({
      screener: [{ address: "anna@example.test", source: "person" }], rules: [], notifyRules: [], awayResponder: null,
      tagNames: ["after", "before"], signature: null,
    }, { updatedAt: new Date(r.clock.at.getTime() + 3_600_000), producer: { kind: "local", version: laterVersion } });
    r.folder.messages = r.folder.messages.filter((m) => !m.raw.includes("X-Ohmail-Install-Id: w-new"));
    await r.folder.appendProfile(formatProfileMessage(L, { installId: "w-new" }));
    r.later(2 * 3_600_000);
    await r.decide("offline");
    r.later(60_000);
    const restored = r.attach();
    await restored.armHoldFromFolder();
    await r.ticks(3, restored);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      kept: r.folder.messages.some((m) => m.raw === formatProfileMessage(L, { installId: "w-new" })),
      asked: marker?.fingerprint === profileFingerprint(L) && marker?.heldForImport === true,
      left: await restored.flushBeforeLeaving(HELD),
    }).toEqual({ kept: true, asked: true, left: "not_saved" });
  });

  /* JUDGED ONCE: a decision the person makes before answering is newer than the later copy, and still
     does not make it the restored store's own, across a restart. */
  it("the question about its later copy stands through a decision and a restart", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    await r.decide("meanwhile");
    await r.ticks(2, restored);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      open: again.importDecisionOpen(), routing: await r.routing(again),
      asked: marker?.fingerprint === profileFingerprint(restored.asked), copies: r.folder.copies(),
    }).toEqual({ open: true, routing: "document", asked: true, copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }] });
  });

  /* NOT NOW ON ANOTHER INSTALL'S SETTINGS, before the backup or after the restore: the later copy is the
     question next, and after Not now on it the store's decisions reach the mailbox beside it, across a restart. */
  it.each([
    ["before the backup", "later"],
    ["after the restore", "theirs"],
  ] as const)("Not now on another install's settings %s: the later copy is asked about next, then published beside", async (when, first) => {
    const r = await rig({ planted: true });
    await r.decide("before");
    await r.ticks(1);
    if (when === "before the backup") {
      await r.answer("declined");
      await r.ticks(1);
    }
    const restored = await restore(r);
    const asking = async (): Promise<string | null | undefined> => {
      const fp = (await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId))?.fingerprint;
      return fp === profileFingerprint(restored.asked) ? "later" : fp === profileFingerprint(THEIRS) ? "theirs" : fp;
    };
    const asked = await asking();
    if (when === "after the restore") await r.answer("declined");
    await r.decide("restored");
    await r.ticks(3, restored);
    const next = { asking: await asking(), routing: await r.routing(restored), left: await restored.flushBeforeLeaving(HELD) };
    await recordProfileImportResolution(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, decision: "declined", fingerprint: profileFingerprint(restored.asked) });
    await r.ticks(3, restored);
    const published = { newest: r.folder.newest(), left: await restored.flushBeforeLeaving(HELD) };
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.decide("restarted");
    await r.ticks(3, again);
    const kept = r.folder.messages.some((m) => m.raw === formatProfileMessage(restored.asked, { installId: "w-new" }));
    expect({ asked, next, published, restarted: { kept, asking: await asking(), newest: r.folder.newest(), left: await again.flushBeforeLeaving(HELD) } }).toEqual({
      asked: first,
      next: { asking: "later", routing: "document", left: "not_saved" },
      published: { newest: { by: "w-new", screener: 0, rules: 0, tags: ["before", "restored"] }, left: "saved" },
      restarted: { kept: true, asking: "later", newest: { by: "w-new", screener: 0, rules: 0, tags: ["before", "restarted", "restored"] }, left: "saved" },
    });
  });

  it("restored while it asked about another install's settings, a decision and a restart: its later copy is asked about next", async () => {
    const r = await rig({ planted: true });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    await r.decide("meanwhile");
    await r.ticks(2, restored);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    await r.answer("replaced");
    await r.ticks(3, again);
    const fp = (await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId))?.fingerprint;
    expect({ asking: fp === profileFingerprint(restored.asked), open: again.importDecisionOpen(), copies: r.folder.copies() })
      .toEqual({ asking: true, open: true, copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }] });
  });

  /* Restored, and another install took the mailbox over after the later life and published its own copy:
     the restored store asks about that one and publishes beside it, and its own record of that write never
     makes the later copy its own: it stays in the mailbox through decisions, the answer and the tidy. */
  it("restored, another install's copy newer than the later one: the later copy is never taken for the store's own", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r, (doc) => makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["cloud"], signature: null },
      { updatedAt: new Date(Date.parse(doc.updatedAt) + 30 * 60_000), producer: { kind: "cloud", version: "0.31.0+abc1234" } }));
    await r.decide("restored-decision");
    await r.ticks(3, restored);
    const cloud = (await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId))?.fingerprint ?? "";
    const writers = r.folder.writers();
    await recordProfileImportResolution(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, decision: "replaced", fingerprint: cloud });
    await r.decide("after-answer");
    await r.ticks(4, restored);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    expect({ writers, kept: r.folder.messages.some((m) => m.raw === formatProfileMessage(restored.asked, { installId: "w-new" })), newest: r.folder.newest() })
      .toEqual({ writers: ["w-cloud", "w-new", "w-new"], kept: true, newest: { by: "w-new", screener: 0, rules: 0, tags: ["after-answer", "before", "restored-decision"] } });
  });

  /* THE AUDIT LOG KEEPS A YEAR. A store whose settings do not change records its current copy again, so a
     backup taken a year on still tells a later copy apart; and a question left unanswered for a year, a
     restart and the age-out still ask about the later copy. */
  const YEAR = async (r: Awaited<ReturnType<typeof rig>>, s: OrganizerProfileSync): Promise<void> => {
    const before = (await r.db.select({ id: auditLog.id }).from(auditLog)).map((row) => row.id);
    for (let i = 0; i < 13; i++) {
      r.later(30 * 24 * 3_600_000);
      await r.ticks(1, s);
    }
    // The age-out, whichever clock stamped the rows: everything written before the year is gone.
    if (before.length > 0) await r.db.delete(auditLog).where(inArray(auditLog.id, before));
  };
  it("a year without a settings change, a backup, a later life and a restore: the later copy is kept and asked about", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    await YEAR(r, r.sync);
    const restored = await restore(r);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ copies: r.folder.copies(), asked: marker?.fingerprint === profileFingerprint(restored.asked) })
      .toEqual({ copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }], asked: true });
  });

  /* A store that wrote nothing for a year keeps its current copy's record alive, so a decision and a
     restart before the next write still find its own copy, not a question about it. */
  it("a year without a write, a decision and a restart before the next write: its own copy, no question", async () => {
    const r = await rig({ planted: false, version: "0.31.0" });
    await r.decide("before");
    await r.ticks(1);
    await YEAR(r, r.sync);
    await r.decide("next");
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(2, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ open: again.importDecisionOpen(), marker: marker?.heldForImport ?? null, copies: r.folder.copies() })
      .toEqual({ open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["before", "next"] }] });
  });

  /* A FULL MAILBOX refuses every append, and each refused write was recorded first: the current copy's
     record is renewed past those, so a restart after a long run of them still finds its own copy. */
  it.each([65, 130])("appends refused for %i write-due ticks, then a restart: its own copy, no question", async (n) => {
    const r = await rig({ planted: false, version: "0.31.0" });
    await r.decide("a");
    await r.ticks(1);
    const append = r.folder.appendProfile.bind(r.folder);
    r.folder.appendProfile = async (): Promise<void> => { throw new Error("over quota"); };
    await r.decide("b");
    await r.ticks(n);
    r.folder.appendProfile = append;
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ open: again.importDecisionOpen(), marker: marker?.heldForImport ?? null, copies: r.folder.copies(), left: await again.flushBeforeLeaving(HELD) })
      .toEqual({ open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a", "b"] }], left: "saved" });
  });

  it("a question about the later copy left a year, the age-out and a restart: still asked, still kept", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    await YEAR(r, restored);
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.ticks(3, again);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ copies: r.folder.copies(), open: again.importDecisionOpen(), asked: marker?.fingerprint === profileFingerprint(restored.asked) })
      .toEqual({ copies: [{ by: "w-new", screener: 1, rules: 0, tags: ["after", "before"] }], open: true, asked: true });
  });

  /* NOT NOW ON THE LATER COPY: the restored store's decisions reach the mailbox beside it from then on, and
     the later copy stays its question, importable, across a restart; never its own to replace. */
  it("Not now on the later copy: later decisions are published beside it, which stays, across a restart", async () => {
    const r = await rig({ planted: false });
    await r.decide("before");
    await r.ticks(1);
    const restored = await restore(r);
    await recordProfileImportResolution(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, decision: "declined", fingerprint: profileFingerprint(restored.asked) });
    await r.decide("after-not-now");
    await r.ticks(3, restored);
    const published = { newest: r.folder.newest(), left: await restored.flushBeforeLeaving(HELD) };
    const again = r.attach();
    await again.armHoldFromFolder();
    await r.decide("restarted");
    await r.ticks(3, again);
    const kept = r.folder.messages.some((m) => m.raw === formatProfileMessage(restored.asked, { installId: "w-new" }));
    expect({ published, kept, newest: r.folder.newest(), open: again.importDecisionOpen() }).toEqual({
      published: { newest: { by: "w-new", screener: 0, rules: 0, tags: ["after-not-now", "before"] }, left: "saved" },
      kept: true, newest: { by: "w-new", screener: 0, rules: 0, tags: ["after-not-now", "before", "restarted"] }, open: true,
    });
  });

  /* A rolling deploy's second attachment beside another install's question keeps publishing after the
     first attachment wrote: it reads the store's record again before each write. */
  it("two attachments beside another install's question: the second keeps publishing after the first writes", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.ticks(1);
    const b = r.attach();
    await b.armHoldFromFolder();
    await r.ticks(1, b);
    await r.decide("x");
    await r.ticks(1);
    await r.decide("y");
    await r.ticks(3, b);
    expect({ ours: r.folder.copies().filter((c) => c.by === "w-new"), left: await b.flushBeforeLeaving(HELD) })
      .toEqual({ ours: [{ by: "w-new", screener: 0, rules: 0, tags: ["mine", "x", "y"] }], left: "saved" });
  });

  /* Two attachments of one install on one store (a rolling deploy) write under one record: neither
     asks about the other's copy. To watch it fail: drop the record's re-read from `isOwn`. */
  it("two attachments of one install on one store never ask about each other's copies", async () => {
    const r = await rig({ planted: false });
    await r.decide("a");
    await r.ticks(1);
    const b = r.attach();
    await b.armHoldFromFolder();
    await r.decide("b");
    await r.ticks(1);
    await r.decide("c");
    await r.ticks(2, b);
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({ open: b.importDecisionOpen(), marker: marker?.heldForImport ?? null, copies: r.folder.copies() })
      .toEqual({ open: false, marker: null, copies: [{ by: "w-new", screener: 0, rules: 0, tags: ["a", "b", "c"] }] });
  });
});

/* AN ANSWER REACHES THE MAILBOX AT ONCE, and nothing empty stands beside found settings: another
   device reads the newest copy, so an empty one or a stale one of ours reads as the settings. */
describe("found settings and the Import that answers them", () => {
  it("a consented empty store publishes nothing beside another install's settings", async () => {
    const r = await rig({ planted: true, baseline: true });
    await r.sync.armHoldFromFolder();
    await r.ticks(3);
    expect({ copies: r.folder.writers(), open: r.sync.importDecisionOpen() }).toEqual({ copies: ["w-old"], open: true });
  });

  it("the same store publishes nothing beside settings that land mid-write", async () => {
    const r = await rig({ planted: false, baseline: true });
    r.folder.landOn = { n: 3, raw: THEIRS_RAW };
    await r.ticks(2);
    expect({ copies: r.folder.writers(), open: r.sync.importDecisionOpen() }).toEqual({ copies: ["w-old"], open: true });
  });

  it("an Import reaches the mailbox within two passes, inside the flush interval", async () => {
    const r = await rig({ planted: true, flushIntervalMs: 5 * 60_000 });
    await r.decide("mine");
    await r.ticks(1);
    const beside = r.folder.writers();
    await r.importInline(THEIRS);
    await r.ticks(2);
    expect({ beside, newest: r.folder.newest() })
      .toEqual({ beside: ["w-new", "w-old"], newest: { by: "w-new", screener: 1, rules: 0, tags: ["mine", "theirs"] } });
  });

  it("a handed-over Import is published on the next pass", async () => {
    const r = await rig({ planted: true, flushIntervalMs: 5 * 60_000 });
    await r.decide("mine");
    await r.ticks(1);
    await recordImportAsk(r.db, { accountId: r.accountId, mailboxId: r.mailboxId, fingerprint: profileFingerprint(THEIRS), now: r.clock.at });
    await r.ticks(2);
    expect(r.folder.newest()).toEqual({ by: "w-new", screener: 1, rules: 0, tags: ["mine", "theirs"] });
  });

  /* The Import makes the store say exactly what theirs says; the copy of ours beside it is newer and
     is what readers read, so it is replaced rather than left saying less. */
  it("a converging Import replaces the copy of ours that readers see", async () => {
    const r = await rig({ planted: true });
    await r.decide("theirs");
    await r.ticks(1);
    const beside = r.folder.copies();
    await r.importInline(THEIRS);
    await r.ticks(2);
    expect({ beside, newest: r.folder.newest() }).toEqual({
      beside: [{ by: "w-old", screener: 1, rules: 0, tags: ["theirs"] }, { by: "w-new", screener: 0, rules: 0, tags: ["theirs"] }],
      newest: { by: "w-new", screener: 1, rules: 0, tags: ["theirs"] },
    });
  });
});

/* WHICH BUILDS RECORD: every build from 0.30.21 on records each copy before appending it, and names a
   release from 0.30.21 on (a server's with its build label after a `+`), or 0.0.0 run unbundled. 0.30.20
   and 0.30.19 shipped without the record, so their copies are a build's that records nothing. */
describe("a copy's label says whether its build recorded it", () => {
  it.each([
    ["0.30.21+52a56a5fc5b2b1d8f9d4a1b7e0c3d2f1a9b8c7d6", false], ["0.30.20+dev", false], ["0.30.21", false], ["0.31.0", false],
    ["1.0.0", false], ["0.30.21-rc.1", false], ["0.0.0", false],
    ["0.30.20", true], ["0.30.19", true], ["0.25.1", true], ["0.30.20-rc.2", true], ["52a56a5", true],
    ["52a56a5fc5b2b1d8f9d4a1b7e0c3d2f1a9b8c7d6", true], ["dev", true], ["", true], [undefined, true],
  ] as const)("%s: records nothing = %s", (label, nothing) => {
    expect(writtenByABuildThatRecordsNothing(label)).toBe(nothing);
  });
});

/* EVERY FOUND COPY IS KEPT AND ASKED ABOUT: settings put aside with Not now, or never answered, on a store
   that is then removed, stay in the mailbox; the next store asks about each, newest first. */
async function stores(o: { flushIntervalMs?: number } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const folder = new Folder();
  const clock = { at: new Date("2026-10-31T20:00:00.000Z") };
  const later = (ms: number): void => { clock.at = new Date(clock.at.getTime() + ms); };
  const doc = (tag: string, minutesAgo: number): OrganizerProfileDoc => makeProfileDoc(
    { screener: [{ address: `${tag}@example.test`, source: "person" }], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null },
    { updatedAt: new Date(clock.at.getTime() - minutesAgo * 60_000), producer: { kind: "mobile", version: "0.30.22" } },
  );
  const plant = (installId: string, d: OrganizerProfileDoc): Promise<void> => folder.appendProfile(formatProfileMessage(d, { installId }));
  /** A fresh store (its own account and mailbox rows, made now) organizing the one folder. */
  const store = async (installId: string) => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: installId, createdAt: clock.at });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: clock.at })
      .returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    const attach = (): OrganizerProfileSync => new OrganizerProfileSync({
      db, accountId, mailboxId, adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
      self: { installId, kind: "mobile" }, producerVersion: "0.30.22", flushIntervalMs: o.flushIntervalMs ?? 0, now: () => clock.at,
    });
    const s = { sync: attach() };
    const decide = (name: string) => db.insert(tags).values({ accountId, name, createdAt: clock.at, updatedAt: clock.at });
    const answer = (d: OrganizerProfileDoc, decision: "declined" | "replaced") => recordProfileImportResolution(db, {
      accountId, mailboxId, decision, fingerprint: profileFingerprint(d),
    });
    const importIt = (d: OrganizerProfileDoc) => recordImportAsk(db, { accountId, mailboxId, fingerprint: profileFingerprint(d), now: clock.at });
    /** Import pressed on the card, applied where the store is. */
    const importInline = (d: OrganizerProfileDoc) => fencedAccountWrite(db, { accountId }, async (tx) => {
      await lockAccountRuleKeys(tx as Tx, accountId);
      await applyOrganizerProfile(tx as LedgerTx, { accountId, mailboxId, doc: d, fingerprint: profileFingerprint(d), now: clock.at });
    });
    const ticks = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { later(31_000); await s.sync.onOrganize(); } };
    const marker = () => latestProfileFoundMarker(db, accountId, mailboxId);
    const asking = async (): Promise<string | null> => {
      const m = await marker();
      return m?.state === "found" && m.heldForImport ? m.fingerprint : null;
    };
    const routing = async (): Promise<string[] | string> => {
      const h = await s.sync.importHoldNow();
      return h?.kind === "document" ? [...h.knownSenders.addresses].sort() : h?.kind ?? "closed";
    };
    const takeOver = async (): Promise<void> => { await s.sync.armHoldFromFolder(); await ticks(1); };
    const restart = async (): Promise<void> => { s.sync = attach(); await takeOver(); };
    /** `gap`: a phone's Stop, whose last flush writes where its gap began. */
    const stopAndRemove = (o: { gap?: true } = {}): Promise<string> => s.sync.flushBeforeLeaving(HELD, undefined,
      o.gap ? { gap: { since: clock.at.toISOString(), by: installId, at: clock.at.toISOString() } } : undefined);
    return { decide, answer, importIt, importInline, ticks, asking, marker, routing, takeOver, restart, stopAndRemove };
  };
  return { folder, clock, later, doc, plant, store };
}

/** A organizes with three decisions and leaves; B takes over, answers Not now or nothing, decides and leaves. */
async function aThenB(o: { idA: string; idB: string; bAnswers: "notNow" | "nothing" }) {
  const w = await stores();
  const A = await w.store(o.idA);
  await A.decide("a1"); await A.decide("a2"); await A.decide("a3");
  await A.takeOver();
  await A.ticks(1);
  await A.stopAndRemove();
  const X = w.folder.docBy(o.idA);
  w.later(30 * 60_000);
  const B = await w.store(o.idB);
  await B.takeOver();
  const bAsked = (await B.asking()) === profileFingerprint(X);
  if (o.bAnswers === "notNow") await B.answer(X, "declined");
  await B.decide("b1");
  w.later(6 * 60_000);
  await B.ticks(3);
  const bLeft = await B.stopAndRemove();
  w.later(20 * 60_000);
  return { w, X, Y: w.folder.docBy(o.idB), bAsked, bLeft, afterB: w.folder.copies().map((c) => c.by).sort() };
}

describe("every found copy is kept and asked about", () => {
  it.each([["Not now", "notNow"], ["no answer", "nothing"]] as const)(
    "%s on B, B removed, C imports B's settings: A's stay and C asks about them next",
    async (_, bAnswers) => {
      const { w, X, Y, bAsked, bLeft, afterB } = await aThenB({ idA: "w-a", idB: "w-b", bAnswers });
      const C = await w.store("w-c");
      await C.takeOver();
      const askedFirst = (await C.asking()) === profileFingerprint(Y);
      const keptAtTakeover = w.folder.holds(X);
      await C.importIt(Y);
      await C.ticks(3);
      w.later(20 * 60_000);
      await C.ticks(3);
      expect({ bAsked, bLeft, afterB, askedFirst, keptAtTakeover, kept: w.folder.holds(X), askingNext: (await C.asking()) === profileFingerprint(X) })
        .toEqual({ bAsked: true, bLeft: "saved", afterB: ["w-a", "w-b"], askedFirst: true, keptAtTakeover: true, kept: true, askingNext: true });
    },
  );

  it("Not now on B's settings at C: A's are asked about next, and both stay", async () => {
    const { w, X, Y } = await aThenB({ idA: "w-a", idB: "w-b", bAnswers: "notNow" });
    const C = await w.store("w-c");
    await C.takeOver();
    await C.answer(Y, "declined");
    await C.decide("c1");
    await C.ticks(3);
    w.later(20 * 60_000);
    await C.ticks(3);
    expect({ x: w.folder.holds(X), y: w.folder.holds(Y), askingNext: (await C.asking()) === profileFingerprint(X) })
      .toEqual({ x: true, y: true, askingNext: true });
  });

  it("one install id across three stores (a phone keeps its id): the first store's settings are asked about after the second's", async () => {
    const { w, X, Y } = await aThenB({ idA: "w-phone", idB: "w-phone", bAnswers: "notNow" });
    const C = await w.store("w-phone");
    await C.takeOver();
    const askedFirst = (await C.asking()) === profileFingerprint(Y);
    await C.importIt(Y);
    await C.ticks(3);
    w.later(20 * 60_000);
    await C.ticks(3);
    expect({ askedFirst, kept: w.folder.holds(X), askingNext: (await C.asking()) === profileFingerprint(X) })
      .toEqual({ askedFirst: true, kept: true, askingNext: true });
  });

  it("Not now moves the question on, routing holds the next copy's senders, and a restart keeps both and the question", async () => {
    const w = await stores();
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant("w-a", X);
    await w.plant("w-b", Y);
    const C = await w.store("w-c");
    await C.takeOver();
    const first = { asking: (await C.asking()) === profileFingerprint(Y), routing: await C.routing() };
    await C.answer(Y, "declined");
    await C.decide("c1");
    await C.ticks(2);
    const second = { asking: (await C.asking()) === profileFingerprint(X), routing: await C.routing() };
    await C.restart();
    await C.ticks(2);
    expect({ first, second, restarted: { asking: (await C.asking()) === profileFingerprint(X), x: w.folder.holds(X), y: w.folder.holds(Y), ours: w.folder.tagsOf("w-c") } })
      .toEqual({
        first: { asking: true, routing: ["ben@example.test"] },
        second: { asking: true, routing: ["anna@example.test"] },
        restarted: { asking: true, x: true, y: true, ours: [["c1"]] },
      });
  });

  it("every copy answered Not now: Settings offers the newest; Save on it offers the next", async () => {
    const w = await stores();
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant("w-a", X);
    await w.plant("w-b", Y);
    const C = await w.store("w-c");
    await C.decide("c1");
    await C.takeOver();
    await C.answer(Y, "declined");
    await C.ticks(2);
    await C.answer(X, "declined");
    await C.ticks(2);
    const declined = { held: (await C.marker())?.fingerprint === profileFingerprint(Y), routing: await C.routing(), x: w.folder.holds(X), y: w.folder.holds(Y) };
    await C.answer(Y, "replaced");
    await C.ticks(3);
    expect({ declined, next: { held: (await C.marker())?.fingerprint === profileFingerprint(X), x: w.folder.holds(X), y: w.folder.holds(Y) } }).toEqual({
      declined: { held: true, routing: "closed", x: true, y: true },
      next: { held: true, x: true, y: false },
    });
  });

  it("Import of each in turn leaves one copy that says them all", async () => {
    const w = await stores();
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant("w-a", X);
    await w.plant("w-b", Y);
    const C = await w.store("w-c");
    await C.takeOver();
    await C.importIt(Y);
    await C.ticks(3);
    await C.importIt(X);
    await C.ticks(4);
    expect({ copies: w.folder.parsed().map((p) => [p.installId, [...p.doc!.tagNames].sort()]), asking: await C.asking() })
      .toEqual({ copies: [["w-c", ["anna", "ben"]]], asking: null });
  });

  it("at most eight found copies are kept: the ninth, oldest, follows the ten-minute rule", async () => {
    const w = await stores();
    const docs = Array.from({ length: 9 }, (_, i) => w.doc(`p${i}`, 60 + i * 15));
    for (const [i, d] of docs.entries()) await w.plant(`w-${i}`, d);
    const C = await w.store("w-c");
    await C.takeOver();
    await C.decide("c1");
    await C.ticks(3);
    expect(docs.map((d) => w.folder.holds(d))).toEqual([true, true, true, true, true, true, true, true, false]);
  });

  // At the shipped five-minute flush interval: the released copy goes only once the store's copy says it.
  const says = (w: Awaited<ReturnType<typeof stores>>, tag: string): boolean => w.folder.parsed().some((p) => p.doc!.tagNames.includes(tag));
  it.each(["inline", "handed over"] as const)(
    "Not now on the newer, Import (%s) of the older into an empty store: what it imported stays in the mailbox at every tick",
    async (via) => {
      const w = await stores({ flushIntervalMs: 5 * 60_000 });
      const X = w.doc("anna", 120);
      const Y = w.doc("ben", 60);
      await w.plant("w-a", X);
      await w.plant("w-b", Y);
      const C = await w.store("w-c");
      await C.takeOver();
      await C.answer(Y, "declined");
      await C.ticks(2);
      const asked = (await C.asking()) === profileFingerprint(X);
      if (via === "inline") await C.importInline(X); else await C.importIt(X);
      const said: boolean[] = [];
      for (let i = 0; i < 14; i++) {
        await C.ticks(1);
        if (i === 10) w.later(20 * 60_000);
        said.push(says(w, "anna"));
      }
      expect({ asked, said: said.every(Boolean), ours: w.folder.tagsOf("w-c"), y: w.folder.holds(Y), writers: w.folder.writers() })
        .toEqual({ asked: true, said: true, ours: [["anna"]], y: true, writers: ["w-b", "w-c"] });
    },
  );

  it("a published store imports the newer copy while the older one waits: what it imported stays in the mailbox at every tick", async () => {
    const w = await stores({ flushIntervalMs: 5 * 60_000 });
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant("w-a", X);
    await w.plant("w-b", Y);
    const C = await w.store("w-c");
    await C.decide("c1");
    await C.takeOver();
    await C.ticks(1);
    const published = w.folder.tagsOf("w-c");
    await C.importIt(Y);
    const said: boolean[] = [];
    for (let i = 0; i < 12; i++) { await C.ticks(1); said.push(says(w, "ben")); }
    expect({ published, said: said.every(Boolean), x: w.folder.holds(X), asking: (await C.asking()) === profileFingerprint(X) })
      .toEqual({ published: [["c1"]], said: true, x: true, asking: true });
  });

  it("an Import, the lid shut two passes later, another store taking over: the imported settings are still in the mailbox", async () => {
    const w = await stores({ flushIntervalMs: 5 * 60_000 });
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant("w-a", X);
    await w.plant("w-b", Y);
    const C = await w.store("w-c");
    await C.takeOver();
    await C.answer(Y, "declined");
    await C.ticks(2);
    await C.importInline(X);
    await C.ticks(2);
    w.later(30 * 60_000);
    const D = await w.store("w-d");
    await D.takeOver();
    await D.ticks(3);
    expect({ anna: says(w, "anna"), ben: says(w, "ben") }).toEqual({ anna: true, ben: true });
  });

  /* A phone keeps its install id across Stop and remove: a gone store's copies under it are found settings, and
     Not now on the newest still lets a decision reach the mailbox beside them. */
  it("one install id across three stores: Not now on the newest, a decision, Stop leaves the decision in the mailbox", async () => {
    const { w, X, Y } = await aThenB({ idA: "w-phone", idB: "w-phone", bAnswers: "notNow" });
    const C = await w.store("w-phone");
    await C.takeOver();
    const askedFirst = (await C.asking()) === profileFingerprint(Y);
    await C.answer(Y, "declined");
    await C.decide("c1");
    await C.ticks(3);
    const left = await C.stopAndRemove();
    expect({ askedFirst, left, c1: says(w, "c1"), x: w.folder.holds(X), y: w.folder.holds(Y), askingNext: (await C.asking()) === profileFingerprint(X) })
      .toEqual({ askedFirst: true, left: "saved", c1: true, x: true, y: true, askingNext: true });
  });

  it.each([
    ["the phone's copy older, a desktop's newer", "w-phone", "w-desk"],
    ["the phone's copy newer, a desktop's older", "w-desk", "w-phone"],
  ] as const)("%s, an empty phone store says Not now to the newer and decides: Stop leaves the decision in the mailbox", async (_, byOlder, byNewer) => {
    const w = await stores();
    const X = w.doc("anna", 120);
    const Y = w.doc("ben", 60);
    await w.plant(byOlder, X);
    await w.plant(byNewer, Y);
    const C = await w.store("w-phone");
    await C.takeOver();
    const askedFirst = (await C.asking()) === profileFingerprint(Y);
    await C.answer(Y, "declined");
    await C.decide("c1");
    await C.ticks(3);
    const left = await C.stopAndRemove();
    expect({ askedFirst, left, c1: says(w, "c1"), x: w.folder.holds(X), y: w.folder.holds(Y) })
      .toEqual({ askedFirst: true, left: "saved", c1: true, x: true, y: true });
  });

  /* A RESTORED STORE'S LATER COPY AT THE NEXT SWITCH (tester C, round 28): the restored store keeps its later
     life's copy L (a decision the backup lacks) and, after Not now on it, publishes its own (a decision since) beside
     it; a fresh phone B says Not now, decides, and its Stop writes 18 minutes after L. L stays, and a fresh store C
     asks about B's copy, then A's, then L. */
  it("a restored store's later copy, Not now, its own copy beside it, then B and Stop and remove: L stays and C asks about it", async () => {
    const w = await stores();
    const A = await w.store("w-a");
    await A.decide("a1");
    await A.takeOver();
    // The backup is taken here. The later life lets a sender in and writes L in place of the store's copy.
    w.later(6 * 60_000);
    const L = makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["a1", "d1"], signature: null },
      { updatedAt: w.clock.at, producer: { kind: "mobile", version: "0.30.22" } });
    w.folder.messages = w.folder.messages.filter((m) => !m.raw.includes("X-Ohmail-Install-Id: w-a"));
    await w.plant("w-a", L);
    // Restored: a decision before it reads the folder, then Not now on L and its own copy beside it.
    w.later(60_000);
    await A.decide("d2");
    await A.restart();
    const restoredAsked = (await A.asking()) === profileFingerprint(L);
    await A.answer(L, "declined");
    w.later(6 * 60_000);
    await A.ticks(2);
    const aLeft = await A.stopAndRemove({ gap: true });
    const ofA = w.folder.docBy("w-a");
    w.later(60_000);
    const B = await w.store("w-b");
    await B.takeOver();
    const bAsked = (await B.asking()) === profileFingerprint(ofA);
    await B.answer(ofA, "declined");
    await B.decide("d3");
    w.later(6 * 60_000);
    await B.ticks(3);
    const bLeft = await B.stopAndRemove({ gap: true });
    const ofB = w.folder.docBy("w-b");
    const afterB = { l: w.folder.holds(L), ofA: w.folder.holds(ofA), lOlderMin: Math.round((Date.parse(ofB.updatedAt) - Date.parse(L.updatedAt)) / 60_000) };
    w.later(4 * 60_000);
    const C = await w.store("w-c");
    await C.takeOver();
    const name = async (): Promise<string | null> => {
      const fp = await C.asking();
      return fp === profileFingerprint(ofB) ? "B" : fp === profileFingerprint(ofA) ? "A" : fp === profileFingerprint(L) ? "L" : fp;
    };
    const offered = [await name()];
    await C.answer(ofB, "declined");
    await C.ticks(2);
    offered.push(await name());
    await C.answer(ofA, "declined");
    await C.ticks(2);
    offered.push(await name());
    expect({ restoredAsked, aLeft, aTags: [...ofA.tagNames].sort(), bAsked, bLeft, afterB, offered, kept: [L, ofA, ofB].map((d) => w.folder.holds(d)) })
      .toEqual({
        restoredAsked: true, aLeft: "saved", aTags: ["a1", "d2"], bAsked: true, bLeft: "saved",
        afterB: { l: true, ofA: true, lOlderMin: 18 }, offered: ["B", "A", "L"], kept: [true, true, true],
      });
  });

  // An older copy another install appends beside an established organizer, never asked about, still goes by the ten-minute rule.
  it("an old copy appended beside an established organizer mid-life is removed by the ten-minute rule", async () => {
    const w = await stores();
    const E = await w.store("w-e");
    await E.decide("e1");
    await E.takeOver();
    await E.ticks(1);
    const stray = w.doc("stray", 60);
    await w.plant("w-stray", stray);
    await E.ticks(3);
    expect({ stray: w.folder.holds(stray), asking: await E.asking() }).toEqual({ stray: false, asking: null });
  });
});
