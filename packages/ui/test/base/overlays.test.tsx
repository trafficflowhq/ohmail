/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  closeTopOverlay,
  contextTrigger,
  Dialog,
  KeyHelp,
  Menu,
  MenuGroup,
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

  it("names an item by its words alone: the key beside them is drawn and never said", () => {
    render(<Opened />);
    open();
    const reply = screen.getByRole("menuitem", { name: "Reply" });
    expect(reply.querySelector("kbd")?.getAttribute("aria-hidden")).toBe("true");
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

  it("holds more than one titled group: each is a group said by its title, a rule between them, the arrows passing from one to the next", () => {
    function Decided() {
      const anchor = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <Button ref={anchor} opens="menu" expanded>
            Ohbox
          </Button>
          <Menu open onClose={() => {}} anchor={anchor} label="Where their mail goes">
            <MenuGroup title="Goes to">
              <MenuItem keyHint="o" checked>
                Ohbox
              </MenuItem>
              <MenuItem keyHint="n" checked={false}>
                News
              </MenuItem>
            </MenuGroup>
            <MenuRule />
            <MenuGroup title="Applies to">
              <MenuItem checked>This sender</MenuItem>
              <MenuItem checked={false}>The whole domain</MenuItem>
            </MenuGroup>
          </Menu>
        </>
      );
    }
    render(<Decided />);
    const menu = screen.getByRole("menu", { name: "Where their mail goes" });
    /* Each group is told by its own title, and holds its own items and no other's. */
    const goes = within(menu).getByRole("group", { name: "Goes to" });
    const applies = within(menu).getByRole("group", { name: "Applies to" });
    const held = (group: HTMLElement) => items().filter((item) => group.contains(item));
    expect([held(goes), held(applies)]).toEqual([items().slice(0, 2), items().slice(2)]);
    expect(items()).toHaveLength(4);
    /* The rule stands between the two groups, in neither; each title stands over its group's first item. */
    const before = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const rule = within(menu).getByRole("separator");
    const [first, second] = within(menu).getAllByRole("heading");
    expect([first?.textContent, second?.textContent]).toEqual(["Goes to", "Applies to"]);
    expect([goes.contains(rule), applies.contains(rule), before(goes, rule), before(rule, applies)]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect([before(first!, items()[0]!), before(second!, items()[2]!)]).toEqual([true, true]);
    expect(second!.className).toBe(first!.className);
    items()[1]!.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[2]);
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

  it("hands a key to the app's own keys first: a key they take is spent, any other is the menu's as before", () => {
    const [below, onClose, onPick] = [vi.fn(), vi.fn(), vi.fn()];
    /* A card's own keys: a digit takes a row of it, and the key that sends takes the time it holds. */
    const onKey = vi.fn((e: { key: string; metaKey: boolean; preventDefault(): void }) => {
      const taken = e.key === "2" || (e.key === "Enter" && e.metaKey) || e.key === "Escape";
      if (taken) onPick(e.key);
      return taken;
    });
    render(
      <div onKeyDown={below}>
        <Menu open onClose={onClose} label="Send later" kind="card" onKey={onKey}>
          <MenuItem onPress={() => {}}>This evening</MenuItem>
          <MenuItem onPress={() => {}}>Tomorrow morning</MenuItem>
        </Menu>
      </div>,
    );
    const card = screen.getByRole("dialog", { name: "Send later" });
    fireEvent.keyDown(card, { key: "2" });
    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    expect(onPick.mock.calls).toEqual([["2"], ["Enter"]]);
    /* A key the app took is not the menu's any more: its own Escape does not close it. */
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    /* A key the app leaves is the menu's: the arrows still move, and Tab stays inside a card. */
    const rows = within(card).getAllByRole("menuitem");
    rows[0]!.focus();
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    expect(onKey).toHaveBeenCalledTimes(4);
    /* Taken or not, no key reaches what lies under the menu. */
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

  it("holds a second answer between the one that does it and the way out", () => {
    const [keep, forget, close] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <Dialog
        open
        onClose={close}
        title="Start over"
        hot
        line="Keep the mailboxes you connected?"
        confirm={{ label: "Keep them", onPress: keep, keyHint: "↵" }}
        second={{ label: "Forget them", onPress: forget }}
        cancel={{ label: "Cancel", keyHint: "Esc" }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Start over" });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.querySelector("span")?.textContent),
    ).toEqual(["Keep them", "Forget them", "Cancel"]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /Keep them/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget them" }));
    expect([keep.mock.calls.length, forget.mock.calls.length, close.mock.calls.length]).toEqual([0, 1, 0]);
  });

  it("says what a press inside it came to beside its answers: no item of its list, and after the list", () => {
    const waiting = (said?: { line: string; refused?: boolean }) => (
      <Dialog open onClose={() => {}} title="2 changes wait" cancel={{ label: "Close" }} list said={said}>
        <div role="listitem">Archive, Lena</div>
        <div role="listitem">Move, Paperbird</div>
      </Dialog>
    );
    const { rerender } = render(waiting());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("status")).toBeNull();
    rerender(waiting({ line: "Not put back. Try again.", refused: true }));
    const list = within(dialog).getByRole("list");
    /* A refusal answers a press: it is said at once, as an alert, never held back as a status. */
    expect(within(dialog).queryByRole("status")).toBeNull();
    const line = within(dialog).getByRole("alert");
    expect(line.textContent).toBe("Not put back. Try again.");
    expect(list.contains(line)).toBe(false);
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const before = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect([before(list, line), before(line, screen.getByRole("button", { name: "Close" }))]).toEqual([
      true,
      true,
    ]);
    /* A refusal leads with its sign; a line that only tells has none. */
    expect(line.querySelector("svg")).not.toBeNull();
    rerender(waiting({ line: "Sent to the install that organizes this mailbox." }));
    const told = within(dialog).getByRole("status");
    expect(told.textContent).toBe("Sent to the install that organizes this mailbox.");
    expect(told.querySelector("svg")).toBeNull();
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

describe("the system's Back over an open overlay", () => {
  it("closes the newest open overlay, once, and answers that Back is spent; with nothing open it answers no", () => {
    const [dialog, menu] = [vi.fn(), vi.fn()];
    expect(closeTopOverlay()).toBe(false);
    const { rerender } = render(
      <>
        <Dialog
          open
          onClose={dialog}
          title="Move"
          confirm={{ label: "Move", onPress: () => {} }}
          cancel={{ label: "Cancel" }}
        />
        <Menu open onClose={menu} label="Folders" anchor={{ x: 10, y: 10 }}>
          <MenuItem onPress={() => {}}>Paperwork</MenuItem>
        </Menu>
      </>,
    );
    expect(closeTopOverlay()).toBe(true);
    expect([dialog.mock.calls.length, menu.mock.calls.length]).toEqual([0, 1]);
    rerender(
      <Dialog
        open
        onClose={dialog}
        title="Move"
        confirm={{ label: "Move", onPress: () => {} }}
        cancel={{ label: "Cancel" }}
      />,
    );
    expect(closeTopOverlay()).toBe(true);
    expect([dialog.mock.calls.length, menu.mock.calls.length]).toEqual([1, 1]);
    rerender(<></>);
    expect(closeTopOverlay()).toBe(false);
  });
});

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
