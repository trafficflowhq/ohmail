import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accountSettings, accounts, mailboxProfileMirror, mailboxes, rules, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, readOrganizerProfile,
  type OrganizerProfileDoc, type ProfileIo, type ProfileScreening, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { readOrganizerScreening, serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { OrganizerProfileSync, applyProfileRead } from "../src/profile.js";

/**
 * THE ORGANIZER PUBLISHES ITS SCREENING WINDOW (RULING-026). One write point, the write-behind
 * tick: the window rides the envelope, read in the payload's own snapshot, and a dial moved with an
 * unchanged payload is dirty through its own trigger. A takeover meeting a copy that differs only
 * in the window holds nothing: the envelope is no import question.
 */

class ProfileFolder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  appends = 0;
  next = 1;
  async ensureMetaFolder(): Promise<void> { /* the folder exists */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.messages.map((m) => ({ ...m, generation: 7 }));
  }
  async appendProfile(raw: string): Promise<void> {
    this.appends += 1;
    this.messages.push({ ref: this.next++, raw, generation: 7 });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

function docsIn(folder: ProfileFolder): OrganizerProfileDoc[] {
  return folder.messages.flatMap((m) => {
    const r = parseProfileMessage(m.raw);
    return r === null || isMalformedProfile(r) || r.doc === undefined ? [] : [r.doc];
  });
}

async function rig(o: { baselineAt?: Date | null; dormancyDays?: number | null; installId?: string } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "window", createdAt: new Date("2026-01-01T00:00:00Z") });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning({ id: mailboxes.id });
  const mailboxId = mb!.id;
  await db.insert(accountSettings).values({
    accountId, updatedAt: new Date(),
    screeningBaselineAt: o.baselineAt ?? null, dormancyDays: o.dormancyDays ?? null,
  });
  const folder = new ProfileFolder();
  let clock = Date.parse("2026-10-12T08:00:00Z");
  const lines: Array<{ event: string; state?: unknown }> = [];
  const sync = new OrganizerProfileSync({
    db, accountId, mailboxId,
    adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId: o.installId ?? "this-install", kind: "local" },
    producerVersion: "test",
    flushIntervalMs: 1_000,
    now: () => new Date(clock),
    log: (event, detail) => { lines.push({ event, state: detail.state }); },
  });
  const tick = async (): Promise<void> => { clock += 60_000; await sync.onOrganize(); };
  return { db, accountId, mailboxId, folder, sync, lines, tick };
}

const BASELINE = new Date("2026-07-01T00:00:00Z");

describe("the organizer's window travels in its settings document", () => {
  it("a consented organizer with nothing else configured publishes its window", async () => {
    const r = await rig({ baselineAt: BASELINE, dormancyDays: 30 });
    for (let i = 0; i < 3; i++) await r.tick();
    expect(r.folder.appends).toBe(1);
    expect(docsIn(r.folder)[0]!.screening).toEqual({ baselineAt: BASELINE.toISOString(), dormancyDays: 30, scope: "window" });
  });

  it("an organizer that never consented and holds nothing writes no document (the litter gate stands)", async () => {
    const r = await rig({ baselineAt: null });
    for (let i = 0; i < 3; i++) await r.tick();
    expect(r.folder.appends).toBe(0);
  });

  it("the dial moved with the payload unchanged is republished on the next tick, once", async () => {
    const r = await rig({ baselineAt: BASELINE, dormancyDays: 30 });
    await r.db.insert(tags).values({ accountId: r.accountId, name: "kiln" });
    await r.tick();
    await r.tick();
    expect(r.folder.appends).toBe(1);
    await r.db.update(accountSettings).set({ dormancyDays: 365 }).where(eq(accountSettings.accountId, r.accountId));
    await r.tick();
    await r.tick();
    expect(r.folder.appends).toBe(2);
    const docs = docsIn(r.folder);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.screening?.dormancyDays).toBe(365);
  });

  it("an organizer's own copy from before the key gets its window published once", async () => {
    const r = await rig({ baselineAt: BASELINE, dormancyDays: 30 });
    await r.db.insert(tags).values({ accountId: r.accountId, name: "kiln" });
    const payload = await serializeOrganizerProfile(r.db, r.accountId, r.mailboxId);
    const old = makeProfileDoc(payload, { updatedAt: new Date("2026-10-01T00:00:00Z"), producer: { kind: "local", version: "0.25.22" } });
    await r.folder.appendProfile(formatProfileMessage(old, { installId: "this-install" }));
    r.folder.appends = 0;
    for (let i = 0; i < 4; i++) await r.tick();
    expect(r.folder.appends).toBe(1);
    expect(docsIn(r.folder).map((d) => d.screening?.dormancyDays)).toEqual([30]);
  });
});

describe("a takeover is asked about configuration, never about the window", () => {
  /** A foreign copy of this store's own configuration, with a window of the foreign organizer's. */
  async function foreignCopy(r: Awaited<ReturnType<typeof rig>>, screening: ProfileScreening, extraRule = false) {
    const payload = await serializeOrganizerProfile(r.db, r.accountId, r.mailboxId);
    const foreign = extraRule
      ? { ...payload, rules: [...payload.rules, { kind: "sender", match: "promo@shop.example", destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "manual" }] }
      : payload;
    const doc = makeProfileDoc(foreign, { updatedAt: new Date("2026-10-01T00:00:00Z"), producer: { kind: "cloud", version: "x" }, screening });
    await r.folder.appendProfile(formatProfileMessage(doc, { installId: "the-other-install" }));
    r.folder.appends = 0;
  }
  const holds = (r: Awaited<ReturnType<typeof rig>>): unknown[] =>
    r.lines.filter((l) => l.event === "organizer_profile_detected" && l.state === "found").map((l) => l.state);

  it("differing ONLY in the window: in sync, no hold, and this organizer publishes its own window", async () => {
    const r = await rig({ baselineAt: BASELINE, dormancyDays: 30 });
    await r.db.insert(rules).values({ accountId: r.accountId, kind: "sender", match: "anna@example.org", destination: "INBOX", provenance: "manual" });
    await foreignCopy(r, { baselineAt: "2020-01-01T00:00:00.000Z", dormancyDays: 7, scope: "all_time" });
    for (let i = 0; i < 3; i++) await r.tick();
    expect(holds(r)).toEqual([]);
    expect(r.lines.some((l) => l.event === "organizer_profile_detected" && l.state === "found_in_sync")).toBe(true);
    const docs = docsIn(r.folder);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.screening).toEqual({ baselineAt: BASELINE.toISOString(), dormancyDays: 30, scope: "window" });
  });

  it("control: a differing rule still holds the import question", async () => {
    const r = await rig({ baselineAt: BASELINE, dormancyDays: 30 });
    await r.db.insert(rules).values({ accountId: r.accountId, kind: "sender", match: "anna@example.org", destination: "INBOX", provenance: "manual" });
    await foreignCopy(r, { baselineAt: BASELINE.toISOString(), dormancyDays: 30, scope: "window" }, true);
    await r.tick();
    expect(holds(r)).toEqual(["found"]);
  });
});

describe("the reader's mirror keeps the window it read", () => {
  async function reader() {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `st-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `st-${accountId.slice(0, 8)}@mirror.test`,
      organizerRole: "reader", organizerState: "held", organizedByKind: "local", organizedByName: "Studio Mac",
    }).returning();
    return { db, accountId, mailboxId: mb!.id };
  }
  async function readFrom(raw: string) {
    const folder = new ProfileFolder();
    folder.messages.push({ ref: 4, raw, generation: 7 });
    return readOrganizerProfile(folder);
  }

  it("stores the envelope's window with the document", async () => {
    const w = await reader();
    const window = { baselineAt: BASELINE.toISOString(), dormancyDays: 30, scope: "window" as const };
    const doc = makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
      { updatedAt: new Date("2026-10-12T07:00:00Z"), producer: { kind: "local", version: "t" }, screening: window });
    const lines: string[] = [];
    await applyProfileRead({ db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: new Date(), log: (e) => { lines.push(e); } },
      await readFrom(formatProfileMessage(doc, { installId: "org" })));
    const [row] = await w.db.select().from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect((row!.doc as OrganizerProfileDoc).screening).toEqual(window);
    expect(lines).toEqual(["profile_mirror_written"]);
  });

  it("a malformed window is stored without the key and the refusal is said", async () => {
    const w = await reader();
    const doc = makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
      { updatedAt: new Date("2026-10-12T07:00:00Z"), producer: { kind: "local", version: "t" } }) as unknown as Record<string, unknown>;
    doc.screening = { baselineAt: null, dormancyDays: 0, scope: "window" };
    const lines: string[] = [];
    await applyProfileRead({ db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: new Date(), log: (e) => { lines.push(e); } },
      await readFrom(formatProfileMessage(doc as never, { installId: "org" })));
    const [row] = await w.db.select().from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect("screening" in (row!.doc as object)).toBe(false);
    expect(lines).toEqual(["profile_mirror_written", "profile_mirror_screening_refused"]);
  });
});

describe("the window is read in the payload's own snapshot", () => {
  it("readOrganizerScreening resolves the default and never answers null days", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    expect(await readOrganizerScreening(db, randomUUID())).toEqual({ baselineAt: null, dormancyDays: 60, scope: "window" });
  });
});
