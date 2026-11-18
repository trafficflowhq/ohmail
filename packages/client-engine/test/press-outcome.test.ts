import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  presentationReader,
  pressGained,
  pressOutcome,
  stayVerdict,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * AFTER THE PRESS, THE LIST IS READ AGAIN. Success is every pressed row
 * shown at the pressed place in the presented list; any other row is named by its cause and place.
 * The filed folder is never the reading: the sheet said "now in Ohbox" over mail the list
 * showed in News.
 */

const NOW = new Date("2026-09-25T13:10:00.000Z");
const ADDR = "info@shop.example";
const TERM = "[Weekly-Digest]";
let seq = 0;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-05T08:00:00.000Z", updatedAt: "2026-08-05T08:00:00.000Z",
    subjectContains: null, bodyContains: null, ...o,
  };
}

function message(id: string, subject: string, folder: Folder = "INBOX"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: ADDR }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-20T09:00:00.000Z",
  } as EngineMessage;
}

async function verdict(rules: RuleDTO[], mail: EngineMessage[], wanted: Folder, retro: boolean) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...mail.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  const presented = presentationReader(store, consentPartition(store, { now: NOW }));
  return stayVerdict(pressOutcome({ presented, subject: mail, rules, profiles: [], wanted, retro }), store);
}

async function read(rules: RuleDTO[], mail: EngineMessage[], wanted: Folder, o: { retro?: boolean } = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...mail.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  const presented = presentationReader(store, consentPartition(store, { now: NOW }));
  return pressOutcome({ presented, subject: mail, rules, profiles: [], wanted, retro: o.retro ?? true });
}

const shape = (news: Folder) => ({
  rules: [
    rule({ id: "bare", destination: "INBOX", provenance: "seeded-from-sent" }),
    rule({ id: "split", destination: news, subjectContains: TERM, createdAt: "2026-08-12T17:00:00.000Z" }),
    rule({ id: "domain", kind: "domain", match: "shop.example", destination: "INBOX" }),
  ],
  mail: [
    message("in-1", "Order fulfilled"), message("in-2", "Order received"),
    message("in-term", `${TERM} week 38`), message("old-term", `${TERM} week 12`, news),
    message("old-1", "Parcel on its way", news),
  ],
});

const summary = (o: Awaited<ReturnType<typeof read>>) =>
  o.away.map((s) => [s.cause, s.place, [...s.messageIds].sort(), s.rule?.id ?? null]);

describe("the pressed rows the list does not show at the pressed place are named", () => {
  it.each(["ohmail/Reads", "ohmail/News"] as Folder[])("the reported press into the Ohbox, News spelled %s", async (news) => {
    const { rules, mail } = shape(news);
    const out = await read(rules, mail, "INBOX");
    // INVERTED by ARCH-R902: `in-term` was never filed, so it IS at the pressed
    // place; the subject rule is named for the row it did file.
    expect(out.at).toBe(3);
    expect(summary(out)).toEqual([
      ["subject", "ohmail/News", ["old-term"], "split"],
      ["moving", "ohmail/News", ["old-1"], null],
    ]);
  });

  it("no past mail asked for: filed mail elsewhere is kept, not moving", async () => {
    const { rules, mail } = shape("ohmail/News");
    const out = await read(rules, mail, "INBOX", { retro: false });
    expect(summary(out).find((s) => (s[2] as string[]).includes("old-1"))?.[0]).toBe("kept");
  });

  it("a clean press reads success: every row at the place, nothing away (the positive control)", async () => {
    const mail = [message("in-1", "Order fulfilled"), message("in-2", "Order received")];
    const out = await read([rule({ id: "bare", destination: "INBOX" })], mail, "INBOX");
    expect(out).toEqual({ at: 2, shown: ["in-1", "in-2"], away: [] });
  });
});

/**
 * THE COUNT A PRESS SENTENCE STATES is what the list gained at the place, never the moves: a rule
 * re-presents a sender's INBOX mail without moving it. The shape: one letter in the INBOX shown
 * at the gate (active, undecided), one in Screened; accepting them into the Ohbox moves one.
 */
describe("what a press gained at the place", () => {
  it("one moved and one re-presented is two, where the server moved one", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const inbox = { ...message("in-1", "Hello"), unread: true, date: "2026-09-25T09:00:00.000Z" };
    const screened = message("sc-1", "Earlier letter", "ohmail/Screened");
    await store.applyChanges([inbox, screened].map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })) as SyncChange[]);
    const shownAt = () => pressOutcome({
      presented: presentationReader(store, consentPartition(store, { now: NOW })),
      subject: [inbox, screened], rules: [], profiles: [], wanted: "INBOX", retro: true,
    }).shown;
    const before = shownAt();
    expect(before, "the INBOX letter was shown at the gate, not in the Ohbox, before the press").toEqual([]);
    // The press: the rule for their mail, and the one move the Screened letter needs.
    const moves = [{ ...screened, folder: "INBOX" as Folder }];
    await store.applyChanges([
      { type: "rule", op: "create", id: "r-in", seq: ++seq, updatedAt: NOW.toISOString(), entity: rule({ id: "r-in", destination: "INBOX" }) },
      ...moves.map((m) => ({ type: "message", op: "move", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m, move: { from: "ohmail/Screened", to: "INBOX" } })),
    ] as SyncChange[]);
    expect(moves).toHaveLength(1);
    expect(pressGained(before, shownAt())).toBe(2);
  });

  it("a row already shown at the place is not gained again (the control)", () => {
    expect(pressGained(["a"], ["a", "b"])).toBe(1);
    expect(pressGained(["a", "b"], ["a", "b"])).toBe(0);
    expect(pressGained([], [])).toBe(0);
  });
});

describe("the one sentence an outcome earns", () => {
  const bare = rule({ id: "bare", destination: "INBOX" });
  it("rows the pass is still moving: applying", async () => {
    const v = await verdict([bare], [message("in-1", "a"), message("old-1", "b", "ohmail/News")], "INBOX", true);
    expect(v).toEqual({ key: "applying", count: 1 });
  });
  it("no past mail asked for, all in the old News folder: stillLegacy", async () => {
    const v = await verdict([bare], [message("in-1", "a"), message("old-1", "b", "ohmail/Reads" as unknown as Folder)], "INBOX", false);
    expect(v).toEqual({ key: "stillLegacy", count: 1, still: 1, ids: ["old-1"], folder: "ohmail/Reads", movable: true });
  });
  it("no past mail asked for, in News: still, with the place", async () => {
    const v = await verdict([bare], [message("in-1", "a"), message("old-1", "b", "ohmail/News")], "INBOX", false);
    expect(v).toEqual({ key: "still", count: 1, still: 1, stillPlace: "ohmail/News", ids: ["old-1"], movable: true });
  });
  it("two subject rules keeping rows elsewhere: keptMany", async () => {
    const rules = [bare, rule({ id: "s1", destination: "ohmail/News", subjectContains: "alpha" }), rule({ id: "s2", destination: "ohmail/Receipts", subjectContains: "beta" })];
    // FILED by those rules since ARCH-R902: the sentence names mail a subject rule moved.
    const v = await verdict(rules, [message("in-1", "a"), message("x", "alpha 1", "ohmail/News"), message("y", "beta 2", "ohmail/Receipts")], "INBOX", true);
    expect(v).toEqual({ key: "keptMany", count: 1, kept: 2 });
  });
  it("two subject rules over rows they never filed: none — the rows are in the Ohbox", async () => {
    // INVERTED by ARCH-R902: this pair read keptMany while the rules presented them.
    const rules = [bare, rule({ id: "s1", destination: "ohmail/News", subjectContains: "alpha" }), rule({ id: "s2", destination: "ohmail/Receipts", subjectContains: "beta" })];
    const v = await verdict(rules, [message("in-1", "a"), message("x", "alpha 1"), message("y", "beta 2")], "INBOX", true);
    expect(v).toEqual({ key: "none" });
  });
  it("every row at the place: none (the positive control)", async () => {
    expect(await verdict([bare], [message("in-1", "a")], "INBOX", true)).toEqual({ key: "none" });
  });
});
