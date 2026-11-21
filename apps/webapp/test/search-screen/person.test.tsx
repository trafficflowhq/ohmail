/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressBookEntry } from "@ohmail/client-engine";
import { DESKTOP, letter, page, search, settle, type Asked, type StoreFn, wideWindow } from "./search-world.js";

/**
 * A PERSON FIRST, THEN THE FILTERS, where the host's server takes them: a person typed or picked stands in the field
 * as one control, their side is a switch, unread and the days narrow, and each goes to the store as its own filter,
 * a person alone with no words too. A host whose server never said it takes them offers none of it and sends none.
 */
const BEN = letter({ id: "ben-kiln", subject: "Kiln booking", from: "Ben Arnold", address: "ben@lichtgrat.example" });
const NADJA = letter({
  id: "nadja-tiles",
  subject: "Glaze tests",
  from: "Nadja Lehner",
  address: "nadja@erdton-atelier.example",
  unread: true,
});
const BOOK = [
  { address: "ben@lichtgrat.example", name: "Ben Arnold", count: 4 },
  { address: "nadja@erdton-atelier.example", name: "Nadja Lehner", count: 9 },
] as unknown as AddressBookEntry[];
const people = { people: () => BOOK };

const box = () => screen.getByRole("textbox", { name: "Search" });
const type = async (q: string) => {
  await act(async () => {
    fireEvent.change(box(), { target: { value: q } });
  });
};
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const pages = (asked: Asked[]) => asked.filter((a) => a.opts.parts === "page");
const results = () => screen.queryAllByRole("listitem").filter((li) => li.hasAttribute("data-hit"));
/** A store that never answers: the device's paint is what stands. */
const never: StoreFn = () => new Promise(() => undefined);

beforeEach(() => {
  wideWindow();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("a person first", () => {
  it("from: typed and finished takes the person into the field, and the store is asked for their mail with no words", async () => {
    const world = await search([BEN, NADJA], { store: page([BEN]), side: people, searchBy: "people" });
    await type("from:ben ");
    await settle();
    expect(screen.getByRole("button", { name: "Remove Ben Arnold" })).not.toBeNull();
    expect(box()).toHaveProperty("value", "");
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "", opts: { filters: { sender: "ben@lichtgrat.example" } } });
    expect(results().map((li) => li.getAttribute("data-hit"))).toEqual(["ben-kiln"]);
  });

  it("a person alone paints their letters on this device before the store answers", async () => {
    await search([BEN, NADJA], { store: never, side: people, searchBy: "people" });
    await type("from:nadja ");
    await settle(200);
    expect(results().map((li) => li.getAttribute("data-hit"))).toEqual(["nadja-tiles"]);
  });

  it("the text that means a person lists them over the messages; a press takes them and the words leave", async () => {
    const world = await search([BEN, NADJA], { store: page([]), side: people, searchBy: "people" });
    await type("ben");
    const meant = screen.getByRole("heading", { name: /^People/ });
    expect(meant).not.toBeNull();
    /* The people stand over the messages: the first row named so is the person's. */
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Ben Arnold/ })[0]!);
    });
    await settle();
    expect(screen.getByRole("button", { name: "Remove Ben Arnold" })).not.toBeNull();
    expect(box()).toHaveProperty("value", "");
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ party: "ben@lichtgrat.example" });
  });

  it("their side is a switch: To asks for mail to them, Both for either side", async () => {
    const world = await search([BEN], { store: page([BEN]), side: people, searchBy: "people" });
    await type("from:ben ");
    await type("kiln");
    await settle();
    expect(box()).toHaveProperty("value", "kiln");
    const side = screen.getByRole("group", { name: "Direction" });
    await act(async () => {
      fireEvent.click(within(side).getByRole("button", { name: "To" }));
    });
    await settle(100);
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "kiln", opts: { filters: { to: "ben@lichtgrat.example" } } });
    await act(async () => {
      fireEvent.click(within(side).getByRole("button", { name: "Both" }));
    });
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ party: "ben@lichtgrat.example" });
  });

  it("an operator still being typed is not asked: the words before it are, and Enter takes the first person it names", async () => {
    const book = [{ address: "ben@other.example", name: "Ben Arnold", count: 4 }] as unknown as AddressBookEntry[];
    const world = await search([BEN], { store: page([BEN]), side: { people: () => book }, searchBy: "people" });
    await type("kiln");
    await settle();
    await type("kiln from:be");
    await settle();
    expect(pages(world.asked).map((a) => a.q)).toEqual(["kiln"]);
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await settle();
    expect(screen.getByRole("button", { name: "Remove Ben Arnold" })).not.toBeNull();
    expect((box() as HTMLInputElement).value.trim()).toBe("kiln");
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "kiln", opts: { filters: { sender: "ben@other.example" } } });
  });

  it("from: over two people of one name takes neither: it stays open, both are listed with their addresses, and the one picked is named by address", async () => {
    const book = [
      { address: "ben@lichtgrat.example", name: "Ben Arnold", count: 9 },
      { address: "ben@other.example", name: "Ben Arnold", count: 4 },
    ] as unknown as AddressBookEntry[];
    const world = await search([BEN], { store: page([BEN]), side: { people: () => book }, searchBy: "people" });
    await type("from:ben ");
    await settle();
    expect(pages(world.asked).map((a) => a.opts.filters)).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(box()).toHaveProperty("value", "from:ben");
    expect(screen.getByRole("button", { name: /ben@lichtgrat\.example/ })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ben@other\.example/ }));
    });
    await settle();
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ sender: "ben@other.example" });
    expect(screen.getByRole("button", { name: "Remove ben@other.example" })).not.toBeNull();
  });

  it("from: with a whole address in the book takes that one person, a namesake beside them", async () => {
    const book = [
      { address: "ben@lichtgrat.example", name: "Ben Arnold", count: 9 },
      { address: "ben@other.example", name: "Ben Arnold", count: 4 },
    ] as unknown as AddressBookEntry[];
    const world = await search([BEN], { store: page([BEN]), side: { people: () => book }, searchBy: "people" });
    await type("from:ben@other.example ");
    await settle();
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ sender: "ben@other.example" });
  });

  it("with no words, the order asked is best match or newest whatever order was kept, and only those two are offered", async () => {
    window.localStorage.setItem("ohmail.ui.search.sort.acct-1", "date_asc");
    /* As the service does: a search with no words in any other order is refused. */
    const refusing: StoreFn = (q, opts) => {
      if (q === "" && opts.sort !== "relevance" && opts.sort !== "date_desc") throw new Error("400");
      return page([BEN])(q, opts);
    };
    const world = await search([BEN, NADJA], { store: refusing, side: people, searchBy: "people" });
    await type("from:ben ");
    await settle();
    expect(["relevance", "date_desc"]).toContain(pages(world.asked).at(-1)?.opts.sort);
    expect(screen.getAllByRole("status").map((line) => line.textContent)).toEqual([
      expect.stringMatching(/^Searched your whole mailbox — 1 matched · [1-9]\d* ms$/),
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Sorted by/ }));
    });
    const orders = within(screen.getByRole("menu", { name: "Sort by" })).getAllByRole("menuitemradio");
    expect(orders.map((it) => [it.textContent, it.getAttribute("aria-checked")])).toEqual([
      ["Best match", "true"],
      ["Newest first", "false"],
    ]);
    expect(window.localStorage.getItem("ohmail.ui.search.sort.acct-1")).toBe("date_asc");
  });

  it("only the operator a space has just finished acts: one met inside pasted words stays words", async () => {
    const world = await search([BEN, NADJA], { store: page([BEN]), side: people, searchBy: "people" });
    await type("is:unread kiln from:ben ");
    await settle();
    expect(screen.getByRole("button", { name: "Remove Ben Arnold" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Unread", pressed: false })).not.toBeNull();
    expect(box()).toHaveProperty("value", "is:unread kiln ");
    expect(pages(world.asked).at(-1)).toMatchObject({
      q: "is:unread kiln",
      opts: { filters: { sender: "ben@lichtgrat.example" } },
    });
  });

  it("a person on the To side paints the letters to them from this device before the store answers", async () => {
    const TO_BEN = {
      ...letter({ id: "to-ben", subject: "Kiln dates", from: "Nadja Lehner", address: "nadja@erdton-atelier.example" }),
      to: [{ name: "Ben Arnold", address: "ben@lichtgrat.example" }],
    } as typeof BEN;
    await search([BEN, TO_BEN], { store: never, side: people, searchBy: "people" });
    await type("to:ben ");
    await settle(200);
    expect(results().map((li) => li.getAttribute("data-hit"))).toEqual(["to-ben"]);
  });

  it("a held Enter asks once", async () => {
    const world = await search([BEN], { store: page([BEN]), side: people, searchBy: "people" });
    await type("kiln");
    for (const repeat of [false, true, true]) {
      await act(async () => {
        fireEvent.keyDown(box(), { key: "Enter", repeat });
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    await settle(300);
    expect(pages(world.asked).map((a) => a.q)).toEqual(["kiln"]);
  });

  it("Backspace in the empty field lets the person go", async () => {
    await search([BEN], { store: page([BEN]), side: people, searchBy: "people" });
    await type("from:ben ");
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Backspace" });
    });
    expect(screen.queryByRole("button", { name: "Remove Ben Arnold" })).toBeNull();
  });
});

describe("the filters beside the words", () => {
  it("Unread is a switch that narrows the question, and is:unread typed sets it", async () => {
    const world = await search([BEN, NADJA], { store: page([NADJA]), side: people, searchBy: "people" });
    await type("glaze is:unread ");
    await settle();
    expect(box()).toHaveProperty("value", "glaze ");
    expect(screen.getByRole("button", { name: "Unread", pressed: true })).not.toBeNull();
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "glaze", opts: { filters: { unread: true } } });
    await press("Unread");
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.filters).toBeUndefined();
  });

  it("the place and the files are two parts: glaze in:archive has:files asks for files in that folder, and both stand", async () => {
    const OLD = letter({ id: "old-glaze", subject: "Glaze samples", folder: "Archive", file: true });
    const facets = {
      folder: { INBOX: 1, Archive: 1 },
      sender: [{ address: "giulia@terra-cotta.example", count: 2 }],
      hasAttachments: { true: 1, false: 1 },
      unread: { true: 0, false: 2 },
    };
    const world = await search([OLD], { store: page([OLD], { facets }), side: people, searchBy: "people" });
    await type("glaze");
    await settle();
    await type("glaze in:archive ");
    await settle(100);
    await type(`${(box() as HTMLInputElement).value}has:files `);
    await settle(100);
    expect(pages(world.asked).at(-1)).toMatchObject({
      q: "glaze",
      opts: { filters: { folder: "Archive", hasAttachments: true } },
    });
    expect(screen.getByRole("button", { name: /archive/i, pressed: true })).not.toBeNull();
    expect(screen.getByRole("button", { name: /attachment/i, pressed: true })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /attachment/i, pressed: true }));
    });
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.filters).toEqual({ folder: "Archive" });
  });

  it("keeps a typed folder's leaf on the device and asks the store for the selected path", async () => {
    const first = letter({ id: "first-sample", subject: "Glaze sample", folder: "Winter/Samples" });
    const second = letter({ id: "second-sample", subject: "Glaze sample", folder: "Summer/Samples" });
    const outside = letter({ id: "outside", subject: "Glaze sample" });
    const facets = {
      folder: { "Winter/Samples": 1, "Summer/Samples": 1, INBOX: 1 },
      sender: [],
      hasAttachments: { true: 0, false: 3 },
      unread: { true: 0, false: 3 },
    };
    let answer!: (value: Awaited<ReturnType<StoreFn>>) => void;
    const narrowed = new Promise<Awaited<ReturnType<StoreFn>>>((resolve) => { answer = resolve; });
    const world = await search([first, second, outside], {
      searchBy: "people",
      store: (q, opts) => opts.filters?.folder
        ? narrowed
        : page([first, second, outside], { facets })(q, opts),
    });
    await type("glaze");
    await settle();
    await press("Place");
    const choices = within(screen.getByRole("menu", { name: "Place" })).getAllByRole("menuitem", { name: /Samples/ });
    await act(async () => { fireEvent.click(choices[0]!); });
    await settle(200);
    expect(results().map((li) => li.getAttribute("data-hit")).sort()).toEqual([first.id, second.id].sort());
    expect(choices.map((choice) => choice.textContent)).toEqual(["Winter/Samples1", "Summer/Samples1"]);
    const asked = pages(world.asked).at(-1)!;
    expect(asked.opts.filters).toEqual({ folder: first.folder });
    await act(async () => { answer(await page([first])(asked.q, asked.opts)); });
    expect(results().map((li) => li.getAttribute("data-hit"))).toEqual([first.id]);
  });

  it("a date window asks for the days it spans, and a press takes it off", async () => {
    const world = await search([BEN], { store: page([BEN]), side: people, searchBy: "people" });
    await type("kiln");
    await settle();
    await press("Date");
    await act(async () => {
      fireEvent.click(within(screen.getByRole("menu", { name: "Date" })).getByText("This week"));
    });
    await settle(100);
    const filters = pages(world.asked).at(-1)?.opts.filters as { dateFrom: string; dateTo: string };
    const span = new Date(filters.dateTo).getTime() - new Date(filters.dateFrom).getTime();
    expect(Math.round(span / 86_400_000)).toBe(7);
    await press("This week");
    await settle(100);
    expect(pages(world.asked).at(-1)?.opts.filters).toBeUndefined();
  });
});

describe("a host whose server takes words only", () => {
  it("offers no person, unread or days, says from: is searched as words, and sends no new filter", async () => {
    const world = await search([BEN], { store: page([BEN]), side: people, searchBy: "words" });
    await type("from:ben ");
    await settle();
    expect(screen.queryByRole("button", { name: "Unread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Ben Arnold" })).toBeNull();
    expect(document.body.textContent).toContain("from: and in: are not filters here.");
    expect(pages(world.asked).map((a) => a.opts.filters)).toEqual([undefined]);
    expect(pages(world.asked).map((a) => a.q)).toEqual(["from:ben"]);
  });
});

describe.each(["desktop", "phone"] as const)("resting Search on %s", (device) => {
  const plan = device === "phone"
    ? { ...DESKTOP, device, size: "compact", pointer: "coarse", columns: 1 } as const
    : DESKTOP;

  it("exposes Place and Has attachment before asking, and either can start a search", async () => {
    const filed = letter({ id: "filed", subject: "Fired samples", folder: "Archive", file: true });
    const world = await search([BEN, filed], { plan, searchBy: "people", store: page([filed]) });
    const group = within(screen.getByRole("group", { name: "Refine" }));
    expect(group.getAllByRole("button").map((button) => button.textContent?.trim()))
      .toEqual(["Place", "Has attachment", "Unread", "Date"]);
    expect(world.asked).toEqual([]);
    await press("Place");
    await act(async () => {
      fireEvent.click(within(screen.getByRole("menu", { name: "Place" })).getByRole("menuitem", { name: "Archive" }));
    });
    await settle();
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "", opts: { filters: { folder: "Archive" } } });
    await press("Has attachment");
    await settle();
    expect(pages(world.asked).at(-1)).toMatchObject({
      q: "", opts: { filters: { folder: "Archive", hasAttachments: true } },
    });
    await press("Archive");
    await settle();
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "", opts: { filters: { hasAttachments: true } } });
    expect(screen.getByRole("button", { name: "Has attachment", pressed: true })).not.toBeNull();
  });

  it("shows the first five people, expands with All, and replaces the resting view when selected", async () => {
    const others = Array.from({ length: 4 }, (_, i) => ({
      name: `Contact ${i + 1}`, address: `contact${i + 1}@example.invalid`, count: i + 1, lastAt: 0,
      evidence: "they_wrote" as const,
    }));
    const reply = { ...BEN, id: "reply", to: [{ name: "Nadja Lehner", address: NADJA.from.address }] };
    const contacts = others.map((p, i) => letter({
      id: `contact-${i}`, subject: "Samples", from: p.name, address: p.address,
    }));
    const world = await search([NADJA, reply, ...contacts], {
      plan, searchBy: "people", store: page([NADJA]), side: { people: () => [...BOOK, ...others] },
    });
    const list = within(screen.getByRole("list", { name: "People" }));
    expect(list.getAllByRole("button")).toHaveLength(5);
    const first = list.getAllByRole("button")[0];
    expect(first?.textContent).toContain("Nadja Lehner");
    expect(first?.textContent).toContain("1 from · 1 to");
    await press("All");
    expect(list.getAllByRole("button")).toHaveLength(6);
    await press("Fewer");
    expect(list.getAllByRole("button")).toHaveLength(5);
    await press(/^Nadja Lehner/);
    await settle();
    expect(pages(world.asked).at(-1)).toMatchObject({ q: "", opts: { filters: { party: NADJA.from.address } } });
    expect(screen.queryByRole("heading", { name: /^People/ })).toBeNull();
  });

  it("prints the supplied mailbox total at rest and removes it while a filter is answering", async () => {
    const total = 4567;
    const caption = `${total.toLocaleString("en")} messages`;
    const world = await search([BEN], {
      plan, searchBy: "people", store: page([]), readMailboxTotal: async () => total, side: people,
    });
    expect(screen.getByText(caption)).not.toBeNull();
    expect(world.asked).toEqual([]);
    await press("Unread");
    expect(screen.queryByText(caption)).toBeNull();
    expect(screen.queryByRole("heading", { name: /^People/ })).toBeNull();
  });
});

it("keeps the refine controls while a query waits and after both kinds of answer", async () => {
  const archived = letter({ id: "archived", subject: "Glaze dates", folder: "Archive" });
  const facets = {
    folder: {}, sender: [], hasAttachments: { true: 0, false: 0 }, unread: { true: 0, false: 0 },
  };
  const world = await search([archived], {
    searchBy: "people",
    store: (q, opts) => page(q === "glaze" ? [archived] : [], { facets, ms: 19 })(q, opts),
  });
  const refine = () => within(screen.getByRole("group", { name: "Refine" }));
  const checkControls = () => expect(refine().getAllByRole("button").map((button) => button.textContent))
    .toEqual(["Place", "Has attachment", "Unread", "Date"]);

  await type("nothing");
  expect(world.asked).toEqual([]);
  checkControls();
  expect(screen.queryByRole("button", { name: /^Sorted by/ })).toBeNull();
  await settle();
  checkControls();
  expect(screen.queryByRole("button", { name: /^Sorted by/ })).toBeNull();
  await press("Place");
  expect(within(screen.getByRole("menu", { name: "Place" })).getByRole("menuitem", { name: "Archive" })).toBeTruthy();
  await press("Place");

  await type("glaze");
  await settle();
  checkControls();
  const heading = screen.getByRole("heading", { name: /^Results/ });
  await act(async () => {
    fireEvent.click(within(heading.parentElement!).getByRole("button", { name: /^Sorted by/ }));
  });
  await act(async () => {
    fireEvent.click(within(screen.getByRole("menu", { name: "Sort by" })).getByRole("menuitemradio", { name: "Newest first" }));
  });
  await settle(100);
  expect(pages(world.asked).at(-1)?.opts.sort).toBe("date_desc");
});

it("prints the measured time after an attachment-only search", async () => {
  const filed = letter({ id: "filed-sample", subject: "Glaze dates", file: true });
  await search([filed], { searchBy: "people", store: page([filed]) });
  const field = within(box().parentElement!);
  expect(field.queryByText(/^\d+ ms$/)).toBeNull();
  await press("Has attachment");
  await settle();
  expect(field.getByText(/^[1-9]\d* ms$/)).toBeTruthy();
});
