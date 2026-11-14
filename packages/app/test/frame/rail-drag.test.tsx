/** @vitest-environment jsdom */
/**
 * A LETTER DRAGGED ONTO THE RAIL. What a rail entry takes is its registration's word (`rail.drop`); past the
 * threshold the frame lights every entry where a drop would change something and the one under the pointer; a
 * release there runs the LIST's own verb with that entry's word, once, and the release opens nothing. Below the
 * threshold a press stays a click; Escape cancels and is the drag's alone; an entry that takes nothing, or the
 * list's own place, never lights and never runs a verb.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import type { DragSource, RailDropTarget } from "@ohmail/app-logic/lists/drag-source";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { useRailDrag } from "../../src/frame/rail-drag.js";
import { TextProvider } from "../../src/text/index.js";
import { LIST_WORDS, listFrame, listSeat, sent } from "../places/list-seat.js";
import { letter as makeLetter } from "../reader/support/mail.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const dropped: { target: RailDropTarget; ids: readonly string[] }[] = [];
const ran: string[] = [];
/** A letter in the Ohbox's folder. */
const letter = { folder: "INBOX", triage: null, labels: [] } as unknown as EngineMessage;
const source: DragSource = {
  ids: ["m1"],
  messages: [letter],
  label: { from: "Ada", subject: "Hello" },
  selection: false,
};

function List(_: PaneProps) {
  useRailDrag({
    rows: ".the-list [data-id]",
    page: () => document,
    sourceFor: (id) => (id === "m1" ? source : null),
    onDrop: (target, s) => dropped.push({ target, ids: s.ids }),
  });
  useKeyBindings([
    { chord: "Escape", group: "message", label: "Clear the selection", run: () => ran.push("cleared") },
  ]);
  return (
    <div className="the-list">
      <button type="button" data-id="m1" onClick={() => ran.push("opened")}>
        the row
      </button>
    </div>
  );
}
const Reading = (_: PaneProps) => <p>the letter</p>;
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title", drop: "move:ohbox" },
  panes: { kind: "columns", List, Reading },
};
const news: PlaceEntry = {
  id: "news",
  body: "news",
  rail: { group: "main", icon: "news", label: "title", drop: "move:reads" },
  panes: { kind: "columns", List: Reading, Reading },
};
/** A place whose entry takes no drop. */
const history: PlaceEntry = {
  id: "history",
  body: "history",
  rail: { group: "more", icon: "history", label: "title" },
  panes: { kind: "columns", List: Reading, Reading },
};

function mount() {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/ohbox"),
    places: { ohbox, news, history },
  });
  render(
    <TextProvider
      locale="en"
      messages={{
        ...FRAME_WORDS.en,
        ohbox: { title: "Ohbox" },
        news: { title: "News" },
        history: { title: "History" },
      }}
      timeZone="Europe/Zurich"
    >
      <Frame host={host} />
    </TextProvider>,
  );
}

const theRow = () => screen.getByRole("button", { name: "the row" });
const entry = (name: string) => screen.getByRole("button", { name });
const lit = (name: string) => entry(name).getAttribute("data-drop");
const pointer = (type: string, target: EventTarget, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
const hovering = (el: Element | null) => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el;
};
/** Press the row and move past the threshold, the pointer over `over`. */
const dragOver = async (over: Element | null) => {
  await pointer("pointerdown", theRow(), 10, 10);
  hovering(over);
  await pointer("pointermove", window, 60, 60);
};
const click = (el: Element) =>
  act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

beforeEach(() => {
  dropped.length = 0;
  ran.length = 0;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  for (const g of document.querySelectorAll(".drag-ghost")) g.remove();
});

describe("a letter dragged onto the rail", () => {
  it("past the threshold lights the entries a drop would change and the one under the pointer; the list's own place and an entry that takes nothing stay quiet", async () => {
    mount();
    await dragOver(entry("History"));
    expect(lit("News"), "News takes the letter").toBe("ready");
    expect(lit("Ohbox"), "the letter is in the Ohbox already").toBeNull();
    expect(lit("History"), "History takes no drop").toBeNull();
    hovering(entry("News"));
    await pointer("pointermove", window, 70, 70);
    expect(lit("News"), "the pointer is on News").toBe("over");
    await pointer("pointerup", window, 70, 70);
  });

  it("a release over a lit entry runs the list's own verb once, with that entry's word, and opens nothing", async () => {
    mount();
    await dragOver(entry("News"));
    /* A browser sends the release's click in the same task as the release. */
    await act(() => {
      window.dispatchEvent(
        new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
      );
      theRow().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(dropped).toEqual([{ target: { kind: "pile", action: "move:reads" }, ids: ["m1"] }]);
    expect(ran, "the release's click did not open the row").toEqual([]);
    expect(lit("News"), "nothing stays lit").toBeNull();
  });

  it("a release over the list's own place or an entry that takes nothing runs no verb", async () => {
    mount();
    for (const name of ["Ohbox", "History"]) {
      await dragOver(entry(name));
      await pointer("pointerup", window, 60, 60);
    }
    expect(dropped).toEqual([]);
  });

  it("below the threshold the press stays a click", async () => {
    mount();
    await pointer("pointerdown", theRow(), 10, 10);
    await pointer("pointermove", window, 12, 11);
    expect(document.querySelector(".drag-ghost"), "no ghost below the threshold").toBeNull();
    /* A browser sends the release's click in the same task as the release. */
    await act(() => {
      window.dispatchEvent(
        new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 12, clientY: 11 }),
      );
      theRow().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(ran).toEqual(["opened"]);
    expect(dropped).toEqual([]);
  });

  it("Escape while dragging cancels: no verb runs, the list's own Escape does not run, nothing stays lit", async () => {
    mount();
    await dragOver(entry("News"));
    expect(lit("News")).toBe("over");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(lit("News"), "nothing stays lit").toBeNull();
    await pointer("pointerup", window, 60, 60);
    expect(dropped).toEqual([]);
    expect(ran, "the list's Escape did not run").toEqual([]);
  });
});

function admitted(letters: readonly [EngineMessage, ...EngineMessage[]]) {
  const first = letters[0];
  return {
    first: "#/ohbox",
    letters,
    more: {
      "rule:known_sender": {
        id: "known_sender",
        kind: "sender",
        match: first.from.address,
        destination: "INBOX",
        priority: 0,
        enabled: true,
        provenance: "manual",
        createdAt: first.date,
        updatedAt: first.date,
        stats: { hits: 0, lastHitAt: null, demotions: 0 },
      },
    },
  };
}

describe("the registered triage rail targets", () => {
  it.each([
    ["Answer Later", "reply_later"],
    ["Parked", "set_aside"],
    ["Resurface", "bubbled_up"],
  ])("files exactly the dragged Ohbox letter into %s without opening it", async (name, state) => {
    const now = new Date().toISOString();
    const letter = makeLetter("target", {
      subject: "The kiln sketches",
      date: now,
      arrivedAt: now,
      unread: false,
    });
    const neighbour = makeLetter("other", {
      subject: "The gallery order",
      date: now,
      arrivedAt: now,
      unread: false,
    });
    const { address, mail } = listSeat(admitted([letter, neighbour]));
    const row = await screen.findByRole("option", { name: /The kiln sketches/ });
    const rail = entry(name);
    await pointer("pointerdown", row, 10, 10);
    hovering(rail);
    await pointer("pointermove", window, 60, 60);
    expect(lit(name)).toBe("over");
    expect(sent(mail)).toEqual([]);
    await act(() => {
      window.dispatchEvent(
        new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
      );
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(sent(mail)).toEqual([`triage_set target ${state}`]);
    expect(address.read()).toBe("#/ohbox");
    expect(lit(name)).toBeNull();
    expect(screen.getByRole("option", { name: /The gallery order/ })).toBeTruthy();
  });
});

describe("an engine replaced during a row gesture", () => {
  it.each([false, true])(
    "does not finish the old press on the replacement letter (drag started: %s)",
    async (activeDrag) => {
      const now = new Date().toISOString();
      const mailbox = (subject: string) =>
        listFrame(admitted([makeLetter("same-id", { subject, date: now, arrivedAt: now, unread: false })]));
      const original = mailbox("Original plans");
      const replacement = mailbox("Replacement notes");
      const tree = (host: typeof original.host) => (
        <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
          <Frame host={host} />
        </TextProvider>
      );
      const view = render(tree(original.host));
      const row = await screen.findByRole("option", { name: /Original plans/ });
      await pointer("pointerdown", row, 10, 10);
      if (activeDrag) {
        hovering(entry("Resurface"));
        await pointer("pointermove", window, 60, 60);
        expect(lit("Resurface")).toBe("over");
        expect(document.querySelector(".drag-ghost")).not.toBeNull();
      }
      view.rerender(tree({ ...original.host, engine: replacement.host.engine }));
      const nextRow = await screen.findByRole("option", { name: /Replacement notes/ });
      const hoverAfterReplacement = lit("Resurface");
      const ghostAfterReplacement = document.querySelector(".drag-ghost");
      await act(() => {
        window.dispatchEvent(
          new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
        );
        nextRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(sent(original.mail)).toEqual([]);
      expect(sent(replacement.mail)).toEqual([]);
      expect(original.address.read()).toBe("#/ohbox");
      expect(hoverAfterReplacement).toBeNull();
      expect(ghostAfterReplacement).toBeNull();
    },
  );
});
