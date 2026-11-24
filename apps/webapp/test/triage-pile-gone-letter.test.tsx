/** @vitest-environment jsdom */
import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { letter } from "../../../packages/app/test/reader/support/fake-mail.js";
import { listSeat } from "../../../packages/app/test/places/list-seat";

/** The visible Answer Later segment counts the letters that still have rows. */
afterEach(cleanup);

const ISO = "2026-10-12T01:19:58.000Z";
const GHOST = "94179640-1ad8-43bf-8863-bccdd7b58e2b";
const id = (i: number) => (i === 6 ? GHOST : `00000000-0000-4000-8000-00000000000${i}`);

const message = (i: number): EngineMessage => letter(id(i), {
  subject: `letter ${i}`,
  snippet: `Preview of letter ${i}`,
  date: new Date(Date.UTC(2026, 10, 12, i)).toISOString(),
  arrivedAt: new Date(Date.UTC(2026, 10, 12, i)).toISOString(),
});

const claim = (i: number, seq: number): SyncChange => ({
  type: "message_state", op: "update", id: `state-row:${id(i)}`, seq, updatedAt: ISO,
  entity: { messageId: id(i), state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO } as unknown as MessageStateDTO,
});

function expectPile(store: MemoryMirrorStore, count: number) {
  listSeat({
    first: "#/triage",
    letters: store.list<EngineMessage>("message"),
    more: Object.fromEntries(store.list<MessageStateDTO>("message_state")
      .map((row) => [`message_state:${row.messageId}`, row])),
  });

  const rows = screen.getAllByRole("option");
  expect(rows).toHaveLength(count);
  for (let index = 0; index < count; index++) {
    expect(screen.getByRole("option", { name: new RegExp(`letter ${index}\\b`) })).toBeTruthy();
  }
  expect(rows.some((row) => row.textContent?.includes(GHOST) || row.getAttribute("aria-label")?.includes(GHOST)))
    .toBe(false);
  const segments = within(screen.getByRole("group", { name: "Piles" }));
  expect(segments.getByRole("button", { name: `Answer Later ${count}`, pressed: true })).toBeTruthy();
  expect(screen.queryByText(`${count} items`)).toBeNull();
}

async function sevenQueued(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = [];
  for (let i = 0; i < 7; i++) {
    changes.push({ type: "message", op: "create", id: id(i), seq: 2 * i + 1, updatedAt: ISO, entity: message(i) });
    changes.push(claim(i, 2 * i + 2));
  }
  await store.applyChanges(changes);
  return store;
}

describe("a letter deleted on the server is not drawn in Answer Later, and the count agrees", () => {
  it("seven queued letters draw seven rows", async () => {
    expectPile(await sevenQueued(), 7);
  });

  it("the sync that deletes the seventh letter leaves six rows, no id row, and 'Answer Later 6'", async () => {
    const store = await sevenQueued();
    await store.applyChanges([{ type: "message", op: "delete", id: GHOST, seq: 100, updatedAt: "2026-10-12T01:39:38.903Z" }]);
    expectPile(store, 6);
  });

  it("a claim kept over a letter this mirror does not hold is not drawn either", async () => {
    const store = await sevenQueued();
    await store.prune([{ type: "message", id: GHOST }]);
    expect(store.record("message_state", `state-row:${GHOST}`)?.entity).toBeTruthy();
    expectPile(store, 6);
  });
});
