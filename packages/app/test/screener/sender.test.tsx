/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consentVia, type ConsentTransport } from "@ohmail/app-logic/consent";
import { NO_RUN } from "@ohmail/app-logic/screener";
import type { ScreenerBeside, ScreenerSuggestControl } from "../../src/screener/index.js";
import { BESIDE, modelOf, mountPlace, sender, type Asked } from "./screener-world.js";

/**
 * THE OPEN SENDER in the real frame, over a model double that records every call: the sentence with the place to
 * press and how wide a decision reaches, the lines said before the press, what the panel says for each kind of
 * install, More with the three verbs that also mark read, and the place where everyone was decided.
 */

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

const suggested = (dest: string, confidence: number, rationale = "") => ({
  ai: { dest, confidence, rationale },
});
const LENA = sender("lena", "Lena Hart", suggested("ohbox", 0.92, "A personal note"));
const MARCO = sender("marco", "Marco Pine");
const QUEUE = [LENA, MARCO];
const reading = () => screen.getByRole("region", { name: "Reading" });
const panel = () => within(reading()).getByRole("toolbar", { name: "Actions" });
const press = (key: string, shiftKey = false) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, shiftKey });
  });

describe("the sentence", () => {
  it("says where a real suggestion files the sender, as a word to press, how sure, and why", () => {
    mountPlace(
      modelOf(asked, { waiting: QUEUE, waitingCount: 2, senderConfirmed: (sender) => sender === LENA }),
    );
    const head = within(reading()).getByRole("heading", { name: /Lena Hart goes to/ });
    const slot = within(head).getByRole("button", { name: "Choose where this sender's mail goes" });
    expect(slot.textContent).toBe("Ohbox");
    expect(slot.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(slot);
    expect(slot.getAttribute("aria-expanded")).toBe("true");
    expect(within(reading()).getByTitle("Confidence").textContent).toBe("92%");
    expect(within(reading()).getByRole("img", { name: "Confirmed" })).toBeTruthy();
    expect(within(reading()).getByText("A personal note", { exact: true })).toBeTruthy();
    expect(asked.decided).toBeUndefined();
  });

  it("with no suggestion the place is nobody's choice yet, and the line says so", () => {
    mountPlace(modelOf(asked, { waiting: [MARCO], waitingCount: 1 }));
    const head = within(reading()).getByRole("heading", { name: /Marco Pine goes to/ });
    expect(within(head).getByRole("button").textContent).toBe("a place");
    expect(reading().textContent).not.toContain("No suggestion yet for this sender.");
    expect(within(reading()).queryByTitle("Confidence")).toBeNull();
    expect(within(reading()).queryByRole("img", { name: "Confirmed" })).toBeNull();
  });

  it("the reach is the person's: whole domain is chosen in its menu and the decision carries it", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }));
    fireEvent.click(within(reading()).getByRole("button", { name: "Decision scope" }));
    expect(screen.getByText("Rule for", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Whole domain/i }));
    expect(within(reading()).getByRole("button", { name: "Decision scope" }).textContent).toBe(
      "whole domain",
    );
    press("o");
    expect(asked.decided).toEqual([{ id: "lena", dest: "ohbox", read: false, scope: "domain" }]);
  });

  it("what Screen out and Spam also send is said before the press", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, unsubClaimOf: (() => "sends") as never }));
    expect(within(reading()).getByText("Unsubscribe offered", { exact: true })).toBeTruthy();
    expect(within(panel()).getByText("+ unsubscribe", { exact: true })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Spam" })).toBeTruthy();
    expect(reading().textContent).not.toContain("Screen out and Spam also send");
    expect(asked.decided).toBeUndefined();
  });
});

describe("the panel says who decides", () => {
  it("nobody organizes: no decision verb, the way to Mailboxes, and the reason whole", () => {
    const role = { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } as never;
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, role }));
    expect(panel().textContent).toContain("Nothing organizes this mailbox");
    expect(reading().textContent).not.toContain("No install is filing it");
    expect(
      within(reading()).queryByRole("button", { name: "Choose where this sender's mail goes" }),
    ).toBeNull();
    /* The key meets the model's own refusal, which says so; the sender stays open. */
    press("o");
    expect(asked.decided).toEqual([{ id: "lena", dest: "ohbox", read: false, scope: "sender" }]);
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Mailboxes" }));
    expect(world.address.read()).toBe("#/settings/mailboxes");
  });

  it("another install organizes: it names who decides", () => {
    const role = {
      mode: "blocked",
      name: "ohmail on a Mac",
      reason: "organizer_outdated",
      oauthOnly: false,
    } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, role }));
    expect(panel().textContent).toContain("ohmail on a Mac decides");
    expect(
      within(panel())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
  });

  it("an organizer that files what is decided here is named beside the verbs, with when it files", () => {
    const role = { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, role }));
    expect(panel().textContent).toContain("ohmail Cloud files what you decide");
    expect(reading().textContent).not.toContain("Your decision is sent to it");
    expect(within(panel()).getByRole("button", { name: /Ohbox/ })).toBeTruthy();
  });
});

describe("More", () => {
  it("holds the three verbs that also mark read; a press decides once, read", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }));
    fireEvent.click(within(panel()).getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.querySelector(".oh-menu-word")?.textContent);
    expect(items).toEqual(["Ohbox, mark read", "News, mark read", "Receipts, mark read"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /News, mark read/ }));
    expect(asked.decided).toEqual([{ id: "lena", dest: "reads", read: true, scope: "sender" }]);
  });
});

describe("everyone decided", () => {
  it("shows the mark and the way to the Ohbox in the reading column, and the list stands empty", () => {
    const world = mountPlace(modelOf(asked, { decidedThisSession: 1 }));
    const messages = screen.getByRole("region", { name: "Messages" });
    expect(within(messages).queryByRole("button", { name: "Ohbox" })).toBeNull();
    fireEvent.click(within(reading()).getByRole("button", { name: "Ohbox" }));
    expect(world.address.read()).toBe("#/ohbox");
  });

  it("on one column the mark stands in the list", () => {
    const world = mountPlace(modelOf(asked, { decidedThisSession: 1 }), { room: "phone" });
    const messages = screen.getByRole("region", { name: "Messages" });
    fireEvent.click(within(messages).getByRole("button", { name: "Ohbox" }));
    expect(world.address.read()).toBe("#/ohbox");
  });

  it("speaks German", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { lang: "de" });
    expect(screen.getByRole("heading", { name: /Lena Hart landet in/ })).toBeTruthy();
  });
});

describe("the place menu, the row's menu and the card", () => {
  it("the place word opens the five places, the suggestion checked with how sure; a press decides once", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }));
    fireEvent.click(within(reading()).getByRole("button", { name: "Choose where this sender's mail goes" }));
    const menu = screen.getByRole("menu", { name: "Choose where this sender's mail goes" });
    const ohbox = within(menu).getByRole("menuitemradio", { name: /Ohbox/ });
    expect(ohbox.getAttribute("aria-checked")).toBe("true");
    expect(ohbox.textContent).toContain("suggested 92%");
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /News/ }));
    expect(asked.decided).toEqual([{ id: "lena", dest: "reads", read: false, scope: "sender" }]);
  });

  it("a right click opens that sender with its menu; a press decides that sender", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }));
    const list = screen.getByRole("listbox", { name: "Screener" });
    fireEvent.contextMenu(within(list).getByRole("option", { name: /Marco Pine/ }), {
      clientX: 40,
      clientY: 80,
    });
    const menu = screen.getByRole("menu", { name: "Choose where this sender's mail goes" });
    expect(within(menu).getByRole("menuitem", { name: "Screening" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Spam/ }));
    expect(asked.decided).toEqual([{ id: "marco", dest: "spam", read: false, scope: "sender" }]);
  });

  it("s opens the card; taking a place there is the decision, with the reach the card shows", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }));
    press("s");
    const card = screen.getByRole("dialog", { name: "Change this sender's screening" });
    expect(asked.decided).toBeUndefined();
    fireEvent.click(within(card).getByRole("radio", { name: /Everyone at/ }));
    fireEvent.click(within(card).getByRole("radio", { name: "Receipts" }));
    expect(asked.decided).toEqual([{ id: "lena", dest: "receipts", read: false, scope: "domain" }]);
  });
});

describe("the unsubscribe question", () => {
  const sends = { unsubClaimOf: (() => "sends") as never };

  it("folded keep-out controls ask the same question as their keyboard shortcuts", () => {
    const widths = [
      vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
        return this.matches(".oh-actionpanel") ? 200 : 0;
      }),
      vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
        return this.matches(".oh-actionpanel-bar")
          ? 100 * this.querySelectorAll("[data-rank]:not([hidden])").length
          : 0;
      }),
    ];
    try {
      mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, ...sends }), { room: "phone" });
      const list = within(screen.getByRole("listbox", { name: "Screener" }));
      fireEvent.click(list.getByRole("option", { name: /Lena Hart/ }));
      const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
      expect(actions.queryByRole("button", { name: /^Screen out/ })).toBeNull();
      fireEvent.click(actions.getByRole("button", { name: "More" }));
      const menu = within(screen.getByRole("menu", { name: "More" }));
      expect(menu.getByText("Spam", { exact: true })).toBeTruthy();
      fireEvent.click(menu.getByRole("menuitem", { name: /^Screen out/ }));
      const ask = () => within(screen.getByRole("dialog", { name: "Screen out and unsubscribe" }));
      fireEvent.click(ask().getByRole("button", { name: "Cancel" }));
      expect(asked.decided).toBeUndefined();
      press("n");
      fireEvent.click(ask().getByRole("button", { name: "Screen out and unsubscribe" }));
      expect(asked.decided).toEqual([{ id: "lena", dest: "screened", read: false, scope: "sender" }]);
    } finally {
      for (const width of widths) width.mockRestore();
    }
  });

  it("asks before Screen out or Spam send one; Cancel sends nothing; the keys start on Cancel", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, ...sends }));
    press("n");
    const ask = screen.getByRole("dialog", { name: "Screen out and unsubscribe" });
    expect(ask.textContent).toContain("Once sent, it cannot be undone.");
    expect(asked.decided).toBeUndefined();
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(asked.decided).toBeUndefined();
    press("x");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Spam and unsubscribe" })).getByRole("button", {
        name: "Spam and unsubscribe",
      }),
    );
    expect(asked.decided).toEqual([{ id: "lena", dest: "spam", read: false, scope: "sender" }]);
  });

  it("explains each manual action on its first confirmation", () => {
    const mountAccount = (accountScope: string, waiting = QUEUE) =>
      mountPlace(modelOf(asked, { accountScope, waiting, waitingCount: waiting.length, ...sends }));
    const question = (key: "n" | "x", name: string) => {
      press(key);
      return within(screen.getByRole("dialog", { name }));
    };
    let account = mountAccount("account-one");
    const first = question("x", "Spam and unsubscribe");
    expect(first.getByText(/Later mail from them follows this rule/)).toBeTruthy();
    fireEvent.click(first.getByRole("button", { name: "Cancel" }));
    expect(asked.decided).toBeUndefined();
    const second = question("x", "Spam and unsubscribe");
    expect(second.getByText(/Later mail from them follows this rule/)).toBeTruthy();
    fireEvent.click(second.getByRole("button", { name: "Spam and unsubscribe" }));
    account.view.unmount();

    account = mountAccount("account-one", [MARCO]);
    const repeat = question("n", "Screen out and unsubscribe");
    expect(repeat.getByText(/Later mail from them follows this rule/)).toBeTruthy();
    expect(repeat.getByText("Once sent, it cannot be undone.")).toBeTruthy();
    fireEvent.click(repeat.getByRole("button", { name: "Screen out and unsubscribe" }));
    expect(asked.decided).toEqual([
      { id: "lena", dest: "spam", read: false, scope: "sender" },
      { id: "marco", dest: "screened", read: false, scope: "sender" },
    ]);
    account.view.unmount();

    mountAccount("account-two", [MARCO]);
    expect(
      question("n", "Screen out and unsubscribe").getByText(/Later mail from them follows this rule/),
    ).toBeTruthy();
  });

  it.each([
    { key: "x", dest: "spam", kind: "spamUnsubscribe", mask: 1, title: "Spam and unsubscribe" },
    {
      key: "n",
      dest: "screened",
      kind: "screenOutUnsubscribe",
      mask: 2,
      title: "Screen out and unsubscribe",
    },
  ])("asks once for $title across clients of the same account", async ({ key, dest, kind, mask, title }) => {
    const accounts = new Map<string, number>();
    const writes = vi.fn();
    const mountAccount = async (accountScope: string, waiting = QUEUE) => {
      const read = vi.fn();
      const consent: ConsentTransport = {
        ...consentVia(async (path, init) => {
          if (path === "/consent/settings") {
            const body = JSON.parse(String(init?.body));
            writes(body);
            expect(body).toEqual({ acknowledgeScreener: kind });
            accounts.set(accountScope, mask);
          } else {
            read();
          }
          return Response.json({
            seedConfirmedAt: null,
            dormancyDays: 60,
            screenerAcknowledgements: accounts.get(accountScope) ?? 0,
          });
        }),
        foldersStorable: false,
      };
      const world = mountPlace(
        modelOf(asked, { accountScope, waiting, waitingCount: waiting.length, ...sends }),
        { consent },
      );
      await waitFor(() => expect(read).toHaveBeenCalled());
      return world;
    };
    const question = () => {
      press(key);
      return within(screen.getByRole("dialog", { name: title }));
    };
    const first = await mountAccount("account-one");
    fireEvent.click(question().getByRole("button", { name: "Cancel" }));
    expect(asked.decided).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(question().getByRole("button", { name: title }));
    press(key);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(asked.decided?.map(({ id, dest }) => [id, dest])).toEqual([
      ["lena", dest],
      ["marco", dest],
    ]);
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    first.view.unmount();

    localStorage.clear();
    const second = await mountAccount("account-one", [MARCO]);
    press(key);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(asked.decided).toHaveLength(3);
    second.view.unmount();

    await mountAccount("account-two", [MARCO]);
    expect(question().getByText("Once sent, it cannot be undone.")).toBeTruthy();
    expect(asked.decided).toHaveLength(3);
  });

  it("reports a refusal when the organizer becomes unavailable during confirmation", () => {
    const ready = modelOf(asked, { waiting: QUEUE, waitingCount: QUEUE.length, ...sends });
    const remember = vi.fn(async () => ({ screenerAcknowledgements: 1 }));
    const consent = consentVia(async () => Response.json({ seedConfirmedAt: null, dormancyDays: 60 }));
    const world = mountPlace(ready, { consent: { ...consent, acknowledgeScreener: remember } });
    press("x");
    const title = "Spam and unsubscribe";
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();

    const decide = vi.fn();
    world.again({
      ...ready,
      role: { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false },
      decide,
    });
    fireEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: title }));

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(LENA, "spam", expect.objectContaining({ scope: "sender" }));
    expect(screen.queryByRole("dialog", { name: title })).toBeNull();
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
    world.again(ready);
    press("x");
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    expect(remember).not.toHaveBeenCalled();
  });

  it("names the domain when a first confirmation can unsubscribe multiple senders", () => {
    const accountScope = "account-one";
    const first = mountPlace(modelOf(asked, { accountScope, waiting: QUEUE, waitingCount: 2, ...sends }));
    press("n");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Screen out and unsubscribe" }),
    );
    first.view.unmount();

    const domainSender = sender("marco", "Marco Pine", { scope: "domain" });
    mountPlace(modelOf(asked, { accountScope, waiting: [domainSender], waitingCount: 1, ...sends }));
    press("x");
    const confirm = within(screen.getByRole("dialog", { name: "Spam and unsubscribe" }));
    expect(confirm.getByText(/marco\.example/)).toBeTruthy();
    expect(confirm.getByRole("button", { name: "Spam and unsubscribe" })).toBeTruthy();
    expect(confirm.getByText("Once sent, it cannot be undone.")).toBeTruthy();
  });

  it("a place that sends none is decided at once", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, ...sends }));
    press("o");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(asked.decided).toEqual([{ id: "lena", dest: "ohbox", read: false, scope: "sender" }]);
  });
});

describe("the queue's tools", () => {
  const news = sender("paper", "Paperbird", suggested("reads", 0.88));

  it("the filter shows one group alone, with its count", () => {
    mountPlace(modelOf(asked, { waiting: [LENA, news], waitingCount: 2 }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Act on all waiting senders" })).getByRole("button", {
        name: /All 2/,
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /News/ }));
    expect(within(screen.getByRole("listbox", { name: "Screener" })).getAllByRole("option")).toHaveLength(1);
  });

  it("Suggest shows the price before anything is bought, and buys on the confirm alone", () => {
    const calls: string[] = [];
    const control: ScreenerSuggestControl = {
      available: 2,
      resuggestable: 0,
      pool: 2,
      sizes: [2],
      size: 2,
      phase: "closed",
      quote: null,
      notice: null,
      progress: null,
      open: () => calls.push("open"),
      openAgain: () => calls.push("again"),
      choose: (n: number) => calls.push(`choose ${n}`),
      confirm: () => calls.push("confirm"),
      cancel: () => calls.push("cancel"),
    };
    const beside = (over: Partial<ScreenerSuggestControl>): ScreenerBeside => ({
      ...BESIDE,
      suggest: { priced: true, control: { ...control, ...over }, noAdvice: NO_RUN },
    });
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), { beside: beside({}) });
    fireEvent.click(screen.getByRole("button", { name: "Suggest…" }));
    expect(calls).toEqual(["open"]);
    world.view.unmount();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2 }), {
      beside: beside({ phase: "ready", quote: { senders: 2, credits: 2 } }),
    });
    const ask = screen.getByRole("dialog", { name: "How many waiting senders to suggest for" });
    expect(within(ask).getByText("2 credits")).toBeTruthy();
    expect(calls).toEqual(["open"]);
    fireEvent.click(within(ask).getByRole("button", { name: "Suggest for all 2 senders" }));
    expect(calls).toEqual(["open", "confirm"]);
  });

  it.each([
    {
      lang: "en",
      open: "Suggest again…",
      list: "List",
      title: "Suggest again",
      empty: "No senders need a new suggestion.",
      action: [
        "Suggest again for 1 sender",
        "Suggest again for the first 2 senders",
        "Suggest again for all 4 senders",
      ],
    },
    {
      lang: "de",
      open: "Neu vorschlagen …",
      list: "Liste",
      title: "Neu vorschlagen",
      empty: "Kein Absender braucht einen neuen Vorschlag.",
      action: [
        "Für 1 Absender neu vorschlagen",
        "Für die ersten 2 Absender neu vorschlagen",
        "Für alle 4 Absender neu vorschlagen",
      ],
    },
  ] as const)(
    "$lang names the actual re-ask and gives an empty quote no purchase control",
    ({ lang, open, list, title, empty, action }) => {
      let phase: ScreenerSuggestControl["phase"] = "closed";
      let size = 4;
      let quote = 0;
      let confirmed = 0;
      const control: ScreenerSuggestControl = {
        available: 0,
        resuggestable: 4,
        pool: 4,
        sizes: [2, 4],
        get size() {
          return size;
        },
        get phase() {
          return phase;
        },
        get quote() {
          return { senders: quote, credits: quote };
        },
        get notice() {
          return quote === 0 ? empty : null;
        },
        progress: null,
        open: () => {},
        openAgain: () => {
          phase = "ready";
        },
        choose: () => {},
        confirm: () => {
          confirmed++;
        },
        cancel: () => {},
      };
      const model = modelOf(asked, { waiting: QUEUE, waitingCount: 2 });
      const world = mountPlace(model, {
        lang,
        beside: {
          ...BESIDE,
          suggest: { priced: true, control, noAdvice: NO_RUN },
        },
      });
      fireEvent.click(screen.getByRole("button", { name: list }));
      fireEvent.click(within(screen.getByRole("menu", { name: list })).getByRole("menuitem", { name: open }));
      world.again({ ...model });
      const ask = within(screen.getByRole("dialog"));
      expect(ask.getByText(title, { exact: true })).toBeTruthy();
      expect(ask.getByText(empty)).toBeTruthy();
      expect(ask.queryAllByRole("button")).toEqual([]);
      for (const [index, count] of [1, 2, 4].entries()) {
        quote = count;
        size = count === 2 ? 2 : 4;
        world.again({ ...model });
        fireEvent.click(ask.getByRole("button", { name: action[index]! }));
      }
      expect(confirmed).toBe(3);
    },
  );

  it("no run handed, no Suggest; Apply files every real suggestion", () => {
    let applied = 0;
    mountPlace(
      modelOf(asked, {
        waiting: QUEUE,
        waitingCount: 2,
        suggestedCount: 1,
        suggestedDests: ["ohbox"],
        applying: null,
        applyAll: (() => (applied += 1)) as never,
      }),
    );
    expect(screen.queryByRole("button", { name: "Suggest…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));
    expect(applied).toBe(1);
  });

  it("Suggest is offered to a reader that may not decide: advice moves no mail", () => {
    const role = { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } as never;
    const control: ScreenerSuggestControl = {
      available: 2,
      resuggestable: 0,
      pool: 2,
      sizes: [2],
      size: 2,
      phase: "closed",
      quote: null,
      notice: null,
      progress: null,
      open: () => undefined,
      openAgain: () => undefined,
      choose: () => undefined,
      confirm: () => undefined,
      cancel: () => undefined,
    };
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 2, role }), {
      beside: { ...BESIDE, suggest: { priced: true, control, noAdvice: NO_RUN } },
    });
    expect(screen.getByRole("button", { name: "Suggest…" })).toBeTruthy();
  });

  it("Apply names every place it files into before the press", () => {
    let applied = 0;
    mountPlace(
      modelOf(asked, {
        waiting: [{ ...LENA, ...suggested("ohbox", 0.92) }, news],
        waitingCount: 2,
        suggestedCount: 2,
        suggestedDests: ["ohbox", "reads"],
        applyAll: (() => (applied += 1)) as never,
      }),
    );
    const list = within(screen.getByRole("listbox", { name: "Screener" }));
    const lena = list.getByRole("option", { name: /Lena Hart/ });
    const paper = list.getByRole("option", { name: /Paperbird/ });
    expect(within(lena.parentElement!).getByRole("button", { name: "Ohbox" })).toBeTruthy();
    expect(within(paper.parentElement!).getByRole("button", { name: "News" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2" }));
    expect(applied).toBe(1);
  });
});

describe("the senders kept out", () => {
  it("Screened out offers Allow to the Ohbox or to News, through the model's own release, once", () => {
    const allowed: string[] = [];
    const out = { ...(sender("zed", "Zed Oak") as object), segment: "screened" };
    mountPlace(
      modelOf(asked, {
        screenedOut: [out] as never,
        allowScreened: ((s: { id: string }, dest: string) => allowed.push(`${s.id} ${dest}`)) as never,
      }),
      { at: "#/screener/screened" },
    );
    expect(panel().textContent).toContain("Allow");
    expect(reading().textContent).toContain("Screened");
    fireEvent.click(within(panel()).getByRole("button", { name: "News" }));
    expect(allowed).toEqual(["zed reads"]);
    expect(asked.decided).toBeUndefined();
  });

  it("Spam offers Not spam, back to the Screener or to the Ohbox", () => {
    const back: string[] = [];
    const detection = { source: "engine", confidence: 0.98, reason: "An unsafe link", label: "Spam" };
    const row = { sender: sender("spam1", "Prize Desk", { segment: "spam", detection }), pinned: false };
    mountPlace(
      modelOf(asked, {
        spam: [row] as never,
        notSpamToWaiting: ((r: { sender: { id: string } }) => back.push(`waiting ${r.sender.id}`)) as never,
        notSpamToOhbox: ((r: { sender: { id: string } }) => back.push(`ohbox ${r.sender.id}`)) as never,
      }),
      { at: "#/screener/spam" },
    );
    expect(panel().textContent).toContain("Not spam");
    expect(within(screen.getByRole("listbox", { name: "Screener" })).getByText("Auto-detected")).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Screener" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Ohbox" }));
    expect(back).toEqual(["waiting spam1", "ohbox spam1"]);
  });

  it("an install that may not move this mailbox's mail draws no verb there", () => {
    const role = {
      mode: "blocked",
      name: "ohmail on a Mac",
      reason: "organizer_outdated",
      oauthOnly: false,
    } as never;
    const out = { ...(sender("zed", "Zed Oak") as object), segment: "screened" };
    mountPlace(modelOf(asked, { screenedOut: [out] as never, role }), { at: "#/screener/screened" });
    expect(
      within(panel())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
    expect(panel().textContent).toContain("ohmail on a Mac decides");
  });

  it("a reader whose organizer runs elsewhere draws no verb there either: this computer moves none of its mail", () => {
    const role = { mode: "pending", name: "Mac", reason: null, oauthOnly: false } as never;
    const out = { ...(sender("zed", "Zed Oak") as object), segment: "screened" };
    mountPlace(modelOf(asked, { screenedOut: [out] as never, role }), { at: "#/screener/screened" });
    expect(
      within(panel())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
    expect(panel().textContent).toContain("This computer does not move this mailbox's mail");
  });
});
