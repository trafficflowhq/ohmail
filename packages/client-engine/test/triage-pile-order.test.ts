import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  messagesByDateDesc,
  oneSourceReader,
  triagePiles,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
  type SyncChange,
  type TriageItemDTO,
  type TriagePiles,
} from "@ohmail/client-engine";

/**
 * ONE ORDER PER PILE ON EVERY SURFACE. `triagePiles` sorted nothing, so each device
 * listed its mirror's INSERTION order: the web took the claims in the order they were set aside,
 * the paired desktop took them on its messages, newest first, and Reply Run began on a different
 * message per device. Answer Later and Parked are in the Ohbox's arrival order; Resurface is in
 * the order its rows are stamped, soonest return first. The two paths below feed ONE fixture.
 */

/** Set aside in THIS order, which is not their arrival order. `p-a`'s header is sender-written. */
const SIX = [
  { id: "p-a", at: "2026-08-26T23:15:00.000Z", header: "2026-09-30T08:00:00.000Z", back: "2026-08-31T07:00:00.000Z" },
  { id: "p-b", at: "2026-08-27T00:43:00.000Z", back: "2026-08-31T07:00:00.000Z" },
  { id: "p-c", at: "2026-08-27T08:21:00.000Z", back: "2026-09-03T07:00:00.000Z" },
  { id: "p-d", at: "2026-08-26T19:41:00.000Z", back: "2026-09-01T07:00:00.000Z" },
  { id: "p-e", at: "2026-08-26T19:18:00.000Z", back: "2026-09-02T07:00:00.000Z" },
  { id: "p-f", at: "2026-08-26T19:16:00.000Z", back: "2026-09-04T07:00:00.000Z" },
] as const;
const NEWEST_FIRST = ["p-c", "p-b", "p-a", "p-d", "p-e", "p-f"];
/** Mon 31 holds two rows, set aside older first; the newer arrival (`p-b`) breaks the tie. */
const SOONEST_BACK = ["p-b", "p-a", "p-d", "p-e", "p-c", "p-f"];

type PileState = "reply_later" | "set_aside" | "bubbled_up";
const PILE: Record<PileState, keyof TriagePiles> = {
  reply_later: "replyLater", set_aside: "setAside", bubbled_up: "resurface",
};

function msg(row: (typeof SIX)[number], triage: MessageStateDTO | null): EngineMessage {
  return {
    id: row.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${row.id}`, from: { name: `N ${row.id}`, address: `${row.id}@example.invalid` },
    to: [], cc: [], date: "header" in row ? row.header : row.at, sortAt: row.at, folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage, labels: [], remoteContent: "none", updatedAt: row.at,
  } as EngineMessage;
}

const claim = (row: (typeof SIX)[number], state: PileState, i: number): MessageStateDTO => ({
  messageId: row.id,
  state,
  bubbleUpAt: state === "bubbled_up" ? row.back : null,
  setAt: `2026-08-28T09:0${i}:00.000Z`,
  updatedAt: `2026-08-28T09:0${i}:00.000Z`,
});

const orphan = (state: PileState): TriageItemDTO => ({ id: `${state}:demo`, pile: state, title: "Demo orphan" });

let seq = 0;
const change = (type: SyncChange["type"], id: string, entity: unknown): SyncChange => ({
  type, op: "create", id, seq: ++seq, updatedAt: "2026-08-28T10:00:00.000Z", entity,
});

/**
 * THE WEB'S ARRIVAL: the messages page newest first, then the change log's claims, keyed by the
 * state ROW's id, in the order they were set aside.
 */
async function webPath(state: PileState): Promise<EntityReader> {
  const store = new MemoryMirrorStore();
  await store.load();
  const byArrival = [...SIX].sort((a, b) => b.at.localeCompare(a.at));
  await store.applyChanges([
    ...byArrival.map((r) => change("message", r.id, msg(r, null))),
    ...SIX.map((r, i) => change("message_state", `state-row-${9 - i}`, claim(r, state, i))),
    change("triage_item", orphan(state).id, orphan(state)),
  ]);
  return oneSourceReader(store);
}

/** THE PAIRED DESKTOP'S ARRIVAL: each claim carried on its message, the messages newest first. */
async function desktopPath(state: PileState): Promise<EntityReader> {
  const store = new MemoryMirrorStore();
  await store.load();
  const byArrival = [...SIX].sort((a, b) => b.at.localeCompare(a.at));
  await store.applyChanges([
    ...byArrival.map((r) => change("message", r.id, msg(r, claim(r, state, SIX.indexOf(r))))),
    change("triage_item", orphan(state).id, orphan(state)),
  ]);
  return oneSourceReader(store);
}

const PATHS = { web: webPath, desktop: desktopPath } as const;
const idsOf = (reader: EntityReader, state: PileState): Array<string | undefined> =>
  triagePiles(reader)[PILE[state]].map((e) => e.messageId);

describe.each(["reply_later", "set_aside"] as const)("%s: newest arrival first", (state) => {
  it.each(["web", "desktop"] as const)("the %s path lists the six by arrival, the orphan last", async (path) => {
    const reader = await PATHS[path](state);
    expect(idsOf(reader, state)).toEqual([...NEWEST_FIRST, undefined]);
    // The Ohbox's own order, filtered to the pile — one comparator, not a look-alike.
    const members = new Set<string>(NEWEST_FIRST);
    expect(idsOf(reader, state).slice(0, 6))
      .toEqual(messagesByDateDesc(reader).map((m) => m.id).filter((id) => members.has(id)));
  });

  it("both paths agree, entry for entry, and the count and membership are the fixture's", async () => {
    const web = triagePiles(await webPath(state))[PILE[state]];
    const desk = triagePiles(await desktopPath(state))[PILE[state]];
    expect(web).toEqual(desk);
    expect(web).toHaveLength(7);
    expect(new Set(web.map((e) => e.messageId ?? e.title))).toEqual(new Set([...NEWEST_FIRST, "Demo orphan"]));
  });
});

describe("bubbled_up: soonest return first, arrival breaking a tie", () => {
  it.each(["web", "desktop"] as const)("the %s path lists the six by return time", async (path) => {
    const reader = await PATHS[path]("bubbled_up");
    expect(idsOf(reader, "bubbled_up")).toEqual([...SOONEST_BACK, undefined]);
    const shown = triagePiles(reader).resurface.slice(0, 6).map((e) => e.resurfaceAt!);
    expect(shown, "the rows' own stamps read out of sequence").toEqual([...shown].sort());
  });
});

/**
 * A CONVERSATION IS ONE ROW in Answer later, Parked and Resurface: a parked seven-message conversation
 * drew seven rows, each "7 messages in this conversation". The row faces the newest letter somebody
 * else wrote and lists every member the pile holds; a Resurface row is dated by its soonest booking.
 * Both delivery paths fold alike.
 */
describe("Answer later, Parked and Resurface: one row per conversation", () => {
  const ME = { name: "Me", address: "me@example.invalid" };
  const at = (h: string) => `2026-08-26T${h}:00.000Z`;
  const conv = (id: string, when: string, over: Partial<EngineMessage> = {}): EngineMessage => ({
    ...msg({ id, at: at(when) }, null), threadId: "T", subject: "Q3", ...over,
  } as EngineMessage);
  const SEVEN = [
    ...["01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((h, i) => conv(`m${i + 1}`, h)),
    conv("r7", "07:00", { from: ME, folder: "Sent" as EngineMessage["folder"] }),
  ];
  const lone = conv("z9", "06:30", { threadId: null });
  const NEWEST_FIRST_IDS = ["r7", "m6", "m5", "m4", "m3", "m2", "m1"];
  const st = (id: string, state: PileState, i = 0, back: string | null = null): MessageStateDTO => ({
    messageId: id, state, bubbleUpAt: back, setAt: `2026-08-28T09:0${i % 10}:00.000Z`, updatedAt: `2026-08-28T09:0${i % 10}:00.000Z`,
  });
  async function fold(
    ms: EngineMessage[], stateOf: (id: string) => PileState, carried: boolean, backOf: (id: string) => string | null = () => null,
  ): Promise<EntityReader> {
    const store = new MemoryMirrorStore();
    await store.load();
    const claimOf = (m: EngineMessage, i: number) => st(m.id, stateOf(m.id), i, backOf(m.id));
    await store.applyChanges([
      ...ms.map((m, i) => change("message", m.id, carried ? { ...m, triage: claimOf(m, i) } : m)),
      ...(carried ? [] : ms.map((m, i) => change("message_state", `row-${m.id}`, claimOf(m, i)))),
    ]);
    return oneSourceReader(store);
  }

  it.each(["reply_later", "set_aside"] as const)("%s: seven members and a lone letter are two rows, on both paths", async (state) => {
    const web = triagePiles(await fold([...SEVEN, lone], () => state, false))[PILE[state]];
    const desk = triagePiles(await fold([...SEVEN, lone], () => state, true))[PILE[state]];
    expect(web, "the web log and the carried state fold alike").toEqual(desk);
    expect(web.map((e) => e.messageId), "ordered by the letter each row faces").toEqual(["z9", "m6"]);
    expect(web[1]!.memberIds).toEqual(NEWEST_FIRST_IDS);
    expect(web[0]!.memberIds).toEqual(["z9"]);
  });

  it("a conversation split across the two piles is one row in each", async () => {
    const piles = triagePiles(await fold(SEVEN, (id) => (id === "m1" || id === "m2" ? "reply_later" : "set_aside"), false));
    expect(piles.replyLater.map((e) => e.memberIds)).toEqual([["m2", "m1"]]);
    expect(piles.setAside.map((e) => [e.messageId, e.memberIds])).toEqual([["m6", ["r7", "m6", "m5", "m4", "m3"]]]);
  });

  it("a held member stays a row of its own; a lone booked member is a Resurface row of one", async () => {
    const held = conv("h8", "08:00", { folder: "ohmail/Screener" as EngineMessage["folder"] });
    const piles = triagePiles(await fold([...SEVEN, held], (id) => (id === "m1" ? "bubbled_up" : "set_aside"), false));
    expect(piles.setAside.map((e) => e.memberIds)).toEqual([["h8"], ["r7", "m6", "m5", "m4", "m3", "m2"]]);
    expect(piles.resurface.map((e) => [e.messageId, e.memberIds])).toEqual([["m1", ["m1"]]]);
  });

  it.each(["web", "desktop"] as const)("bubbled_up on the %s path: seven booked and a lone booked letter are two rows, dated", async (path) => {
    const back = (id: string) => (id === "z9" ? "2026-09-02T07:00:00.000Z" : "2026-09-01T07:00:00.000Z");
    const piles = triagePiles(await fold([...SEVEN, lone], () => "bubbled_up", path === "desktop", back));
    expect(piles.resurface.map((e) => [e.messageId, e.resurfaceAt])).toEqual([
      ["m6", "2026-09-01T07:00:00.000Z"], ["z9", "2026-09-02T07:00:00.000Z"],
    ]);
    expect(piles.resurface[0]!.memberIds).toEqual(NEWEST_FIRST_IDS);
  });

  it("mixed bookings: the row is dated and ordered by its soonest", async () => {
    const back = (id: string) => (id === "z9" ? "2026-09-02T07:00:00.000Z" : id === "m3" ? "2026-09-01T07:00:00.000Z" : "2026-09-05T07:00:00.000Z");
    const piles = triagePiles(await fold([...SEVEN, lone], () => "bubbled_up", false, back));
    expect(piles.resurface.map((e) => [e.messageId, e.resurfaceAt])).toEqual([
      ["m6", "2026-09-01T07:00:00.000Z"], ["z9", "2026-09-02T07:00:00.000Z"],
    ]);
  });
});
