import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  oneSourceReader,
  type EntityReader,
  type SyncChange,
} from "@ohmail/client-engine";
import { livePiles, presentedOf, type WorldView } from "../src/state/live";

/**
 * THE PHONE'S PILES IN THE ONE ORDER — the same six messages the engine's
 * `triage-pile-order.test.ts` feeds, set aside in an order that is not their arrival order.
 * The phone renders `livePiles` as it comes back, so this list IS the screen's order: Answer
 * Later and Parked newest arrival first, Resurface soonest return first.
 */

const view: WorldView = { now: new Date("2026-08-28T12:00:00Z"), zone: "UTC" };

const SIX = [
  { id: "p-a", at: "2026-08-26T23:15:00.000Z", back: "2026-08-31T07:00:00.000Z" },
  { id: "p-b", at: "2026-08-27T00:43:00.000Z", back: "2026-08-31T07:00:00.000Z" },
  { id: "p-c", at: "2026-08-27T08:21:00.000Z", back: "2026-09-03T07:00:00.000Z" },
  { id: "p-d", at: "2026-08-26T19:41:00.000Z", back: "2026-09-01T07:00:00.000Z" },
  { id: "p-e", at: "2026-08-26T19:18:00.000Z", back: "2026-09-02T07:00:00.000Z" },
  { id: "p-f", at: "2026-08-26T19:16:00.000Z", back: "2026-09-04T07:00:00.000Z" },
] as const;
const NEWEST_FIRST = ["p-c", "p-b", "p-a", "p-d", "p-e", "p-f"];
const SOONEST_BACK = ["p-b", "p-a", "p-d", "p-e", "p-c", "p-f"];

type PileState = "reply_later" | "set_aside" | "bubbled_up";
const KIND = { reply_later: "replyLater", set_aside: "setAside", bubbled_up: "resurface" } as const;

function msg(row: (typeof SIX)[number]): EngineMessage {
  return {
    id: row.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${row.id}`, from: { name: `N ${row.id}`, address: `${row.id}@example.invalid` },
    to: [], cc: [], date: row.at, sortAt: row.at, folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: row.at,
  } as EngineMessage;
}

const claim = (row: (typeof SIX)[number], state: PileState, i: number): MessageStateDTO => ({
  messageId: row.id, state, bubbleUpAt: state === "bubbled_up" ? row.back : null,
  setAt: `2026-08-28T09:0${i}:00.000Z`, updatedAt: `2026-08-28T09:0${i}:00.000Z`,
});

let seq = 0;
const change = (type: SyncChange["type"], id: string, entity: unknown): SyncChange => ({
  type, op: "create", id, seq: ++seq, updatedAt: "2026-08-28T10:00:00.000Z", entity,
});

/** `web`: claims as their own rows, in set-aside order. `desktop`: carried on the messages. */
async function mirror(state: PileState, path: "web" | "desktop"): Promise<EntityReader> {
  const store = new MemoryMirrorStore();
  await store.load();
  const byArrival = [...SIX].sort((a, b) => b.at.localeCompare(a.at));
  await store.applyChanges(path === "web"
    ? [
        ...byArrival.map((r) => change("message", r.id, msg(r))),
        ...SIX.map((r, i) => change("message_state", `state-row-${9 - i}`, claim(r, state, i))),
      ]
    : byArrival.map((r) => change("message", r.id, { ...msg(r), triage: claim(r, state, SIX.indexOf(r)) })));
  return oneSourceReader(store);
}

const shown = (reader: EntityReader, state: PileState): Array<string | undefined> =>
  livePiles(presentedOf(reader, view.now), view)
    .find((p) => p.kind === KIND[state])!.items.map((i) => i.messageId);

describe("the phone's piles, whichever way the claims reached its mirror", () => {
  it.each([
    ["reply_later", "web"], ["reply_later", "desktop"], ["set_aside", "web"], ["set_aside", "desktop"],
  ] as const)("%s over the %s arrival: newest first", async (state, path) => {
    expect(shown(await mirror(state, path), state)).toEqual(NEWEST_FIRST);
  });

  it.each(["web", "desktop"] as const)("bubbled_up over the %s arrival: soonest return first", async (path) => {
    expect(shown(await mirror("bubbled_up", path), "bubbled_up")).toEqual(SOONEST_BACK);
  });
  it("names each return as the web does — the date once it is past this week", async () => {
    /* Friday 28 Aug: next Friday's 07:00 is seven days out, where a bare "Fri 07:00" read as this
       morning's; the phone used to print the date with no clock at all. */
    const items = livePiles(presentedOf(await mirror("bubbled_up", "web"), view.now), view)
      .find((p) => p.kind === "resurface")!.items;
    expect(items.map((i) => i.resurfaceAt)).toEqual([
      "Mon 07:00", "Mon 07:00", "Tue 07:00", "Wed 07:00", "Thu 07:00", "4 Sep, 07:00",
    ]);
  });
});
