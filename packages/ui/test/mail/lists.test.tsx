/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountRow,
  Doorbell,
  FolderFold,
  FolderShelf,
  GroupHeading,
  ListHead,
  ListLine,
  ListTail,
  MonthRail,
  PullMark,
  ReadSquares,
  SelectionBar,
  TickList,
  type TickPerson,
} from "../../src/mail/index.js";
import { Seg } from "../../src/base/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ListHead", () => {
  it("is the heading of its list, with the list's tools beside it", () => {
    render(<ListHead title="Ohbox" hot aside={<button type="button">Mark all read</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Ohbox" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Mark all read" })).toBeTruthy();
  });

  it("draws the way to a place inside a tree: each part with a way leads there", () => {
    const [onFolders, onParent, onMore] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <ListHead
        title="Angebote"
        way={{
          title: "Kunden / Gastronomie / Angebote",
          more: { label: "All folders", onPress: onMore },
          parts: [
            { label: "Folders", onPress: onFolders },
            { label: "Studio" },
            { label: "Kunden", onPress: onParent },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    fireEvent.click(screen.getByRole("button", { name: "Kunden" }));
    expect([onFolders, onParent].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(screen.queryByRole("button", { name: "Studio" })).toBeNull();
    expect(screen.getByText("Studio")).toBeTruthy();
  });

  it("gives up the parts nearest the root when the way is longer than its line, and one mark stands for them", () => {
    /* No layout here: the line is as wide as its shown parts, 80 px each, in a room of 250. */
    const wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.querySelectorAll("[data-part]:not([hidden])").length * 80;
    });
    const room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(250);
    const onMore = vi.fn();
    const parts = ["Folders", "Kunden", "Gastronomie", "Gartenlokal Rosa"].map((label) => ({
      label,
      onPress: () => {},
    }));
    render(
      <ListHead
        title="Angebote"
        way={{ title: "the whole way", more: { label: "All folders", onPress: onMore }, parts }}
      />,
    );
    expect(screen.getByRole("button", { name: "Folders" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kunden" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gartenlokal Rosa" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All folders" }));
    expect(onMore).toHaveBeenCalledTimes(1);
    wide.mockRestore();
    room.mockRestore();
  });
});

describe("ListHead, a place of one person or one pile", () => {
  it("says a quiet line under its name, above what stands below, and how many it holds before its tools", () => {
    render(
      <ListHead
        title="Petra Wyss"
        meta="petra@makersfest.example"
        count="2 messages"
        aside={<button type="button">More</button>}
        below={<p>the direction</p>}
      />,
    );
    const head = screen.getByRole("banner");
    const [meta, count, below, tool] = [
      within(head).getByText("petra@makersfest.example"),
      within(head).getByText("2 messages"),
      within(head).getByText("the direction"),
      within(head).getByRole("button", { name: "More" }),
    ];
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByRole("heading", { level: 1, name: "Petra Wyss" }), meta)).toBe(true);
    expect(before(meta, below)).toBe(true);
    expect(before(count, tool)).toBe(true);
  });

  it("draws neither where neither is handed, and the line alone where nothing else stands below", () => {
    const { rerender } = render(<ListHead title="Drafts" />);
    expect(screen.getByRole("banner").textContent).toBe("Drafts");
    rerender(<ListHead title="Petra Wyss" meta="petra@makersfest.example" />);
    expect(within(screen.getByRole("banner")).getByText("petra@makersfest.example")).toBeTruthy();
  });
});

describe("ListHead, a place with sections", () => {
  const sections = (onChange?: (value: string) => void) => (
    <Seg
      label="Screener sections"
      value="waiting"
      onChange={onChange}
      options={[
        { value: "waiting", label: "Waiting", count: 6 },
        { value: "screened", label: "Screened out", count: 2 },
        { value: "spam", label: "Spam", count: 1 },
      ]}
    />
  );

  it("holds the place's sections as their own group in the head, and a press on one says which", () => {
    const onChange = vi.fn();
    render(<ListHead title="Screener" hot sections={sections(onChange)} />);
    const head = screen.getByRole("banner");
    expect(within(head).getByRole("heading", { level: 1, name: "Screener" })).toBeTruthy();
    const group = within(head).getByRole("group", { name: "Screener sections" });
    expect(
      within(group)
        .getByRole("button", { name: /Waiting/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: /Screened out/ }));
    expect(onChange.mock.calls).toEqual([["screened"]]);
  });

  it("stands the sections before the list's tools, and draws no room for tools where none are handed", () => {
    const { container, rerender } = render(<ListHead title="Screener" sections={sections()} />);
    const head = screen.getByRole("banner");
    /* The name, then the sections: nothing else stands in the head. */
    expect([...head.children].map((el) => el.tagName)).toEqual(["H1", "DIV"]);
    rerender(<ListHead title="Screener" sections={sections()} aside={<button type="button">More</button>} />);
    const [group, tool] = [screen.getByRole("group"), screen.getByRole("button", { name: "More" })];
    expect(group.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("header").length).toBe(1);
  });
});

describe("PullMark", () => {
  const mark = (c: HTMLElement) => c.firstElementChild as HTMLElement;

  it("is a mark for the eye alone, there as soon as the list is pulled and whole once letting go will pull", () => {
    const { container, rerender } = render(<PullMark pulled={0} armed={false} />);
    expect(mark(container).getAttribute("aria-hidden")).toBe("true");
    expect(mark(container).style.opacity).toBe("0");
    rerender(<PullMark pulled={10} armed={false} />);
    expect(mark(container).style.opacity).toBe("0.5");
    expect(mark(container).hasAttribute("data-armed")).toBe(false);
    rerender(<PullMark pulled={64} armed />);
    expect(mark(container).style.opacity).toBe("1");
    expect(mark(container).hasAttribute("data-armed")).toBe(true);
  });

  it("stands in the middle of the room the pull has opened, and grows to its size as the pull arms", () => {
    const { container, rerender } = render(<PullMark pulled={32} armed={false} />);
    /* The reference: its middle half the room down, at 0.35 of its size growing to 1 at 64. */
    expect(mark(container).style.transform).toBe("translateY(calc(16px - 50%)) scale(0.675)");
    rerender(<PullMark pulled={103.4} armed />);
    expect(mark(container).style.transform).toBe("translateY(calc(51.7px - 50%)) scale(1)");
  });
});

describe("MonthRail", () => {
  const entries = [
    { id: "2026", label: "2026", year: true },
    { id: "2026-11", label: "Nov", title: "November 2026" },
    { id: "2026-10", label: "Oct", title: "October 2026" },
    { id: "2025", label: "2025", year: true },
  ];

  it("is a named way through a list's time: one press a year or a month, the one the list is at marked as current", () => {
    const onPick = vi.fn();
    render(
      <MonthRail label="Month" entries={entries} current="2026-10" onPick={onPick}>
        <p>the rows</p>
      </MonthRail>,
    );
    expect(screen.getByText("the rows")).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Month" });
    expect(within(rail).getAllByRole("button")).toHaveLength(4);
    const october = within(rail).getByRole("button", { name: "October 2026" });
    expect(october.textContent).toBe("Oct");
    expect(october.getAttribute("aria-current")).toBe("true");
    expect(within(rail).getByRole("button", { name: "2026" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "2025" }));
    expect(onPick).toHaveBeenCalledWith("2025");
    october.focus();
    fireEvent.click(october, { detail: 1 });
    expect(onPick).toHaveBeenNthCalledWith(2, "2026-10");
    fireEvent.click(october, { detail: 0 });
    expect(onPick).toHaveBeenNthCalledWith(3, "2026-10", true);
  });

  it("leaves a list with nothing to step through standing alone", () => {
    render(
      <MonthRail label="Month" entries={[]}>
        <p>the rows</p>
      </MonthRail>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("the rows")).toBeTruthy();
  });
});

describe("Doorbell", () => {
  it("is named by how many wait and where it leads, and goes there", () => {
    const onPress = vi.fn();
    render(<Doorbell count="6" label="6 waiting, Screener" onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: "6 waiting, Screener" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("says whether the panel it opens stands, where it opens one", () => {
    render(<Doorbell count="3" label="3 to answer, Invitations" expanded />);
    expect(
      screen.getByRole("button", { name: "3 to answer, Invitations" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("GroupHeading", () => {
  it("is a heading; one that shuts is a button that says whether its rows stand", () => {
    const onPress = vi.fn();
    render(
      <>
        <GroupHeading count="3" hot>
          New
        </GroupHeading>
        <GroupHeading count="4" expanded={false} onPress={onPress}>
          Pottery Project
        </GroupHeading>
      </>,
    );
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
    const fold = screen.getByRole("button", { name: /Pottery Project/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("carries one word about the whole group as a label at its end, inside the heading", () => {
    render(
      <GroupHeading count="0" tag="Read-only">
        On your mail server
      </GroupHeading>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("On your mail server");
    expect(heading.lastElementChild?.textContent).toBe("Read-only");
  });

  it("says that it opens a menu where it does", () => {
    render(<GroupHeading opensMenu>Newest first</GroupHeading>);
    const name = screen.getByRole("button", { name: /Newest first/ });
    expect(name.getAttribute("aria-haspopup")).toBe("menu");
    expect(name.hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("GroupHeading, with a control of the group's own", () => {
  it("stands the control at the heading's end and keeps it out of the heading's name", () => {
    const onOrder = vi.fn();
    render(
      <GroupHeading
        count="12"
        aside={
          <button type="button" onClick={onOrder}>
            Best match
          </button>
        }
      >
        Results
      </GroupHeading>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Results12");
    expect(heading.contains(screen.getByRole("button", { name: "Best match" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Best match" }));
    expect(onOrder).toHaveBeenCalledTimes(1);
  });
});

describe("what arrives later takes nobody's place", () => {
  it("a heading keeps the keys on its own button when a control of the group's own arrives, and when it goes", () => {
    const { rerender } = render(<GroupHeading expanded>Results</GroupHeading>);
    const fold = screen.getByRole("button", { name: /Results/ });
    fold.focus();
    rerender(
      <GroupHeading expanded aside={<button type="button">Best match</button>}>
        Results
      </GroupHeading>,
    );
    expect(screen.getByRole("button", { name: /Results/ })).toBe(fold);
    expect(document.activeElement).toBe(fold);
    rerender(<GroupHeading expanded>Results</GroupHeading>);
    expect(document.activeElement).toBe(fold);
  });

  it("a list keeps its rows, and the keys on one, when the steps through its time arrive", () => {
    const rows = <button type="button">A letter</button>;
    const { rerender } = render(
      <MonthRail label="Jump to a month" entries={[]}>
        {rows}
      </MonthRail>,
    );
    const row = screen.getByRole("button", { name: "A letter" });
    row.focus();
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(
      <MonthRail label="Jump to a month" entries={[{ id: "2026-11", label: "Nov" }]}>
        {rows}
      </MonthRail>,
    );
    expect(screen.getByRole("navigation", { name: "Jump to a month" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A letter" })).toBe(row);
    expect(document.activeElement).toBe(row);
  });
});

describe("ListTail", () => {
  it("is one line with one word that can be pressed", () => {
    const onPress = vi.fn();
    render(<ListTail way={{ label: "History", onPress }}>Older mail</ListTail>);
    expect(screen.getByText(/Older mail/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("ListLine", () => {
  it("says a whole sentence as it is handed, with its own full stop and no dot added: why a list is withheld", () => {
    const why = "Your mail is still being read. The senders are listed when that is done.";
    render(<ListLine>{why}</ListLine>);
    const line = screen.getByText(why);
    expect(line.closest("p")!.textContent).toBe(why);
    expect(line.closest("p")!.querySelector("svg")).toBeNull();
    expect(line.closest("p")!.hasAttribute("role")).toBe(false);
  });

  it("says what the list is reading as a status, and never holds it back as busy", () => {
    render(<ListLine busy>Loading more senders…</ListLine>);
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("Loading more senders…");
    /* A live region that says it is busy asks a screen reader to wait with what it holds. */
    expect(line.hasAttribute("aria-busy")).toBe(false);
  });

  it("says a verdict when it appears: a status that is neither a refusal nor a reading", () => {
    render(<ListLine said>Nothing in Junk matches.</ListLine>);
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("Nothing in Junk matches.");
    expect(line.hasAttribute("aria-busy")).toBe(false);
    /* No warning sign: nothing was refused. */
    expect(line.querySelector("svg")).toBeNull();
  });

  it("says a refusal as a status, with the one press that tries again", () => {
    const onPress = vi.fn();
    render(
      <ListLine warn act={{ label: "Try again", onPress }}>
        More senders could not be loaded.
      </ListLine>,
    );
    const line = screen.getByRole("status");
    expect(line.textContent).toContain("More senders could not be loaded.");
    expect(line.hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(within(line).getByRole("button", { name: "Try again" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("is plain words where nothing happened: no status, and no button without an act", () => {
    render(<ListLine>That is everything on your mail server.</ListLine>);
    expect(screen.getByText("That is everything on your mail server.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("can be its press alone", () => {
    const onPress = vi.fn();
    render(<ListLine act={{ label: "Show more senders", quiet: true, onPress }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more senders" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("ReadSquares", () => {
  it("is a group named by its counts, and a press on a square says which message", () => {
    const onJump = vi.fn();
    const { container } = render(
      <ReadSquares
        squares={["own", "seen", "unseen"]}
        axis="row"
        label="3 messages, 1 unread"
        onJump={onJump}
      />,
    );
    expect(screen.getByRole("group", { name: "3 messages, 1 unread" })).toBeTruthy();
    fireEvent.click(container.querySelectorAll("[data-square]")[2]!);
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("marks which square the reader is on, and only that one", () => {
    const { container } = render(
      <ReadSquares
        squares={["seen", "seen", "unseen"]}
        here={1}
        axis="column"
        label="3 messages, 1 unread"
      />,
    );
    const squares = [...container.querySelectorAll("[data-square]")];
    expect(squares.map((s) => s.hasAttribute("data-here"))).toEqual([false, true, false]);
  });

  it("does not open the row it stands on when a square is pressed", () => {
    const onRow = vi.fn();
    const { container } = render(
      <div onClick={onRow}>
        <ReadSquares squares={["seen", "unseen"]} axis="row" label="2 messages, 1 unread" onJump={() => {}} />
      </div>,
    );
    fireEvent.click(container.querySelectorAll("[data-square]")[0]!);
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe("SelectionBar", () => {
  it("is the toolbar of what is picked: the count lets go, a verb acts", () => {
    const [onClear, onLater] = [vi.fn(), vi.fn()];
    render(
      <SelectionBar
        label="Selection"
        count={{ count: "3", word: "selected", label: "3 selected", onClear }}
        verbs={[{ id: "later", label: "Later", icon: "later", rank: 1, onPress: onLater }]}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    fireEvent.click(within(bar).getByRole("button", { name: "3 selected" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Later" }));
    expect([onClear, onLater].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });
});

describe("SelectionBar, the count", () => {
  it("is said, whole, when it changes: it stands in a polite live region that stays the same node", () => {
    const bar = (n: string) => (
      <SelectionBar
        label="Selection"
        count={{ count: n, word: "selected", label: `${n} selected` }}
        verbs={[]}
      />
    );
    const { rerender, container } = render(bar("3"));
    const live = container.querySelector("[aria-live='polite']");
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).toBe("3 selected");
    rerender(bar("4"));
    expect(container.querySelector("[aria-live='polite']")).toBe(live);
    expect(live?.textContent).toBe("4 selected");
  });
});

describe("FolderShelf", () => {
  const shelf = {
    label: "Folders",
    expanded: true,
    folders: [
      { id: "rosa", name: "Gartenlokal Rosa" },
      { id: "team", name: "Team", count: "3", label: "Team, 3 unread", current: true },
    ],
    all: { name: "All folders", label: "All folders, 29 unread", count: "29", expanded: false },
  };

  it("is the line Folders, the few folders the rail has room for, and the fold that opens the rest", () => {
    const onOpen = vi.fn();
    const onAll = vi.fn();
    render(<FolderShelf {...shelf} onOpen={onOpen} all={{ ...shelf.all, onToggle: onAll }} />);
    expect(screen.getByRole("button", { name: "Folders" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Gartenlokal Rosa" }));
    expect(onOpen).toHaveBeenCalledWith("rosa");
    expect(screen.getByRole("button", { name: "Team, 3 unread" }).getAttribute("aria-current")).toBe("page");
    const all = screen.getByRole("button", { name: "All folders, 29 unread" });
    expect(all.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(all);
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it("hands on a folder's own menu, asked for with the pointer's other button, with where it was asked", () => {
    const [onMenu, onOpen] = [vi.fn(), vi.fn()];
    render(<FolderShelf {...shelf} onOpen={onOpen} onMenu={onMenu} />);
    const rosa = screen.getByRole("button", { name: "Gartenlokal Rosa" });
    const asked = fireEvent.contextMenu(rosa, { clientX: 40, clientY: 90 });
    /* The browser's own menu does not open over it. */
    expect(asked).toBe(false);
    expect(onMenu).toHaveBeenCalledWith("rosa", { x: 40, y: 90 });
    expect(onOpen).not.toHaveBeenCalled();
    /* The lines that are no folder have no menu of their own. */
    expect(fireEvent.contextMenu(screen.getByRole("button", { name: "Folders" }))).toBe(true);
  });

  it("shows only its line while it is shut", () => {
    const onToggle = vi.fn();
    render(<FolderShelf {...shelf} expanded={false} onToggle={onToggle} />);
    expect(screen.queryByRole("button", { name: "Gartenlokal Rosa" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("two folders of one name", () => {
  it("on the shelf each says which it is, small after its name, for the eye and for a screen reader", () => {
    const onOpen = vi.fn();
    render(
      <FolderShelf
        label="Folders"
        expanded
        onOpen={onOpen}
        folders={[
          { id: "k/angebote", name: "Angebote", hint: "Kunden" },
          {
            id: "p/angebote",
            name: "Angebote",
            hint: "Privat",
            count: "2",
            label: "Angebote in Privat, 2 unread",
          },
          { id: "team", name: "Team" },
        ]}
      />,
    );
    const first = screen.getByRole("button", { name: "Angebote, Kunden" });
    expect(within(first).getByText("Kunden").tagName).toBe("SMALL");
    /* A name the app hands whole stands as handed. */
    const second = screen.getByRole("button", { name: "Angebote in Privat, 2 unread" });
    expect(within(second).getByText("Privat").tagName).toBe("SMALL");
    fireEvent.click(second);
    expect(onOpen).toHaveBeenCalledWith("p/angebote");
    /* A folder that needs no telling apart draws none. */
    expect(screen.getByRole("button", { name: "Team" }).querySelector("small")).toBeNull();
  });

  it("keeps the count it shows in the name it makes itself, on the shelf and in the fold", () => {
    render(
      <>
        <FolderShelf
          label="Folders"
          expanded
          folders={[{ id: "k/angebote", name: "Angebote", hint: "Kunden", count: "3" }]}
        />
        <FolderFold
          label="All folders"
          groups={[{ folders: [{ id: "p/angebote", name: "Angebote", hint: "Privat", count: "2" }] }]}
        />
      </>,
    );
    expect(within(screen.getByRole("button", { name: "Angebote, Kunden, 3" })).getByText("3")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Angebote, Privat, 2" })).getByText("2")).toBeTruthy();
  });

  it("in the fold a hit of the find line says its way after its name", () => {
    render(
      <FolderFold
        label="All folders"
        groups={[
          {
            folders: [
              { id: "k/g/angebote", name: "Angebote", hint: "Kunden › Gastronomie" },
              { id: "archiv", name: "Archiv" },
            ],
          },
        ]}
      />,
    );
    const hit = screen.getByRole("button", { name: "Angebote, Kunden › Gastronomie" });
    expect(within(hit).getByText("Kunden › Gastronomie").tagName).toBe("SMALL");
    expect(screen.getByRole("button", { name: "Archiv" }).querySelector("small")).toBeNull();
  });
});

describe("FolderFold", () => {
  const groups = [
    {
      mailbox: "lichtgrat.example",
      folders: [
        { id: "archive", name: "Archive", branch: { expanded: false, label: "Open Archive" } },
        {
          id: "kunden",
          name: "Kunden",
          count: "2",
          label: "Kunden, 2 unread",
          branch: { expanded: true, label: "Shut Kunden" },
        },
        { id: "rosa", name: "Gartenlokal Rosa", depth: 1 },
      ],
      add: { label: "New folder" },
    },
  ];

  it("hands on a folder's own menu, asked for with the pointer's other button, and leaves the line that adds one alone", () => {
    const onMenu = vi.fn();
    render(<FolderFold label="All folders" groups={groups} onMenu={onMenu} />);
    expect(
      fireEvent.contextMenu(screen.getByRole("button", { name: "Gartenlokal Rosa" }), {
        clientX: 12,
        clientY: 30,
      }),
    ).toBe(false);
    expect(onMenu).toHaveBeenCalledWith("rosa", { x: 12, y: 30 });
    expect(fireEvent.contextMenu(screen.getByRole("button", { name: "New folder" }))).toBe(true);
  });

  it("is the named tree of every folder, under its mailbox, with the line that adds one", () => {
    const onOpen = vi.fn();
    const onAdd = vi.fn();
    render(
      <FolderFold
        label="All folders"
        groups={[{ ...groups[0]!, add: { label: "New folder", onPress: onAdd } }]}
        onOpen={onOpen}
      />,
    );
    const tree = screen.getByRole("tree", { name: "All folders" });
    expect(within(tree).getByText("lichtgrat.example")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "Kunden, 2 unread" }));
    expect(onOpen).toHaveBeenCalledWith("kunden");
    fireEvent.click(within(tree).getByRole("button", { name: "New folder" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("opens and shuts a branch by its own control, which says whether it stands; a folder without children has none", () => {
    const onBranch = vi.fn();
    render(<FolderFold label="All folders" groups={groups} onBranch={onBranch} />);
    const open = screen.getByRole("button", { name: "Open Archive" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Shut Kunden" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(onBranch).toHaveBeenCalledWith("archive");
    expect(screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"))).toHaveLength(2);
  });

  it("looks for a folder as you type: Enter opens the first match, Escape empties the line", () => {
    const onChange = vi.fn();
    const onOpen = vi.fn();
    render(
      <FolderFold
        label="All folders"
        groups={groups}
        find={{ label: "Find a folder", value: "ku", onChange }}
        onOpen={onOpen}
      />,
    );
    const line = screen.getByRole("textbox", { name: "Find a folder" });
    fireEvent.change(line, { target: { value: "kun" } });
    expect(onChange).toHaveBeenLastCalledWith("kun");
    fireEvent.keyDown(line, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("archive");
    fireEvent.keyDown(line, { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("says so where no folder has that name", () => {
    render(
      <FolderFold
        label="All folders"
        groups={[]}
        find={{ label: "Find a folder", value: "zz" }}
        none="No folder of that name"
      />,
    );
    expect(screen.getByText("No folder of that name")).toBeTruthy();
  });
});

describe("AccountRow", () => {
  const row = {
    name: "mila@lichtgrat.example",
    address: "mila@lichtgrat.example",
    facts: ["Synced 09:23", "IMAP"],
    state: "Connected",
  };

  it("is one button that says whether the account's lines stand, and shows them only then", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AccountRow {...row} expanded={false} onToggle={onToggle}>
        <p>its lines</p>
      </AccountRow>,
    );
    const head = screen.getByRole("button", { name: /mila@lichtgrat\.example/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("its lines")).toBeNull();
    fireEvent.click(head);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <AccountRow {...row} expanded onToggle={onToggle}>
        <p>its lines</p>
      </AccountRow>,
    );
    expect(
      screen.getByRole("button", { name: /mila@lichtgrat\.example/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("its lines")).toBeTruthy();
  });

  it("carries an offer as its one action, which does not open the row", () => {
    const onToggle = vi.fn();
    const onPress = vi.fn();
    render(
      <AccountRow
        {...row}
        state={undefined}
        expanded={false}
        onToggle={onToggle}
        offer={{ label: "Add its calendars", onPress }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add its calendars" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("its offer can be spent: off, or under way after its own press, and then it takes no second one", () => {
    const [onToggle, onPress] = [vi.fn(), vi.fn()];
    const offered = (offer: { label: string; disabled?: boolean; busy?: boolean }) => (
      <AccountRow
        {...row}
        state={undefined}
        expanded={false}
        onToggle={onToggle}
        offer={{ ...offer, onPress }}
      />
    );
    const { rerender } = render(offered({ label: "Organizing here", busy: true }));
    const under = screen.getByRole("button", { name: "Organizing here" }) as HTMLButtonElement;
    expect([under.getAttribute("aria-busy"), under.getAttribute("aria-disabled"), under.disabled]).toEqual([
      "true",
      "true",
      false,
    ]);
    fireEvent.click(under);
    rerender(offered({ label: "Organize here", disabled: true }));
    const off = screen.getByRole("button", { name: "Organize here" }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    fireEvent.click(off);
    expect([onPress.mock.calls.length, onToggle.mock.calls.length]).toEqual([0, 0]);
  });
});

describe("ListLine, a quiet press wider than its line", () => {
  it("marks its press to take a second line only while its words are wider than its box, and never a press that is no word", () => {
    /* jsdom lays nothing out: the words need 300 px, and the room is what the case says. */
    let room = 400;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => room);
    const line = (quiet: boolean) => (
      <ListLine act={{ label: "Auch den Spam-Ordner deines Mailservers durchsuchen", quiet }}>
        Nichts passt.
      </ListLine>
    );
    const { rerender } = render(line(true));
    const folds = () => screen.getByRole("button").dataset.fold !== undefined;
    expect(folds()).toBe(false);
    room = 250;
    rerender(line(true));
    expect(folds()).toBe(true);
    room = 400;
    rerender(line(true));
    expect(folds()).toBe(false);
    /* A second button keeps its one line whatever the room. */
    room = 250;
    rerender(line(false));
    expect(folds()).toBe(false);
  });
});

/**
 * PEOPLE TO TICK: a count as the list's own head, a field to find one, all or none, and every person a checkbox
 * with its tick at the row's end. Once the ticks are taken nothing takes a press any more.
 */
describe("TickList", () => {
  const PEOPLE: TickPerson[] = [
    {
      id: "lena",
      name: "Lena Kaufmann",
      address: "lena@lichtgrat.example",
      count: "12×",
      said: "12 messages",
      on: true,
    },
    {
      id: "ben",
      name: "Ben Frei",
      address: "ben@paperbird.example",
      count: "3×",
      said: "3 messages",
      on: false,
    },
    {
      id: "mila",
      name: "Mila Brunner",
      address: "mila@studio.example",
      count: "1×",
      said: "1 message",
      on: true,
    },
  ];
  const list = (more: Partial<Parameters<typeof TickList>[0]> = {}) => (
    <TickList figure="7" words="people you wrote to" label="People you wrote to" people={PEOPLE} {...more} />
  );
  const ticks = () =>
    within(screen.getByRole("group", { name: "People you wrote to" })).getAllByRole("checkbox");

  it("is a named group of checkboxes: each a person, ticked or not, named by who it is, how many letters in words, and the address", () => {
    render(list());
    const group = screen.getByRole("group", { name: "People you wrote to" });
    /* The address may break after its @: a reader of names hears it whole either way. */
    expect(
      [
        /^Lena Kaufmann 12 messages lena@ ?lichtgrat\.example$/,
        /^Ben Frei 3 messages ben@ ?paperbird\.example$/,
        /^Mila Brunner 1 message mila@ ?studio\.example$/,
      ].map((name) => within(group).getByRole("checkbox", { name }).getAttribute("aria-checked")),
    ).toEqual(["true", "false", "true"]);
    /* What a row shows: the name, how many letters as they are printed, the address. */
    expect(within(ticks()[1]!).getByText("Ben Frei")).toBeTruthy();
    expect(within(ticks()[1]!).getByText("3×")).toBeTruthy();
    /* The figure is a picture named by its words: no name is hung on a plain box, and nothing says "3×". */
    expect(within(ticks()[1]!).getByRole("img", { name: "3 messages" }).textContent).toBe("3×");
    expect(ticks()[1]!.textContent).toContain("ben@paperbird.example");
    /* The tick is drawn at the row's end, never said. */
    expect(ticks().map((tick) => tick.querySelector(":scope > i svg")?.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
      "true",
    ]);
  });

  it("a press ticks a person, and so do Space and Enter with the keys on the row", () => {
    const onTick = vi.fn();
    render(list({ onTick }));
    fireEvent.click(ticks()[1]!);
    ticks()[0]!.focus();
    fireEvent.keyDown(ticks()[0]!, { key: " " });
    fireEvent.keyDown(ticks()[2]!, { key: "Enter" });
    expect(onTick.mock.calls).toEqual([["ben"], ["lena"], ["mila"]]);
    expect(ticks().map((tick) => tick.tabIndex)).toEqual([0, 0, 0]);
  });

  it("its head is the count with its words, a field that finds one, and one press for all or none", () => {
    const [onChange, onPress] = [vi.fn(), vi.fn()];
    render(
      list({
        find: { label: "Find someone", placeholder: "Find", value: "", onChange },
        all: { label: "None", onPress },
      }),
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("7 people you wrote to");
    const find = screen.getByRole("textbox", { name: "Find someone" }) as HTMLInputElement;
    expect(find.placeholder).toBe("Find");
    fireEvent.change(find, { target: { value: "le" } });
    expect(onChange.mock.calls).toEqual([["le"]]);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("the ticks taken, no row takes a press, each says it is off, and the find field and the press for all are gone", () => {
    const onTick = vi.fn();
    render(
      list({
        onTick,
        settled: true,
        find: { label: "Find someone", placeholder: "Find", value: "" },
        all: { label: "None" },
      }),
    );
    expect(
      ticks().map((tick) => [tick.getAttribute("aria-checked"), tick.getAttribute("aria-disabled")]),
    ).toEqual([
      ["true", "true"],
      ["false", "true"],
      ["true", "true"],
    ]);
    fireEvent.click(ticks()[0]!);
    fireEvent.keyDown(ticks()[1]!, { key: " " });
    expect(onTick).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    /* A person who was let in ends in the dot; one who was not, in nothing. No tick is left. */
    const end = (tick: HTMLElement) => tick.querySelector(":scope > i")!;
    expect(
      ticks().map((tick) => [end(tick).children.length, end(tick).querySelectorAll("svg").length]),
    ).toEqual([
      [1, 0],
      [0, 0],
      [1, 0],
    ]);
  });

  it("with nobody found it keeps its head and holds no row", () => {
    render(list({ people: [] }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("7 people you wrote to");
    expect(
      within(screen.getByRole("group", { name: "People you wrote to" })).queryAllByRole("checkbox"),
    ).toEqual([]);
  });
});
