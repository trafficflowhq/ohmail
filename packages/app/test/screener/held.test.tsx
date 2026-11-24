/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELD_ANCHOR_PAD_PX } from "@ohmail/app-logic/lists/held-window";
import type { LetterProps } from "../../src/reader/index.js";
import { NONE } from "../../src/host/index.js";
import type { HeldParts, ScreenerBeside } from "../../src/screener/index.js";
import { BESIDE, modelOf, mountPlace, screenerEngine, sender, type Asked } from "./screener-world.js";

/**
 * THE HELD LETTERS of the open sender, drawn with the parts the shell hands the reader: shown and never read, their
 * pictures blocked until the person presses for that letter, their bodies asked as one urgent request, the calendar's
 * part under a letter of Waiting, and a letter its provider failed opened and decided alone.
 */

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

const twoLetters = (id: string, name: string) =>
  sender(id, name, {
    held: [
      { id: `${id}-1`, subject: `First from ${name}`, time: "09:00", body: "", snippet: "first" },
      { id: `${id}-2`, subject: `Second from ${name}`, time: "09:10", body: "", snippet: "second" },
    ],
  });
const QUEUE = [twoLetters("lena", "Lena Hart"), sender("ben", "Ben Kiln")];
const reading = () => screen.getByRole("region", { name: "Reading" });

/** The shell's parts as a recording double: a body that says what it was handed, a picture seam that counts. */
function parts() {
  const seen = { consented: [] as string[], needed: [] as string[] };
  function Body(p: LetterProps) {
    return (
      <div role="article" aria-label={`body ${p.messageId}`} data-remote={String(p.remoteLoaded)}>
        <p>{p.text}</p>
        {p.onLoadRemote ? (
          <button type="button" onClick={p.onLoadRemote}>
            Show pictures {p.messageId}
          </button>
        ) : null}
      </div>
    );
  }
  const letters: HeldParts = {
    body: Body,
    files: "none",
    look: "none",
    pictures: {
      proxyFor: () => (url: string) => url,
      consented: (id: string) => seen.consented.includes(id),
      consent: (id: string) => void seen.consented.push(id),
      auto: true,
      loadPixels: false,
      resolvedFor: () => new Map(),
      needRemote: (id: string) => void seen.needed.push(id),
    },
  };
  return { letters, seen };
}

describe("a held letter", () => {
  it("is drawn by the shell's body with its pictures blocked, even where the account loads them by itself", () => {
    const { letters, seen } = parts();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { beside: { ...BESIDE, letters } });
    const bodies = within(reading()).getAllByRole("article", { name: /^body / });
    expect(bodies.map((b) => b.getAttribute("data-remote"))).toEqual(["false", "false"]);
    expect(seen.consented).toEqual([]);
  });

  it("shows its pictures on a press, for that letter alone", () => {
    const { letters, seen } = parts();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { beside: { ...BESIDE, letters } });
    fireEvent.click(within(reading()).getByRole("button", { name: "Show pictures lena-2" }));
    expect(seen.consented).toEqual(["lena-2"]);
  });

  it("the open sender's bodies are asked as one urgent request; walking on asks for the next; nothing is changed", () => {
    const { engine, asked: engineAsked } = screenerEngine();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { engine });
    expect(engineAsked.bodies).toEqual(["lena-1,lena-2 urgent"]);
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
    });
    expect(engineAsked.bodies).toEqual(["lena-1,lena-2 urgent", "ben-1 urgent"]);
    expect(engineAsked.mutations).toEqual([]);
    expect(asked.decided).toBeUndefined();
  });

  it("a body that failed offers Retry, which asks for that letter again", () => {
    const failedBody = { state: "failed", text: "", html: null };
    const { engine, asked: engineAsked } = screenerEngine({ "lena-1": failedBody });
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { engine });
    fireEvent.click(within(reading()).getByRole("button", { name: "Retry" }));
    expect(engineAsked.bodies).toContain("lena-1 retry");
  });

  it("stands the calendar's part under each letter of Waiting, and under none of a sender kept out", () => {
    const Invitation = ({ messageId }: { messageId: string }) => <p>invitation {messageId}</p>;
    const beside: ScreenerBeside = { ...BESIDE, invitation: Invitation };
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { beside });
    expect(within(reading()).getByText("invitation lena-1")).toBeTruthy();
    expect(within(reading()).getByText("invitation lena-2")).toBeTruthy();
    world.view.unmount();
    const out = { ...(twoLetters("zed", "Zed Oak") as object), segment: "screened" };
    mountPlace(modelOf(asked, { screenedOut: [out] as never }), { at: "#/screener/screened", beside });
    expect(within(reading()).getByRole("heading", { name: /Zed Oak goes to/ })).toBeTruthy();
    expect(within(reading()).queryByText(/invitation/)).toBeNull();
  });

  it("with no parts handed draws the letter's text", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { beside: { ...BESIDE, letters: NONE } });
    expect(within(reading()).getByText("first")).toBeTruthy();
  });
});

describe("a letter its provider failed", () => {
  const failed = [
    {
      id: "f1",
      from: { name: "Bank", address: "bank@bank.example" },
      subject: "Your card",
      time: "08:00",
      mailboxId: "mb",
      own: false,
    },
  ];

  it("opens from its row with what the check found; each answer files it once, and it closes", () => {
    const { engine, asked: engineAsked } = screenerEngine();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, failedAtGate: failed as never }), {
      engine,
    });
    const rows = screen.getByRole("listbox", { name: "Messages that failed the sender check" });
    fireEvent.click(within(rows).getByRole("option", { name: /Bank: Your card/ }));
    expect(within(reading()).getByRole("heading", { name: /The sender check failed/ })).toBeTruthy();
    expect(reading().textContent).toContain("the check failed");
    expect(engineAsked.bodies).toContain("f1 urgent");
    expect(within(reading()).queryByRole("button", { name: /Ohbox/ })).toBeNull();
    fireEvent.click(within(reading()).getByRole("button", { name: "Not from them" }));
    expect(asked.filedFailed).toEqual([["f1", "spam"]]);
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
    expect(asked.decided).toBeUndefined();
  });
});

describe("unsubscribe, on a letter of a sender kept out", () => {
  const full = (unsubscribe: string) => ({
    state: "ready",
    text: "The letter",
    html: null,
    loadedRemoteContent: false,
    unsubscribe,
    unsubscribeUrl: null,
  });
  const kept = () => ({ ...(sender("zed", "Zed Oak") as object), segment: "screened" }) as never;
  const mountKept = (body: unknown, unsubscribe: ScreenerBeside["unsubscribe"]) =>
    mountPlace(modelOf(asked, { screenedOut: [kept()] }), {
      at: "#/screener/screened",
      beside: { ...BESIDE, unsubscribe },
      engine: screenerEngine({ "zed-1": body }).engine,
    });

  it("is one press once the text has arrived; the server is asked once and the sentence follows its answer", async () => {
    const sent: string[] = [];
    mountKept(full("one_click"), async (id) => {
      sent.push(id);
      return { messageId: id, posted: true, status: 200, refusal: null, header: "one_click" };
    });
    expect(sent).toEqual([]);
    expect(within(reading()).queryByText("Unsubscribed", { exact: true })).toBeNull();
    await act(async () => {
      fireEvent.click(within(reading()).getByRole("button", { name: "Unsubscribe" }));
    });
    expect(sent).toEqual(["zed-1"]);
    expect(reading().textContent).toContain("Unsubscribe request sent.");
    expect(within(reading()).getByText("Unsubscribed", { exact: true })).toBeTruthy();
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    expect(asked.decided).toBeUndefined();
  });

  it("a list that refused is said and the press goes; one that failed keeps the press", async () => {
    const refusedBy = (code: string) => async () => {
      throw Object.assign(new Error("no"), { code });
    };
    const world = mountKept(full("one_click"), refusedBy("unsubscribe_list_refused"));
    await act(async () => {
      fireEvent.click(within(reading()).getByRole("button", { name: "Unsubscribe" }));
    });
    expect(reading().textContent).toContain("The list did not accept the unsubscribe request.");
    expect(within(reading()).queryByText("Unsubscribed", { exact: true })).toBeNull();
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    world.view.unmount();
    mountKept(full("one_click"), refusedBy("unsubscribe_list_failed"));
    await act(async () => {
      fireEvent.click(within(reading()).getByRole("button", { name: "Unsubscribe" }));
    });
    expect(reading().textContent).toContain("The list could not take the request right now.");
    expect(within(reading()).getByRole("button", { name: "Unsubscribe" })).toBeTruthy();
  });

  it("is not offered before the text, on a letter of Waiting, or where the shell hands no request; by email it is declined", () => {
    const send = async () => null;
    const world = mountKept({ state: "loading" }, send);
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    world.view.unmount();
    const none = mountKept(full("one_click"), NONE);
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    none.view.unmount();
    const waiting = mountPlace(modelOf(asked, { waiting: [sender("zed", "Zed Oak")], waitingCount: 1 }), {
      beside: { ...BESIDE, unsubscribe: send },
      engine: screenerEngine({ "zed-1": full("one_click") }).engine,
    });
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    waiting.view.unmount();
    mountKept(full("mailto_only"), send);
    expect(reading().textContent).not.toContain("ohmail never sends mail on your behalf");
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
  });

  it("is not offered on a letter whose text the server withholds, whatever its headers offer", () => {
    const withheld = {
      state: "ready",
      withheld: "storage_cap",
      text: "",
      html: null,
      loadedRemoteContent: false,
      unsubscribe: "one_click",
      unsubscribeUrl: null,
    };
    mountPlace(modelOf(asked, { screenedOut: [kept()] }), {
      at: "#/screener/screened",
      beside: { ...BESIDE, unsubscribe: async () => null },
      engine: screenerEngine({ "zed-1": withheld }).engine,
    });
    expect(within(reading()).queryByRole("button", { name: "Unsubscribe" })).toBeNull();
  });

  it("a second press while the first request is on its way sends nothing more", async () => {
    const sent: string[] = [];
    let settle: (v: unknown) => void = () => undefined;
    const full = {
      state: "ready",
      text: "The letter",
      html: null,
      loadedRemoteContent: false,
      unsubscribe: "one_click",
      unsubscribeUrl: null,
    };
    mountPlace(modelOf(asked, { screenedOut: [kept()] }), {
      at: "#/screener/screened",
      beside: {
        ...BESIDE,
        unsubscribe: (id) => {
          sent.push(id);
          return new Promise((res) => (settle = res as never));
        },
      },
      engine: screenerEngine({ "zed-1": full }).engine,
    });
    const button = within(reading()).getByRole("button", { name: "Unsubscribe" });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(within(reading()).getByRole("button", { name: /Unsubscribe|Sending/ }));
    });
    expect(sent).toEqual(["zed-1"]);
    await act(async () => {
      settle({ messageId: "zed-1", posted: true, status: 200, refusal: null, header: "one_click" });
    });
    expect(sent).toEqual(["zed-1"]);
  });
});

/**
 * THE NEWEST LETTER FIRST (1.0.11's `apps/webapp/test/screener-latest-anchor.test.tsx`): the letters stand oldest
 * first, so the reading column opens on the newest and keeps it there while their bodies land, until the person
 * scrolls. jsdom has no layout, so layout is modelled as that test models it: an offset written to a box reads back,
 * and a letter stands at its place in the column less the column's offset, a snippet's height until its body is
 * drawn and a body's after. The column is the box the offset was written to.
 */
describe("the newest letter first", () => {
  const ABOVE = 200;
  const SNIPPET = 100;
  const BODY = 600;
  const WHOLE = "the whole of";
  const offsets = new WeakMap<Element, number>();
  const watchers = new Set<{ report: ResizeObserverCallback; boxes: Set<Element> }>();
  const before: { rect?: PropertyDescriptor; offset?: PropertyDescriptor; watch?: unknown } = {};
  const tall = (el: Element) => ((el.textContent ?? "").includes(WHOLE) ? BODY : SNIPPET);
  const columnOf = (el: Element): Element | null => {
    for (let at = el.parentElement; at !== null; at = at.parentElement) if (offsets.has(at)) return at;
    return null;
  };
  const box = (top: number, height: number) =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;

  beforeEach(() => {
    before.rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
    before.offset = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    before.watch = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return offsets.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        offsets.set(this, Math.max(0, v));
      },
    });
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element): DOMRect {
        if (this.tagName !== "ARTICLE") return box(0, 0);
        let at = ABOVE;
        for (const sheet of this.parentElement?.children ?? []) {
          if (sheet === this) break;
          if (sheet.tagName === "ARTICLE") at += tall(sheet);
        }
        const column = columnOf(this);
        return box(at - (column === null ? 0 : (offsets.get(column) ?? 0)), tall(this));
      },
    });
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      private readonly mine: { report: ResizeObserverCallback; boxes: Set<Element> };
      constructor(report: ResizeObserverCallback) {
        this.mine = { report, boxes: new Set() };
        watchers.add(this.mine);
      }
      observe(el: Element) {
        this.mine.boxes.add(el);
      }
      unobserve(el: Element) {
        this.mine.boxes.delete(el);
      }
      disconnect() {
        watchers.delete(this.mine);
      }
    };
  });
  afterEach(() => {
    Object.defineProperty(Element.prototype, "getBoundingClientRect", before.rect!);
    Object.defineProperty(Element.prototype, "scrollTop", before.offset!);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = before.watch;
    watchers.clear();
  });

  /** Layout reports that the box the letters stand in changed size, to whoever watches it. */
  const grown = () =>
    act(() => {
      const run = sheets()[0]!.parentElement!;
      for (const w of watchers)
        if (w.boxes.has(run)) w.report([{ target: run } as unknown as ResizeObserverEntry], null as never);
    });
  const sheets = () => within(reading()).getAllByRole("article");
  const topOf = (el: Element) => el.getBoundingClientRect().top;
  const letters = (id: string, name: string, count: number) =>
    sender(id, name, {
      held: Array.from({ length: count }, (_, i) => ({
        id: `${id}-${i + 1}`,
        subject: `Letter ${i + 1} from ${name}`,
        time: `09:0${i}`,
        body: "",
        snippet: `snippet ${i + 1}`,
      })),
    });
  const body = (id: string) => ({
    state: "ready",
    text: `${WHOLE} ${id}`,
    html: null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
  });
  const walk = () =>
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
    });

  it("opens on the newest letter, its body drawn from the start, and on the newest of the sender walked to", () => {
    const ids = ["lena-1", "lena-2", "lena-3", "ben-1", "ben-2"];
    const { engine } = screenerEngine(Object.fromEntries(ids.map((id) => [id, body(id)])));
    const queue = [letters("lena", "Lena Hart", 3), letters("ben", "Ben Kiln", 2)];
    mountPlace(modelOf(asked, { waiting: queue, waitingCount: 2 }), { engine });
    expect(sheets().map((s) => s.textContent?.includes(WHOLE))).toEqual([true, true, true]);
    expect(topOf(sheets()[2]!)).toBe(HELD_ANCHOR_PAD_PX);
    expect(topOf(sheets()[0]!)).toBeLessThan(0);
    walk();
    expect(within(reading()).getByRole("heading", { name: /Ben Kiln goes to/ })).toBeTruthy();
    expect(topOf(sheets()[1]!)).toBe(HELD_ANCHOR_PAD_PX);
  });

  it("stays on the newest letter once the bodies land after it opened", () => {
    const { engine, land } = screenerEngine();
    mountPlace(modelOf(asked, { waiting: [letters("lena", "Lena Hart", 3)], waitingCount: 1 }), { engine });
    expect(topOf(sheets()[2]!)).toBe(HELD_ANCHOR_PAD_PX);
    act(() => {
      for (const id of ["lena-1", "lena-2", "lena-3"]) land(id, body(id));
    });
    expect(
      sheets().map((s) => s.textContent?.includes(WHOLE)),
      "premise: the bodies are drawn",
    ).toEqual([true, true, true]);
    expect(topOf(sheets()[2]!), "premise: the letters above it grew").toBeGreaterThan(HELD_ANCHOR_PAD_PX);
    grown();
    expect(topOf(sheets()[2]!)).toBe(HELD_ANCHOR_PAD_PX);
  });

  it("the person's own scroll is kept while the letters grow", () => {
    const { engine, land } = screenerEngine();
    mountPlace(modelOf(asked, { waiting: [letters("lena", "Lena Hart", 3)], waitingCount: 1 }), { engine });
    const column = columnOf(sheets()[0]!);
    expect(column, "premise: the column put itself on the newest letter").not.toBeNull();
    column!.scrollTop = 50;
    act(() => {
      for (const id of ["lena-1", "lena-2", "lena-3"]) land(id, body(id));
    });
    grown();
    expect(topOf(sheets()[0]!)).toBe(ABOVE - 50);
  });

  it("a sender of one letter opens at the column's top, also after one of several", () => {
    const { engine } = screenerEngine();
    const queue = [letters("lena", "Lena Hart", 3), letters("ben", "Ben Kiln", 1)];
    mountPlace(modelOf(asked, { waiting: queue, waitingCount: 2 }), { engine });
    expect(topOf(sheets()[2]!)).toBe(HELD_ANCHOR_PAD_PX);
    walk();
    expect(within(reading()).getByRole("heading", { name: /Ben Kiln goes to/ })).toBeTruthy();
    expect(topOf(sheets()[0]!)).toBe(ABOVE);
  });
});

describe("which mailbox a sender wrote to", () => {
  it("is said where the account has several, and nothing where the shell has no name for it", () => {
    const words = (id: string) => (id === "mb-work" ? "Work" : null);
    const world = mountPlace(
      modelOf(asked, { waiting: [sender("lena", "Lena Hart", { mailboxId: "mb-work" })], waitingCount: 1 }),
      { beside: { ...BESIDE, mailboxWord: words } },
    );
    expect(reading().textContent).toContain("Delivered to Work");
    world.view.unmount();
    mountPlace(
      modelOf(asked, { waiting: [sender("lena", "Lena Hart", { mailboxId: "mb-home" })], waitingCount: 1 }),
      {
        beside: { ...BESIDE, mailboxWord: words },
      },
    );
    expect(reading().textContent).not.toContain("Delivered to");
  });
});
