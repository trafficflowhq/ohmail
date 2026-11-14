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
  ListTail,
  ReadSquares,
  SelectionBar,
} from "../../src/mail/index.js";

afterEach(cleanup);

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

  it("says that it opens a menu where it does", () => {
    render(<GroupHeading opensMenu>Newest first</GroupHeading>);
    const name = screen.getByRole("button", { name: /Newest first/ });
    expect(name.getAttribute("aria-haspopup")).toBe("menu");
    expect(name.hasAttribute("aria-expanded")).toBe(false);
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

  it("shows only its line while it is shut", () => {
    const onToggle = vi.fn();
    render(<FolderShelf {...shelf} expanded={false} onToggle={onToggle} />);
    expect(screen.queryByRole("button", { name: "Gartenlokal Rosa" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
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
});
