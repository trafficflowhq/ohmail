// @vitest-environment jsdom
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { OhmailEngine, TrashRowWire } from "@ohmail/client-engine";
import {
  armDeleteIntent,
  deleteIntentsKey,
  takeDeleteIntents,
} from "@ohmail/app-logic/press/delete-intents";
import { UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../../../packages/app/src/frame/Frame";
import { usePress } from "../../../packages/app/src/frame/room";
import { MailGround } from "../../../packages/app/src/mail/MailGround";
import { TextProvider, type Messages } from "../../../packages/app/src/text";
import { FOLDERS_ON, listFrame } from "../../../packages/app/test/places/list-seat";
import { letter } from "../../../packages/app/test/reader/support/mail";
import { fakeWindow } from "../../../packages/app/test/support/fake-window";
import en from "../messages/en.json";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  window.localStorage.clear();
});

type RestoreAnswer = Awaited<ReturnType<OhmailEngine["restoreFromTrash"]>>;

function row(id: string): TrashRowWire {
  return {
    ...letter(id),
    subject: `Subject ${id}`,
    date: "2026-01-01T00:00:00.000Z",
    snippet: "snip",
    trashedAt: "2026-09-09T09:00:00.000Z",
    restoreTo: "ohmail/News",
  };
}

async function mountTrash({
  rows = [],
  room = "desktop",
  answer = async () => ({ state: "restored", restoreTo: "INBOX", pending: true }),
  restoreAvailable = true,
}: {
  rows?: readonly TrashRowWire[];
  room?: "desktop" | "phone";
  answer?: (id: string) => Promise<RestoreAnswer>;
  restoreAvailable?: boolean;
} = {}) {
  let listed = [...rows];
  let deleting: ReturnType<typeof usePress>["deleting"] | null = null;
  const restored: { id: string; intentId: string }[] = [];
  const replayedDeletes: { id: string; intentId: string }[] = [];
  function CaptureDelete() {
    const press = usePress();
    React.useLayoutEffect(() => { deleting = press.deleting; }, [press]);
    return null;
  }
  function Ground({ children }: { children: React.ReactNode }) {
    return <MailGround><CaptureDelete />{children}</MailGround>;
  }
  const mounted = listFrame({
    first: "#/trash",
    room,
    letters: [letter("u8")],
    consent: FOLDERS_ON,
    engine: () => ({
      trashAvailable: () => restoreAvailable,
      listTrash: async () => ({ state: "ready", items: listed, nextCursor: null }),
      restoreFromTrash: async (id: string, { intentId }: { intentId: string }) => {
        restored.push({ id, intentId });
        const result = await answer(id);
        if (result.state === "restored" || (result.state === "rolled_back" && result.code === "not_in_trash")) {
          listed = listed.filter((item) => item.id !== id);
        }
        return result;
      },
      replayDelete: async (id: string, { intentId }: { intentId: string }) => {
        replayedDeletes.push({ id, intentId });
        return { status: "confirmed" };
      },
    }),
  });
  const windowFacts = fakeWindow(room);
  const live = {
    ...mounted.host,
    device: { ...mounted.host.device, window: windowFacts },
    features: {
      ...mounted.host.features,
      above: Ground,
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TextProvider locale="en" messages={en as Messages} timeZone="UTC">
        <Frame host={live} />
      </TextProvider>,
    );
  });
  return {
    address: mounted.address,
    windowFacts,
    restored,
    replayedDeletes,
    mutations: mounted.mail.mutations,
    deleteFromMail: () => {
      if (deleting === null) throw new Error("The mail press seam has not mounted");
      listed = [row("u8"), ...listed];
      return deleting.remove({ id: "u8", mailboxId: letter("u8").mailboxId });
    },
  };
}

const reading = () => within(screen.getByRole("region", { name: "Reading" }));
const said = () => screen.queryAllByRole("status").map((status) => status.textContent).join(" ");
const listed = () => gateList().queryAllByRole("option").map((option) => option.getAttribute("data-id"));
const cursor = () => gateList().queryByRole("option", { selected: true })?.getAttribute("data-id");
const gateList = () => within(screen.getByRole("listbox", { name: en.trash.title }));
const press = async (key: string, more: KeyboardEventInit = {}) => {
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key, ...more }); });
};
const click = async (button: HTMLElement) => {
  await act(async () => { fireEvent.click(button); });
};
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const restoreShown = () => press("Backspace", { shiftKey: true });
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.scrollTo ??= () => undefined;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  vi.stubGlobal("CSS", { escape: (raw: string) => raw });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-09T11:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the intents journal carries which verb it holds", () => {
  const owner = "acct-1";
  const journal = () => takeDeleteIntents(Date.now(), owner);

  it("a restore press writes kind:restore; a delete press writes kind:delete", async () => {
    const bin = await mountTrash({ rows: [row("m1")] });
    await restoreShown();
    expect(journal().map(({ kind, messageIds }) => [kind, messageIds])).toEqual([["restore", ["m1"]]]);
    await act(async () => {
      expect(bin.deleteFromMail()).toBe(true);
    });
    expect(journal().map(({ kind, messageIds }) => [kind, messageIds])).toEqual([
      ["restore", ["m1"]],
      ["delete", ["u8"]],
    ]);
    expect(bin.restored).toEqual([]);
    expect(bin.mutations).toEqual([]);
  });

  it("a row a PREVIOUS build wrote — no kind at all — reads as a delete", async () => {
    localStorage.setItem(
      deleteIntentsKey(owner),
      JSON.stringify([{ id: "old", messageIds: ["m9"], at: Date.now() }]),
    );
    expect(journal().map(({ kind }) => kind)).toEqual(["delete"]);
    const bin = await mountTrash();
    await wait(0);
    expect(bin.replayedDeletes).toEqual([{ id: "m9", intentId: "old" }]);
    expect(bin.restored).toEqual([]);
    expect(journal()).toEqual([]);
  });

  it("a row naming a verb this build does not know is DROPPED, never approximated", async () => {
    localStorage.setItem(
      deleteIntentsKey(owner),
      JSON.stringify([{ id: "future", messageIds: ["m9"], at: Date.now(), kind: "shred" }]),
    );
    expect(journal()).toEqual([]);
    const bin = await mountTrash();
    await wait(0);
    expect(bin.replayedDeletes).toEqual([]);
    expect(bin.restored).toEqual([]);
    expect(bin.mutations).toEqual([]);
  });

  it("a stranded RESTORE with no restore dispatch is DROPPED and is NEVER sent to mutate", async () => {
    armDeleteIntent({ id: "p1", messageIds: ["m9"], at: Date.now(), kind: "restore" }, owner);
    expect(journal()).toHaveLength(1);
    const bin = await mountTrash({ restoreAvailable: false });
    await wait(0);
    expect(bin.replayedDeletes).toEqual([]);
    expect(bin.restored).toEqual([]);
    expect(bin.mutations).toEqual([]);
    expect(journal()).toEqual([]);
  });

  it("a stranded RESTORE with a restore dispatch is replayed AS A RESTORE", async () => {
    const at = Date.now();
    const otherOwner = "acct-2";
    const other = { id: "other", messageIds: ["m9"], at, kind: "delete" as const };
    armDeleteIntent({ id: "p1", messageIds: ["m9"], at, kind: "restore" }, owner);
    armDeleteIntent({ id: "p2", messageIds: ["m8"], at, kind: "delete" }, owner);
    armDeleteIntent(other, otherOwner);
    const bin = await mountTrash({ rows: [row("m9")] });
    await wait(0);
    expect(bin.restored).toEqual([{ id: "m9", intentId: "p1" }]);
    expect(bin.replayedDeletes).toEqual([{ id: "m8", intentId: "p2" }]);
    expect(bin.mutations).toEqual([]);
    expect(journal()).toEqual([]);
    expect(takeDeleteIntents(Date.now(), otherOwner)).toEqual([other]);
  });
});

describe("the restore's place sentence states the state it is in", () => {
  it("the dispatch's callback raises that sentence and no other", async () => {
    const bin = await mountTrash({
      rows: [row("m1")],
      answer: async () => ({ state: "restored", restoreTo: "ohmail/News", pending: true }),
    });
    await restoreShown();
    const expected = en.trash.toastRestoringTo.replace("{place}", "News");
    expect(said()).toContain(en.trash.restoring);
    expect(said()).not.toContain(expected);
    expect(bin.restored).toEqual([]);
    await wait(UNDO_MS);
    expect(said()).toContain(expected);
    expect(said()).not.toContain("Restored to News.");
    expect(bin.restored.map(({ id }) => id)).toEqual(["m1"]);
  });
});

describe("the Trash view", () => {
  it("⇧⌫ restores the row the column shows — what the Restore button beside it does", async () => {
    const bin = await mountTrash({ rows: [row("m1"), row("m2")] });
    expect(reading().getByRole("heading", { name: "Subject m1" })).toBeTruthy();
    await restoreShown();
    expect(bin.restored).toEqual([]);
    await wait(UNDO_MS);
    expect(bin.restored.map(({ id }) => id)).toEqual(["m1"]);
    await click(gateList().getByRole("option", { name: /Subject m2/ }));
    expect(reading().getByRole("heading", { name: "Subject m2" })).toBeTruthy();
    await click(reading().getByRole("button", { name: en.trash.restore }));
    await wait(UNDO_MS);
    expect(bin.restored.map(({ id }) => id)).toEqual(["m1", "m2"]);
  });

});

describe("a letter listed late never takes the cursor or the reader", () => {
  it("the delete that lands after its Undo window lists on top; the letter shown stays shown and ⇧⌫ restores it", async () => {
    const bin = await mountTrash({ rows: [row("m1"), row("m2")] });
    expect(cursor()).toBe("m1");
    expect(reading().getByRole("heading", { name: "Subject m1" })).toBeTruthy();
    await act(async () => { expect(bin.deleteFromMail()).toBe(true); });
    await wait(UNDO_MS + 1);
    expect(listed()).toEqual(["u8", "m1", "m2"]);
    expect(cursor()).toBe("m1");
    expect(reading().getByRole("heading", { name: "Subject m1" })).toBeTruthy();
    expect(reading().queryByRole("heading", { name: "Subject u8" })).toBeNull();
    await restoreShown();
    await wait(UNDO_MS);
    expect(bin.restored.map(({ id }) => id)).toEqual(["m1"]);
    expect(bin.address.read()).toBe("#/trash");
    expect(reading().queryByRole("heading", { name: /Subject/ })).toBeNull();
    expect(cursor()).toBe("m2");
    await press("ArrowDown");
    expect(cursor()).toBe("m2");
    expect(reading().queryByRole("heading", { name: /Subject/ })).toBeNull();
  });
});

describe("a restored letter leaves Trash for good", () => {
  const letters = [row("m1"), row("m2")];

  it("past its Undo window the restored letter stays out of the list, the cursor and the reader", async () => {
    await mountTrash({ rows: letters });
    expect(cursor()).toBe("m1");
    await restoreShown();
    expect(listed()).toEqual(["m2"]);
    await wait(UNDO_MS + 1_000);
    expect(listed()).toEqual(["m2"]);
    expect(cursor()).toBe("m2");
    expect(reading().queryByRole("heading", { name: "Subject m1" })).toBeNull();
    expect(said()).not.toContain(en.trash.toastRestoreFailed);
  });

  it("stays hidden while the server answers, and a refusal brings it back with the refusal", async () => {
    const response = Promise.withResolvers<RestoreAnswer>();
    await mountTrash({ rows: letters, answer: () => response.promise });
    await restoreShown();
    await wait(UNDO_MS + 1_000);
    expect(listed()).toEqual(["m2"]);
    await act(async () => { response.resolve({ state: "rolled_back", error: "x", code: "provider_unreachable" }); });
    expect(listed()).toEqual(["m1", "m2"]);
    expect(said()).toContain(en.trash.toastRestoreFailed);
  });

  it("a letter already out of Trash leaves the list and is said to be out, never 'still in Trash'", async () => {
    await mountTrash({
      rows: letters,
      answer: async () => ({ state: "rolled_back", error: "this message is not in Trash", code: "not_in_trash" }),
    });
    await restoreShown();
    await wait(UNDO_MS + 1_000);
    expect(listed()).toEqual(["m2"]);
    expect(said()).toContain(en.trash.toastRestoreGone);
    expect(said()).not.toContain(en.trash.toastRestoreFailed);
  });
});

it.each([
  ["desktop", "middle", ["m1", "m2", "m3"], "m2", "m3"],
  ["desktop", "last", ["m1", "m2", "m3"], "m3", "m2"],
  ["desktop", "only", ["m1"], "m1", undefined],
  ["phone", "middle", ["m1", "m2", "m3"], "m2", "m3"],
  ["phone", "last", ["m1", "m2", "m3"], "m3", "m2"],
  ["phone", "only", ["m1"], "m1", undefined],
] as const)("%s Restore leaves the expected selection for a %s row", async (room, _position, ids, target, adjacent) => {
  const bin = await mountTrash({ rows: ids.map(row), room });
  const option = (id: string) => gateList().getByRole("option", { name: new RegExp("Subject " + id) });
  const selection = () => screen.queryByRole("option", { selected: true })?.getAttribute("data-id");
  await click(option(target));
  const column = within(screen.getByRole(room === "phone" ? "dialog" : "region", { name: "Reading" }));
  await click(column.getByRole("button", { name: en.trash.restore }));
  expect(bin.address.read()).toBe("#/trash");
  expect(bin.restored).toEqual([]);
  expect(selection()).toBe(adjacent);

  if (room === "phone" && adjacent) {
    await press("k");
    expect(selection()).toBe("m1");
    await press("j");
    expect(selection()).toBe(adjacent);
    act(() => option(adjacent).focus());
    await press("ArrowUp");
    expect(selection()).toBe("m1");
    expect(bin.address.read()).toBe("#/trash");
  }
  await wait(UNDO_MS);
  expect(bin.restored.map(({ id }) => id)).toEqual([target]);
  expect(selection()).toBe(room === "phone" && adjacent ? "m1" : adjacent);
});

it("keeps the current Trash row when widening after a compact Restore", async () => {
  const bin = await mountTrash({ rows: [row("m1"), row("m2"), row("m3")], room: "phone" });
  await click(gateList().getByRole("option", { name: /Subject m2/ }));
  const dialog = within(screen.getByRole("dialog", { name: "Reading" }));
  await click(dialog.getByRole("button", { name: en.trash.restore }));
  expect(cursor()).toBe("m3");
  await press("k");
  expect(cursor()).toBe("m1");
  expect(bin.address.read()).toBe("#/trash");

  await act(async () => { bin.windowFacts.resize(1440, 900, "fine"); });
  expect(bin.address.read()).toBe("#/trash");
  expect(cursor()).toBe("m1");
  expect(reading().queryByRole("heading", { name: /Subject/ })).toBeNull();
  expect(bin.restored).toEqual([]);
  await wait(UNDO_MS);
  expect(bin.restored.map(({ id }) => id)).toEqual(["m2"]);
  expect(cursor()).toBe("m1");
});
