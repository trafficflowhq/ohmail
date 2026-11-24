/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuItem } from "../../src/base/index.js";
import { portalRenderer } from "../../src/base/Overlays/portal-renderer.js";
import { ContactCard, MovePicker, QuickLook, type ContactCardProps } from "../../src/mail/index.js";

afterEach(cleanup);

const giulia = { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" };
const card: ContactCardProps = {
  open: true,
  onClose: () => {},
  label: "Giulia Ferrari",
  person: giulia,
  copy: { label: "Copy address" },
  scope: {
    label: "Whose mail",
    value: "address",
    options: [
      { value: "address", label: "This address", note: "2 messages" },
      { value: "domain", label: "Everyone at terracotta-milano.example", note: "2 messages · 1 sender" },
    ],
  },
  now: { line: "Now in Ohbox", place: "Ohbox", all: { label: "See all" } },
  goes: {
    label: "Goes to",
    value: "ohbox",
    places: [
      { value: "ohbox", label: "Ohbox" },
      { value: "news", label: "News" },
      { value: "receipts", label: "Receipts" },
    ],
  },
  rules: [{ place: "Ohbox", note: "this address · your decision" }],
  switches: [{ label: "Rule for future mail", on: true }],
};

describe("ContactCard", () => {
  it("is a dialog named for the person, and draws nothing while it is shut", () => {
    const { rerender } = render(<ContactCard {...card} />);
    const dialog = screen.getByRole("dialog", { name: "Giulia Ferrari" });
    expect(within(dialog).getByText(giulia.address)).toBeTruthy();
    rerender(<ContactCard {...card} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copies the address and shows all their mail from its own controls", () => {
    const copy = vi.fn();
    const all = vi.fn();
    render(
      <ContactCard
        {...card}
        copy={{ label: "Copy address", onPress: copy }}
        now={{ ...card.now!, all: { label: "See all", onPress: all } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
  });

  it("says which place their mail goes to, and a press on another one moves it", () => {
    const onChange = vi.fn();
    render(<ContactCard {...card} goes={{ ...card.goes!, onChange }} />);
    const places = screen.getByRole("radiogroup", { name: "Goes to" });
    expect(within(places).getByRole("radio", { name: "Ohbox" }).getAttribute("aria-checked")).toBe("true");
    expect(within(places).getByRole("radio", { name: "News" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(places).getByRole("radio", { name: "Receipts" }));
    expect(onChange).toHaveBeenCalledWith("receipts");
  });

  it("walks the keys through the places with the arrows, round the end, and moves nothing until a press", () => {
    const onChange = vi.fn();
    render(<ContactCard {...card} goes={{ ...card.goes!, onChange }} />);
    const ohbox = screen.getByRole("radio", { name: "Ohbox" });
    ohbox.focus();
    fireEvent.keyDown(ohbox, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "News" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Receipts" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(document.activeElement!);
    expect(onChange).toHaveBeenCalledWith("receipts");
  });

  it("changes whose mail it is about, turns its switches, and closes on Escape", () => {
    const onScope = vi.fn();
    const onSwitch = vi.fn();
    const onClose = vi.fn();
    render(
      <ContactCard
        {...card}
        onClose={onClose}
        scope={{ ...card.scope!, onChange: onScope }}
        switches={[{ label: "Rule for future mail", on: true, onChange: onSwitch }]}
      >
        <MenuItem icon="write">Write</MenuItem>
      </ContactCard>,
    );
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Whose mail" })).getByRole("radio", {
        name: /Everyone at/,
      }),
    );
    expect(onScope).toHaveBeenCalledWith("domain");
    fireEvent.click(screen.getByRole("switch", { name: "Rule for future mail" }));
    expect(onSwitch).toHaveBeenCalledWith(false);
    expect(screen.getByRole("menuitem", { name: "Write" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MovePicker", () => {
  const places = [
    { id: "news", label: "News" },
    { id: "spam", label: "Spam" },
  ];
  const folders = [
    { id: "rosa", name: "Gartenlokal Rosa", path: "Kunden › Gastronomie" },
    { id: "2026", name: "2026", path: "Buchhaltung › Rechnungen" },
  ];

  it("is a menu with the app's places first, then the folders with the way to each", () => {
    const onMove = vi.fn();
    render(
      <MovePicker
        open
        onClose={() => {}}
        label="Move"
        title="Move"
        places={places}
        folders={folders}
        onMove={onMove}
      />,
    );
    const items = within(screen.getByRole("menu", { name: "Move" })).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "News",
      "Spam",
      "Gartenlokal RosaKunden › Gastronomie",
      "2026Buchhaltung › Rechnungen",
    ]);
    fireEvent.click(items[2]!);
    expect(onMove).toHaveBeenCalledWith("rosa");
    fireEvent.click(items[0]!);
    expect(onMove).toHaveBeenLastCalledWith("news");
  });

  it("looks for a folder as you type, and Enter takes the first match", () => {
    const onMove = vi.fn();
    const onChange = vi.fn();
    render(
      <MovePicker
        open
        onClose={() => {}}
        label="Move"
        title="Move"
        places={places}
        folders={folders}
        find={{ label: "Move to a folder", value: "", onChange }}
        onMove={onMove}
      />,
    );
    const line = screen.getByRole("textbox", { name: "Move to a folder" });
    fireEvent.change(line, { target: { value: "ro" } });
    expect(onChange).toHaveBeenCalledWith("ro");
    fireEvent.keyDown(line, { key: "Enter" });
    expect(onMove).toHaveBeenCalledWith("rosa");
  });

  it("says so in one line where no folder has that name, and Enter then moves nothing", () => {
    const onMove = vi.fn();
    render(
      <MovePicker
        open
        onClose={() => {}}
        label="Move"
        title="Move"
        places={places}
        folders={[]}
        find={{ label: "Move to a folder", value: "zz", none: "No folder of that name" }}
        onMove={onMove}
      />,
    );
    expect(screen.getByText("No folder of that name")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Move to a folder" }), { key: "Enter" });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("lists a folder that cannot take mail now as disabled: no press moves there, and Enter takes the next", () => {
    const onMove = vi.fn();
    render(
      <MovePicker
        open
        onClose={() => {}}
        label="Move"
        title="Move"
        places={places}
        folders={[{ ...folders[0]!, disabled: true }, folders[1]!]}
        find={{ label: "Move to a folder", value: "" }}
        onMove={onMove}
      />,
    );
    const held = screen.getByRole("menuitem", { name: /Gartenlokal Rosa/ });
    expect((held as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(held);
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Move to a folder" }), { key: "Enter" });
    expect(onMove).toHaveBeenCalledWith("2026");
  });
});

describe("QuickLook", () => {
  const look = {
    open: true,
    label: "Attachment preview",
    name: "Invoice-2291",
    facts: "PDF · 84 KB · 1 / 2",
    download: { label: "Download" },
    close: { label: "Close" },
  };

  it("is a modal dialog with the file's name, its facts and the look itself", () => {
    render(
      <QuickLook {...look} onClose={() => {}}>
        <p>the page</p>
      </QuickLook>,
    );
    const dialog = screen.getByRole("dialog", { name: "Attachment preview" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Invoice-2291")).toBeTruthy();
    expect(within(dialog).getByText("PDF · 84 KB · 1 / 2")).toBeTruthy();
    expect(within(dialog).getByText("the page")).toBeTruthy();
  });

  it("the host seats a file preview outside the composer and keeps paste and drop there", () => {
    const onPaste = vi.fn();
    const onDrop = vi.fn();
    const { container } = render(
      <portalRenderer.Provider value={createPortal}>
        <div onPaste={onPaste} onDrop={onDrop}>
          <QuickLook {...look} portal onClose={() => {}}>
            <p>the page</p>
          </QuickLook>
        </div>
      </portalRenderer.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Attachment preview" });
    expect(container.contains(dialog)).toBe(false);
    expect(fireEvent.paste(dialog)).toBe(false);
    expect(fireEvent.drop(dialog)).toBe(false);
    expect(onPaste).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("closes on Escape, on Space and from its button, and saves from Download", () => {
    const onClose = vi.fn();
    const onPress = vi.fn();
    render(
      <QuickLook {...look} onClose={onClose} download={{ label: "Download", onPress }}>
        <p>the page</p>
      </QuickLook>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(dialog, { key: " " });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("walks the files with the side arrows and their keys, and the pages with up and down", () => {
    const prev = vi.fn();
    const next = vi.fn();
    const up = vi.fn();
    const down = vi.fn();
    render(
      <QuickLook
        {...look}
        onClose={() => {}}
        prev={{ label: "Previous file", onPress: prev }}
        next={{ label: "Next file", onPress: next }}
        pages={{ up: { label: "Previous page", onPress: up }, down: { label: "Next page", onPress: down } }}
      >
        <p>the page</p>
      </QuickLook>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(next).toHaveBeenCalledTimes(2);
    expect(prev).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("draws no arrow for a side that has no file, and its key does nothing", () => {
    render(
      <QuickLook {...look} onClose={() => {}}>
        <p>the page</p>
      </QuickLook>,
    );
    expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  });
});

describe("a file preview across updates", () => {
  it("keeps the chosen control focused and closes on Escape", () => {
    const onClose = vi.fn();
    const draw = (facts: string) => (
      <div className="oh-root">
        <portalRenderer.Provider value={createPortal}>
          <QuickLook
            open
            portal
            onClose={onClose}
            label="File preview"
            name="Document"
            facts={facts}
            close={{ label: "Close" }}
            next={{ label: "Next file", onPress: () => {} }}
          >
            <p>File content</p>
          </QuickLook>
        </portalRenderer.Provider>
      </div>
    );
    const { rerender } = render(draw("First"));
    const next = screen.getByRole("button", { name: "Next file" });
    next.focus();
    rerender(draw("Updated"));
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
