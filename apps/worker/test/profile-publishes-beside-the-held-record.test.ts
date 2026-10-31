import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, contacts, latestProfileFoundMarker, mailboxes, recordImportAsk, recordProfileImportResolution, tags,
  type Tx,
} from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ParsedProfileMessage, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync } from "../src/profile.js";
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
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1 })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.uid++, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { this.messages = this.messages.filter((m) => !refs.includes(m.ref)); }
  writers(): string[] { return this.messages.map((m) => /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim() ?? "?").sort(); }
  copies(): Array<{ by: string | null; screener: number; rules: number; tags: string[] }> {
    return this.messages.map((m) => parseProfileMessage(m.raw, m.ref))
      .filter((p): p is ParsedProfileMessage => p !== null && !isMalformedProfile(p))
      .map((p) => ({ by: p.installId, screener: p.doc!.screener.length, rules: p.doc!.rules.length, tags: [...p.doc!.tagNames].sort() }));
  }
}

const THEIRS = makeProfileDoc({
  screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date("2026-09-10T08:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
const THEIRS_RAW = formatProfileMessage(THEIRS, { installId: "w-old" });

/** `by` writes the planted document (another install by default); `rowAt` dates this store's rows. */
async function rig(o: { planted: boolean; theirs?: OrganizerProfileDoc; by?: string; rowAt?: Date; baseline?: true }) {
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
    db, ...at, adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId, kind: "local" }, producerVersion: "test", flushIntervalMs: 0,
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
  const decide = (name: string) => db.insert(tags).values({ accountId, name });
  const answer = (decision: "declined" | "replaced") => recordProfileImportResolution(db, {
    accountId, mailboxId: mb!.id, decision, fingerprint: profileFingerprint(theirs),
  });
  const ticks = async (n: number, s = sync): Promise<void> => {
    for (let i = 0; i < n; i++) { later(31_000); await s.onOrganize(); }
  };
  const routing = async (s = sync): Promise<string> => (await s.importHoldNow())?.kind ?? "closed";
  return { db, sync, folder, decide, answer, later, attach, store, ticks, routing, clock, accountId, mailboxId: mb!.id };
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

  // The next organizer finds the removed store's copy itself, never a newer one of ours beside it.
  it.each([
    ["the same id's next store, after Not now and a decision", "w-new", true],
    ["another install taking over after a decision", "w-desk", false],
  ] as const)("%s still asks about it, holds its senders and keeps it", async (_, installId, declined) => {
    const r = await reconnect();
    if (declined) await r.answer("declined");
    await r.decide("fresh");
    await r.ticks(3);
    r.later(20 * 60_000);
    const next = await r.store(installId);
    await next.sync.armHoldFromFolder();
    await r.ticks(3, next.sync);
    const hold = await next.sync.importHoldNow();
    const marker = await latestProfileFoundMarker(r.db, next.accountId, next.mailboxId);
    expect({
      kept: kept(r), copies: r.folder.messages.length, asked: marker?.fingerprint === profileFingerprint(PREVIOUS),
      senders: hold?.kind === "document" ? [...hold.knownSenders.addresses].sort() : hold,
    }).toEqual({ kept: true, copies: 1, asked: true, senders: ["anna@example.test", "ben@example.test"] });
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
