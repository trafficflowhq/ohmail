/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerJunk, ScreenerJunkItem } from "../../src/screener/index.js";
import { BESIDE, modelOf, mountPlace, sender, WORDS, type Asked } from "./screener-world.js";

import { QuarantineMove } from "../../src/screener/list/QuarantineMove.js";
import { TextProvider } from "../../src/text/index.js";

/**
 * JUNK, the third section where the shell hands its window over the mail server's own Junk folder: who filed each
 * letter, its text asked once when it opens, Not junk and Not junk, always allow as presses of the open letter, a
 * standing or refused move said where the presses were, a read that failed never called empty, Search Junk and
 * Show older on a press only. Nothing here moves a letter but those presses.
 */

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

const item = (uid: number, name: string, over: Partial<ScreenerJunkItem> = {}): ScreenerJunkItem => ({
  mailboxId: "mb-1",
  uidValidity: "7",
  uid,
  subject: `Offer ${uid} from ${name}`,
  from: { name, address: `${name.toLowerCase()}@junk.example` },
  date: "2026-11-10T09:00:00Z",
  messageIdHeader: null,
  seen: false,
  origin: "provider",
  ...over,
});

interface JunkAsked {
  bodies: string[];
  rescued: [number, boolean][];
  dismissed: number[];
  reloads: number;
  older: number;
  queries: string[];
  server: number;
}

function junkOf(over: Partial<ScreenerJunk> = {}, search: Partial<ScreenerJunk["search"]> = {}) {
  const got: JunkAsked = {
    bodies: [],
    rescued: [],
    dismissed: [],
    reloads: 0,
    older: 0,
    queries: [],
    server: 0,
  };
  const items = over.items ?? [item(1, "Konto", { origin: "verdict" }), item(2, "Deals")];
  const junk: ScreenerJunk = {
    supported: true,
    phase: "ready",
    items,
    visible: items,
    mailboxes: [{ id: "mb-1", address: "me@home.example", window: "ok" }],
    nextCursor: null,
    olderLoading: false,
    reload: () => void (got.reloads += 1),
    loadOlder: () => void (got.older += 1),
    bodyFor: (i) => ({ phase: "ready", text: `The text of ${i.uid}` }),
    openBody: (i, opts) => void got.bodies.push(`${i.uid}${opts?.retry ? " retry" : ""}`),
    rescue: (i, opts) => void got.rescued.push([i.uid, opts?.allow === true]),
    rescuing: (i) => got.rescued.some(([uid]) => uid === i.uid),
    dismissRescue: (i) => void got.dismissed.push(i.uid),
    search: {
      query: "",
      setQuery: (q) => void got.queries.push(q),
      phase: "idle",
      hits: [],
      localCount: 0,
      mailboxes: [],
      truncated: false,
      searchServer: () => void (got.server += 1),
      ...search,
    },
    ...over,
  };
  return { junk, got };
}

const SPAM = [sender("spammy", "Spammy Sender", { segment: "spam" })];
const reading = () => screen.getByRole("region", { name: "Reading" });
const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
const mountJunk = (junk: ScreenerJunk, opts: { room?: "desktop" | "phone"; lang?: "en" | "de" } = {}) =>
  mountPlace(modelOf(asked, { spam: SPAM as never }), {
    at: "#/screener/spam",
    beside: { ...BESIDE, junk },
    ...opts,
  });

describe("the third section with the mail server's Junk handed", () => {
  it("shows the complete Junk count and filing origins without the Spam senders", () => {
    const { junk } = junkOf();
    mountJunk(junk);
    expect(screen.getByRole("button", { name: "Spam 2" }).getAttribute("aria-pressed")).toBe("true");
    const rows = screen.getByRole("listbox", { name: "Junk" });
    expect(within(rows).getAllByRole("option")).toHaveLength(2);
    expect(rows.textContent).toContain("Your verdict");
    expect(rows.textContent).toContain("Mail server");
    expect(screen.queryByText("Spammy Sender")).toBeNull();
  });

  it("shows the first page of Junk without presenting its size as the total", () => {
    const { junk } = junkOf({ nextCursor: "c-1" });
    mountJunk(junk);
    expect(screen.getByRole("button", { name: "Spam", exact: true }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const rows = screen.getByRole("listbox", { name: "Junk" });
    expect(within(rows).getAllByRole("option")).toHaveLength(2);
  });

  it("with no window handed, the third section is Spam with its senders", () => {
    mountPlace(modelOf(asked, { spam: SPAM as never }), { at: "#/screener/spam" });
    expect(screen.getByRole("listbox", { name: "Screener" }).textContent).toContain("Spammy Sender");
    expect(screen.queryByRole("listbox", { name: "Junk" })).toBeNull();
  });

  it("the open letter's text is asked once when it opens, and walking on asks the next; nothing moves", () => {
    const { junk, got } = junkOf();
    const world = mountJunk(junk);
    expect(got.bodies).toEqual(["1"]);
    expect(reading().textContent).toContain("The text of 1");
    world.again(modelOf(asked, { spam: SPAM as never }));
    expect(got.bodies).toEqual(["1"]);
    press("j");
    expect(got.bodies).toEqual(["1", "2"]);
    expect(reading().textContent).toContain("Offer 2 from Deals");
    expect(got.rescued).toEqual([]);
    expect(got.dismissed).toEqual([]);
  });

  it("no key moves a letter out of Junk", () => {
    const { junk, got } = junkOf();
    mountJunk(junk);
    for (const key of ["o", "r", "c", "n", "x", "Enter", "a", "s"]) press(key);
    expect(got.rescued).toEqual([]);
    expect(asked.decided).toBeUndefined();
  });

  it("Not junk and Not junk, always allow are presses of the open letter, each once", () => {
    const { junk, got } = junkOf();
    const world = mountJunk(junk);
    const panel = () => within(reading()).getByRole("toolbar", { name: "Actions" });
    const junkSlot = within(reading()).getByRole("button", { name: "Junk actions" });
    fireEvent.click(junkSlot);
    const menu = within(screen.getByRole("menu", { name: "Junk actions" }));
    expect(menu.getByRole("menuitem", { name: "Not junk, always allow" })).toBeTruthy();
    expect(got.rescued).toEqual([]);
    fireEvent.click(menu.getByRole("menuitem", { name: "Not junk" }));
    expect(got.rescued).toEqual([[1, false]]);
    /* The shell draws again when its window's busy set changes: the letter being recorded takes no second verb. */
    world.again(modelOf(asked, { spam: SPAM as never }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Not junk, always allow" }));
    expect(got.rescued).toEqual([[1, false]]);
    press("j");
    fireEvent.click(within(panel()).getByRole("button", { name: "Not junk, always allow" }));
    expect(got.rescued).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("Not junk pressed again while the first is being recorded sends one command", () => {
    const rescued: number[] = [];
    const busy = new Set<number>();
    const items = [item(1, "Konto"), item(2, "Deals")];
    const junk: ScreenerJunk = {
      supported: true,
      phase: "ready",
      items,
      visible: items,
      mailboxes: [{ id: "mb-1", address: "me@home.example", window: "ok" }],
      nextCursor: null,
      olderLoading: false,
      reload: () => undefined,
      loadOlder: () => undefined,
      bodyFor: (i) => ({ phase: "ready", text: `The text of ${i.uid}` }),
      openBody: () => undefined,
      rescue: (i) => {
        rescued.push(i.uid);
        busy.add(i.uid);
      },
      rescuing: (i) => busy.has(i.uid),
      dismissRescue: () => undefined,
      search: {
        query: "",
        setQuery: () => undefined,
        phase: "idle",
        hits: [],
        localCount: 0,
        mailboxes: [],
        truncated: false,
        searchServer: () => undefined,
      },
    };
    const model = () => modelOf(asked, { spam: [sender("spammy", "Spammy", { segment: "spam" })] as never });
    const world = mountPlace(model(), { at: "#/screener/spam", beside: { ...BESIDE, junk } });
    const notJunk = () => within(reading()).getByRole("button", { name: "Not junk" });
    fireEvent.click(notJunk());
    /* The shell draws again when its window's busy set changes. */
    world.again(model());
    fireEvent.click(notJunk());
    expect(rescued).toEqual([1]);
  });

  it("at a phone's width, Leave it in Junk stands behind More and is pressed from there", () => {
    /* jsdom lays nothing out: the panel's bar is as wide as its shown verbs, 140 each, in a phone's 390. */
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") !== "toolbar") return 0;
      return [...this.querySelectorAll<HTMLElement>("[data-rank]")].filter((v) => !v.hidden).length * 140;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("oh-actionpanel") ? 390 : 0;
    });
    try {
      const refusedOne = item(2, "Deals", { rescue: "refused", rescueId: "r-2" });
      const { junk, got } = junkOf({ items: [refusedOne], visible: [refusedOne] });
      mountJunk(junk, { room: "phone" });
      fireEvent.click(within(screen.getByRole("listbox", { name: "Junk" })).getAllByRole("option")[0]!);
      const panel = screen.getByRole("toolbar", { name: "Actions" });
      expect(within(panel).queryByRole("button", { name: "Leave it in Junk" })).toBeNull();
      fireEvent.click(within(panel).getByRole("button", { name: "More" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Leave it in Junk" }));
      expect(got.dismissed).toEqual([2]);
      expect(got.rescued).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a move that stands is said where the presses were; a refused one can be left in Junk", () => {
    const queued = item(1, "Konto", { rescue: "queued" });
    const refusedOne = item(2, "Deals", { rescue: "refused", rescueId: "r-2" });
    const { junk, got } = junkOf({ items: [queued, refusedOne], visible: [queued, refusedOne] });
    mountJunk(junk);
    const panel = () => within(reading()).getByRole("toolbar", { name: "Actions" });
    expect(within(panel()).queryAllByRole("button")).toEqual([]);
    expect(panel().textContent).toContain("Will be moved to your inbox.");
    press("j");
    expect(reading().textContent).toContain("Your mail server wouldn't move this one.");
    fireEvent.click(within(panel()).getByRole("button", { name: "Leave it in Junk" }));
    expect(got.dismissed).toEqual([2]);
    expect(got.rescued).toEqual([]);
  });

  it("a text that could not be read offers Try again, which asks that letter again", () => {
    const { junk, got } = junkOf({ bodyFor: () => ({ phase: "failed" }) });
    mountJunk(junk);
    fireEvent.click(within(reading()).getByRole("button", { name: "Try again" }));
    expect(got.bodies).toEqual(["1", "1 retry"]);
  });
});

describe("what Junk says of its folder", () => {
  it("a read that failed says so and offers Try again, never that Junk is empty", () => {
    const { junk, got } = junkOf({ phase: "failed", items: [], visible: [] });
    mountJunk(junk);
    expect(screen.getByText(/Junk couldn't be read just now/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Junk is empty");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(got.reloads).toBe(1);
    expect(got.bodies).toEqual([]);
  });

  it("is empty only when every mailbox's folder was read; one not read is named", () => {
    const { junk } = junkOf({ items: [], visible: [] });
    const world = mountJunk(junk);
    expect(document.body.textContent).toContain("Junk is empty");
    world.view.unmount();
    const away = junkOf({
      items: [],
      visible: [],
      mailboxes: [
        { id: "mb-1", address: "me@home.example", window: "ok" },
        { id: "mb-2", address: "work@office.example", window: "unreachable" },
      ],
    });
    mountJunk(away.junk);
    expect(document.body.textContent).not.toContain("Junk is empty");
    expect(screen.getByText("work@office.example couldn't be read just now.")).toBeTruthy();
  });

  it("Show older pages back on a press only", () => {
    const { junk, got } = junkOf({ nextCursor: "c-1" });
    mountJunk(junk);
    expect(got.older).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(got.older).toBe(1);
  });
});

describe("Search Junk", () => {
  it("hands what is typed to the window and asks the server on a press only", () => {
    const { junk, got } = junkOf({}, { query: "zzz", phase: "local", localCount: 0 });
    mountJunk(junk);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search your Junk folder" }), {
      target: { value: "prize" },
    });
    expect(got.queries).toEqual(["prize"]);
    expect(got.server).toBe(0);
    expect(screen.getByText("Nothing loaded here matches “zzz”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Also search your mail server" }));
    expect(got.server).toBe(1);
  });

  it("the server's hits stand under their own name, after what was loaded", () => {
    const hit = item(9, "Prize");
    const kept = item(1, "Konto");
    const { junk } = junkOf(
      { visible: [kept, hit] },
      { query: "o", phase: "done", hits: [hit], localCount: 1 },
    );
    mountJunk(junk);
    const found = screen.getByRole("listbox", { name: "Found on your mail server" });
    expect(within(found).getAllByRole("option")).toHaveLength(1);
    expect(found.textContent).toContain("Prize");
  });

  it("a search that failed offers Search again", () => {
    const { junk, got } = junkOf({}, { query: "o", phase: "failed", localCount: 2 });
    mountJunk(junk);
    fireEvent.click(screen.getByRole("button", { name: "Search again" }));
    expect(got.server).toBe(1);
  });
});

describe("Junk on one column", () => {
  it("opens a letter over the list on a press, and asks its text only then", () => {
    const { junk, got } = junkOf();
    mountJunk(junk, { room: "phone" });
    expect(got.bodies).toEqual([]);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Junk" })).getAllByRole("option")[1]!);
    expect(got.bodies).toEqual(["2"]);
    expect(screen.getByRole("button", { name: "Not junk" })).toBeTruthy();
    press("Escape");
    expect(screen.getByRole("listbox", { name: "Junk" })).toBeTruthy();
  });

  it("speaks German", () => {
    const { junk } = junkOf();
    mountJunk(junk, { lang: "de" });
    expect(screen.getByRole("listbox", { name: "Spam-Ordner" }).textContent).toContain("Mailserver");
  });
});

it("closes the Quarantine confirmation when a fresh preview arrives for the same count", () => {
  const request = vi.fn();
  const view = (confirmation: string, confirmationRequired = false) => (
    <TextProvider locale="en" timeZone="UTC" messages={WORDS.en}>
      <QuarantineMove
        sweep={{
          phase: "offer",
          preview: { mailboxes: [], movable: 2, pending: false, confirmation, confirmationRequired },
          requesting: false,
          request,
          dismiss: () => {},
        }}
      />
    </TextProvider>
  );
  const { rerender } = render(view("old-preview"));
  fireEvent.click(screen.getByRole("button", { name: "Move to Junk" }));
  expect(screen.getByRole("dialog", { name: "Move to Junk" })).toBeTruthy();

  rerender(view("fresh-preview", true));
  expect(screen.queryByRole("dialog", { name: "Move to Junk" })).toBeNull();
  expect(request).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Move to Junk" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move 2 messages" }));
  expect(request.mock.calls).toEqual([["fresh-preview"]]);
});
