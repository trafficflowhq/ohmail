import { describe, expect, it } from "vitest";
import {
  FixturesAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  isPersonsOwnFolder,
  presentationReader,
  pressOutcome,
  stayVerdict,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE PRESS SENTENCE OVER MAIL ANOTHER APP FILED. The rule's pass leaves a
 * message in a folder the person made, so the sentence every surface says after the press names
 * it as staying (`still`) and never "all 5" over six. Trash and Junk are the person's own putting
 * away and are not the press's; while the pass still moves rows the sentence is `applying`.
 */
const NOW = new Date("2026-10-02T21:00:00.000Z");
const ADDR = "letters@vendor.example";
let seq = 0;

const rule: RuleDTO = {
  id: "r", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
  subjectContains: null, bodyContains: null,
} as RuleDTO;

function message(id: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-09-28T09:00:00.000Z", folder: folder as Folder,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-28T09:00:00.000Z",
  } as EngineMessage;
}

async function verdictOf(mail: EngineMessage[], retro: boolean) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...mail.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    { type: "rule", op: "create", id: rule.id, seq: ++seq, updatedAt: rule.updatedAt, entity: rule },
  ] as SyncChange[]);
  const presented = presentationReader(store, consentPartition(store, { now: NOW }));
  return stayVerdict(pressOutcome({ presented, subject: mail, rules: [rule], profiles: [], wanted: "INBOX", retro }), store);
}

const five = Array.from({ length: 5 }, (_, i) => message(`in-${i}`, "INBOX"));

describe("a folder the person made is where a press leaves mail", () => {
  it("names the classes: a folder of theirs, never an organized, Sent, Trash or Junk folder", () => {
    expect(["Fixture", "Archive/2026", "INBOX/Projects"].map((f) => isPersonsOwnFolder(f, "mb"))).toEqual([true, true, true]);
    expect(["INBOX", "ohmail/News", "Sent", "Trash", "INBOX/Junk", "Spam", "Drafts", null].map((f) => isPersonsOwnFolder(f, "mb")))
      .toEqual([false, false, false, false, false, false, false, false]);
  });

  it("five at the place and one in Fixture: still, 5 and 1, never none", async () => {
    expect(await verdictOf([...five, message("fix-1", "Fixture")], false))
      .toMatchObject({ key: "still", count: 5, still: 1, stillPlace: "Fixture", ids: ["fix-1"] });
  });

  it("Trash and Junk copies are not the press's: all five, none", async () => {
    expect(await verdictOf([...five, message("t-1", "Trash"), message("j-1", "INBOX/Junk")], false)).toEqual({ key: "none" });
  });

  it("while the pass still moves rows the sentence is applying; the read at its end says still", async () => {
    const moving = message("news-1", "ohmail/News");
    expect(await verdictOf([...five, moving, message("fix-1", "Fixture")], true)).toEqual({ key: "applying", count: 5 });
    expect(await verdictOf([...five, message("fix-1", "Fixture")], false)).toMatchObject({ key: "still", still: 1 });
  });

  it("positive control: a sender ohmail filed all of reads none, as before", async () => {
    expect(await verdictOf(five, true)).toEqual({ key: "none" });
  });

  it("the mailbox's recorded Sent folder is Sent, not a folder of theirs: none; unstated it still is", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => NOW });
    expect(await verdictOf([...five, message("nl-1", "INBOX/Verzonden")], false)).toMatchObject({ key: "still", still: 1 });
    try {
      engine.setSentFolders([{ id: "mb", sentFolder: "INBOX/Verzonden" }]);
      expect(isPersonsOwnFolder("INBOX/Verzonden", "mb")).toBe(false);
      expect(isPersonsOwnFolder("INBOX/Verzonden", "mb-other")).toBe(true);
      expect(await verdictOf([...five, message("nl-1", "INBOX/Verzonden")], false)).toEqual({ key: "none" });
    } finally {
      engine.setSentFolders([]);
    }
  });
});
