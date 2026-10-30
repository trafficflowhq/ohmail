import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
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
 * THE SENTENCE NAMES EXACTLY THE MAIL ITS MOVE MOVES (a high review finding, from the
 * reviewer's probes). Staying rows in one place name that place with that place's rows; in more
 * than one they name no single place (`stillSpread`), and `ids` are every row counted. History is a
 * place as the lists show it, a folder of the person's own is a place per mailbox, and a message
 * that failed its checks takes no move, as on the sheet.
 */
const NOW = new Date("2026-10-02T21:00:00.000Z");
const ADDR = "letters@vendor.example";
let seq = 0;

const rule: RuleDTO = {
  id: "r", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
  subjectContains: null, bodyContains: null,
} as RuleDTO;

function message(id: string, folder: string, o: { mailbox?: string; date?: string; auth?: "fail" } = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: o.mailbox ?? "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: o.date ?? "2026-09-28T09:00:00.000Z", folder: folder as Folder,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-28T09:00:00.000Z",
    ...(o.auth ? { authVerdict: o.auth } : {}),
  } as EngineMessage;
}

async function verdictOf(mail: EngineMessage[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...mail.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    { type: "rule", op: "create", id: rule.id, seq: ++seq, updatedAt: rule.updatedAt, entity: rule },
  ] as SyncChange[]);
  const partition = consentPartition(store, { now: NOW });
  const presented = presentationReader(store, partition);
  const v = stayVerdict(pressOutcome({ presented, subject: mail, rules: [rule], profiles: [], wanted: "INBOX", retro: false }), store);
  return { v, placeOf: partition.placeOf };
}

const five = Array.from({ length: 5 }, (_, i) => message(`in-${i}`, "INBOX"));
const sorted = (v: { ids?: string[] }) => [...(v.ids ?? [])].sort();

describe("one place is named with its own rows; several are named as several", () => {
  it("two folders of the person's own, one row each: stillSpread, 2, both moved", async () => {
    const { v } = await verdictOf([...five, message("a-1", "Projects"), message("b-1", "Receipts-2019")]);
    expect(v).toMatchObject({ key: "stillSpread", count: 5, still: 2, movable: true });
    expect(sorted(v as { ids: string[] })).toEqual(["a-1", "b-1"]);
    expect(v).not.toHaveProperty("stillPlace");
  });

  it("two in A and one in B: stillSpread, 3, never '3 are still in A'", async () => {
    const { v } = await verdictOf([...five, message("a-1", "Projects"), message("a-2", "Projects"), message("b-1", "Receipts-2019")]);
    expect(v).toMatchObject({ key: "stillSpread", still: 3 });
    expect(sorted(v as { ids: string[] })).toEqual(["a-1", "a-2", "b-1"]);
  });

  it("kept in News and filed in Fixture mixed: stillSpread over both", async () => {
    const { v } = await verdictOf([...five, message("n-1", "ohmail/News"), message("f-1", "Fixture")]);
    expect(v).toMatchObject({ key: "stillSpread", still: 2 });
    expect(sorted(v as { ids: string[] })).toEqual(["f-1", "n-1"]);
  });

  it("two in one folder: still, that folder, those two", async () => {
    const { v } = await verdictOf([...five, message("a-1", "Projects"), message("a-2", "Projects")]);
    expect(v).toMatchObject({ key: "still", still: 2, stillPlace: "Projects", movable: true });
    expect(sorted(v as { ids: string[] })).toEqual(["a-1", "a-2"]);
  });

  it("the same path in two mailboxes is two places", async () => {
    const { v } = await verdictOf([...five, message("a-1", "Fixture", { mailbox: "mb" }), message("b-1", "Fixture", { mailbox: "mb-2" })]);
    expect(v).toMatchObject({ key: "stillSpread", still: 2 });
  });
});

describe("the toast names one message's place as the sheet does", () => {
  it("an old letter in a folder of theirs, which the lists put in History, is still in History", async () => {
    const old = message("f-1", "Fixture", { date: "2024-01-05T09:00:00.000Z" });
    const { v, placeOf } = await verdictOf([...five, old]);
    expect(placeOf.get("f-1")).toBeNull();
    expect(v).toMatchObject({ key: "still", still: 1, stillPlace: null, ids: ["f-1"] });
  });
});

describe("History is one place, whichever mailbox a row came from", () => {
  it("two old letters in Fixture of two mailboxes, both put in History: still, History, 2", async () => {
    const old = { date: "2024-01-05T09:00:00.000Z" };
    const { v } = await verdictOf([...five, message("a-1", "Fixture", { ...old, mailbox: "mb" }), message("b-1", "Fixture", { ...old, mailbox: "mb-2" })]);
    expect(v).toMatchObject({ key: "still", still: 2, stillPlace: null });
  });
});

describe("no move past a message that failed its checks", () => {
  it("a filed row that failed its checks: the sentence stands, the move is withheld", async () => {
    const { v } = await verdictOf([...five, message("f-1", "Fixture", { auth: "fail" })]);
    expect(v).toMatchObject({ key: "still", still: 1, stillPlace: "Fixture", movable: false });
  });

  it("positive control: a filed row that passed is movable", async () => {
    const { v } = await verdictOf([...five, message("f-1", "Fixture", { auth: "pass" as never })]);
    expect(v).toMatchObject({ key: "still", movable: true });
  });
});

describe("localized Sent and Trash names are no folder of the person's own", () => {
  const LOCALIZED = ["Gesendet", "Gesendete Elemente", "INBOX/Sent Items", "Papierkorb", "Gelöschte Elemente", "Junk-E-Mail", "Spam", "Deleted Messages"];
  it("each reads as not theirs", () => {
    expect(LOCALIZED.map((f) => isPersonsOwnFolder(f, "mb"))).toEqual(LOCALIZED.map(() => false));
  });
  it("five at the place and one in each: none, all five", async () => {
    const { v } = await verdictOf([...five, ...LOCALIZED.map((f, i) => message(`x-${i}`, f))]);
    expect(v).toEqual({ key: "none" });
  });
});
