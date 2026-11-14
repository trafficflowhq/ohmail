/** @vitest-environment jsdom */
/**
 * THE OHBOX AND THE READER, JOINED (RULING-MEETING-LINE, the join). The real `ohboxPlace` and the real reader (`readerEntry`,
 * its body a double, no files, pictures or look) through the real `Frame` over the fake host and the reader's fake
 * engine; above the frame, `OhboxAbove` with the model of `useOhboxList` over the Ohbox harness's input
 * (`inputOf`), its selection read from the address and written to it, as a shell's slot will stand it. What crosses
 * between the two columns is the meeting line alone: the list's visit and its blank. One press seam, the room's,
 * lives throughout.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import type { EngineMessage, EngineMutation } from "@ohmail/client-engine";
import { Frame } from "../../src/frame/Frame.js";
import { OhboxAbove, ohboxPlace } from "../../src/ohbox/index.js";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { readerEntry } from "../../src/reader/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import { beside, inputOf, type Said } from "../ohbox/ohbox-world.js";
import { wideWindow } from "../ohbox/setup.js";
import { bodyDouble, fakeMail, letter, WORDS } from "../reader/support/mail.js";

const live = vi.hoisted(() => ({ seams: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect: effect } = await import("react");
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const seam = real.useShellDispatch(input);
      effect(() => {
        live.seams += 1;
        return () => {
          live.seams -= 1;
        };
      }, []);
      return seam;
    },
  };
});

const OPEN = /^#\/ohbox\/m\/([^/]+)$/;

/** The model above both columns, as the frame's slot will stand it: its selection is the address's open letter. */
function Above({
  address,
  said,
  over,
  children,
}: {
  address: FakeAddress;
  said: Said;
  over: Partial<OhboxListInput>;
  children: ReactNode;
}) {
  const fragment = useSyncExternalStore(address.subscribe, address.read);
  const selectedId = OPEN.exec(fragment)?.[1] ?? null;
  const onSelect = useCallback(
    (id: string | null) => address.write(id === null ? "#/ohbox" : `#/ohbox/m/${id}`, "push"),
    [address],
  );
  const [input] = useState(() => inputOf(said, over));
  const [side] = useState(() => beside(said));
  const model = useOhboxList({ ...input, selectedId, onSelect });
  return (
    <OhboxAbove model={model} beside={side}>
      {children}
    </OhboxAbove>
  );
}

interface Joined {
  readonly letters: readonly EngineMessage[];
  /** What the list holds; every letter by default. */
  readonly listed?: readonly EngineMessage[];
  readonly open?: string | null;
}

function join(o: Joined) {
  const mail = fakeMail(o.letters);
  const said: Said = { marked: [], bulk: [], went: [], pulled: 0, markedAll: [] };
  const spies = {
    onHoldRow: vi.fn<(id: string | null) => void>(),
    onMarkSeen: vi.fn<OhboxListInput["onMarkSeen"]>(),
    onAction: vi.fn<OhboxListInput["onAction"]>(),
  };
  const address = fakeAddress(o.open ? `#/ohbox/m/${o.open}` : "#/ohbox");
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: ohboxPlace },
    reader: readerEntry({
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
    }),
    window: fakeWindow("desktop"),
    address,
  });
  const over: Partial<OhboxListInput> = { newForYou: [...(o.listed ?? o.letters)], ...spies };
  render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Above address={address} said={said} over={over}>
        <Frame host={host} />
      </Above>
    </TextProvider>,
  );
  return { mail, address, spies };
}

type Box = { top: number; bottom: number };
const boxed = (el: Element | null, box: Box): void => {
  if (!el) throw new Error("no element to lay out");
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...box,
      left: 0,
      right: 600,
      width: 600,
      height: box.bottom - box.top,
      x: 0,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
};
/** The open letter on screen, as a browser lays it out: its sender line, its first lines and its end. */
function layOut(id: string): void {
  const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
  boxed(scroller, { top: 0, bottom: 800 });
  Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
  boxed(document.querySelector(READER_DOM.stops), { top: 700, bottom: 760 });
  const panel = document.querySelector(`[data-conv-id="${id}"]`)!;
  boxed(panel, { top: 10, bottom: 400 });
  boxed(panel.querySelector(READER_DOM.from), { top: 10, bottom: 50 });
  boxed(panel.querySelector(READER_DOM.body), { top: 60, bottom: 400 });
  boxed(panel.querySelector("[data-own-end]"), { top: 380, bottom: 380 });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}
const pass = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const reads = (mutations: readonly EngineMutation[]) =>
  mutations
    .filter((m): m is Extract<EngineMutation, { kind: "mark_seen" }> => m.kind === "mark_seen")
    .map((m) => ({ ids: m.messageIds, unread: m.unread }));

const reading = () => screen.getByRole("region", { name: "Reading" });
const pane = () => within(reading()).getByRole("region", { name: "Open message" });
const rowOf = (subject: string) =>
  within(screen.getByRole("listbox", { name: "New" })).getByRole("option", { name: new RegExp(subject) });

const LETTERS = [
  letter("a", { subject: "Kiln schedule", date: "2026-11-10T10:00:00.000Z" }),
  letter("b", { subject: "Glaze order", date: "2026-11-10T09:00:00.000Z" }),
];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  document.hasFocus = () => true;
  live.seams = 0;
  localStorage.clear();
  wideWindow();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Ohbox and the reader, joined through the frame", () => {
  it("a pressed row is held, and the reader shows the letter tinted on the model's record", () => {
    const { address, spies } = join({ letters: LETTERS });
    expect(live.seams).toBe(1);
    fireEvent.click(rowOf("Kiln schedule"));
    expect(address.read()).toBe("#/ohbox/m/a");
    expect(spies.onHoldRow).toHaveBeenLastCalledWith("a");
    // The list's look: the sheet is washed, and a hidden word says it is unread.
    expect(within(pane()).getByRole("article")).toBeTruthy();
    expect(within(pane()).getByText("Unread")).toBeTruthy();
    expect(live.seams).toBe(1);
  });

  it("a dwell on the open letter reaches the model's onMarkSeen as a glance, and the engine hears no read", () => {
    const { mail, spies } = join({ letters: LETTERS });
    fireEvent.click(rowOf("Kiln schedule"));
    layOut("a");
    pass(900);
    expect(spies.onMarkSeen).toHaveBeenCalledWith(["a"], false, "glance");
    expect(reads(mail.mutations)).toEqual([]);
    expect(live.seams).toBe(1);
  });

  it("Later in the panel reaches the model's onAction; the engine hears nothing from the reader", () => {
    const { mail, spies } = join({ letters: LETTERS });
    fireEvent.click(rowOf("Kiln schedule"));
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Later" }),
    );
    expect(spies.onAction).toHaveBeenCalledTimes(1);
    expect(spies.onAction.mock.calls[0]![0]).toBe("later");
    expect(spies.onAction.mock.calls[0]![1]).toMatchObject({ id: "a" });
    expect(mail.mutations).toEqual([]);
    expect(live.seams).toBe(1);
  });

  it("an address naming a letter the list does not hold is read on the reader's own visit", () => {
    const outside = letter("z", { subject: "Not in the list" });
    const { mail, spies } = join({ letters: [...LETTERS, outside], listed: LETTERS, open: "z" });
    expect(within(pane()).getByRole("article")).toBeTruthy();
    layOut("z");
    pass(900);
    expect(reads(mail.mutations)).toEqual([{ ids: ["z"], unread: false }]);
    expect(spies.onMarkSeen).not.toHaveBeenCalled();
    expect(live.seams).toBe(1);
  });

  it("with nothing open the column says the Ohbox's label", () => {
    join({ letters: LETTERS });
    expect(reading().textContent).toBe("2 unread");
    expect(live.seams).toBe(1);
  });

  it("one region named by the reader's pane, and no option inside it", () => {
    join({ letters: LETTERS });
    fireEvent.click(rowOf("Kiln schedule"));
    expect(screen.getAllByRole("region", { name: "Open message" })).toHaveLength(1);
    expect(within(pane()).queryAllByRole("option")).toEqual([]);
    expect(live.seams).toBe(1);
  });
});
