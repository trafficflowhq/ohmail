/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useContext, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMessage, FolderEntity, TagDTO } from "@ohmail/client-engine";
import { useAddressList } from "@ohmail/app-logic/address";
import { useFolderList } from "@ohmail/app-logic/folder";
import { useHistoryList } from "@ohmail/app-logic/history";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import { ListMeetingContext } from "@ohmail/app-logic/reading";
import { useTagsList } from "@ohmail/app-logic/tags";
import { AddressAbove, AddressList } from "../../src/address/index.js";
import { FolderAbove, FolderList } from "../../src/folder/index.js";
import { HistoryAbove, HistoryList } from "../../src/history/index.js";
import { TagsAbove, TagsList } from "../../src/tags/index.js";
import { FrameContext, type FrameInner } from "../../src/frame/commands.js";
import type { LayoutPlan, RailModel } from "../../src/frame/contract.js";
import { createFeed } from "../../src/frame/feeds.js";
import { ListMenu } from "../../src/place-list/index.js";
import { at, draw, inWords, msg, pane, PHONE, stamp } from "./lists-world.js";
import { wideWindow } from "../ohbox/setup.js";

interface Seen {
  marked: Array<{ ids: string[]; unread: boolean }>;
  acted: Array<[MessageAction, string]>;
}

/** The meeting as the reading column reads it: the open letter, its two steps, or what the place holds. */
function Column() {
  const meeting = useContext(ListMeetingContext);
  const visit = meeting?.visit ?? null;
  if (visit === null) return <p data-testid="column">{meeting?.blank?.label ?? ""}</p>;
  return (
    <div data-testid="column">
      <p>open {visit.openId}</p>
      <button type="button" disabled={visit.step.up.disabled} onClick={visit.step.up.run}>
        {visit.step.up.label}
      </button>
      <button type="button" disabled={visit.step.down.disabled} onClick={visit.step.down.run}>
        {visit.step.down.label}
      </button>
      <button type="button" onClick={() => visit.act("later")}>
        later
      </button>
    </div>
  );
}

/** What every list place takes from its seat, with the open letter held as the frame's route would hold it. */
function useSeat(seen: Seen, first: string | null = null) {
  const [openId, open] = useState<string | null>(first);
  return {
    openId,
    open,
    markSeen: (ids: string[], unread: boolean) => {
      seen.marked.push({ ids, unread });
      return true;
    },
    act: (action: MessageAction, m: EngineMessage) => seen.acted.push([action, m.id]),
    stamp,
  };
}

const fresh = (): Seen => ({ marked: [], acted: [] });

beforeEach(() => wideWindow());
afterEach(() => cleanup());

describe("the list's menu", () => {
  it("offers the frame's one pull first, then the place's own verbs; with nothing to offer no button stands", () => {
    const pressed: string[] = [];
    const rail = createFeed<RailModel | null>({
      groups: [],
      write: null,
      account: null,
      pull: { label: "Pull new mail", busy: false, onPress: () => pressed.push("pull") },
    });
    const inner = { rail } as unknown as FrameInner;
    const menu = (items: Parameters<typeof ListMenu>[0]["items"]) => (
      <FrameContext.Provider value={inner}>
        <ListMenu label="List" items={items} />
      </FrameContext.Provider>
    );
    draw(menu([{ label: "Mark all read", onPress: () => pressed.push("all") }]));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Pull new mail", "Mark all read"]);
    fireEvent.click(items[0]!);
    expect(pressed).toEqual(["pull"]);
    cleanup();
    // The host has no pull and the place no verb: nothing stands to open.
    act(() => rail.set({ groups: [], write: null, account: null, pull: null }));
    draw(menu([]));
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
  });
});

describe("History", () => {
  function History(props: { messages: EngineMessage[]; seen: Seen; down?: boolean; retried?: () => void }) {
    const seat = useSeat(props.seen);
    const model = useHistoryList({
      ...seat,
      messages: props.messages,
      settled: true,
      owed: false,
      placeOf: (m) => (m.folder === "INBOX" ? "Ohbox" : "News"),
      store: { down: props.down ?? false, retry: props.retried ?? (() => {}) },
    });
    return (
      <HistoryAbove model={model}>
        <HistoryList {...pane("history", { open: seat.openId })} />
        <Column />
      </HistoryAbove>
    );
  }
  const mail = [
    msg({ id: "old", date: at(1), subject: "Oldest" }),
    msg({ id: "new", date: at(5), subject: "Newest", folder: "ohmail/News" }),
    msg({ id: "mid", date: at(3), subject: "Middle" }),
  ];

  it("lists every letter newest first, each with its place, and the count in the head", () => {
    draw(<History messages={mail} seen={fresh()} />);
    const rows = screen.getByRole("listbox", { name: "History" }).querySelectorAll("[data-id]");
    expect([...rows].map((r) => r.getAttribute("data-id"))).toEqual(["new", "mid", "old"]);
    expect(rows[0]!.textContent).toContain("News");
    expect(rows[1]!.textContent).toContain("Ohbox");
    expect(screen.getByTestId("column").textContent).toBe("3 messages");
  });

  it("the title ends in the hot dot while an unread letter stands in it; a letter with a file shows the paper-clip", () => {
    const title = () => screen.getByRole("heading", { name: "History" }).querySelector(".oh-dot")!;
    draw(<History messages={mail} seen={fresh()} />);
    expect(title().getAttribute("data-kind")).toBe("ink");
    expect(document.querySelectorAll('[aria-label="Has an attachment"]')).toHaveLength(0);
    cleanup();
    const more = [...mail, msg({ id: "u", date: at(6), unread: true, hasAttachments: true })];
    draw(<History messages={more} seen={fresh()} />);
    expect(title().getAttribute("data-kind")).toBe("hot");
    // The row is one option to a screen reader; the paper-clip is named inside it.
    expect(document.querySelectorAll('[aria-label="Has an attachment"]')).toHaveLength(1);
  });

  it("a press opens the letter beside it; the steps walk the list and a verb runs on the seat's path", () => {
    const seen = fresh();
    draw(<History messages={mail} seen={seen} />);
    fireEvent.click(screen.getByRole("option", { name: /Middle/ }));
    const column = screen.getByTestId("column");
    expect(column.textContent).toContain("open mid");
    fireEvent.click(within(column).getByRole("button", { name: "Older" }));
    expect(screen.getByTestId("column").textContent).toContain("open old");
    expect(within(screen.getByTestId("column")).getByRole("button", { name: "Older" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(screen.getByTestId("column")).getByRole("button", { name: "later" }));
    expect(seen.acted).toEqual([["later", "old"]]);
    expect(seen.marked).toEqual([]);
  });

  it("the server's store silent: the device's mail stands under the sentence, with its way to ask again", () => {
    let asked = 0;
    draw(<History messages={mail} seen={fresh()} down retried={() => (asked += 1)} />);
    expect(document.body.textContent).toContain("Your server did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(asked).toBe(1);
  });

  it("speaks German", () => {
    draw(<History messages={mail} seen={fresh()} />, "de");
    expect(screen.getByRole("listbox", { name: "Historie" })).toBeTruthy();
  });

  describe("its months, at the list's right edge", () => {
    /* Nine in the morning, UTC, of the day named: the same month in every zone the test may run in. */
    const day = (iso: string) =>
      new Date(
        Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 9),
      ).toISOString();
    const spread = [
      msg({ id: "nov", date: day("2026-11-05") }),
      msg({ id: "nov2", date: day("2026-11-02") }),
      msg({ id: "sep", date: day("2026-09-10") }),
      msg({ id: "y25", date: day("2025-12-01") }),
    ];
    let went: string[] = [];
    const was = Element.prototype.scrollIntoView;
    beforeEach(() => {
      went = [];
      Element.prototype.scrollIntoView = function (this: Element) {
        went.push(this.getAttribute("data-id") ?? this.tagName);
      };
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = was;
    });
    function Months(props: { plan?: LayoutPlan }) {
      const seat = useSeat(fresh());
      const model = useHistoryList({
        ...seat,
        messages: spread,
        settled: true,
        owed: false,
        placeOf: () => "Ohbox",
        store: { down: false, retry: () => {} },
      });
      return (
        <HistoryAbove model={model}>
          <HistoryList {...pane("history", { open: seat.openId }, props.plan)} />
        </HistoryAbove>
      );
    }
    const steps = (name: string) =>
      within(screen.getByRole("navigation", { name }))
        .getAllByRole("button")
        .map((b) => b.textContent);
    const current = (name: string) =>
      within(screen.getByRole("navigation", { name }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-current") === "true")
        .map((b) => b.textContent);

    it("with a pointer: the years, and the months of the year on show; a press goes to that month's first letter", () => {
      draw(<Months />);
      expect(steps("Month")).toEqual(["2026", "Nov", "Sep", "2025"]);
      expect(current("Month")).toEqual(["Nov"]);
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Month" })).getByRole("button", {
          name: "September 2026",
        }),
      );
      expect(went).toEqual(["sep"]);
      expect(current("Month")).toEqual(["Sep"]);
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Month" })).getByRole("button", { name: "2025" }),
      );
      expect(went).toEqual(["sep", "y25"]);
      // The year on show is 2025 now: its months stand, 2026's leave.
      expect(steps("Month")).toEqual(["2026", "2025", "Dec"]);
      expect(current("Month")).toEqual(["Dec"]);
    });

    it("under a finger, the years alone; on the unfolded phone the years stand in the head", () => {
      draw(<Months plan={PHONE} />);
      expect(steps("Year")).toEqual(["2026", "2025"]);
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Year" })).getByRole("button", { name: "2025" }),
      );
      expect(went).toEqual(["y25"]);
      cleanup();
      went = [];
      draw(<Months plan={{ ...PHONE, device: "fold", size: "medium" }} />);
      expect(screen.queryByRole("navigation", { name: /Year|Month/ })).toBeNull();
      const years = within(screen.getByRole("banner")).getByRole("group", { name: "Year" });
      fireEvent.click(within(years).getByRole("button", { name: "2025" }));
      expect(went).toEqual(["y25"]);
      expect(within(years).getByRole("button", { name: "2025" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("speaks German", () => {
      draw(<Months />, "de");
      expect(screen.getByRole("navigation", { name: "Monat" })).toBeTruthy();
    });
  });
});

describe("Tags", () => {
  const tags: TagDTO[] = [
    { id: "t-pottery", name: "Pottery", hue: "40", createdAt: at(1), updatedAt: at(1) },
    { id: "t-paper", name: "Paperwork", hue: "200", createdAt: at(1), updatedAt: at(1) },
  ];
  const mail = [
    msg({ id: "a", subject: "Glaze", labels: ["t-pottery"], date: at(4) }),
    msg({ id: "b", subject: "Tax form", labels: ["t-paper"], date: at(3) }),
    msg({ id: "c", subject: "Kiln", labels: ["t-pottery", "t-paper"], date: at(5) }),
  ];
  function Tags(props: { tagId: string | null; seen: Seen; renamed?: string[]; removed?: string[] }) {
    const seat = useSeat(props.seen);
    const model = useTagsList({
      ...seat,
      tags,
      messages: mail,
      tagId: props.tagId,
      settled: true,
      owed: false,
      rename: (id, name) => props.renamed?.push(`${id}:${name}`),
      remove: (id) => props.removed?.push(id),
    });
    return (
      <TagsAbove model={model}>
        <TagsList {...pane("tags", { sub: props.tagId, open: seat.openId })} />
        <Column />
      </TagsAbove>
    );
  }

  it("one tag: its head counts the letters carrying it and ends in the hot dot while one is unread", () => {
    draw(<Tags tagId="t-pottery" seen={fresh()} />);
    const head = screen.getByRole("banner");
    expect(head.textContent).toContain("2 messages");
    expect(within(head).getByRole("heading").querySelector(".oh-dot")!.getAttribute("data-kind")).toBe("ink");
  });

  it("with no tag named, lists every tag by name as a group that shuts and opens", () => {
    draw(<Tags tagId={null} seen={fresh()} />);
    const groups = screen.getAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Paperwork", "Pottery"]);
    expect(
      within(groups[1]!)
        .getAllByRole("option")
        .map((o) => o.getAttribute("data-id") ?? o.closest("[data-id]")?.getAttribute("data-id")),
    ).toHaveLength(2);
    fireEvent.click(within(groups[1]!).getByRole("button", { name: /Pottery/ }));
    expect(within(screen.getAllByRole("region")[1]!).queryAllByRole("option")).toEqual([]);
    expect(screen.getByTestId("column").textContent).toBe("2 tags");
  });

  it("one tag: the letters carrying it across every place, newest first", () => {
    draw(<Tags tagId="t-pottery" seen={fresh()} />);
    const list = screen.getByRole("listbox", { name: "Pottery" });
    expect(list.textContent!.indexOf("Kiln")).toBeLessThan(list.textContent!.indexOf("Glaze"));
    expect(list.textContent).not.toContain("Tax form");
  });

  it("Rename refuses another tag's name, and saves a new one", () => {
    const renamed: string[] = [];
    draw(<Tags tagId="t-pottery" seen={fresh()} renamed={renamed} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Name");
    fireEvent.change(field, { target: { value: "paperwork" } });
    expect(document.body.textContent).toContain("You already have a tag called Paperwork.");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "  Ceramics " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(renamed).toEqual(["t-pottery:Ceramics"]);
  });

  function openRename(renamed: string[]): HTMLElement {
    draw(<Tags tagId="t-pottery" seen={fresh()} renamed={renamed} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    return screen.getByLabelText("Name");
  }

  it("Rename gives the keys to the name field as it opens", () => {
    const field = openRename([]);
    expect(document.activeElement).toBe(field);
  });

  it("Enter in Rename's field renames once", () => {
    const renamed: string[] = [];
    const field = openRename(renamed);
    fireEvent.change(field, { target: { value: "Ceramics" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(renamed).toEqual(["t-pottery:Ceramics"]);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("Escape in Rename's field keeps the old name and closes the question", () => {
    const renamed: string[] = [];
    const field = openRename(renamed);
    fireEvent.change(field, { target: { value: "Ceramics" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(renamed).toEqual([]);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("Enter on an empty, an unchanged or a taken name renames nothing and keeps the question open", () => {
    const renamed: string[] = [];
    const field = openRename(renamed);
    for (const name of ["   ", "Pottery", "paperwork"]) {
      fireEvent.change(field, { target: { value: name } });
      fireEvent.keyDown(field, { key: "Enter" });
    }
    expect(renamed).toEqual([]);
    expect(screen.getByLabelText("Name")).toBe(field);
  });

  it("Delete says what it takes off and that the letters stay, before it is asked", () => {
    const removed: string[] = [];
    draw(<Tags tagId="t-pottery" seen={fresh()} removed={removed} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(document.body.textContent).toContain("2 messages carry it and stay where they are.");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(removed).toEqual(["t-pottery"]);
  });

  it("speaks German", () => {
    draw(<Tags tagId={null} seen={fresh()} />, "de");
    expect(screen.getByTestId("column").textContent).toBe("2 Tags");
  });
});

describe("a folder", () => {
  const folder: FolderEntity = {
    id: "f1",
    name: "Clients/Gartenlokal Rosa",
    mailboxId: "mb",
    mailbox: "mb",
  } as FolderEntity;
  const clients: FolderEntity = { id: "f0", name: "Clients", mailboxId: "mb", mailbox: "mb" } as FolderEntity;
  function Folder(props: {
    folder: FolderEntity | null;
    messages: EngineMessage[];
    seen: Seen;
    folders?: FolderEntity[];
    opened?: string[];
  }) {
    const seat = useSeat(props.seen);
    const model = useFolderList({
      ...seat,
      folder: props.folder,
      folderId: "f1",
      folders: props.folders ?? [clients, folder],
      openFolder: (id) => props.opened?.push(id),
      messages: props.messages,
      settled: true,
      owed: false,
    });
    return (
      <FolderAbove model={model}>
        <FolderList {...pane("folder", { sub: "f1", open: seat.openId })} />
        <Column />
      </FolderAbove>
    );
  }

  it("names the folder, and lists what is new above what came before", () => {
    draw(
      <Folder
        folder={folder}
        seen={fresh()}
        messages={[
          msg({ id: "r", date: at(5), subject: "Read one" }),
          msg({ id: "u", date: at(2), subject: "Unread one", unread: true }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: /Gartenlokal Rosa/ })).toBeTruthy();
    const groups = screen.getAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["New", "Earlier"]);
  });

  it("says the way to it: Folders, then each folder above it, a press on one the mirror holds opening it", () => {
    const opened: string[] = [];
    draw(
      <Folder folder={folder} seen={fresh()} messages={[msg({ id: "r", date: at(5) })]} opened={opened} />,
    );
    const head = screen.getByRole("banner");
    expect(within(head).getByText("Folders")).toBeTruthy();
    fireEvent.click(within(head).getByRole("button", { name: "Clients" }));
    expect(opened).toEqual(["f0"]);
    cleanup();
    // A part the mirror does not hold is said, never pressed.
    draw(<Folder folder={folder} seen={fresh()} messages={[]} folders={[folder]} opened={opened} />);
    expect(within(screen.getByRole("banner")).getByText("Clients")).toBeTruthy();
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Clients" })).toBeNull();
    cleanup();
    // A folder at the tree's root still says where it lives.
    const top = { ...folder, name: "Workshops" } as FolderEntity;
    draw(<Folder folder={top} seen={fresh()} messages={[]} folders={[top]} />);
    expect(within(screen.getByRole("banner")).getByText("Folders")).toBeTruthy();
  });

  it("ends its title in the hot dot while an unread letter stands in it, and shows a file's paper-clip", () => {
    draw(
      <Folder
        folder={folder}
        seen={fresh()}
        messages={[msg({ id: "u", date: at(2), unread: true, hasAttachments: true })]}
      />,
    );
    const heading = screen.getByRole("heading", { name: /Gartenlokal Rosa/ });
    expect(heading.querySelector(".oh-dot")!.getAttribute("data-kind")).toBe("hot");
    // The row is one option to a screen reader; the paper-clip is named inside it.
    expect(document.querySelectorAll('[aria-label="Has an attachment"]')).toHaveLength(1);
  });

  it("an empty folder says it holds nothing; a folder that left the server says so by name", () => {
    const seen = fresh();
    const view = draw(<Folder folder={folder} seen={seen} messages={[]} />);
    expect(document.body.textContent).toContain("Nothing in this folder");
    act(() => view.rerender(inWords(<Folder folder={null} seen={seen} messages={[]} />)));
    expect(document.body.textContent).toContain("“Gartenlokal Rosa” is no longer on your mail server.");
  });
  it("a folder the mirror never held is not said to be loading once the mirror is read", () => {
    draw(<Folder folder={null} seen={fresh()} messages={[]} />);
    expect(document.body.textContent).not.toContain("Loading this folder");
    expect(document.body.textContent).not.toContain("no longer on your mail server");
  });
});

describe("an address", () => {
  const petra = "petra@makersfest.example";
  const mail = [
    msg({ id: "in1", from: "Petra Wyss", fromAddress: petra, date: at(4), subject: "Your talk" }),
    msg({ id: "in2", from: "Petra Wyss", fromAddress: petra, date: at(2), subject: "The stand" }),
    msg({ id: "out1", from: "Me", to: petra, date: at(3), subject: "Re: Your talk" }),
  ];
  function Address(props: { seen: Seen; messages?: EngineMessage[] }) {
    const seat = useSeat(props.seen);
    const model = useAddressList({
      ...seat,
      address: petra,
      messages: props.messages ?? mail,
      settled: true,
      owed: false,
      placeOf: () => "Ohbox",
      back: null,
    });
    return (
      <AddressAbove model={model}>
        <AddressList {...pane("address", { sub: petra, open: seat.openId })} />
        <Column />
      </AddressAbove>
    );
  }

  it("says who it is, and counts all, from them and to them", () => {
    draw(<Address seen={fresh()} />);
    expect(screen.getByRole("heading", { name: /Petra Wyss/ })).toBeTruthy();
    expect(screen.getByTestId("column").textContent).toBe("3 messages");
    fireEvent.click(screen.getByRole("button", { name: /From them/ }));
    expect(screen.getByTestId("column").textContent).toBe("2 messages");
    fireEvent.click(screen.getByRole("button", { name: /To them/ }));
    const list = screen.getByRole("listbox", { name: "To them" });
    expect(list.textContent).toContain("To Petra Wyss");
    expect(list.textContent).not.toContain("The stand");
  });

  it("says the address under the name, and each side's number in its words, a side with nothing as 0", () => {
    draw(<Address seen={fresh()} />);
    const head = screen.getByRole("banner");
    expect(within(head).getByText(petra)).toBeTruthy();
    const sides = within(head).getByRole("group", { name: "Direction" });
    expect(
      within(sides)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All 3", "From them 2", "To them 1"]);
    expect(within(sides).getByRole("button", { name: "All 3" })).toBeTruthy();
    cleanup();
    draw(<Address seen={fresh()} messages={mail.slice(0, 2)} />);
    expect(screen.getByRole("button", { name: "To them 0" })).toBeTruthy();
    cleanup();
    draw(<Address seen={fresh()} />, "de");
    expect(screen.getByRole("button", { name: "An sie 1" })).toBeTruthy();
  });
});
