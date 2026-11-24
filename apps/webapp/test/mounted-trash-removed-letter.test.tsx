/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import type { SyncChange, TrashRowWire } from "@ohmail/client-engine";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { ohboxRow as row, readingColumn } from "./ohbox/_finders.js";
import { NOW, S, act, click, engineOver, msg, setup, shell, storeWith, teardown, tombstone, waitFor } from "./_view-shell";

const GONE = messages.reader.goneShort;
const column = (el: HTMLElement) => readingColumn(el)?.textContent ?? "";

beforeEach(setup);
afterEach(teardown);

const VIEWS = ["triage", "folder", "trash"] as const;
type View = (typeof VIEWS)[number];

function record(type: SyncChange["type"], id: string, entity: object): SyncChange {
  return { type, id, entity, op: "create", seq: ++S.seq, updatedAt: NOW.toISOString() } as SyncChange;
}

async function mountView(view: View, letters: EngineMessage[]) {
  const inView = (letter: EngineMessage): EngineMessage => ({
    ...letter,
    folder: view === "folder" ? "Projects" as EngineMessage["folder"] : letter.folder,
    triage: view === "triage" ? {
      messageId: letter.id, state: "reply_later",
      bubbleUpAt: null, setAt: letter.date ?? NOW.toISOString(), updatedAt: NOW.toISOString(),
    } : null,
  });
  const extras = view === "folder" ? [record("folder", "fd1", {
    id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "me@example.invalid", updatedAt: NOW.toISOString(),
  })] : [];
  const trashed = (letter: EngineMessage): TrashRowWire => ({
    ...letter, trashedAt: letter.date ?? NOW.toISOString(), restoreTo: "INBOX",
  });
  let trash = letters.map(trashed);
  const store = await storeWith(view === "trash" ? [] : letters.map(inView), extras);
  const engine = engineOver(store);
  if (view === "trash") {
    vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
    vi.spyOn(engine, "listTrash").mockImplementation(async () => ({ state: "ready", items: trash, nextCursor: null }));
  }
  const host = await shell(store, engine, view === "folder" ? "#/folder/fd1" : "#/" + view);
  await waitFor(() => row(host, letters[0]!.id) !== null, view + " rows");
  return {
    host,
    async remove(id: string) {
      trash = trash.filter((letter) => letter.id !== id);
      await tombstone(id);
    },
    async add(letter: EngineMessage) {
      S.pending = [record("message", letter.id, inView(letter))];
      await act(async () => { await engine.syncOnce(); });
    },
  };
}

const listed = () => [msg("m1"), msg("m2", { date: "2026-09-16T08:00:00.000Z" })];

describe("Triage, a folder and Trash say it too", () => {
  for (const view of VIEWS) {
    it(`the ${view} column says a picked message is gone`, async () => {
      const { host, remove } = await mountView(view, listed());
      await click(row(host, "m1"), view + " row m1");
      await waitFor(() => column(host).includes("Subject m1"), "the selected letter");
      await remove("m1");
      await waitFor(() => column(host).includes(GONE), "the gone notice");
      expect(column(host)).toContain(GONE);
      expect(column(host)).not.toContain("Subject m2");
      expect(row(host, "m2")).not.toBeNull();
    });
  }
});

it("keeps a listed Trash letter when its filing is replayed by sync", async () => {
  const letter = msg("m1", { date: NOW.toISOString() });
  const store = await storeWith([]);
  const engine = engineOver(store);
  vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
  vi.spyOn(engine, "listTrash").mockResolvedValue({
    state: "ready", items: [{ ...letter, trashedAt: NOW.toISOString(), restoreTo: "INBOX" }], nextCursor: null,
  });
  const host = await shell(store, engine, "#/trash");
  await waitFor(() => row(host, letter.id) !== null, "the already filed row");
  await click(row(host, letter.id), "the already filed row");
  await tombstone(letter.id);
  expect(column(host)).toContain("Subject m1");
  expect(column(host)).not.toContain(GONE);
});

it("blocks Shift+Backspace behind a visible menu and restores the same row after it closes", async () => {
  const { host } = await mountView("trash", listed());
  await click(row(host, "m1"), "select the first Trash row");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  const pressRestore = () => act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", shiftKey: true, bubbles: true, cancelable: true,
    }));
  });
  try {
    await pressRestore();
    expect.soft(row(host, "m1")).not.toBeNull();
    expect.soft(column(host)).toContain("Subject m1");
  } finally {
    menu.remove();
  }
  await pressRestore();
  expect(row(host, "m1")).toBeNull();
  expect(row(host, "m2")).not.toBeNull();
});

it.each(["later page", "failed confirmation", "confirmed removal"])(
  "checks the store when a newer sync deletion concerns a Trash letter: %s",
  async (answer) => {
    const letter = msg("m1", { date: new Date(NOW.getTime() - 1).toISOString() });
    const other = msg("m2");
    const store = await storeWith([]);
    const engine = engineOver(store);
    let checking = false;
    const checkPages: (string | undefined)[] = [];
    vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
    vi.spyOn(engine, "listTrash").mockImplementation(async ({ cursor } = {}) => {
      if (checking) checkPages.push(cursor);
      if (checking && cursor && answer === "failed confirmation") {
        return { state: "failed", error: "Unavailable", code: null };
      }
      const canSee = !checking || answer !== "confirmed removal";
      const items = cursor ? canSee ? [letter] : [] : [other];
      return {
        state: "ready",
        items: items.map((item) => ({ ...item, trashedAt: item.date!, restoreTo: "INBOX" })),
        nextCursor: cursor ? null : "older",
      };
    });
    const host = await shell(store, engine, "#/trash");
    await waitFor(() => row(host, "m2") !== null, "the first Trash page");
    await click(within(host).getByRole("button", { name: messages.trash.liveOlder }), "load an older Trash page");
    await waitFor(() => row(host, "m1") !== null, "the selected letter's page");
    await click(row(host, "m1"), "select the older letter");
    await waitFor(() => column(host).includes("Subject m1"), "the selected letter");
    checking = true;
    await tombstone("m1");

    if (answer === "confirmed removal") {
      await waitFor(() => column(host).includes(GONE), "the removed letter's notice");
      expect(row(host, "m1")).toBeNull();
    } else {
      expect.soft(row(host, "m1")).not.toBeNull();
      expect.soft(column(host)).toContain("Subject m1");
      expect(column(host)).not.toContain(GONE);
    }
    expect(row(host, "m2")).not.toBeNull();
    expect(checkPages).toEqual([undefined, "older"]);
  },
);

it("keeps a Trash letter when an older check reports absence after a newer check finds it", async () => {
  const [letter, neighbor] = listed().map((item): TrashRowWire => ({
    ...item, trashedAt: item.date!, restoreTo: "INBOX",
  }));
  const store = await storeWith([]);
  const engine = engineOver(store);
  type TrashAnswer = Awaited<ReturnType<typeof engine.listTrash>>;
  let finishOlder!: (answer: TrashAnswer) => void;
  const olderAnswer = new Promise<TrashAnswer>((resolve) => { finishOlder = resolve; });
  let finishNewer!: (answer: TrashAnswer) => void;
  const newerAnswer = new Promise<TrashAnswer>((resolve) => { finishNewer = resolve; });
  vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
  const listTrash = vi.spyOn(engine, "listTrash")
    .mockResolvedValueOnce({ state: "ready", items: [letter!, neighbor!], nextCursor: null })
    .mockResolvedValueOnce({ state: "ready", items: [neighbor!], nextCursor: "older" })
    .mockReturnValueOnce(olderAnswer)
    .mockReturnValueOnce(newerAnswer);
  const host = await shell(store, engine, "#/trash");
  await waitFor(() => row(host, "m1") !== null, "the listed letter");
  await click(row(host, "m1"), "select the Trash letter");
  await waitFor(() => column(host).includes("Subject m1"), "the selected letter");

  await tombstone("m1");
  expect(listTrash).toHaveBeenNthCalledWith(3, expect.objectContaining({ cursor: "older" }));
  await tombstone("m1");
  expect(listTrash).toHaveBeenCalledTimes(4);
  await act(async () => finishNewer({ state: "ready", items: [letter!], nextCursor: "more" }));
  expect(row(host, "m1")).not.toBeNull();

  await act(async () => finishOlder({ state: "ready", items: [], nextCursor: null }));
  expect.soft(row(host, "m1")).not.toBeNull();
  expect.soft(column(host)).toContain("Subject m1");
  expect.soft(column(host)).not.toContain(GONE);
  expect(row(host, "m2")).not.toBeNull();

  listTrash.mockResolvedValueOnce({ state: "ready", items: [neighbor!], nextCursor: null });
  await tombstone("m1");
  expect(row(host, "m1")).toBeNull();
  expect(column(host)).toContain(GONE);

  listTrash.mockResolvedValueOnce({ state: "ready", items: [letter!, neighbor!], nextCursor: "more" });
  await tombstone("m1");
  expect(row(host, "m1")).not.toBeNull();
});
