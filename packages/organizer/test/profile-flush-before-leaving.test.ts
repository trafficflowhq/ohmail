import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  PROFILE_VERSION, formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
  type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import type { OrganizerWriteAuthority } from "../src/lease.js";
import { OrganizerProfileSync } from "../src/profile.js";

/**
 * THE LAST SETTINGS WRITE BEFORE A HAND-BACK — `flushBeforeLeaving`, through the real module.
 *
 * A decision made after the last debounced write reaches the mailbox before the claim leaves; a
 * permit that stood down writes nothing, the drain's own publish rule; a document another install
 * saved stays and this install's own is written beside it, `saved`; a newer format's document is
 * never written over and is answered `kept_other`. The folder is an IO this file scripts.
 */
class ProfileFolder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  appends = 0;
  async ensureMetaFolder(): Promise<void> { /* the folder exists */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.messages.map((m) => ({ ...m, generation: 1 }));
  }
  async appendProfile(raw: string): Promise<void> {
    this.appends += 1;
    this.messages.push({ ref: this.messages.length + 1, raw, generation: 1 });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

const HELD: OrganizerWriteAuthority = { noLease: "not_supplied" } as OrganizerWriteAuthority;
const STOOD_DOWN = { revoked: true } as unknown as OrganizerWriteAuthority;

async function rig(o: { foreign?: boolean; newer?: boolean } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const folder = new ProfileFolder();
  if (o.foreign || o.newer) {
    const doc = makeProfileDoc({
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null,
    }, { updatedAt: new Date("2026-09-26T09:40:00Z"), producer: { kind: "local", version: "0.25.1" } });
    let raw = formatProfileMessage(doc, { installId: "another-install" });
    if (o.newer) raw = raw.replace(`"v": ${PROFILE_VERSION}`, `"v": ${PROFILE_VERSION + 1}`);
    folder.messages.push({ ref: 1, raw, generation: 1 });
  }
  await db.insert(accounts).values({ id: accountId, name: "flush", createdAt: new Date("2026-01-01T00:00:00Z") });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning({ id: mailboxes.id });
  const sync = new OrganizerProfileSync({
    db, accountId, mailboxId: mb!.id,
    adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId: "this-install", kind: "mobile" },
    producerVersion: "test",
    // The shipped debounce, so only the flush can be what writes after the first tick.
    flushIntervalMs: 5 * 60 * 1000,
  });
  const decide = (name: string) => db.insert(tags).values({ accountId, name });
  return { sync, folder, decide };
}

describe("the settings write before this install lets the mailbox go", () => {
  it("a decision made since the last write reaches the mailbox first", async () => {
    const r = await rig();
    await r.decide("first");
    await r.sync.onOrganize();
    expect(r.folder.appends).toBe(1);
    await r.decide("second");
    await r.sync.onOrganize();
    expect(r.folder.appends, "the debounce holds the second decision").toBe(1);
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    expect(r.folder.appends).toBe(2);
    // Read by the parser: the body spells a tag name as JSON escapes (FIX-026 commit 2).
    const last = parseProfileMessage(r.folder.messages.at(-1)!.raw);
    expect(last !== null && !isMalformedProfile(last) && last.doc!.tagNames).toContain("second");
    // Nothing new since: no I/O, and the same answer.
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    expect(r.folder.appends).toBe(2);
  });

  it("a permit that stood down writes nothing", async () => {
    const r = await rig();
    await r.decide("first");
    await r.sync.onOrganize();
    await r.decide("second");
    expect(await r.sync.flushBeforeLeaving(STOOD_DOWN)).toBe("not_saved");
    expect(r.folder.appends).toBe(1);
  });

  it("another install's document stays, and this install's own is saved beside it", async () => {
    const r = await rig({ foreign: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    const writers = r.folder.messages.map((m) => /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim());
    expect(writers.sort()).toEqual(["another-install", "this-install"]);
  });

  it("a newer format's document stays, and says so", async () => {
    const r = await rig({ newer: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("kept_other");
    expect(r.folder.appends).toBe(0);
  });

  it("nothing to save is saved", async () => {
    const r = await rig();
    expect(await r.sync.flushBeforeLeaving(HELD)).toBe("saved");
    expect(r.folder.appends).toBe(0);
  });
});
