/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  contextTrigger,
  Dialog,
  KeyHelp,
  Menu,
  MenuItem,
  MenuRule,
  Overlay,
  Palette,
  PhoneSheet,
  placeMenu,
  type PaletteCommand,
} from "../../src/base/index.js";

afterEach(cleanup);

function Opened({ onRun = () => {}, kind }: { onRun?: (what: string) => void; kind?: "context" | "card" }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={anchor} opens="menu" expanded={open} onPress={() => setOpen(true)}>
        More
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="More" kind={kind}>
        <MenuItem icon="reply" keyHint="r" onPress={() => onRun("reply")}>
          Reply
        </MenuItem>
        <MenuItem disabled onPress={() => onRun("spam")}>
          Spam
        </MenuItem>
        <MenuRule />
        <MenuItem checked onPress={() => onRun("ohbox")}>
          Ohbox
        </MenuItem>
        <MenuItem checked={false} note="Mon 08:00" onPress={() => onRun("news")}>
          News
        </MenuItem>
      </Menu>
    </>
  );
}
const open = () => fireEvent.click(screen.getByRole("button", { name: "More" }));
const items = () => [...screen.queryAllByRole("menuitem"), ...screen.queryAllByRole("menuitemradio")];

describe("Menu", () => {
  it("offers several choices that may all be taken as checkboxes of the menu, each saying whether it is taken", () => {
    render(
      <Menu open onClose={() => {}} anchor={{ x: 10, y: 10 }} label="Tags">
        <MenuItem checked many hue={25} onPress={() => {}}>
          Pottery
        </MenuItem>
        <MenuItem checked={false} many hue={150} onPress={() => {}}>
          Travel
        </MenuItem>
      </Menu>,
    );
    const boxes = screen.getAllByRole("menuitemcheckbox");
    expect(boxes.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([
      ["Pottery", "true"],
      ["Travel", "false"],
    ]);
    expect(screen.queryAllByRole("menuitemradio")).toEqual([]);
  });

  it("draws nothing until it is open, then a named menu with its items", () => {
    render(<Opened />);
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    expect(screen.getByRole("menu", { name: "More" })).toBeTruthy();
    expect(items().map((i) => i.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(items().map((i) => i.getAttribute("aria-checked"))).toEqual([null, null, "true", "false"]);
  });

  it("puts the keys on the first item that is not off", () => {
    render(<Opened />);
    open();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Reply/ }));
  });

  it("the arrows move and wrap past an item that is off; Home and End take the ends", () => {
    render(<Opened />);
    open();
    const menu = screen.getByRole("menu");
    const at = () => document.activeElement?.textContent;
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(at()).toBe("Ohbox");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(at()).toBe("Replyr");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(at()).toBe("NewsMon 08:00");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(at()).toBe("Replyr");
    fireEvent.keyDown(menu, { key: "End" });
    expect(at()).toBe("NewsMon 08:00");
  });

  it("runs an item at a press, and never one that is off", () => {
    const onRun = vi.fn();
    render(<Opened onRun={onRun} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Spam" }));
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /News/ }));
    expect(onRun).toHaveBeenCalledWith("news");
  });

  it("Esc closes it and the keys go back to what opened it", () => {
    render(<Opened />);
    open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
  });

  it("a press beside it closes it", () => {
    const { container } = render(<Opened />);
    open();
    fireEvent.pointerDown(container.querySelector("[data-veil]")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a letter typed over it stays inside it", () => {
    const below = vi.fn();
    render(
      <div onKeyDown={below}>
        <Opened />
      </div>,
    );
    open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "e" });
    expect(below).not.toHaveBeenCalled();
  });

  it("a card is a dialog, and Tab stays inside it", () => {
    render(<Opened kind="card" />);
    open();
    const card = screen.getByRole("dialog", { name: "More" });
    const all = items().filter((i) => !(i as HTMLButtonElement).disabled);
    all.at(-1)!.focus();
    fireEvent.keyDown(card, { key: "Tab" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(card, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(all.at(-1));
  });
});

describe("where a menu stands", () => {
  const stage = { width: 1000, height: 800 };
  const menu = { width: 240, height: 200 };
  it("under its anchor, 8 away, at the anchor's left edge", () => {
    expect(placeMenu({ left: 100, top: 100, right: 180, bottom: 140 }, menu, stage)).toEqual({
      left: 100,
      top: 148,
      up: false,
    });
  });
  it("2 from a point", () => {
    expect(placeMenu({ x: 300, y: 300 }, menu, stage)).toEqual({ left: 300, top: 302, up: false });
  });
  it("upwards where it would leave the stage below and there is more room above", () => {
    expect(placeMenu({ left: 100, top: 700, right: 180, bottom: 740 }, menu, stage)).toEqual({
      left: 100,
      top: 492,
      up: true,
    });
  });
  it("never nearer than 8 to the stage's edge", () => {
    expect(placeMenu({ x: 990, y: 790 }, menu, stage)).toEqual({ left: 752, top: 588, up: true });
    expect(placeMenu({ left: 0, top: 0, right: 40, bottom: 20 }, menu, stage, { right: true })).toEqual({
      left: 8,
      top: 28,
      up: false,
    });
  });
});

describe("contextTrigger", () => {
  it("opens at the pointer on a right click, and at the element for the menu key and Shift+F10", () => {
    const openAt = vi.fn();
    render(<div role="button" tabIndex={0} aria-label="A row" {...contextTrigger(openAt)} />);
    const row = screen.getByRole("button", { name: "A row" });
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    expect(openAt).toHaveBeenLastCalledWith({ x: 40, y: 60 });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(openAt).toHaveBeenLastCalledWith(row);
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(openAt).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(row, { key: "F10" });
    expect(openAt).toHaveBeenCalledTimes(3);
  });
});

function Asked({ kind, onConfirm = () => {} }: { kind?: "delete"; onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button opens="dialog" expanded={open} onPress={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Move to Trash"
        line="Your mail server keeps it there."
        kind={kind}
        confirm={{ label: "Move to Trash", onPress: onConfirm }}
        cancel={{ label: "Cancel" }}
      />
    </>
  );
}
/* A press on a button puts the keys on it first, as a browser does. */
const ask = () => {
  screen.getByRole("button", { name: "Delete" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
};

describe("Dialog", () => {
  it("is a modal dialog named by its sentence, with the keys on its first button", () => {
    render(<Asked />);
    expect(screen.queryByRole("dialog")).toBeNull();
    ask();
    const dialog = screen.getByRole("dialog", { name: "Move to Trash" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move to Trash" }));
  });

  it("Tab cycles inside it", () => {
    render(<Asked />);
    ask();
    const dialog = screen.getByRole("dialog");
    screen.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move to Trash" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("Esc, Cancel and a press on the scrim close it, and the keys go back to what opened it", () => {
    const { container } = render(<Asked />);
    for (const close of [
      () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
      () => fireEvent.pointerDown(container.querySelector("[data-scrim]")!),
    ]) {
      ask();
      close();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    }
  });

  it("a press inside it does not close it", () => {
    render(<Asked />);
    ask();
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Enter confirms a delete wherever the keys are, and only a delete", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<Asked kind="delete" onConfirm={onConfirm} />);
    ask();
    screen.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    unmount();
    render(<Asked onConfirm={onConfirm} />);
    ask();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("holds its other ways under its answers, inside it: the keys start on the answer and reach them last", () => {
    const passkey = vi.fn();
    render(
      <Dialog
        open
        onClose={() => {}}
        title="Confirm with a one-time code"
        confirm={{ label: "Verify code", onPress: () => {} }}
        cancel={{ label: "Cancel" }}
        under={
          <Button kind="quiet" size="s" onPress={passkey}>
            Use a passkey instead
          </Button>
        }
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Verify code",
      "Cancel",
      "Use a passkey instead",
    ]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Verify code" }));
    const way = screen.getByRole("button", { name: "Use a passkey instead" });
    fireEvent.click(way);
    expect(passkey).toHaveBeenCalledTimes(1);
    way.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Verify code" }));
  });
});

describe("a dialog that starts on the answer that does nothing", () => {
  it("puts the keys on Cancel, so Enter at once opens nothing", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog
        open
        onClose={onClose}
        title="This link goes to shop.example"
        keysOn="cancel"
        confirm={{ label: "Open shop.example", onPress: onOpen }}
        cancel={{ label: "Cancel" }}
      />,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    fireEvent.click(cancel);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("where the page says a finger is used", () => {
  /* The root stamps data-touch="1"; the kit's sheet turns it into --oh-touch on every part. */
  const touch = () => {
    const style = document.createElement("style");
    style.textContent = "* { --oh-touch: 1; }";
    document.head.append(style);
    return () => style.remove();
  };

  it("a dialog still takes the keys, keeps Tab inside, and Esc closes it", () => {
    const untouch = touch();
    try {
      render(<Asked />);
      ask();
      const dialog = screen.getByRole("dialog");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move to Trash" }));
      screen.getByRole("button", { name: "Cancel" }).focus();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move to Trash" }));
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    } finally {
      untouch();
    }
  });

  it("the palette puts the caret in its line", () => {
    const untouch = touch();
    try {
      render(<Typed />);
      expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Command" }));
    } finally {
      untouch();
    }
  });

  it("a menu leaves the keys where they were", () => {
    const untouch = touch();
    try {
      render(<Opened />);
      const more = screen.getByRole("button", { name: "More" });
      more.focus();
      open();
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(document.activeElement).toBe(more);
    } finally {
      untouch();
    }
  });
});

describe("a dialog that only tells", () => {
  it("has the way out alone, with its key shown where keys are shown", () => {
    render(
      <Dialog
        open
        onClose={() => {}}
        title="Waiting for the other ohmail"
        hot
        cancel={{ label: "Close", keyHint: "Esc" }}
        keysShown
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["CloseEsc"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Close/ }));
  });
});

describe("PhoneSheet", () => {
  it("is the menu at the foot: named, with the menu's keys, closed by a press outside and by Esc", () => {
    const onClose = vi.fn();
    const { container } = render(
      <PhoneSheet open onClose={onClose} label="More">
        <MenuItem>Forward</MenuItem>
        <MenuItem>Delete</MenuItem>
      </PhoneSheet>,
    );
    const sheet = screen.getByRole("menu", { name: "More" });
    fireEvent.keyDown(sheet, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.pointerDown(container.querySelector("[data-veil]")!);
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Overlay", () => {
  it("is a modal part on a scrim that hands its own keys to the part first", () => {
    const onClose = vi.fn();
    const onKey = vi.fn((e: { key: string }) => e.key === "x");
    render(
      <Overlay open onClose={onClose} label="Keys" className="oh-test" onKey={onKey}>
        <Button kind="quiet">Close</Button>
      </Overlay>,
    );
    const part = screen.getByRole("dialog", { name: "Keys" });
    expect(part.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(part, { key: "x" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(part, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Escape over an open overlay", () => {
  /* The keys left the overlay: its confirm turned disabled while it works, and the browser dropped them on the body. */
  const outside = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    return fireEvent.keyDown(document.body, { key: "Escape" });
  };

  it.each([
    [
      "a dialog",
      (onClose: () => void) => (
        <Dialog
          open
          onClose={onClose}
          title="Delete it?"
          line="It cannot be undone."
          confirm={{ label: "Delete", onPress: () => {}, disabled: true }}
          cancel={{ label: "Cancel", keyHint: "Esc" }}
        />
      ),
    ],
    [
      "an overlay",
      (onClose: () => void) => (
        <Overlay open onClose={onClose} label="Keys" className="oh-test">
          <Button kind="quiet">Close</Button>
        </Overlay>
      ),
    ],
    [
      "a menu",
      (onClose: () => void) => (
        <Menu open onClose={onClose} label="More" anchor={{ x: 10, y: 10 }}>
          <MenuItem onPress={() => {}}>Reply</MenuItem>
        </Menu>
      ),
    ],
    [
      "an ask",
      (onClose: () => void) => (
        <Menu open onClose={onClose} label="Sure?" kind="ask" anchor={{ x: 10, y: 10 }}>
          <Button onPress={() => {}}>Yes</Button>
        </Menu>
      ),
    ],
    [
      "a sheet",
      (onClose: () => void) => (
        <PhoneSheet open onClose={onClose} label="More">
          <MenuItem onPress={() => {}}>Reply</MenuItem>
        </PhoneSheet>
      ),
    ],
  ])("closes %s when the keys are outside it, and the page underneath never hears it", (_, part) => {
    const onClose = vi.fn();
    const page = vi.fn();
    document.addEventListener("keydown", page);
    try {
      render(<>{part(onClose)}</>);
      expect(outside()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", page);
    }
  });

  it("closes the topmost first, once, wherever the keys are; the one beneath with the next", () => {
    const [dialog, menu] = [vi.fn(), vi.fn()];
    const { rerender } = render(
      <>
        <Dialog
          open
          onClose={dialog}
          title="Move"
          confirm={{ label: "Move", onPress: () => {} }}
          cancel={{ label: "Cancel", keyHint: "Esc" }}
        />
        <Menu open onClose={menu} label="Folders" anchor={{ x: 10, y: 10 }}>
          <MenuItem onPress={() => {}}>Paperwork</MenuItem>
        </Menu>
      </>,
    );
    outside();
    expect([dialog.mock.calls.length, menu.mock.calls.length]).toEqual([0, 1]);
    /* A finger leaves the keys where they were: in the dialog, under the menu. */
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Move" }), { key: "Escape" });
    expect([dialog.mock.calls.length, menu.mock.calls.length]).toEqual([0, 2]);
    rerender(
      <Dialog
        open
        onClose={dialog}
        title="Move"
        confirm={{ label: "Move", onPress: () => {} }}
        cancel={{ label: "Cancel", keyHint: "Esc" }}
      />,
    );
    outside();
    expect([dialog.mock.calls.length, menu.mock.calls.length]).toEqual([1, 2]);
  });

  it("is heard once where the keys are inside it, and a field in it that keeps its Escape keeps it open", () => {
    const onClose = vi.fn();
    render(
      <Overlay open onClose={onClose} label="Find" className="oh-test">
        <input aria-label="Find" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()} />
        <Button kind="quiet">Close</Button>
      </Overlay>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to the page once nothing is open", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Overlay open onClose={onClose} label="Keys" className="oh-test">
        <Button kind="quiet">Close</Button>
      </Overlay>,
    );
    rerender(
      <Overlay open={false} onClose={onClose} label="Keys" className="oh-test">
        <Button kind="quiet">Close</Button>
      </Overlay>,
    );
    expect(outside()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});

const COMMANDS: PaletteCommand[] = [
  { id: "ohbox", label: "Go to the Ohbox", icon: "ohbox", keys: ["g", "o"] },
  { id: "tag", label: "Tag: Paperwork", icon: "tags", disabled: true },
  { id: "news", label: "Go to News", icon: "news" },
];
function Typed({
  onRun = () => {},
  onClose = () => {},
}: {
  onRun?: (id: string) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <Palette
      open
      onClose={onClose}
      label="Command palette"
      inputLabel="Command"
      placeholder="Type a command"
      query={query}
      onQuery={setQuery}
      commands={shown}
      onRun={onRun}
      empty="No command"
      keyHint="Ctrl K"
      onKey={(e) => e.key === "k" && e.ctrlKey && (onClose(), true)}
    />
  );
}
const marked = () =>
  screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;

describe("Palette", () => {
  it("puts the keys on its line, with the first command marked and named to the line", () => {
    render(<Typed />);
    const line = screen.getByRole("combobox", { name: "Command" });
    expect(document.activeElement).toBe(line);
    expect(marked()).toBe("Go to the Ohboxgo");
    expect(line.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
  });

  it("the arrows move the mark round the list while the keys stay in the line", () => {
    render(<Typed />);
    const line = screen.getByRole("combobox");
    fireEvent.keyDown(line, { key: "ArrowUp" });
    expect(marked()).toBe("Go to News");
    fireEvent.keyDown(line, { key: "ArrowDown" });
    expect(marked()).toBe("Go to the Ohboxgo");
    expect(document.activeElement).toBe(line);
  });

  it("Enter runs the marked command, never one that is off; a press runs its own", () => {
    const onRun = vi.fn();
    render(<Typed onRun={onRun} />);
    const line = screen.getByRole("combobox");
    fireEvent.keyDown(line, { key: "ArrowDown" });
    fireEvent.keyDown(line, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.keyDown(line, { key: "ArrowDown" });
    fireEvent.keyDown(line, { key: "Enter" });
    expect(onRun).toHaveBeenLastCalledWith("news");
    fireEvent.click(screen.getByRole("option", { name: /Ohbox/ }));
    expect(onRun).toHaveBeenLastCalledWith("ohbox");
  });

  it("what is typed narrows the list, marks its first again, and says so when nothing is left", () => {
    render(<Typed />);
    const line = screen.getByRole("combobox");
    fireEvent.keyDown(line, { key: "ArrowDown" });
    fireEvent.change(line, { target: { value: "news" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(marked()).toBe("Go to News");
    fireEvent.change(line, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("listbox").textContent).toBe("No command");
  });

  it("Esc closes it, and so does the key the app says is its own", () => {
    const onClose = vi.fn();
    render(<Typed onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "k", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("KeyHelp", () => {
  const columns = [
    [
      {
        title: "Move around",
        rows: [
          { label: "Next", keys: [["j"], ["↓"]] },
          { label: "Ohbox", keys: [["g", "o"]] },
        ],
      },
    ],
  ];
  it("is a dialog named by its title that lists every key under its group, and its own control closes it", () => {
    const onClose = vi.fn();
    render(<KeyHelp open onClose={onClose} title="Keys" close="Close" columns={columns} />);
    const help = screen.getByRole("dialog", { name: "Keys" });
    expect(screen.getByRole("heading", { name: "Move around" })).toBeTruthy();
    expect(help.textContent).toContain("Nextj·↓");
    expect(help.textContent).toContain("Ohboxgo");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is read, not answered: the keys land on the help itself, and Tab reaches Close", () => {
    render(<KeyHelp open onClose={() => {}} title="Keys" close="Close" columns={columns} />);
    const help = screen.getByRole("dialog", { name: "Keys" });
    expect(document.activeElement).toBe(help);
    fireEvent.keyDown(help, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("listens for no letter itself: the app says which key shuts it", () => {
    const onClose = vi.fn();
    render(
      <KeyHelp
        open
        onClose={onClose}
        title="Keys"
        close="Close"
        columns={columns}
        onKey={(e) => e.key === "?" && (onClose(), true)}
      />,
    );
    const help = screen.getByRole("dialog");
    fireEvent.keyDown(help, { key: "j" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(help, { key: "?" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
