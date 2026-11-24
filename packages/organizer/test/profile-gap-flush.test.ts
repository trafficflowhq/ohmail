import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  PROFILE_VERSION, formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
  type ProfileGap, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import type { OrganizerWriteAuthority } from "../src/lease.js";
import { OrganizerProfileSync, readTravellingGap } from "../src/profile.js";

/**
 * THE GAP A HAND-BACK LEAVES (RULING-026 lane A), through the real module: only the release flush
 * writes the key, once; every other write drops it; a store that never published writes nothing to
 * carry it; a newer format's document is never written over. The folder is an IO this file scripts.
 */
class ProfileFolder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  appends = 0;
  private nextRef = 100;
  async ensureMetaFolder(): Promise<void> { /* the folder exists */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.messages.map((m) => ({ ...m, generation: 1 }));
  }
  async appendProfile(raw: string): Promise<void> {
    this.appends += 1;
    this.messages.push({ ref: this.nextRef++, raw, generation: 1 });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
  /** The gap the newest message carries, read by the parser. */
  gapOfLast(): ProfileGap | undefined {
    const last = parseProfileMessage(this.messages.at(-1)!.raw);
    if (last === null || isMalformedProfile(last)) throw new Error("unreadable");
    return last.doc!.gap;
  }
}

const HELD: OrganizerWriteAuthority = { noLease: "not_supplied" } as OrganizerWriteAuthority;
const SELF = "this-install";
const GAP: ProfileGap = { since: "2026-10-20T09:00:00.000Z", by: SELF, at: "2026-10-20T09:00:29.000Z" };
const LATER: ProfileGap = { since: "2026-10-21T09:00:00.000Z", by: SELF, at: "2026-10-21T09:00:05.000Z" };

async function rig(o: { planted?: { gap?: ProfileGap; installId: string; newer?: boolean } } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const folder = new ProfileFolder();
  if (o.planted !== undefined) {
    const doc = makeProfileDoc({
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["kept"], signature: null,
    }, {
      updatedAt: new Date("2026-10-20T09:00:29Z"), producer: { kind: "mobile", version: "test" },
      ...(o.planted.gap === undefined ? {} : { gap: o.planted.gap }),
    });
    let raw = formatProfileMessage(doc, { installId: o.planted.installId });
    if (o.planted.newer) raw = raw.replace(`"v": ${PROFILE_VERSION}`, `"v": ${PROFILE_VERSION + 1}`);
    folder.messages.push({ ref: 1, raw, generation: 1 });
  }
  await db.insert(accounts).values({ id: accountId, name: "gap", createdAt: new Date("2026-01-01T00:00:00Z") });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning({ id: mailboxes.id });
  const sync = new OrganizerProfileSync({
    db, accountId, mailboxId: mb!.id,
    adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId: SELF, kind: "mobile" },
    producerVersion: "test",
    // The shipped debounce: after the first tick only the flush (or a forced tick) writes.
    flushIntervalMs: 5 * 60 * 1000,
  });
  const decide = (name: string) => db.insert(tags).values({ accountId, name });
  /** An ordinary write-due tick: the debounce spent, no gap. */
  const tick = async () => { (sync as unknown as { lastAttemptAt: number }).lastAttemptAt = 0; await sync.onOrganize(); };
  return { sync, folder, decide, tick };
}

describe("the gap a hand-back leaves in the settings document", () => {
  it("a flush with a gap appends exactly one write carrying it; repeated, it appends none", async () => {
    const r = await rig();
    await r.decide("first");
    await r.sync.onOrganize();
    expect(r.folder.appends).toBe(1);
    expect(r.folder.gapOfLast(), "an ordinary write carried a gap").toBeUndefined();
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("saved");
    expect(r.folder.appends).toBe(2);
    expect(r.folder.gapOfLast()).toEqual(GAP);
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("saved");
    expect(r.folder.appends, "the same gap was written twice").toBe(2);
    // A later hand-back's gap is a new fact.
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: LATER })).toBe("saved");
    expect(r.folder.appends).toBe(3);
    expect(r.folder.gapOfLast()).toEqual(LATER);
  });

  it("the next ordinary write drops the key", async () => {
    const r = await rig();
    await r.decide("first");
    await r.sync.onOrganize();
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("saved");
    expect(r.folder.gapOfLast()).toEqual(GAP);
    await r.tick();
    expect(r.folder.appends).toBe(3);
    expect(r.folder.gapOfLast(), "the key was carried past its hand-back").toBeUndefined();
    await r.tick();
    expect(r.folder.appends, "a gapless store kept rewriting").toBe(3);
  });

  it("a flush without a gap never adds one, and drops one a previous flush left", async () => {
    const r = await rig();
    await r.decide("first");
    await r.sync.onOrganize();
    await r.decide("second");
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    expect(r.folder.appends).toBe(2);
    expect(r.folder.gapOfLast()).toBeUndefined();
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("saved");
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    expect(r.folder.appends).toBe(4);
    expect(r.folder.gapOfLast()).toBeUndefined();
  });

  it("seeding our own key-carrying document republishes it without the key", async () => {
    const r = await rig({ planted: { gap: GAP, installId: SELF } });
    expect(r.folder.gapOfLast(), "premise: the planted document carries the key").toEqual(GAP);
    await r.decide("kept");
    await r.sync.onOrganize();
    expect(r.folder.appends).toBe(1);
    expect(r.folder.gapOfLast(), "a restart carried the key into a new tenure").toBeUndefined();
  });

  it("an empty store that never published writes nothing to carry a key", async () => {
    const r = await rig();
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("saved");
    expect(r.folder.appends).toBe(0);
  });

  it("a newer format's document is never written over, key or not", async () => {
    const r = await rig({ planted: { installId: "another-install", newer: true } });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(await r.sync.flushBeforeLeaving(HELD, undefined, { gap: GAP })).toBe("kept_other");
    expect(r.folder.appends).toBe(0);
  });

  it("a reader reads the key without writing; none, a refused key and a failed read are null", async () => {
    const lines: string[] = [];
    const log = (event: string) => { lines.push(event); };
    const carried = await rig({ planted: { gap: GAP, installId: SELF } });
    expect(await readTravellingGap(carried.folder, log)).toEqual(GAP);
    expect(carried.folder.appends).toBe(0);
    expect(await readTravellingGap((await rig()).folder, log)).toBeNull();
    const forged = await rig({ planted: { gap: { ...GAP, by: "somebody-else" }, installId: SELF } });
    expect(await readTravellingGap(forged.folder, log)).toBeNull();
    expect(lines).toContain("profile_gap_refused");
    const failing = { listProfileMessages: async () => { throw new Error("NO [UNAVAILABLE]"); } } as unknown as ProfileIo;
    expect(await readTravellingGap(failing, log)).toBeNull();
    expect(lines).toContain("profile_gap_read_failed");
  });
});
