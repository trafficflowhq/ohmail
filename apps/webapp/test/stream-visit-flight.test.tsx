/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

const observedGlances = vi.hoisted(() => [] as string[]);
vi.mock("../../../packages/app-logic/src/reading/seen-batch.js", async (load) => {
  const actual = await load<typeof import("../../../packages/app-logic/src/reading/seen-batch.js")>();
  return {
    ...actual,
    createSeenBatcher: (...args: Parameters<typeof actual.createSeenBatcher>) => {
      const batch = actual.createSeenBatcher(...args);
      return {
        ...batch,
        add(id: string) {
          observedGlances.push(id);
          batch.add(id);
        },
      };
    },
  };
});

const CARD = 200;
const VIEW = 600;
const COUNT = 40;
const END = COUNT * CARD - VIEW;
const END_SCREEN = ["r37", "r38", "r39"];
const box = (top: number, height: number) => new DOMRect(0, top, VIEW, height);

beforeEach(() => {
  observedGlances.length = 0;
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function visit(place: "News" | "Receipts" = "News", { measureText = true, pending = false } = {}) {
  let frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++serial, run);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

  const view = place === "News" ? "reads" : "receipts";
  const make = place === "News" ? issue : receipt;
  const letters = Array.from({ length: COUNT }, (_, i) =>
    make(`r${i}`, COUNT - i, pending ? { body: undefined } : {}),
  );
  const { address, mail } = mountStreamFrame({ at: `#/${view}`, letters });
  const stream = screen.getByRole("region", { name: `${place} stream` });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  const cards = () => [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
  let grownAboveEnd = 0;
  let panelTop: number | null = null;
  const topOfIndex = (index: number) => index * CARD + (index > 35 ? grownAboveEnd : 0) - scroller.scrollTop;
  const heightOfIndex = (index: number) => CARD + (index === 35 ? grownAboveEnd : 0);
  const indexOf = (card: HTMLElement) => Number(card.dataset.streamItem!.slice(1));
  const topOf = (card: HTMLElement) => topOfIndex(indexOf(card));
  const cursor = () => cards().find((card) => card.hasAttribute("data-open"))?.dataset.streamItem;
  const cursors: string[] = [];
  const rect = HTMLElement.prototype.getBoundingClientRect;

  // Measuring the landing can mount a new window of cards during the same frame.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return box(0, VIEW);
    if (panelTop !== null && this.matches("[data-read-stop]")) return box(panelTop, 52);
    if (this.dataset.streamWindowItem !== undefined) {
      const index = Number(this.dataset.streamWindowItem.slice(1));
      return box(topOfIndex(index), heightOfIndex(index));
    }
    const card = this.closest<HTMLElement>("[data-stream-item]");
    if (card && scroller.contains(card)) {
      const top = topOf(card);
      if (this === card) return box(top, heightOfIndex(indexOf(card)));
      if (measureText && this.matches("[data-sender-line]")) return box(top + 16, 20);
      if (measureText && this.matches(".oh-message-clip, .oh-message-body, [data-read-body]")) return box(top + 70, CARD - 100);
    }
    return rect.call(this);
  });

  Object.defineProperties(scroller, {
    clientHeight: { get: () => VIEW },
    scrollHeight: { get: () => COUNT * CARD + grownAboveEnd },
    scrollTo: { value: (options: ScrollToOptions) => scroll(options.top ?? 0) },
  });

  function scroll(top: number) {
    scroller.scrollTop = Math.max(0, Math.min(top, END + grownAboveEnd));
    fireEvent.scroll(scroller);
  }

  function frame(ms = 20) {
    const due = frames;
    frames = new Map();
    act(() => {
      vi.advanceTimersByTime(ms);
      for (const run of due.values()) run(performance.now());
    });
    const selected = cursor();
    if (selected !== undefined && selected !== cursors.at(-1)) cursors.push(selected);
  }

  const rest = (count = 40) => {
    for (let i = 0; i < count; i += 1) frame();
  };
  const move = (...offsets: number[]) => {
    for (const top of offsets) {
      scroll(top);
      frame(16);
    }
  };
  const leap = (...offsets: number[]) => {
    for (const top of offsets) {
      scroll(top);
      frame(20);
    }
    for (let i = 0; i < 5; i += 1) frame(16);
  };
  const wheel = (top: number) => {
    let from = scroller.scrollTop;
    fireEvent.wheel(scroller, { deltaY: top - from });
    while (from !== top) {
      const distance = top - from;
      from += Math.sign(distance) * Math.min(Math.abs(distance), CARD / 2);
      scroll(from);
      frame(20);
    }
    frame(20);
    frame(20);
  };
  const key = (key: string) => fireEvent.keyDown(scroller, { key });
  const visible = () => new Set(cards().filter((card) => topOf(card) > -CARD && topOf(card) < VIEW)
    .map((card) => card.dataset.streamItem!));
  const marked = () => mail.mutations.flatMap((mutation) => {
    if (mutation.kind === "feed_mark_seen" && mutation.view === view && !mutation.upToId) return mutation.messageIds ?? [];
    if (view === "receipts" && mutation.kind === "mark_seen" && !mutation.unread && mutation.via === "glance")
      return mutation.messageIds ?? [];
    return [];
  });
  const leave = () => {
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    fireEvent.click(rail.getByRole("button", { name: /^Ohbox/ }));
    return mail.mutations.filter((mutation) => mutation.kind === "feed_mark_seen" && mutation.upToId);
  };
  const jump = () => {
    act(() => address.write("#/reads/m/r30", "push"));
    rest(20);
    expect(scroller.scrollTop, "the jump went deep").toBeGreaterThan(5000);
    return scroller.scrollTop;
  };

  const growAboveEnd = (height: number) => {
    grownAboveEnd = height;
    // Report the transient scroll geometry before the anchoring frame runs.
    fireEvent.scroll(scroller);
  };
  const row = (id: string) => screen.getByRole("region", { name: place }).querySelector(`[role="option"][data-id="${id}"]`)!;
  const heading = (id: string) => scroller.querySelector(`[data-stream-item="${id}"] h2`)!;
  move(0);
  const placePanelAt = (top: number) => { panelTop = top; };
  return { mail, address, row, heading, scroller, cursors, frame, rest, move, leap, wheel, key, visible, marked, leave, jump, growAboveEnd, placePanelAt };
}

const flight = [222, 888, 2220, 4070, 5550, 6660, 7178, END];
const commit = (upToId: string, messageIds: string[], view = "reads") => ({
  kind: "feed_mark_seen", view, upToId, messageIds,
});

describe("a far jump ends the tracked run: nothing the visit never displayed is marked", () => {
  it("leave after a far jump and one wheel commits only what was on screen after the landing", () => {
    const visitAt = visit();
    const landing = visitAt.jump();
    const displayed = visitAt.visible();
    visitAt.wheel(landing + 125);
    visitAt.rest();
    const commits = visitAt.leave();
    expect(commits).toEqual([commit("r29", ["r30", "r31", "r32"])]);
    expect(commits.flatMap((entry) => entry.kind === "feed_mark_seen" ? (entry.messageIds ?? []) : [])
      .filter((id) => !displayed.has(id))).toEqual([]);
  });

  it("after a far jump and a wheel, the seen observer marks no card mounted above the landing", () => {
    const visitAt = visit();
    const landing = visitAt.jump();
    const displayed = visitAt.visible();
    visitAt.wheel(landing + 125);
    visitAt.rest(10);
    expect(observedGlances.filter((id) => !displayed.has(id))).toEqual([]);
    expect(observedGlances).toEqual(["r30"]);
  });

  it("a scrollbar drag to the end after a wheel commits only the screen it rests on", () => {
    const visitAt = visit();
    visitAt.wheel(100);
    visitAt.leap(2400, 4800, END);
    visitAt.rest();
    expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN)]);
  });

  const drags = [
    { to: "mid-pile", path: [1200, 2400, 3600, 4800, 4840, 4880, 4900], after: { curs: ["r6", "r12", "r18", "r24", "r25"], top: 4986, marked: [] } },
    { to: "the end", path: [2400, 4800, 7000, 7300, END], after: { curs: ["r12", "r39"], top: END, marked: [] } },
  ];
  for (const { to, path, after } of drags) {
    it(`a scrollbar drag to ${to} rests the cursor on a card of the screen it shows, never one off it, and j starts from there`, () => {
      // The released cursor-only cases use unloaded letters, so a wire write here would read a flight.
      const visitAt = visit("News", { pending: true, measureText: false });
      visitAt.wheel(100);
      visitAt.cursors.length = 0;
      visitAt.leap(...path);
      visitAt.key("j");
      visitAt.rest(10);
      expect({ curs: visitAt.cursors, top: visitAt.scroller.scrollTop, marked: visitAt.marked() }).toEqual(after);
    });
  }

  it("End over frames moves the cursor once and marks and commits only the end screen", () => {
    const visitAt = visit();
    visitAt.cursors.length = 0;
    visitAt.key("End");
    visitAt.move(...flight);
    visitAt.rest(20);
    expect({ curs: visitAt.cursors, offScreen: visitAt.marked().filter((id) => !END_SCREEN.includes(id)) })
      .toEqual({ curs: ["r39"], offScreen: [] });
    visitAt.rest();
    expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN)]);
  });

  it("a dwell that comes due while End is in flight marks nothing End carried off the screen", () => {
    // This case isolates the scroll-spy's dwell from the separate measured text dwell.
    const visitAt = visit("News", { measureText: false });
    visitAt.wheel(150);
    visitAt.rest(10);
    expect(observedGlances, "r0 crossed the reading line before its neighbour rested").toEqual(["r0"]);
    visitAt.frame(339);
    visitAt.key("End");
    visitAt.move(...flight);
    visitAt.rest(20);
    expect(observedGlances.slice(1).filter((id) => !END_SCREEN.includes(id))).toEqual([]);
  });

  it("End after a scroll key commits only the end screen, in Receipts too", () => {
    const visitAt = visit("Receipts");
    visitAt.wheel(100);
    visitAt.key("End");
    visitAt.leap(END);
    visitAt.rest();
    expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN, "receipts")]);
  });

  it("a drag back up past unseen cards starts the run where it rests", () => {
    const visitAt = visit();
    visitAt.wheel(100);
    visitAt.leap(6000);
    visitAt.wheel(6100);
    visitAt.leap(1200);
    visitAt.rest();
    expect(visitAt.leave()).toEqual([commit("r6", ["r6", "r7", "r8"])]);
  });
});

describe("after End rests, a frame the stream has not re-anchored yet is nobody's read", () => {
  it("control: with no growth the leave commits the resting screen", () => {
    const visitAt = visit();
    visitAt.wheel(900);
    visitAt.rest(150);
    visitAt.key("End");
    visitAt.leap(1300, 2220, 4070, 5550, 6660, 7178, END);
    visitAt.rest(20);
    visitAt.rest();
    expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN)]);
  });
});

it("holds the End screen when a letter above it grows before the anchoring frame", () => {
  const visitAt = visit();
  visitAt.key("End");
  visitAt.move(...flight);
  visitAt.rest(10);
  expect(visitAt.scroller.scrollTop).toBe(END);
  visitAt.growAboveEnd(CARD);
  expect(visitAt.visible()).toEqual(new Set(["r36", "r37", "r38"]));
  expect(observedGlances).toEqual([]);
  visitAt.frame();
  expect(visitAt.scroller.scrollTop).toBe(END + CARD);
  expect(visitAt.visible()).toEqual(new Set(END_SCREEN));
  visitAt.rest(45);
  expect(observedGlances).toEqual(END_SCREEN);
  expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN)]);
});


it("hears End from the letter's own document and reads only the final screen", () => {
  const visitAt = visit();
  const card = visitAt.scroller.querySelector("[data-stream-item]")!;
  const frame = document.createElement("iframe");
  card.append(frame);
  fireEvent.load(frame);
  const text = frame.contentDocument!.body;
  fireEvent.keyDown(text, { key: "End" });
  visitAt.move(...flight);
  visitAt.rest(45);
  expect(visitAt.cursors).toEqual(["r39"]);
  expect(observedGlances).toEqual(END_SCREEN);
  expect(visitAt.leave()).toEqual([commit("r37", END_SCREEN)]);
});

it("after a wheel, the resting snippet earns a glance at 600 ms", () => {
  const visitAt = visit("News", { pending: true });
  visitAt.wheel(150);
  visitAt.frame(539);
  expect(observedGlances).toEqual(["r0"]);
  visitAt.frame(1);
  expect(observedGlances).toEqual(["r0", "r1"]);
});

it("judges a scroll from an isolated letter by what stays on screen", () => {
  const visitAt = visit();
  const frame = document.createElement("iframe");
  visitAt.scroller.querySelector("[data-stream-item]")!.append(frame);
  frame.focus();
  Object.defineProperty(frame, "contentDocument", { value: null });
  fireEvent.load(frame);
  expect(document.activeElement).toBe(frame);
  visitAt.move(...flight);
  visitAt.rest(45);
  expect(observedGlances).toEqual(END_SCREEN);
  expect(visitAt.leave()).toEqual([commit("r0", END_SCREEN)]);
});

it("a heading press reads the displayed first lines after the dwell", () => {
  const visitAt = visit();
  fireEvent(visitAt.heading("r0"), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  visitAt.rest(30);
  expect(observedGlances).toEqual([]);
  visitAt.rest(10);
  expect(observedGlances).toEqual(["r0", "r1", "r2"]);
});

it("a row press reads the displayed destination and leaves the card above unread", () => {
  const visitAt = visit();
  fireEvent.click(visitAt.row("r4"));
  visitAt.rest(25);
  expect(observedGlances).toEqual([]);
  visitAt.rest(25);
  expect(observedGlances).toEqual(["r4", "r5", "r6"]);
});

it("after a wheel, quick cursor steps read just the final displayed screen", () => {
  const visitAt = visit();
  visitAt.wheel(40);
  visitAt.rest(45);
  expect(observedGlances).toEqual(["r0", "r1", "r2"]);
  observedGlances.length = 0;
  for (let i = 0; i < 3; i++) {
    visitAt.key("j");
    visitAt.rest(4);
  }
  expect(observedGlances).toEqual([]);
  visitAt.rest(45);
  expect(observedGlances).toEqual(["r3", "r4", "r5"]);
});

it("a key step onto a snippet earns no live glance until the next wheel lifts it", () => {
  const visitAt = visit("News", { pending: true });
  visitAt.wheel(40);
  visitAt.rest(150);
  expect(observedGlances).toEqual(["r0"]);
  observedGlances.length = 0;
  visitAt.key("j");
  visitAt.rest(130);
  expect(observedGlances).toEqual([]);
  visitAt.wheel(310);
  expect(observedGlances).toEqual(["r1"]);
});

it.each([
  ["News", "reads"],
  ["Receipts", "receipts"],
] as const)("%s Later files the addressed card after scrolling to another", async (place, route) => {
  const v = visit(place);
  fireEvent.click(v.heading("r0"));
  fireEvent.click(v.heading("r1"));
  fireEvent.click(v.heading("r0"));
  v.rest(20);
  v.wheel(CARD * 4);
  expect(v.cursors.at(-1)).toBe("r4");
  expect(v.address.read()).toBe(`#/${route}/m/r0`);
  const toolbar = screen.getByRole("toolbar", { name: "Actions" });
  await act(async () => {
    fireEvent.click(within(toolbar).getByRole("button", { name: "Later" }));
  });
  expect(v.mail.mutations.filter((mutation) => mutation.kind === "triage_set")).toEqual([
    expect.objectContaining({ messageId: "r0", state: "reply_later" }),
  ]);
});

it("does not read first lines covered by the action panel", () => {
  const v = visit();
  v.placePanelAt(486);
  fireEvent.click(v.heading("r0"));
  const stop = screen.getByRole("toolbar", { name: "Actions" }).closest("[data-read-stop]");
  expect(stop?.getBoundingClientRect().top).toBe(486);
  fireEvent(v.heading("r0"), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  v.rest(125);
  expect(observedGlances).toContain("r1");
  expect(observedGlances).not.toContain("r2");
});

it("leaves a covered snippet unread after a wheel stops", () => {
  const v = visit("News", { pending: true });
  v.placePanelAt(486);
  fireEvent.click(v.heading("r0"));
  v.rest(20);
  v.wheel(10);
  v.rest(125);
  expect(v.leave()).toEqual([commit("r0", ["r0", "r1"])]);
});

it("keeps the leave range above an action panel covering the end of the screen", () => {
  const v = visit("News", { pending: true });
  fireEvent.click(v.heading("r0"));
  v.rest(20);
  v.wheel(10);
  v.rest(125);
  // These previews earned deferred reads. The current screen's visible range ends before r2.
  v.placePanelAt(380);
  v.move(10);
  expect(v.leave()).toEqual([commit("r0", ["r0", "r1"])]);
});

it("after a middle-of-stream wheel, only the resting snippet earns a glance", () => {
  const v = visit("News", { pending: true });
  v.move(17 * CARD);
  v.rest(20);
  v.wheel(18 * CARD);
  expect(v.cursors.at(-1)).toBe("r18");
  observedGlances.length = 0;
  v.frame(539);
  expect(observedGlances).toEqual([]);
  v.frame(1);
  expect(observedGlances).toEqual(["r18"]);
});

it("starts a fresh 600 ms dwell when a second wheel moves the current card", () => {
  const v = visit("News", { pending: true });
  v.move(17 * CARD);
  v.rest(20);
  v.wheel(18 * CARD);
  v.frame(200);
  v.wheel(19 * CARD);
  expect(v.cursors.at(-1)).toBe("r19");
  observedGlances.length = 0;
  v.frame(539);
  expect(observedGlances).toEqual([]);
  v.frame(1);
  expect(observedGlances).toEqual(["r19"]);
});

it("keyboard Delete cannot trash a scroll cursor hidden by the action panel", async () => {
  const v = visit();
  fireEvent.click(v.heading("r0"));
  v.rest(20);
  v.wheel(4 * CARD);
  v.placePanelAt(380);
  v.key("End");
  v.move(...flight);
  v.rest(30);
  const panel = screen.getByRole("toolbar", { name: "Actions" }).closest("[data-read-stop]")!;
  const footer = v.heading("r39").closest<HTMLElement>("[data-stream-item]")!;
  expect(footer.getBoundingClientRect().top).toBeGreaterThan(panel.getBoundingClientRect().top);
  expect(v.cursors.at(-1)).toBe("r39");
  expect(v.address.read()).toBe("#/reads/m/r0");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Delete" });
  const disappeared = !v.scroller.querySelector('[data-stream-item="r39"]');
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect({
    disappeared,
    deletions: v.mail.mutations.filter((m) => m.kind === "message_delete"),
  }).toEqual({ disappeared: false, deletions: [] });
});

it("Backspace leaves the previous scroll cursor alone during End's flight", async () => {
  const v = visit();
  fireEvent.click(v.heading("r0"));
  v.rest(20);
  v.wheel(4 * CARD);
  expect(v.cursors.at(-1)).toBe("r4");
  v.key("End");
  v.key("Backspace");
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  v.move(...flight);
  v.rest(30);
  expect(v.cursors.at(-1)).toBe("r39");
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(v.mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
});

it("entering the earlier expanded card through Collapse retargets Later", async () => {
  const v = visit();
  fireEvent.click(v.heading("r0"));
  fireEvent.click(v.heading("r1"));
  expect(v.address.read()).toBe("#/reads/m/r1");
  const first = v.heading("r0").closest<HTMLElement>("[data-stream-item]")!;
  const collapse = within(first).getByRole("button", { name: "Collapse" });
  act(() => collapse.focus());
  v.rest(6);
  expect(v.address.read()).toBe("#/reads/m/r0");
  expect(document.activeElement).toBe(collapse);
  await act(async () => {
    const panel = screen.getByRole("toolbar", { name: "Actions" });
    fireEvent.click(within(panel).getByRole("button", { name: "Later" }));
  });
  expect(v.mail.mutations.filter((mutation) => mutation.kind === "triage_set")).toEqual([
    expect.objectContaining({ messageId: "r0", state: "reply_later" }),
  ]);
});

it("a prefetched ready preview can earn a live read after a wheel", () => {
  let report: ((element: Element) => void) | undefined;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      if (options?.rootMargin === "100% 0px") {
        report = (target) => callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const v = visit("News", { pending: true });
  const card = v.heading("r1").closest("[data-stream-item]")!;
  expect(report).toBeDefined();
  act(() => report?.(card));
  expect(v.mail.bodyAsks).toEqual(["r1"]);
  const copy = card.querySelector(".oh-message-body")!.textContent!;
  expect(copy.length).toBeGreaterThan(0);
  act(() => {
    v.mail.patch("r0", { body: copy });
    v.mail.patch("r1", { body: copy });
  });
  expect(card.querySelector(".oh-message-body")!.textContent).toBe(copy);
  v.rest(45);
  expect(observedGlances).toEqual([]);
  expect(v.mail.mutations).toEqual([]);
  v.wheel(10);
  v.rest(45);
  expect(observedGlances).toContain("r0");
  expect(observedGlances).toContain("r1");
});
