import { describe, expect, it } from "vitest";
import {
  formatProfileMessage, makeProfileDoc, readFoundCopies, writeOrganizerProfile,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileIo, type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";

/**
 * WHOSE COPY IS IT. A settings copy under this install's id is its own only when it was written
 * after this install's store began organizing the mailbox (`ownSince`) and, where the store keeps a
 * record, at a second the store recorded (`owns`). A copy from before (a phone removed and added
 * again, a store restored from a backup) is another install's: the write does not replace it, it
 * stays as it is, and it is offered as found settings. And every write tells the store the second of
 * the copy it is about to add before the copy is in the folder.
 */

const PRODUCER = { kind: "local", version: "0.0.0" };
const EMPTY: OrganizerProfilePayload = { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null };
const OLD = new Date("2026-09-10T08:00:00.000Z");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const secondOf = (d: Date): number => Math.floor(d.getTime() / 1000);

class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  private uid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1 })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.uid++, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

const doc = (tag: string, when: Date): OrganizerProfileDoc =>
  makeProfileDoc({ ...EMPTY, tagNames: [tag] }, { updatedAt: when, producer: PRODUCER });

/** A folder holding one copy under this install's id, written at OLD. */
async function withEarlierCopy(): Promise<{ folder: Folder; raw: string }> {
  const folder = new Folder();
  const raw = formatProfileMessage(doc("earlier", OLD), { installId: "w-me" });
  await folder.appendProfile(raw);
  return { folder, raw };
}

describe("a copy under this install's id", () => {
  it("CONTROL: with nothing to say otherwise, it is this install's own and the write replaces it", async () => {
    const { folder } = await withEarlierCopy();
    expect(await writeOrganizerProfile({ io: folder, doc: doc("now", NOW), installId: "w-me", now: NOW }))
      .toEqual({ written: true, removed: 1 });
  });

  it("dated before this install began organizing, it is another install's: kept as it is and found", async () => {
    const { folder, raw } = await withEarlierCopy();
    const ownSince = secondOf(NOW) - 60;
    const r = await writeOrganizerProfile({ io: folder, doc: doc("now", NOW), installId: "w-me", now: NOW, ownSince });
    expect(r).toMatchObject({ written: false, reason: "foreign" });
    expect(folder.messages.map((m) => m.raw)).toEqual([raw]);
    const found = await readFoundCopies(folder, { installId: "w-me", ownSince });
    expect(found.state === "read" ? found.copies.map((c) => c.doc.tagNames) : found).toEqual([["earlier"]]);
  });

  it("at a second this install's store never recorded, it is another install's: kept as it is and found", async () => {
    const { folder, raw } = await withEarlierCopy();
    const owns = (): boolean => false;
    const r = await writeOrganizerProfile({ io: folder, doc: doc("now", NOW), installId: "w-me", now: NOW, owns });
    expect(r).toMatchObject({ written: false, reason: "foreign" });
    expect(folder.messages.map((m) => m.raw)).toEqual([raw]);
    const found = await readFoundCopies(folder, { installId: "w-me", owns });
    expect(found.state === "read" ? found.copies.map((c) => c.doc.tagNames) : found).toEqual([["earlier"]]);
  });
});

describe("the write tells the store its copy's second first", () => {
  it("beforeAppend receives the new copy's second while the folder does not hold the copy yet", async () => {
    const folder = new Folder();
    const asked: Array<{ second: number; held: number }> = [];
    const r = await writeOrganizerProfile({
      io: folder, doc: doc("now", NOW), installId: "w-me", now: NOW,
      beforeAppend: async (second) => { asked.push({ second, held: folder.messages.length }); },
    });
    expect(r).toEqual({ written: true, removed: 0 });
    expect(asked).toEqual([{ second: secondOf(NOW), held: 0 }]);
    expect(folder.messages).toHaveLength(1);
  });

  it("a beforeAppend that throws leaves the folder as it was", async () => {
    const { folder, raw } = await withEarlierCopy();
    const out = await writeOrganizerProfile({
      io: folder, doc: doc("now", NOW), installId: "w-me", now: NOW,
      beforeAppend: async () => { throw new Error("the store could not record the copy"); },
    }).then((v) => v, (e: unknown) => e);
    expect(out).toBeInstanceOf(Error);
    expect(folder.messages.map((m) => m.raw)).toEqual([raw]);
  });
});
