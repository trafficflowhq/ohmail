import { describe, expect, it } from "vitest";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint, profileLocatorOf, readFoundCopies,
  readOrganizerProfile, tidyOrganizerProfile, writeOrganizerProfile,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileIo, type ProfileListOptions, type ProfileLocator, type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";

/**
 * THE HELD RECORD STAYS BESIDE THIS INSTALL'S OWN DOCUMENT. While an organizer asks about settings
 * another install left, its writes publish beside that record (`retain`), its tidy keeps it and its
 * reads find it by locator after its own document became the newest. A third install's tidy, which
 * holds no question, removes it by the ordinary rule. To watch it fail: drop `retain` from the
 * write's `unseen` test, from `planTidy`, or from the read.
 */

const PRODUCER = { kind: "local", version: "0.0.0" };
const EMPTY: OrganizerProfilePayload = { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null };
const OLD = new Date("2026-09-10T08:00:00.000Z");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);

class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  private uid = 1;
  refuseRemovals = false;
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1 })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.uid++, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    if (this.refuseRemovals) throw new Error("NO the server refused the expunge");
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
  writers(): string[] {
    return this.messages.map((m) => /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim() ?? "?");
  }
}

/** A server's listing: the newest message by body, every other one by header unless `bodyFor` names it. */
class HeadersFolder extends Folder {
  override async listProfileMessages(opts?: ProfileListOptions): Promise<RawProfileMessage[]> {
    const top = Math.max(...this.messages.map((m) => m.ref as number));
    return this.messages.map((m) => {
      const headerBlock = m.raw.slice(0, /\r?\n\r?\n/.exec(m.raw)?.index ?? m.raw.length);
      return m.ref === top || opts?.bodyFor?.({ ref: m.ref, headerBlock }) === true
        ? { ...m, generation: 1 } : { ref: m.ref, raw: headerBlock, generation: 1, headerOnly: true as const };
    });
  }
}

function heldFolder(): { folder: Folder; held: OrganizerProfileDoc; raw: string } {
  const folder = new Folder();
  const held = makeProfileDoc({ ...EMPTY, tagNames: ["theirs"] }, { updatedAt: OLD, producer: PRODUCER });
  const raw = formatProfileMessage(held, { installId: "w-old" });
  void folder.appendProfile(raw);
  return { folder, held, raw };
}
const mine = (tag: string, when: Date): OrganizerProfileDoc =>
  makeProfileDoc({ ...EMPTY, tagNames: [tag] }, { updatedAt: when, producer: PRODUCER });

describe("a write beside the held record", () => {
  it("CONTROL: without the locator the held record refuses the write, as before", async () => {
    const { folder } = heldFolder();
    const r = await writeOrganizerProfile({ io: folder, doc: mine("a", NOW), installId: "w-new", now: NOW });
    expect(r).toMatchObject({ written: false, reason: "foreign" });
  });

  it("publishes beside it, and each later write replaces its own copy and keeps the held one", async () => {
    const { folder, held, raw } = heldFolder();
    const retain = profileLocatorOf("w-old", held)!;
    expect(await writeOrganizerProfile({ io: folder, doc: mine("a", NOW), installId: "w-new", now: NOW, retain }))
      .toEqual({ written: true, removed: 0 });
    expect(await writeOrganizerProfile({ io: folder, doc: mine("b", at(1)), installId: "w-new", now: at(1), retain }))
      .toEqual({ written: true, removed: 1 });
    expect(folder.writers().sort()).toEqual(["w-new", "w-old"]);
    expect(folder.messages.find((m) => m.raw.includes("w-old"))?.raw, "the held record changed").toBe(raw);
  });
});

describe("the tidy and the reads", () => {
  async function published() {
    const h = heldFolder();
    const retain = profileLocatorOf("w-old", h.held)!;
    await writeOrganizerProfile({ io: h.folder, doc: mine("a", NOW), installId: "w-new", now: NOW, retain });
    return { ...h, retain };
  }

  it("the holder's tidy keeps it; a third install's tidy, which asks nothing, removes it", async () => {
    const { folder, retain } = await published();
    const kept = await tidyOrganizerProfile({ io: folder, installId: "w-new", now: at(20), retain });
    expect({ removed: kept.removed, keptHeld: kept.planned?.keptHeld }).toEqual({ removed: 0, keptHeld: 1 });
    expect(folder.writers().sort()).toEqual(["w-new", "w-old"]);
    const third = await tidyOrganizerProfile({ io: folder, installId: "w-third", now: at(20) });
    expect(third.removed).toBe(1);
    expect(folder.writers()).toEqual(["w-new"]);
  });

  /* A RELEASED RECORD GOES WHATEVER ITS AGE: written a minute before this install's own, it is too
     fresh for the ten-minute rule, and only the caller's `released` locator removes it. The folder
     reads bodies for the newest and the located records only, as a server does. To watch it fail:
     drop the `released` arm from `planTidy`, or the locators from the tidy's listing. */
  it("a released record is removed beside this install's own; fresh and not released, it is kept", async () => {
    const folder = new HeadersFolder();
    const theirs = makeProfileDoc({ ...EMPTY, tagNames: ["theirs"] }, { updatedAt: at(-1), producer: PRODUCER });
    await folder.appendProfile(formatProfileMessage(theirs, { installId: "w-old" }));
    await folder.appendProfile(formatProfileMessage(mine("a", NOW), { installId: "w-new" }));
    const kept = await tidyOrganizerProfile({ io: folder, installId: "w-new", now: NOW });
    expect({ removed: kept.removed, fresh: kept.planned?.keptForeignFresh }).toEqual({ removed: 0, fresh: 1 });
    const gone = await tidyOrganizerProfile({ io: folder, installId: "w-new", now: NOW, released: [profileLocatorOf("w-old", theirs)!] });
    expect({ removed: gone.removed, released: gone.planned?.released, writers: folder.writers() })
      .toEqual({ removed: 1, released: 1, writers: ["w-new"] });
  });

  /* THE QUESTION ON A SERVER'S LISTING: bodies come for the newest Date only, so the other
     install's document beside this install's newer one is a header. The organizer's question read
     (`foreignTo`) must still answer it. To watch it fail: drop the second listing from
     `readOrganizerProfile`. */
  it("a foreignTo read on a server's listing answers the other install's document beside a newer own one", async () => {
    const folder = new HeadersFolder();
    const theirs = makeProfileDoc({ ...EMPTY, tagNames: ["theirs"] }, { updatedAt: at(-1), producer: PRODUCER });
    await folder.appendProfile(formatProfileMessage(theirs, { installId: "w-old" }));
    await folder.appendProfile(formatProfileMessage(mine("a", NOW), { installId: "w-new" }));
    const plain = await readOrganizerProfile(folder);
    const question = await readOrganizerProfile(folder, { foreignTo: "w-new" });
    expect({
      plain: plain.state === "found" ? plain.installId : plain.state,
      question: question.state === "found" ? [question.installId, profileFingerprint(question.doc)] : question.state,
    }).toEqual({ plain: "w-new", question: ["w-old", profileFingerprint(theirs)] });
  });

  it("a read by locator answers the held record, the plain read the newest, and residue leaves it out", async () => {
    const { folder, held, retain } = await published();
    const byLocator = await readOrganizerProfile(folder, { installId: "w-new", now: at(20), retain });
    const plain = await readOrganizerProfile(folder, { installId: "w-new", now: at(20) });
    expect({
      byLocator: byLocator.state === "found" ? [byLocator.installId, profileFingerprint(byLocator.doc), byLocator.residue] : byLocator.state,
      plain: plain.state === "found" ? [plain.installId, plain.residue] : plain.state,
    }).toEqual({ byLocator: ["w-old", profileFingerprint(held), 0], plain: ["w-new", 1] });
  });

  it("`foreignTo` answers the newest document another install wrote, and ours where there is none", async () => {
    const { folder, retain } = await published();
    const asked = await readOrganizerProfile(folder, { foreignTo: "w-new" });
    expect(asked.state === "found" ? asked.installId : asked.state).toBe("w-old");
    folder.messages = folder.messages.filter((m) => !m.raw.includes("w-old"));
    const none = await readOrganizerProfile(folder, { foreignTo: "w-new" });
    expect(none.state === "found" ? none.installId : none.state, "no other install's document: ours").toBe("w-new");
    void retain;
  });

  it("a locator that names nothing is a record that is gone: the read answers the newest", async () => {
    const { folder, retain } = await published();
    folder.messages = folder.messages.filter((m) => !m.raw.includes("w-old"));
    const read = await readOrganizerProfile(folder, { retain });
    expect(read.state === "found" ? read.installId : read.state).toBe("w-new");
  });
});

describe("the bound on a server that refuses every removal", () => {
  it("at most this install's copy, the held record and one older copy of its own", async () => {
    const { folder, held } = heldFolder();
    const retain = profileLocatorOf("w-old", held)!;
    folder.refuseRemovals = true;
    const most: number[] = [];
    for (let i = 0; i < 6; i++) {
      await writeOrganizerProfile({ io: folder, doc: mine(`t${i}`, at(i)), installId: "w-new", now: at(i), retain })
        .catch(() => undefined);
      most.push(folder.messages.length);
    }
    expect(Math.max(...most)).toBeLessThanOrEqual(3);
    expect(folder.writers()).toContain("w-old");
  });
});

describe("kept found copies", () => {
  it("the tidy keeps a kept copy whatever its age; one not kept goes by the ten-minute rule", async () => {
    const folder = new Folder();
    const x = makeProfileDoc({ ...EMPTY, tagNames: ["x"] }, { updatedAt: OLD, producer: PRODUCER });
    const z = makeProfileDoc({ ...EMPTY, tagNames: ["z"] }, { updatedAt: at(-120), producer: PRODUCER });
    const y = makeProfileDoc({ ...EMPTY, tagNames: ["y"] }, { updatedAt: at(-60), producer: PRODUCER });
    await folder.appendProfile(formatProfileMessage(x, { installId: "w-a" }));
    await folder.appendProfile(formatProfileMessage(z, { installId: "w-z" }));
    await folder.appendProfile(formatProfileMessage(y, { installId: "w-b" }));
    const tidied = await tidyOrganizerProfile({ io: folder, installId: "w-c", now: NOW, kept: [profileLocatorOf("w-a", x)!] });
    expect({ writers: folder.writers().sort(), keptHeld: tidied.planned?.keptHeld, foreignStale: tidied.planned?.foreignStale })
      .toEqual({ writers: ["w-a", "w-b"], keptHeld: 1, foreignStale: 1 });
  });

  it("a write publishes beside a kept copy that is the newest, and never removes it", async () => {
    const folder = new Folder();
    const y = makeProfileDoc({ ...EMPTY, tagNames: ["y"] }, { updatedAt: at(-1), producer: PRODUCER });
    await folder.appendProfile(formatProfileMessage(y, { installId: "w-b" }));
    const r1 = await writeOrganizerProfile({ io: folder, doc: mine("c", NOW), installId: "w-c", now: NOW, kept: [profileLocatorOf("w-b", y)!] });
    const r2 = await writeOrganizerProfile({ io: folder, doc: mine("d", at(1)), installId: "w-c", now: at(1), kept: [profileLocatorOf("w-b", y)!] });
    expect({ r1, r2, writers: folder.writers().sort() })
      .toEqual({ r1: { written: true, removed: 0 }, r2: { written: true, removed: 1 }, writers: ["w-b", "w-c"] });
  });

  it("readFoundCopies reads every copy that is not the caller's, newest first, by body, at most the bound", async () => {
    const folder = new HeadersFolder();
    const docs = [0, 1, 2].map((i) => makeProfileDoc({ ...EMPTY, tagNames: [`f${i}`] }, { updatedAt: at(-10 * (i + 1)), producer: PRODUCER }));
    for (const [i, d] of docs.entries()) await folder.appendProfile(formatProfileMessage(d, { installId: `w-${i}` }));
    await folder.appendProfile(formatProfileMessage(mine("own", NOW), { installId: "w-c" }));
    const read = await readFoundCopies(folder, { installId: "w-c", max: 2 });
    expect(read.state === "read" ? read.copies.map((c) => [c.installId, c.doc.tagNames]) : read)
      .toEqual([["w-0", ["f0"]], ["w-1", ["f1"]]]);
  });

  // A torn copy is read and examined all the same; nothing the caller skips is read again.
  it("readFoundCopies reads the next batch past what the caller skips, and says what it read and whether more wait", async () => {
    const folder = new HeadersFolder();
    const docs = [0, 1, 2, 3, 4].map((i) => makeProfileDoc({ ...EMPTY, tagNames: [`f${i}`] }, { updatedAt: at(-10 * (i + 1)), producer: PRODUCER }));
    for (const [i, d] of docs.entries()) await folder.appendProfile(formatProfileMessage(d, { installId: `w-${i}` }));
    await folder.appendProfile([
      "X-Ohmail-Profile: 1", "X-Ohmail-Install-Id: w-torn", "X-Ohmail-Profile-Version: 2",
      "Subject: ohmail settings for this mailbox", `Date: ${at(-25).toUTCString()}`, "", "{ torn",
    ].join("\r\n"));
    await folder.appendProfile(formatProfileMessage(mine("own", NOW), { installId: "w-c" }));
    const judged = new Set<string>();
    const batches: unknown[] = [];
    for (let n = 0; n < 4; n++) {
      const read = await readFoundCopies(folder, { installId: "w-c", max: 2, skip: (id, second) => judged.has(`${id} ${second}`) });
      if (read.state !== "read") throw new Error(read.state);
      for (const [id, second] of read.examined) judged.add(`${id} ${second}`);
      batches.push({ copies: read.copies.map((c) => c.installId), examined: read.examined.map(([id]) => id), more: read.more });
    }
    expect(batches).toEqual([
      { copies: ["w-0", "w-1"], examined: ["w-0", "w-1"], more: true },
      { copies: ["w-2"], examined: ["w-torn", "w-2"], more: true },
      { copies: ["w-3", "w-4"], examined: ["w-3", "w-4"], more: false },
      { copies: [], examined: [], more: false },
    ]);
  });
});

/* WHAT THE ORGANIZER HAS READ OF THE FOUND COPIES (`found`). Until it has read them all, no copy goes by age; once
   it has, a copy under its id that is not its own and that it does not keep follows the ten-minute rule like
   another install's. Absent, the plan is the one before. Beside C (ours, recorded): another install's copy an hour
   older, and two under our id with no record, two and three hours older, the first of them kept. */
describe("the found copies read", () => {
  async function folderOf(): Promise<{ folder: Folder; named: ProfileLocator }> {
    const folder = new HeadersFolder();
    const named = makeProfileDoc({ ...EMPTY, tagNames: ["named"] }, { updatedAt: at(-120), producer: PRODUCER });
    await folder.appendProfile(formatProfileMessage(makeProfileDoc({ ...EMPTY, tagNames: ["unnamed"] }, { updatedAt: at(-180), producer: PRODUCER }), { installId: "w-c" }));
    await folder.appendProfile(formatProfileMessage(named, { installId: "w-c" }));
    await folder.appendProfile(formatProfileMessage(makeProfileDoc({ ...EMPTY, tagNames: ["z"] }, { updatedAt: at(-60), producer: PRODUCER }), { installId: "w-z" }));
    await folder.appendProfile(formatProfileMessage(mine("c", NOW), { installId: "w-c" }));
    return { folder, named: profileLocatorOf("w-c", named)! };
  }
  const owns = (second: number): boolean => second === Math.floor(NOW.getTime() / 1000);
  const tidy = (folder: Folder, mode: "count" | "remove", found?: { read: "all" | "partly"; kept: readonly ProfileLocator[] }) =>
    tidyOrganizerProfile({ io: folder, installId: "w-c", mode, now: at(1), owns, ...(found === undefined ? {} : { found }) });
  const counts = (r: Awaited<ReturnType<typeof tidy>>) => {
    const { removable, foreignStale, keptFound, foundStale, keptUnread } = r.planned!;
    return { removable, foreignStale, keptFound, foundStale, keptUnread };
  };

  it("partly keeps every copy that would go by age; all lets the copy under our id it does not keep go; absent is the plan before", async () => {
    const { folder, named } = await folderOf();
    expect({
      absent: counts(await tidy(folder, "count")),
      partly: counts(await tidy(folder, "count", { read: "partly", kept: [named] })),
      all: counts(await tidy(folder, "count", { read: "all", kept: [named] })),
    }).toEqual({
      absent: { removable: 1, foreignStale: 1, keptFound: 2, foundStale: 0, keptUnread: 0 },
      partly: { removable: 0, foreignStale: 0, keptFound: 0, foundStale: 0, keptUnread: 3 },
      all: { removable: 2, foreignStale: 1, keptFound: 1, foundStale: 1, keptUnread: 0 },
    });
  });

  // The write's own rule: another install's current copy this organizer has not seen may ask about one of them.
  it("beside another install's newer copy it has not seen, a copy under its id it does not keep stays", async () => {
    const { folder, named } = await folderOf();
    await folder.appendProfile(formatProfileMessage(makeProfileDoc({ ...EMPTY, tagNames: ["theirs"] }, { updatedAt: at(1), producer: PRODUCER }), { installId: "w-y" }));
    expect(counts(await tidy(folder, "count", { read: "all", kept: [named] })))
      .toEqual({ removable: 1, foreignStale: 1, keptFound: 2, foundStale: 0, keptUnread: 0 });
  });

  it("all removes another install's copy and ours it does not keep, and keeps the one it names", async () => {
    const { folder, named } = await folderOf();
    await tidy(folder, "remove", { read: "all", kept: [named] });
    expect(folder.messages.map((m) => {
      const p = parseProfileMessage(m.raw, m.ref);
      return p === null || isMalformedProfile(p) ? "?" : p.doc!.tagNames[0];
    })).toEqual(["named", "c"]);
  });
});
