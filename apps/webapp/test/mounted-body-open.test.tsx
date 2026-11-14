/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import type { EngineMessage, EngineMutation, MessageBodyWire } from "@ohmail/wire";
import { message } from "./_draft-shell.js";
import {
  ISO, act, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

const accountId = "acct_live_1";
const mailboxId = "mb_1";
const full = (id: string): MessageBodyWire => ({
  text: `FULL BODY of ${id}\n` + "Sanded the north elevation again today. ".repeat(40),
  html: null,
  loadedRemoteContent: false,
  unsubscribe: "no_header",
  unsubscribeUrl: null,
});

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
});
afterEach(async () => {
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

function letter(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return message(id, {
    accountId, mailboxId, date: ISO, updatedAt: ISO, unread: true, snippet: `one line of ${id}`, ...over,
  });
}

async function mount(hash: string, letters: EngineMessage[], body = async (id: string) => full(id)) {
  window.location.hash = hash;
  const asked: string[] = [];
  const sent: EngineMutation[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(letters.map((m, i): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: ISO, entity: m,
  })));
  const engine = new OhmailEngine({
    store,
    now: () => new Date(),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async (mutation) => {
        sent.push(mutation);
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: (id) => {
        asked.push(id);
        return body(id);
      },
    },
  });
  await engine.start();
  const el = await mountShell([mailbox({ id: mailboxId, lastSyncAt: ISO })], { engine });
  await tick(1_000);
  return { asked, el, engine, sent };
}

function articleFor(el: HTMLElement, subject: string): HTMLElement {
  return within(el).getByRole("heading", { name: subject }).closest("article")!;
}

const inNews = ["r1", "r2", "r3"].map((id, index) =>
  letter(id, { folder: "ohmail/News", date: new Date(Date.parse(ISO) - index * 60_000).toISOString() }),
);
const held = [
  letter("s1", { from: { name: "Lena", address: "lena@example.test" }, folder: "ohmail/Screener", date: "2026-08-04T07:00:00Z" }),
  letter("s2", { from: { name: "Lena", address: "lena@example.test" }, folder: "ohmail/Screener", date: "2026-08-04T08:00:00Z" }),
  letter("s3", { from: { name: "Ruth", address: "ruth@example.test" }, folder: "ohmail/Screener", date: "2026-08-04T06:00:00Z" }),
];

async function openHeld(body?: (id: string) => Promise<MessageBodyWire>, letters = held) {
  const shell = await mount("#/screener", letters, body);
  await tick(2000);
  return shell;
}

/** Give the kit real short and long cases without asking jsdom to lay out text. */
function measurePreviews() {
  const observers = new Set<ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly observeSize: ResizeObserverCallback) {}
    observe() { observers.add(this.observeSize); }
    unobserve() {}
    disconnect() { observers.delete(this.observeSize); }
  });
  const isClip = (element: HTMLElement) => element.classList.contains("oh-message-clip");
  const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
  const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
  const contentHeight = (element: HTMLElement) => /FULL BODY/.test(element.textContent ?? "") ? 700 : 20;
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isClip(this) ? contentHeight(this) : scrollHeight.call(this);
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isClip(this) ? Math.min(contentHeight(this), 120) : clientHeight.call(this);
  });
  return () => {
    for (const resized of observers) resized([], {} as ResizeObserver);
  };
}

/** One News article intersects the prefetch band. Other observed articles are outside it. */
function keepOnlyFirstNear() {
  let notify: IntersectionObserverCallback | undefined;
  const observed = new Set<Element>();
  vi.stubGlobal("IntersectionObserver", class {
    private readonly loadsBodies: boolean;
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.loadsBodies = options.rootMargin === "100% 0px";
      if (this.loadsBodies) notify = callback;
    }
    observe(card: Element) {
      if (this.loadsBodies && card.hasAttribute("data-stream-item")) observed.add(card);
    }
    disconnect() {}
    unobserve(card: Element) { observed.delete(card); }
    takeRecords() { return []; }
  });
  return () => {
    expect(observed.size).toBe(3);
    expect(notify).toBeDefined();
    notify!([...observed].map((target) => ({
      target,
      isIntersecting: target.getAttribute("data-stream-item") === "r1",
    }) as IntersectionObserverEntry), {} as IntersectionObserver);
  };
}

describe("Reads — collapsed by default, and openable because the body arrives", () => {
  it("the CURRENT card hydrates, and it is the ONLY one that does", async () => {
    const prefetched = keepOnlyFirstNear();
    const { asked } = await mount("#/reads", inNews);
    await act(async () => { prefetched(); });
    await tick(1000);
    expect(asked).toEqual(["r1"]);
  });

  it("the hydrated card shows the FULL body; its siblings show a snippet AND their pill", async () => {
    measurePreviews();
    const { asked, el } = await mount("#/reads/m/r1", inNews);
    await tick(4_000);
    const stream = within(el).getByRole("region", { name: "News stream" });
    const hydrated = articleFor(stream, "Subject r1");
    const sibling = articleFor(stream, "Subject r2");
    expect(hydrated.textContent).toContain("FULL BODY of r1");
    expect(within(hydrated).getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(sibling.textContent).toContain("one line of r2");
    expect(sibling.textContent).not.toContain("FULL BODY");
    expect(within(sibling).getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
    expect(asked).toEqual(["r1"]);
  });

  it("expanding a snippet card fetches its body, and the card then holds the mail", async () => {
    measurePreviews();
    const { asked, el } = await mount("#/reads/m/r1", inNews);
    await tick(4_000);
    const stream = within(el).getByRole("region", { name: "News stream" });
    expect(asked).toEqual(["r1"]);
    const sibling = articleFor(stream, "Subject r2");
    expect(sibling.textContent).toContain("one line of r2");
    await act(async () => { fireEvent.click(within(sibling).getByRole("button", { name: "Expand" })); });
    await tick(1000);
    expect(asked).toEqual(["r1", "r2"]);
    expect(articleFor(stream, "Subject r2").textContent).toContain("FULL BODY of r2");
  });
});

describe("StreamCard — the clamp tells the truth about what it is clamping", () => {
  it("a LONG full body clamps and offers the pill: the shape the prototype drew", async () => {
    const resized = measurePreviews();
    const prefetched = keepOnlyFirstNear();
    const { el } = await mount("#/reads", inNews);
    await act(async () => { prefetched(); });
    await tick(1000);
    const stream = within(el).getByRole("region", { name: "News stream" });
    const card = articleFor(stream, "Subject r1");
    await act(async () => { resized(); });
    expect(card.textContent).toContain("FULL BODY of r1");
    expect(within(card).queryByRole("status")).toBeNull();
    const expand = within(card).getByRole("button", { name: "Expand" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { fireEvent.click(expand); });
    expect(within(articleFor(stream, "Subject r1")).getByRole("button", { name: "Collapse" })
      .getAttribute("aria-expanded")).toBe("true");
  });

  it("A SNIPPET IS SHORT AND STILL OPENABLE — the defect, closed", async () => {
    measurePreviews();
    const { asked, el } = await mount("#/reads", inNews);
    const stream = within(el).getByRole("region", { name: "News stream" });
    const card = articleFor(stream, "Subject r1");
    expect(card.textContent).toContain("one line of r1");
    expect(asked).toEqual([]);
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Expand" })); });
    await tick(1000);
    expect(asked).toEqual(["r1"]);
    expect(within(articleFor(stream, "Subject r1")).getByRole("button", { name: "Collapse" })
      .getAttribute("aria-expanded")).toBe("true");
  });

  it("an OPEN card re-pins to its new height when the body arrives", async () => {
    measurePreviews();
    let release!: (value: MessageBodyWire) => void;
    const body = new Promise<MessageBodyWire>((resolve) => { release = resolve; });
    const { asked, el } = await mount("#/reads", inNews, () => body);
    const stream = within(el).getByRole("region", { name: "News stream" });
    const card = () => articleFor(stream, "Subject r1");
    await act(async () => { fireEvent.click(within(card()).getByRole("button", { name: "Expand" })); });
    await tick(400);
    expect(asked).toEqual(["r1"]);
    const box = () => card().querySelector<HTMLElement>(".oh-message-clip")!;
    expect(box().hasAttribute("data-shut")).toBe(false);
    expect(box().style.maxHeight).toBe("");
    expect(box().textContent).toContain("one line of r1");
    await act(async () => { release(full("r1")); });
    await tick(400);
    expect(box().hasAttribute("data-shut")).toBe(false);
    expect(box().style.maxHeight).toBe("");
    expect(box().textContent).toContain(full("r1").text);
  });

  it("the state line is a SIBLING of the body, never inside it", async () => {
    const { el } = await mount("#/reads", inNews, () => new Promise(() => {}));
    const stream = within(el).getByRole("region", { name: "News stream" });
    const card = () => articleFor(stream, "Subject r1");
    await act(async () => { fireEvent.click(within(card()).getByRole("button", { name: "Expand" })); });
    await tick(400);
    const loading = within(card()).getByRole("status");
    expect(loading.textContent).toContain("Loading the full message");
    const snippet = within(card()).getByText("one line of r1");
    expect(snippet.contains(loading)).toBe(false);
    expect(snippet.textContent).not.toContain("Loading the full message");
  });

});

describe("Screener — every held message, in full, for the sender being decided about", () => {
  it("renders held.length articles, each with the HYDRATED body", async () => {
    const { asked, el } = await openHeld();
    const preview = within(el).getAllByRole("article");
    expect(preview).toHaveLength(2);
    expect(preview.map((article) => article.textContent)).toEqual([
      expect.stringContaining("FULL BODY of s1"),
      expect.stringContaining("FULL BODY of s2"),
    ]);
    expect([...asked].sort()).toEqual(["s1", "s2"]);
    for (const article of preview) expect(within(article).queryByRole("status")).toBeNull();
  });

  it("READING HELD MAIL IS SIDE-EFFECT-FREE — nothing is marked seen, nothing moves", async () => {
    const { asked, el, engine, sent } = await openHeld();
    const preview = within(el).getAllByRole("article");
    expect(preview).toHaveLength(2);
    expect([...asked].sort()).toEqual(["s1", "s2"]);
    expect(preview.map((article) => article.textContent)).toEqual([
      expect.stringContaining("FULL BODY of s1"),
      expect.stringContaining("FULL BODY of s2"),
    ]);
    expect(sent).toEqual([]);
    for (const id of ["s1", "s2", "s3"]) {
      const m = engine.read().get<EngineMessage>("message", id)!;
      expect(m.unread, id).toBe(true);
      expect(m.folder, id).toBe("ohmail/Screener");
    }
  });

  it("a FAILED body says so in the preview — the one place a wrong decision is expensive", async () => {
    const { el } = await openHeld(async () => { throw new Error("HTTP 503"); });
    const preview = within(el).getAllByRole("article");
    expect(preview).toHaveLength(2);
    for (const article of preview) {
      const note = within(article).getByRole("status");
      expect(note.textContent).toContain("This letter could not be loaded");
      expect(within(note).getByRole("button", { name: "Retry" })).toBeTruthy();
    }
    expect(articleFor(el, "Subject s1").textContent).toContain("one line of s1");
  });

  it("a SENSITIVE held message is fetched and shows its body — no withholding at the gate", async () => {
    const sensitive = letter("p1", {
      from: { name: "Bank", address: "bank@example.test" },
      folder: "ohmail/Screener",
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
    });
    const { asked, el } = await openHeld(undefined, [sensitive]);
    const article = within(el).getByRole("article");
    expect(asked).toContain("p1");
    expect(article.textContent).not.toMatch(/protected/i);
    expect(article.textContent).toContain("FULL BODY of p1");
  });
});
