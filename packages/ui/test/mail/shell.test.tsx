/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionPanel,
  ColumnHandle,
  Dock,
  Rail,
  RailEntry,
  RailFoot,
  Sheet,
  Switcher,
  type DockPlace,
} from "../../src/mail/index.js";
import { createRef } from "react";
import { JumpBack } from "../../src/base/index.js";

afterEach(cleanup);

/* The test page has no pointer events of its own: a pointer event here is a mouse event that says which pointer. */
if (typeof globalThis.PointerEvent !== "function") {
  class PointerEventHere extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  globalThis.PointerEvent = PointerEventHere as unknown as typeof PointerEvent;
}

describe("ColumnHandle", () => {
  const handle = () => screen.getByRole("separator", { name: "Sidebar width" });

  it("is a separator that says how wide its column is, and between which widths", () => {
    render(<ColumnHandle column="rail" label="Sidebar width" value={232} min={200} max={360} />);
    expect(handle().getAttribute("aria-valuenow")).toBe("232");
    expect(handle().getAttribute("aria-valuemin")).toBe("200");
    expect(handle().getAttribute("aria-valuemax")).toBe("360");
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("tabindex")).toBe("0");
  });

  it("moves 16 px a key, never past its ends, and goes to an end with Home and End", () => {
    const onChange = vi.fn();
    render(
      <ColumnHandle
        column="rail"
        label="Sidebar width"
        value={208}
        min={200}
        max={360}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    fireEvent.keyDown(handle(), { key: "Home" });
    fireEvent.keyDown(handle(), { key: "End" });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([224, 200, 200, 360]);
  });

  it("follows the pointer while it is dragged, and stops when it is let go", () => {
    const onChange = vi.fn();
    render(
      <ColumnHandle
        column="rail"
        label="Sidebar width"
        value={232}
        min={200}
        max={360}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 300 });
    expect(handle().hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 340 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 100 });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([272, 360]);
    expect(handle().hasAttribute("data-dragging")).toBe(false);
  });

  it("goes back to the theme's own width on a double press", () => {
    const onReset = vi.fn();
    render(
      <ColumnHandle column="list" label="List width" value={520} min={320} max={640} onReset={onReset} />,
    );
    fireEvent.doubleClick(screen.getByRole("separator", { name: "List width" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("RailEntry", () => {
  it("is a button that says where you are, and carries its count in its name", () => {
    const onPress = vi.fn();
    render(
      <RailEntry kind="place" icon="news" count="5" label="News, 5" current onPress={onPress}>
        News
      </RailEntry>,
    );
    const news = screen.getByRole("button", { name: "News, 5" });
    expect(news.getAttribute("aria-current")).toBe("page");
    fireEvent.click(news);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("says whether what is under a fold stands, and that a tool is working", () => {
    render(
      <>
        <RailEntry kind="fold" expanded={false}>
          Tags
        </RailEntry>
        <RailEntry kind="tool" icon="pull" busy>
          Pull new mail
        </RailEntry>
      </>,
    );
    expect(screen.getByRole("button", { name: "Tags" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Pull new mail" }).getAttribute("aria-busy")).toBe("true");
  });

  it("shows a place's digit in place of its key while the keys are in the rail", () => {
    const { rerender } = render(
      <RailEntry kind="place" icon="ohbox" keyHint="g o" keyShown>
        Ohbox
      </RailEntry>,
    );
    expect(screen.getByText("g o")).toBeTruthy();
    rerender(
      <RailEntry kind="place" icon="ohbox" keyHint="g o" keyShown digit="1">
        Ohbox
      </RailEntry>,
    );
    expect(screen.queryByText("g o")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("names the key that goes there on the button itself, and none where it has none", () => {
    render(
      <>
        <RailEntry kind="place" icon="search" shortcut="/">
          Search
        </RailEntry>
        <RailEntry kind="place" icon="ohbox">
          Ohbox
        </RailEntry>
      </>,
    );
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("aria-keyshortcuts")).toBe("/");
    expect(screen.getByRole("button", { name: "Ohbox" }).hasAttribute("aria-keyshortcuts")).toBe(false);
  });
});

describe("Rail", () => {
  it("keeps Write at its head while only the places scroll", () => {
    render(
      <Rail
        label="Places"
        write={{ label: "Write" }}
        groups={[
          <RailEntry key="o" kind="place" icon="ohbox">
            Ohbox
          </RailEntry>,
        ]}
      />,
    );
    const rail = screen.getByRole("navigation", { name: "Places" });
    /* The part of the rail that holds the places is the one that scrolls: Write is not in it. */
    const places = [...rail.children].find((part) =>
      within(part as HTMLElement).queryByRole("button", { name: /Ohbox/ }),
    ) as HTMLElement;
    expect(within(places).queryByRole("button", { name: /Write/ })).toBeNull();
  });

  it("is the landmark of the places, with the way to write first", () => {
    const onWrite = vi.fn();
    render(
      <Rail
        label="Places"
        write={{ label: "Write", keyHint: "c", onPress: onWrite }}
        groups={[
          <RailEntry key="o" kind="place" icon="ohbox">
            Ohbox
          </RailEntry>,
        ]}
        foot={
          <RailFoot
            account={{
              name: "Mila Brunner",
              address: "mila@lichtgrat.example",
              note: "2 mailboxes",
              title: "Mailboxes",
            }}
          />
        }
      />,
    );
    const rail = screen.getByRole("navigation", { name: "Places" });
    const buttons = within(rail).getAllByRole("button");
    expect(buttons[0]).toBe(within(rail).getByRole("button", { name: /Write/ }));
    fireEvent.click(buttons[0]!);
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(
      within(rail)
        .getByRole("button", { name: /Mila Brunner/ })
        .getAttribute("title"),
    ).toBe("Mailboxes");
  });
  it("names the way to write's key on its button, from the first draw, and drops it with the model", () => {
    const groups = [
      <RailEntry key="o" kind="place" icon="ohbox">
        Ohbox
      </RailEntry>,
    ];
    const { rerender } = render(
      <Rail label="Places" write={{ label: "Write", keyHint: "c", shortcut: "c" }} groups={groups} />,
    );
    const write = () =>
      within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: /Write/ });
    expect(write().getAttribute("aria-keyshortcuts")).toBe("c");
    rerender(<Rail label="Places" write={{ label: "Write", keyHint: "c" }} groups={groups} />);
    expect(write().hasAttribute("aria-keyshortcuts")).toBe(false);
  });
});

describe("RailFoot", () => {
  it("stands without an account while nobody is known: no account button, the tools still named", () => {
    const onPalette = vi.fn();
    render(
      <RailFoot
        pull={{ label: "Pull new mail" }}
        tools={[{ icon: "command", label: "Command palette · Ctrl K", onPress: onPalette }]}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Pull new mail",
      "Command palette · Ctrl K",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Command palette · Ctrl K" }));
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it("runs Pull new mail, opens the account, and names its two tools", () => {
    const [onPull, onAccount, onPalette] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <RailFoot
        pull={{ label: "Pull new mail", onPress: onPull }}
        account={{
          name: "Mila Brunner",
          address: "mila@lichtgrat.example",
          note: "2 mailboxes",
          title: "Mailboxes",
          onPress: onAccount,
        }}
        tools={[
          { icon: "command", label: "Command palette · Ctrl K", onPress: onPalette },
          { icon: "moon", label: "Dark" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pull new mail" }));
    fireEvent.click(screen.getByRole("button", { name: /Mila Brunner/ }));
    fireEvent.click(screen.getByRole("button", { name: "Command palette · Ctrl K" }));
    expect([onPull, onAccount, onPalette].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
  });
});

describe("Switcher", () => {
  const mail = { word: "ohmail", label: "ohmail" };
  const cal = { word: "ohcal", label: "ohcal" };

  it("is a named pair whose half you are in says so, and the other half leads there", () => {
    const onSwitch = vi.fn();
    render(
      <Switcher
        kind="pair"
        label="Mail or Calendar"
        current="mail"
        mail={mail}
        cal={cal}
        onSwitch={onSwitch}
      />,
    );
    const pair = screen.getByRole("group", { name: "Mail or Calendar" });
    expect(within(pair).getByRole("button", { name: "ohmail" }).getAttribute("aria-current")).toBe("true");
    expect(within(pair).getByRole("button", { name: "ohcal" }).hasAttribute("aria-current")).toBe(false);
    fireEvent.click(within(pair).getByRole("button", { name: "ohcal" }));
    expect(onSwitch).toHaveBeenCalledWith("cal");
  });

  it("as one round button leads to the product you are not in", () => {
    const onSwitch = vi.fn();
    render(
      <Switcher
        kind="round"
        label="Mail or Calendar"
        current="cal"
        mail={mail}
        cal={cal}
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ohmail" }));
    expect(onSwitch).toHaveBeenCalledWith("mail");
  });
});

describe("Sheet, the reading column", () => {
  it("hands out the box its sheets scroll in", () => {
    const scroller = createRef<HTMLDivElement>();
    render(
      <Sheet kind="reading" label="Conversation" scroller={scroller} head={<h2>Glaze order</h2>}>
        <p>The first letter</p>
      </Sheet>,
    );
    const column = screen.getByRole("region", { name: "Conversation" });
    expect(column.contains(scroller.current)).toBe(true);
    expect(within(scroller.current!).getByText("The first letter")).toBeTruthy();
    expect(within(scroller.current!).getByRole("heading", { name: "Glaze order" })).toBeTruthy();
  });

  it("carries the way back to its start, with the action panel and without one", () => {
    const jump = <JumpBack label="Back to top" to="top" shown onPress={() => {}} />;
    const { rerender } = render(
      <Sheet
        kind="reading"
        label="Conversation"
        jump={jump}
        foot={<ActionPanel label="Actions" items={[]} />}
      >
        <p>The first letter</p>
      </Sheet>,
    );
    const column = () => screen.getByRole("region", { name: "Conversation" });
    expect(within(column()).getByRole("button", { name: "Back to top" })).toBeTruthy();
    expect(within(column()).getByRole("toolbar", { name: "Actions" })).toBeTruthy();
    rerender(
      <Sheet kind="reading" label="Conversation" jump={jump}>
        <p>The first letter</p>
      </Sheet>,
    );
    expect(within(column()).getByRole("button", { name: "Back to top" })).toBeTruthy();
  });
});

describe("Dock", () => {
  const place = (id: string, label: string, more: Partial<DockPlace> = {}): DockPlace => ({
    id,
    label,
    icon: "ohbox",
    ...more,
  });
  const places = [
    place("ohbox", "Ohbox", { count: "5", current: true }),
    place("screener", "Screener", { count: "6" }),
    place("news", "News"),
    place("later", "Answer Later"),
    place("parked", "Parked"),
  ];
  const parts = {
    label: "Places",
    floor: 2,
    more: { label: "More" },
    search: { label: "Search" },
    write: { label: "Write" },
  };

  it("names every place, with its count, and says which one is open", () => {
    render(<Dock {...parts} places={places} />);
    const dock = screen.getByRole("navigation", { name: "Places" });
    expect(within(dock).getByRole("button", { name: "Ohbox, 5" }).getAttribute("aria-current")).toBe("page");
    for (const name of ["Screener, 6", "News", "More", "Search", "Write"])
      expect(within(dock).getByRole("button", { name })).toBeTruthy();
  });

  it("lets places go from the end while it is higher than its room, never the first ones, and says which stand", () => {
    /* The page has no layout here: the rail is as high as its shown places, 48 px each, in a room of 150. */
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.querySelectorAll("[data-place]:not([hidden])").length * 48;
    });
    const room = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(150);
    const onFit = vi.fn();
    render(<Dock {...parts} places={places} onFit={onFit} />);
    expect(onFit).toHaveBeenLastCalledWith(["ohbox", "screener", "news"]);
    expect(screen.queryByRole("button", { name: "Parked" })).toBeNull();
    room.mockReturnValue(40);
    cleanup();
    render(<Dock {...parts} places={places} onFit={onFit} />);
    expect(onFit).toHaveBeenLastCalledWith(["ohbox", "screener"]);
    height.mockRestore();
    room.mockRestore();
  });
});
