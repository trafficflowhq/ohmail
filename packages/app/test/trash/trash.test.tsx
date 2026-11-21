/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine, TrashRowWire } from "@ohmail/client-engine";
import type { ReactNode } from "react";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine";
import type { DeleteTarget } from "@ohmail/app-logic/press/delete-undo";
import {
  useTrashList,
  type TrashLiveWire,
  type TrashWindowItemWire,
  type TrashWindowPageWire,
} from "@ohmail/app-logic/trash";
import { TrashAbove, TrashList, TrashReading } from "../../src/trash/index.js";
import { at, draw, msg, pane, stamp, walkAt } from "../places/lists-world.js";
import { wideWindow } from "../ohbox/setup.js";

const row = (id: string, restoreTo: string): TrashRowWire =>
  ({
    ...msg({ id, subject: `About ${id}`, from: "Tim Keller" }),
    trashedAt: at(3),
    restoreTo,
  }) as TrashRowWire;

function engineWith(rows: TrashRowWire[]): EngineBinding {
  const engine = {
    trashAvailable: () => true,
    onMessagesRemoved: () => () => {},
    listTrash: async () => ({ state: "ready", items: rows, nextCursor: null }),
  } as unknown as OhmailEngine;
  return {
    engine,
    demo: false,
    serverDemo: false,
    sync: { phase: "idle" } as unknown as EngineBinding["sync"],
  };
}

const live = (uid: number, subject: string): TrashWindowItemWire => ({
  mailboxId: "mb",
  uid,
  uidValidity: "7",
  subject,
  from: { name: "Someone Else", address: "someone@ex.example" },
  date: at(1),
  messageIdHeader: null,
  seen: true,
  origin: "provider",
});

function wireOf(page: TrashWindowPageWire, asked: string[]): TrashLiveWire {
  return {
    list: async () => {
      asked.push("list");
      return page;
    },
    body: async (_m, uid) => {
      asked.push(`body:${uid}`);
      return { subject: "s", text: "the text from the server" };
    },
  };
}

function Trash(props: {
  restore: (t: DeleteTarget) => boolean;
  marked: Array<{ ids: readonly string[]; unread: boolean }>;
  wire: TrashLiveWire | "none";
  open: string | null;
  went: (id: string | null) => void;
  keys: boolean;
}) {
  const model = useTrashList({
    held: new Set(),
    landed: 0,
    restored: [],
    restore: props.restore,
    markSeen: async (ids, unread) => {
      props.marked.push({ ids, unread });
      return true;
    },
    wire: props.wire,
    openId: props.open,
    open: props.went,
    stamp,
    placeOf: (folder) => (folder === "INBOX" ? "Ohbox" : folder),
    ...walkAt(),
  });
  const p = { ...pane("trash", { open: props.open }), keysHere: props.keys };
  return (
    <TrashAbove model={model}>
      <TrashList {...p} />
      <TrashReading {...p} />
    </TrashAbove>
  );
}

function Registry({ children }: { children: ReactNode }) {
  return <KeymapContext.Provider value={useKeymapStore()}>{children}</KeymapContext.Provider>;
}

function mount(o: {
  rows: TrashRowWire[];
  wire?: TrashLiveWire | "none";
  open?: string | null;
  keys?: boolean;
}) {
  const restored: DeleteTarget[] = [];
  const marked: Array<{ ids: readonly string[]; unread: boolean }> = [];
  const went: Array<string | null> = [];
  const view = draw(
    <Registry>
      <EngineContext.Provider value={engineWith(o.rows)}>
        <Trash
          restore={(t) => {
            restored.push(t);
            return true;
          }}
          marked={marked}
          wire={o.wire ?? "none"}
          open={o.open ?? null}
          went={(id) => went.push(id)}
          keys={o.keys ?? true}
        />
      </EngineContext.Provider>
    </Registry>,
  );
  return { view, restored, marked, went };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });

beforeEach(() => wideWindow());
afterEach(() => cleanup());

describe("Trash lists what ohmail deleted, each row saying when and where Restore puts it", () => {
  it("draws the deleted letters with their deletion time and their place", async () => {
    mount({ rows: [row("t1", "INBOX"), row("t2", "Clients")] });
    await flush();
    const list = screen.getByRole("listbox", { name: "Trash" });
    expect(list.textContent).toContain(`Deleted ${stamp(at(3))}`);
    expect(list.textContent).toContain("← Ohbox");
    expect(list.textContent).toContain("← Clients");
  });

  it("Restore goes through the seam for that row alone: where it goes is the row's record, not the client's", async () => {
    const m = mount({ rows: [row("t1", "INBOX"), row("t2", "Clients")], open: "t2" });
    await flush();
    const open = screen.getByRole("listbox", { name: "Trash" }).querySelector('[data-id="t2"]');
    expect(open?.textContent).toContain("Clients");
    const panel = screen.getByRole("toolbar");
    fireEvent.click(within(panel).getByRole("button", { name: /Restore/ }));
    expect(m.restored).toEqual([{ id: "t2", mailboxId: "mb" }]);
    expect(Object.keys(m.restored[0]!)).toEqual(["id", "mailboxId"]);
    expect(m.went).toEqual([null]);
  });

  it("a second press before the window shows the row held is no second restore", async () => {
    const m = mount({ rows: [row("t1", "INBOX")], open: "t1" });
    await flush();
    const restore = within(screen.getByRole("toolbar")).getByRole("button", { name: /Restore/ });
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(m.restored).toHaveLength(1);
  });

  it("the panel carries the read slot beside Restore: Mark unread on a read letter, Mark read once it is unread", async () => {
    const m = mount({ rows: [row("t1", "INBOX"), row("t2", "Clients")], open: "t2" });
    await flush();
    // The reader's panel, named as the reader names it.
    const panel = screen.getByRole("toolbar", { name: "Actions" });
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([expect.stringMatching(/Restore/), expect.stringMatching(/Mark unread/)]);
    fireEvent.click(within(panel).getByRole("button", { name: /Mark unread/ }));
    await flush();
    expect(m.marked).toEqual([{ ids: ["t2"], unread: true }]);
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Mark read/ }));
    await flush();
    expect(m.marked).toEqual([
      { ids: ["t2"], unread: true },
      { ids: ["t2"], unread: false },
    ]);
    expect(m.restored).toEqual([]);
  });
});

describe("Trash's keys are the two its panel names", () => {
  it("u presses the read slot and ⇧⌫ Restore, for the letter that stands open", async () => {
    const m = mount({ rows: [row("t1", "INBOX"), row("t2", "Clients")], open: "t2" });
    await flush();
    fireEvent.keyDown(document.body, { key: "u" });
    await flush();
    expect(m.marked).toEqual([{ ids: ["t2"], unread: true }]);
    expect(within(screen.getByRole("toolbar")).getByRole("button", { name: /Mark read/ })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true });
    expect(m.restored).toEqual([{ id: "t2", mailboxId: "mb" }]);
  });

  it("neither key acts in a field, with Ctrl, Cmd or Alt, while the column has not the keys, or as a held ⇧⌫", async () => {
    const m = mount({ rows: [row("t1", "INBOX")], open: "t1" });
    await flush();
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "u" });
    fireEvent.keyDown(field, { key: "Backspace", shiftKey: true });
    field.remove();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      fireEvent.keyDown(document.body, { key: "u", ...mod });
      fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true, ...mod });
    }
    fireEvent.keyDown(document.body, { key: "Backspace" });
    fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true, repeat: true });
    await flush();
    expect(m.marked).toEqual([]);
    expect(m.restored).toEqual([]);
    cleanup();
    const away = mount({ rows: [row("t1", "INBOX")], open: "t1", keys: false });
    await flush();
    fireEvent.keyDown(document.body, { key: "u" });
    fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true });
    await flush();
    expect(away.marked).toEqual([]);
    expect(away.restored).toEqual([]);
  });

  it("while a dialog or a menu stands over the column neither key acts (the released Trash's guard)", async () => {
    const m = mount({ rows: [row("t1", "INBOX")], open: "t1" });
    await flush();
    for (const role of ["dialog", "menu"]) {
      const over = document.createElement("div");
      over.setAttribute("role", role);
      document.body.append(over);
      fireEvent.keyDown(document.body, { key: "u" });
      fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true });
      over.remove();
    }
    await flush();
    expect(m.marked).toEqual([]);
    expect(m.restored).toEqual([]);
    fireEvent.keyDown(document.body, { key: "u" });
    await flush();
    expect(m.marked).toEqual([{ ids: ["t1"], unread: true }]);
  });

  it("with no deleted letter open neither key does anything", async () => {
    const m = mount({ rows: [row("t1", "INBOX")] });
    await flush();
    fireEvent.keyDown(document.body, { key: "u" });
    fireEvent.keyDown(document.body, { key: "Backspace", shiftKey: true });
    await flush();
    expect(m.marked).toEqual([]);
    expect(m.restored).toEqual([]);
  });
});

describe("the mail server's own Trash", () => {
  it("`none` withholds the section: nothing is asked of any server", async () => {
    mount({ rows: [row("t1", "INBOX")], wire: "none" });
    await flush();
    expect(screen.queryByRole("region", { name: "In your mail server's Trash" })).toBeNull();
    expect(document.body.textContent).not.toContain("In your mail server's Trash");
  });

  it("lists its rows read-only: an open live row reads its text and offers no verb", async () => {
    const asked: string[] = [];
    const wire = wireOf(
      {
        mailboxes: [{ id: "mb", address: "a", window: "ok" }],
        items: [live(41, "Gone elsewhere")],
        nextCursor: null,
      },
      asked,
    );
    const m = mount({ rows: [], wire, open: "mb:7:41" });
    await flush();
    expect(screen.getByRole("listbox", { name: "In your mail server's Trash" }).textContent).toContain(
      "Gone elsewhere",
    );
    expect(asked).toEqual(["list", "body:41"]);
    expect(document.body.textContent).toContain("the text from the server");
    const panel = screen.getByRole("toolbar");
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(m.restored).toEqual([]);
  });

  it("its heading counts the rows only once the last page is read; with older rows to read it says no number", async () => {
    const page = (nextCursor: string | null): TrashWindowPageWire => ({
      mailboxes: [{ id: "mb", address: "a", window: "ok" }],
      items: [live(41, "Gone elsewhere"), live(42, "Gone too")],
      nextCursor,
    });
    mount({ rows: [], wire: wireOf(page("more"), []) });
    await flush();
    const partial = screen.getByRole("heading", { name: /In your mail server's Trash/ });
    expect(partial.textContent).not.toMatch(/\d/);
    expect(screen.getByRole("button", { name: "Show older" })).toBeTruthy();
    cleanup();
    mount({ rows: [], wire: wireOf(page(null), []) });
    await flush();
    expect(screen.getByRole("heading", { name: /In your mail server's Trash/ }).textContent).toContain("2");
  });

  it("a failed read says so with a way to ask again, never an empty Trash", async () => {
    const asked: string[] = [];
    const wire: TrashLiveWire = {
      list: async () => {
        asked.push("list");
        throw new Error("down");
      },
      body: async () => ({ subject: "", text: "" }),
    };
    mount({ rows: [], wire });
    await flush();
    expect(document.body.textContent).toContain("couldn’t be read just now");
    expect(document.body.textContent).not.toContain("Nothing in your mail server’s Trash");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(asked).toEqual(["list", "list"]);
  });
});
