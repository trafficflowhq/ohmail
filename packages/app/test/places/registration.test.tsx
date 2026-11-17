/** @vitest-environment jsdom */
/**
 * EACH LIST PLACE MOUNTS ALONE IN THE REAL FRAME over the fake host and engine: its rail entry where it has one, its
 * list in the list column at its own address, and nothing of any other place. No host hands these over yet; this is
 * what the seating step relies on.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMessage, FolderEntity, TagDTO } from "@ohmail/client-engine";
import { useAddressList } from "@ohmail/app-logic/address";
import { useDraftsList } from "@ohmail/app-logic/drafts";
import { useFolderList } from "@ohmail/app-logic/folder";
import { useHistoryList } from "@ohmail/app-logic/history";
import { useTagsList } from "@ohmail/app-logic/tags";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine";
import { useTrashList } from "@ohmail/app-logic/trash";
import { Frame } from "../../src/frame/Frame.js";
import type { PlaceEntry, PlaceId } from "../../src/frame/contract.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { addressPlace, AddressAbove } from "../../src/address/index.js";
import { draftsPlace, DraftsAbove } from "../../src/drafts/index.js";
import { folderPlace, FolderAbove } from "../../src/folder/index.js";
import { historyPlace, HistoryAbove } from "../../src/history/index.js";
import { tagsPlace, TagsAbove } from "../../src/tags/index.js";
import { trashPlace, TrashAbove } from "../../src/trash/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import { wideWindow } from "../ohbox/setup.js";
import { at, draft, msg, stamp, WORDS } from "./lists-world.js";

const mail: EngineMessage[] = [
  msg({
    id: "m1",
    subject: "A letter",
    date: at(3),
    labels: ["t1"],
    from: "Petra Wyss",
    fromAddress: "petra@ex.example",
  }),
];
const tags: TagDTO[] = [{ id: "t1", name: "Pottery", hue: "40", createdAt: at(1), updatedAt: at(1) }];
const folder = { id: "f1", name: "Workshops", mailboxId: "mb", mailbox: "mb" } as FolderEntity;

function useSeat() {
  const [openId, open] = useState<string | null>(null);
  return { openId, open, markSeen: () => true, act: () => {}, stamp, settled: true, owed: false };
}

/** Each place's Above, its model over plain rows, as a seat would stand it. */
const ABOVE: Record<string, (props: { children: ReactNode }) => ReactNode> = {
  history: function HistorySeat({ children }: { children: ReactNode }) {
    const model = useHistoryList({
      ...useSeat(),
      messages: mail,
      placeOf: () => "Ohbox",
      store: { down: false, retry: () => {} },
    });
    return <HistoryAbove model={model}>{children}</HistoryAbove>;
  },
  tags: function TagsSeat({ children }: { children: ReactNode }) {
    const model = useTagsList({
      ...useSeat(),
      tags,
      messages: mail,
      tagId: null,
      rename: () => {},
      remove: () => {},
    });
    return <TagsAbove model={model}>{children}</TagsAbove>;
  },
  folder: function FolderSeat({ children }: { children: ReactNode }) {
    const model = useFolderList({
      ...useSeat(),
      folder,
      folderId: "f1",
      folders: [folder],
      openFolder: () => {},
      messages: mail,
    });
    return <FolderAbove model={model}>{children}</FolderAbove>;
  },
  address: function AddressSeat({ children }: { children: ReactNode }) {
    const model = useAddressList({
      ...useSeat(),
      address: "petra@ex.example",
      messages: mail,
      placeOf: () => "Ohbox",
      back: null,
    });
    return <AddressAbove model={model}>{children}</AddressAbove>;
  },
  drafts: function DraftsSeat({ children }: { children: ReactNode }) {
    const model = useDraftsList({
      drafts: [draft({ id: "d1", subject: "Half a letter" })],
      scheduled: [],
      settled: true,
      owed: false,
      door: {
        open: () => {},
        decide: () => ({ kind: "go" }),
        withdrawWaiting: async () => "none",
        discard: async () => ({ kind: "applied" }),
        cancelSchedule: () => {},
        editScheduled: () => {},
        resolve: () => {},
        sendAgain: () => {},
        repliesHere: () => false,
        heldHere: new Set(),
        waiting: new Set(),
        notSent: new Map(),
      },
      report: () => {},
      words: { discarded: "", undo: "", notSent: "", refused: () => "", queued: () => "" },
      stamp,
      appointment: stamp,
      now: new Date(at(3)),
    });
    return <DraftsAbove model={model}>{children}</DraftsAbove>;
  },
  trash: function TrashSeat({ children }: { children: ReactNode }) {
    const model = useTrashList({
      held: new Set(),
      landed: 0,
      restored: [],
      restore: () => true,
      markSeen: () => true,
      wire: "none",
      openId: null,
      open: () => {},
      stamp,
      placeOf: (f) => f,
    });
    return <TrashAbove model={model}>{children}</TrashAbove>;
  },
};

const ENTRIES: readonly [PlaceEntry, string, string][] = [
  [historyPlace, "#/history", "History"],
  [tagsPlace, "#/tag/t1", "Tags"],
  [folderPlace, "#/folder/f1", "Workshops"],
  [addressPlace, "#/address/petra%40ex.example", "Petra Wyss"],
  [draftsPlace, "#/drafts", "Drafts"],
  [trashPlace, "#/trash", "Trash"],
];

const ALL: Messages = { ...FRAME_WORDS.en, ...WORDS.en } as Messages;

function mount(entry: PlaceEntry, at: string) {
  const engine = fakeMail([]).engine;
  /* The paged window of Trash, as the server answers it with nothing deleted. */
  Object.assign(engine, { listTrash: async () => ({ state: "ready", items: [], nextCursor: null }) });
  const made = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: { [entry.id]: entry } as Partial<Record<PlaceId, PlaceEntry>>,
    window: fakeWindow("desktop"),
    address: fakeAddress(at),
  });
  const Above = ABOVE[entry.id]!;
  const binding: EngineBinding = {
    engine,
    demo: false,
    serverDemo: false,
    sync: { phase: "idle" } as unknown as EngineBinding["sync"],
  };
  return render(
    <TextProvider locale="en" messages={ALL} timeZone="UTC">
      <EngineContext.Provider value={binding}>
        <Above>
          <Frame host={made.host} />
        </Above>
      </EngineContext.Provider>
    </TextProvider>,
  );
}

beforeEach(() => wideWindow());
afterEach(() => cleanup());

describe("the list places, each alone in the frame", () => {
  it.each(ENTRIES)("%#: %s draws its list at its address", (entry, address, title) => {
    mount(entry, address);
    expect(
      screen.getAllByRole("heading", { name: new RegExp(title.replace(/[.@]/g, "\\$&")) }).length,
    ).toBeGreaterThan(0);
  });

  it("the places with a rail entry name it in their own words; a folder and an address have none", () => {
    for (const [entry, address, title] of ENTRIES) {
      const view = mount(entry, address);
      const rail = view.container.querySelector(`[data-rail-id="${entry.id}"]`);
      if (entry.rail === null) expect(rail).toBeNull();
      else expect(rail?.textContent).toContain(title);
      view.unmount();
    }
    expect(ENTRIES.map(([e]) => [e.id, e.rail?.group ?? null])).toEqual([
      ["history", "more"],
      ["tags", "tags"],
      ["folder", null],
      ["address", null],
      ["drafts", "more"],
      ["trash", "more"],
    ]);
  });

  it("the four reader places use the reader's column; Trash asks the room for its own, Drafts' blank column does not", () => {
    const panes = ENTRIES.map(([e]) =>
      e.panes.kind === "columns" ? [e.id, e.panes.Reading === "reader", e.panes.room ?? false] : [e.id],
    );
    expect(panes).toEqual([
      ["history", true, false],
      ["tags", true, false],
      ["folder", true, false],
      ["address", true, false],
      ["drafts", false, false],
      ["trash", false, true],
    ]);
  });
});
