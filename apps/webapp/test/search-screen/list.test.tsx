/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  letter,
  page,
  search,
  settle,
  type ServerSearchWire,
  type StoreAnswer,
  type StoreFn,
  wideWindow,
} from "./search-world.js";

/**
 * SEARCH'S LIST, drawn alone over the real behaviour: one field named Search in no form, one list of results whose
 * every item is a button, one verdict for every way a pass ends, the empty answer's true sentences, the order, what
 * narrows, and the keys. Everything is read by role and name.
 */
const GLAZE = letter({ id: "glaze", subject: "Glaze order 2291", unread: true });
const KILN = letter({ id: "kiln", subject: "Kiln booking", from: "Ben Arnold", address: "ben@kiln.example" });
const ARCHIVED = letter({ id: "old-glaze", subject: "Glaze samples from March", folder: "Archive" });

const box = (name = "Search") => screen.getByRole("textbox", { name });
const type = async (q: string) => {
  await act(async () => {
    fireEvent.change(box(), { target: { value: q } });
  });
};
const results = () => screen.queryAllByRole("listitem").filter((li) => li.hasAttribute("data-hit"));
const press = async (key: string, on: Element = document.activeElement ?? document.body) => {
  await act(async () => {
    on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};
/** A line said whole by one element (a label the kit ends with its dot). */
const said = (words: string) =>
  screen.getByText((_, el) => el !== null && el.tagName === "P" && el.textContent?.trim() === words);
const pages = <A extends { opts: { parts?: string } }>(asked: A[]): A[] => asked.filter((a) => a.opts.parts === "page");
const failing: StoreAnswer = () => {
  throw new Error("network down");
};

beforeEach(() => {
  wideWindow();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("search's field", () => {
  it("is one textbox named Search, takes the keyboard, and stands in no form with no name", async () => {
    await search([GLAZE]);
    const field = box();
    expect(document.activeElement).toBe(field);
    expect((field as HTMLInputElement).form).toBeNull();
    expect(field.hasAttribute("name")).toBe(false);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("Enter asks the whole mailbox at once, without the typing wait", async () => {
    const world = await search([GLAZE], { store: page([GLAZE]) });
    await type("glaze");
    await press("Enter", box());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const asked = () => pages(world.asked).map((a) => a.q);
    expect(asked()).toEqual(["glaze"]);
    await settle(300);
    expect(asked(), "the typed question's wait was let go, not added").toEqual(["glaze"]);
  });

  it("its clear control empties the words and leaves the caret in the field", async () => {
    await search([GLAZE], { store: page([GLAZE]), query: "glaze" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(box()).toHaveProperty("value", "");
    expect(document.activeElement).toBe(box());
  });
});

describe("the one list", () => {
  it("lists every result as a button in one list, its matched word marked, the store's page in place of the device's", async () => {
    await search([GLAZE, KILN], { store: page([GLAZE, ARCHIVED]) });
    await type("glaze");
    await settle();
    const items = results();
    expect(items.map((li) => li.getAttribute("data-hit"))).toEqual(["glaze", "old-glaze"]);
    for (const li of items) expect(within(li).getByRole("button").textContent).toContain("Glaze");
    expect(items[0]!.querySelector("mark")?.textContent?.toLowerCase()).toBe("glaze");
    expect(items[0]!.getAttribute("aria-posinset")).toBe("1");
    expect(items[0]!.getAttribute("aria-setsize")).toBe("2");
  });

  it("a result pressed is opened; its address leads to everything from and to that person", async () => {
    const world = await search([KILN], { store: page([KILN]) });
    await type("kiln");
    await settle();
    const [kiln] = results();
    await act(async () => {
      fireEvent.click(within(kiln!).getByText("ben@kiln.example"));
    });
    expect(world.said.went).toEqual(["ben@kiln.example"]);
    expect(world.said.opened).toEqual([]);
    await act(async () => {
      fireEvent.click(within(kiln!).getByRole("button"));
    });
    expect(world.said.opened).toEqual(["kiln"]);
  });

  it("the arrows move the cursor down the results, and Enter opens the one under it", async () => {
    const world = await search([GLAZE], { store: page([GLAZE, ARCHIVED]) });
    await type("glaze");
    await settle();
    await press("ArrowDown", box());
    const current = () => results().find((li) => li.getAttribute("aria-current") === "true");
    expect(current()?.getAttribute("data-hit")).toBe("old-glaze");
    await press("Enter", box());
    expect(world.said.opened).toEqual(["old-glaze"]);
  });

  it("Escape clears the words first, then leaves Search", async () => {
    const world = await search([GLAZE], { store: page([GLAZE]) });
    await type("glaze");
    await settle();
    await press("Escape", box());
    expect(box()).toHaveProperty("value", "");
    expect(world.said.exits).toBe(0);
    await press("Escape", box());
    expect(world.said.exits).toBe(1);
  });
});

describe("the verdict", () => {
  it("the whole mailbox counted exactly: its count beside Results, and nothing more is said", async () => {
    await search([GLAZE], { store: page([GLAZE]) });
    await type("glaze");
    await settle();
    expect(screen.getByRole("heading", { name: /^Results/ }).textContent).toContain("1");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain("whole mailbox");
  });

  it("more than can be counted: at least so many, beside Results and in its line", async () => {
    await search([GLAZE], { store: page([GLAZE], { total: 2000, totalExact: false }) });
    await type("glaze");
    await settle();
    expect(screen.getByRole("heading", { name: /^Results/ }).textContent).toContain("2,000+");
    expect(document.body.textContent).toContain("At least 2,000 matched in your whole mailbox.");
  });

  it("a server that did not answer is said, and its retry asks again", async () => {
    const world = await search([GLAZE], { store: failing });
    await type("glaze");
    await settle();
    expect(screen.getByRole("status").textContent).toContain(
      "Your server did not answer — showing the recent mail this device holds.",
    );
    const asked = world.asked.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
    });
    await settle(50);
    expect(world.asked.length).toBe(asked + 1);
  });

  it("with no store on this host, the device's rows are the answer and that is said", async () => {
    await search([GLAZE], { store: "none" });
    await type("glaze");
    await settle();
    expect(results().map((li) => li.getAttribute("data-hit"))).toEqual(["glaze"]);
    expect(document.body.textContent).toContain("Search covers the sample mailbox.");
  });
});

describe("an empty answer", () => {
  it("says nothing matched, how deep a long letter is searched, and the Junk folder no pass reaches", async () => {
    await search([GLAZE], {
      store: page([]),
      side: { junk: { named: "Spam" }, junkReadable: true },
    });
    await type("pizza invoice");
    await settle();
    const text = document.body.textContent ?? "";
    expect(said("Nothing matched")).not.toBeNull();
    expect(text).toContain("A long message is searched in its first 65,536 characters.");
    expect(text).toContain("Search does not reach your mail server's Spam folder, because ohmail keeps no copy of it.");
    expect(text).toContain("Read it under Junk in the Screener.");
  });

  it("a store that could not run it says the device's mail is all there is: Nothing matched stands above", async () => {
    await search([GLAZE], { store: failing });
    await type("pizza invoice");
    await settle();
    expect(said("Nothing matched")).not.toBeNull();
    expect(document.body.textContent).toContain("Your server did not answer");
  });

  it("an address alone is offered everything from and to it", async () => {
    const world = await search([GLAZE], { store: page([]) });
    await type("nadja@erdton-atelier.example");
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Everything from and to them" }));
    });
    expect(world.said.went).toEqual(["nadja@erdton-atelier.example"]);
  });
});

describe("the order and what narrows", () => {
  it("the order opens its list, the taken one checked; a pick asks again in that order", async () => {
    const world = await search([GLAZE], { store: page([GLAZE]) });
    await type("glaze");
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sorted by Best match" }));
    });
    const menu = screen.getByRole("menu", { name: "Sort by" });
    const taken = within(menu)
      .getAllByRole("menuitemradio")
      .filter((it) => it.getAttribute("aria-checked") === "true");
    expect(taken.map((it) => it.textContent)).toEqual(["Best match"]);
    await act(async () => {
      fireEvent.click(within(menu).getByText("Newest first"));
    });
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.sort).toBe("date_desc");
  });

  it("From lists the senders the answer counted; a pick narrows, stands pressed, and a press takes it off", async () => {
    const facets = {
      folder: { INBOX: 2 },
      sender: [
        { address: "giulia@terra-cotta.example", count: 1 },
        { address: "ben@kiln.example", count: 1 },
      ],
      hasAttachments: { true: 0, false: 2 },
      unread: { true: 1, false: 1 },
    };
    const world = await search([GLAZE, KILN], { store: page([GLAZE, KILN], { facets }) });
    await type("order");
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "From" }));
    });
    const menu = screen.getByRole("menu", { name: "From" });
    await act(async () => {
      fireEvent.click(within(menu).getByText("ben@kiln.example"));
    });
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ sender: "ben@kiln.example" });
    const set = screen.getByRole("button", { name: "ben@kiln.example", pressed: true });
    await act(async () => {
      fireEvent.click(set);
    });
    expect(screen.getByRole("button", { name: "From" })).not.toBeNull();
  });
});

describe("the count with a filter pressed", () => {
  it("is the store's count for the narrowed question, never the rows walked so far", async () => {
    const facets = {
      folder: { INBOX: 2 },
      sender: [{ address: "ben@kiln.example", count: 300 }],
      hasAttachments: { true: 0, false: 2 },
      unread: { true: 1, false: 1 },
    };
    await search([GLAZE, KILN], {
      store: page([GLAZE, KILN], { facets, total: 300, totalExact: true, nextCursor: "c2" }),
    });
    await type("order");
    await settle();
    expect(screen.getByRole("heading", { name: /^Results/ }).textContent).toContain("300");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "From" }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("menu", { name: "From" })).getByText("ben@kiln.example"));
    });
    await settle();
    expect(screen.getByRole("heading", { name: /^Results/ }).textContent).toContain("300");
  });
});

describe("the rows still owed", () => {
  it("hold their places out of reach: a page asked again stands as rows no one can press", async () => {
    const many = Array.from({ length: 300 }, (_, i) => letter({ id: `m${i}`, subject: `Order ${i}` }));
    let top = 0;
    /* Pages of fifty by the cursor; the first page, once left far behind and asked again, does not come back. */
    const store: StoreFn = (_q, opts) => {
      const at = opts.cursor ? Number(opts.cursor) : 0;
      if (at === 0 && opts.parts === "page" && ++top > 1) return new Promise<ServerSearchWire>(() => undefined);
      const next = at + 50 < many.length ? String(at + 50) : null;
      const wire = { items: many.slice(at, at + 50), total: 300, totalExact: true, ms: 4, tier: "exact", nextCursor: next };
      return wire as unknown as ServerSearchWire;
    };
    await search([], { store });
    await type("order");
    await settle();
    const scroller = screen.getByRole("list").closest('[tabindex="-1"]') as HTMLElement;
    const scrollTo = async (px: number) => {
      scroller.scrollTop = px;
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
        await new Promise((r) => setTimeout(r, 40));
      });
    };
    for (let i = 0; i < 12; i++) await scrollTo(100_000);
    await scrollTo(0);
    await settle(100);
    /* The top's rows are owed again: no result stands first. */
    expect(results().some((li) => li.getAttribute("aria-posinset") === "1")).toBe(false);
    expect(within(screen.getByRole("list")).queryAllByRole("button")).toHaveLength(results().length);
  });
});

describe("in German", () => {
  it("says every sentence of a matched answer and an empty one in German", async () => {
    await search([GLAZE], { store: (q, opts) => page(q.includes("glaze") ? [GLAZE] : [])(q, opts), lang: "de" });
    expect(box("Suche")).toHaveProperty("placeholder", "Alles durchsuchen");
    await act(async () => {
      fireEvent.change(box("Suche"), { target: { value: "glaze" } });
    });
    await settle();
    expect(screen.getByRole("heading", { name: /^Treffer/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: "Sortiert nach Beste Treffer" })).not.toBeNull();
    await act(async () => {
      fireEvent.change(box("Suche"), { target: { value: "pizza invoice" } });
    });
    await settle();
    expect(said("Nichts gefunden")).not.toBeNull();
  });
});
