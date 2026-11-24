/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consentVia } from "@ohmail/app-logic/consent";
import { BESIDE, modelOf, mountPlace, sender, type Asked } from "./screener-world.js";

/**
 * THE SCREENER'S LIST AND ITS OPEN SENDER in the real frame, over a model double that records every call: the
 * sections, the rows, a decision from the panel and from a key (each once, through the one `decide`, the next sender
 * open after it), a reader's install with no verb, the failed letters' two answers, Show more senders on a press only,
 * and the empty sections.
 */

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

const QUEUE = [sender("lena", "Lena Hart"), sender("ben", "Ben Kiln"), sender("ada", "Ada Pine")];
const list = () => screen.getByRole("listbox", { name: "Screener" });
const column = () =>
  within(screen.getByRole("heading", { name: "Screener" }).closest<HTMLElement>(".sc-list")!);
const reading = () => screen.getByRole("region", { name: "Reading" });
/* Mark all spam stands in the list's menu over Waiting. */
const pressMarkAllSpam = () => {
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark all spam" }));
};

describe("the queue", () => {
  it("draws one option per sender, the first open, and the sender open in the reading column", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    const options = within(list()).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
    expect(asked.rereads).toBe(1);
  });

  it("asks the queue again once on opening, not on every draw of the model", () => {
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    world.again(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    world.again(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    expect(asked.rereads).toBe(1);
  });

  it("the sections are a group of pressed buttons with their counts; a press goes to the section", () => {
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    const sections = screen.getByRole("group", { name: "Screener sections" });
    const waiting = within(sections).getByRole("button", { name: /Waiting/ });
    expect(waiting.getAttribute("aria-pressed")).toBe("true");
    expect(waiting.textContent).toContain("3");
    fireEvent.click(within(sections).getByRole("button", { name: /Screened out/ }));
    expect(world.address.read()).toBe("#/screener/screened");
    expect(asked.flushes).toBe(1);
  });

  it("shows the empty queue without an explanation of how screening works", () => {
    mountPlace(modelOf(asked, { waiting: [], waitingCount: 0 }));
    expect(screen.getByRole("region", { name: "Messages" }).textContent).toContain("No one’s waiting");
    expect(reading().textContent).toContain("No one’s waiting");
    expect(within(reading()).queryByRole("button", { name: "Ohbox" })).toBeNull();
    expect(screen.queryByText(/First-time senders appear here/)).toBeNull();
  });

  it("puts the route's title and count under the section controls", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, screenedOut: [QUEUE[0]!] }));
    const sections = screen.getByRole("group", { name: "Screener sections" });
    expect(column().getByRole("heading", { name: /All.*3/ })).toBeTruthy();
    fireEvent.click(within(sections).getByRole("button", { name: /^Screened out/ }));
    expect(column().getByRole("heading", { name: /Screened out.*1/ })).toBeTruthy();
    fireEvent.click(within(sections).getByRole("button", { name: /^Spam/ }));
    expect(column().getByRole("heading", { name: /Spam.*0/ })).toBeTruthy();
  });

  it("shows the Spam origin only when it knows how the sender was screened", () => {
    const detection = { source: "engine", confidence: 0.98, reason: "An unsafe link", label: "Spam" };
    mountPlace(
      modelOf(asked, {
        spam: [
          { sender: sender("detected", "Detected", { detection }), pinned: false },
          { sender: sender("unknown", "Unknown"), pinned: false },
          { sender: sender("marked", "Marked"), pinned: true },
        ],
      }),
    );
    const sections = screen.getByRole("group", { name: "Screener sections" });
    fireEvent.click(within(sections).getByRole("button", { name: /^Spam/ }));
    const shelf = within(list());
    expect(shelf.getByRole("option", { name: /^Detected/ }).textContent).toContain("Auto-detected");
    expect(shelf.getByRole("option", { name: /^Unknown/ }).textContent).not.toContain("Auto-detected");
    expect(shelf.getByRole("option", { name: /^Marked/ }).textContent).toContain("By you");
  });

  it("shows the finished count and the Ohbox action for this session", () => {
    mountPlace(modelOf(asked, { decidedThisSession: 3 }));
    expect(screen.getByRole("region", { name: "Messages" }).textContent).toContain("No one’s waiting");
    expect(within(reading()).getByText((_, element) => element?.textContent === "3 decided")).toBeTruthy();
    expect(within(reading()).getByRole("button", { name: "Ohbox" })).toBeTruthy();
  });

  it("opening a row asks the model for nothing", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    fireEvent.click(within(list()).getByRole("option", { name: /Ben Kiln/ }));
    expect(within(reading()).getByRole("heading", { name: /Ben Kiln goes to/ })).toBeTruthy();
    expect(asked.decided).toBeUndefined();
    expect(asked.filedFailed).toBeUndefined();
  });
});

describe("a waiting row", () => {
  const letter = (id: string, subject: string) => ({
    id,
    subject,
    time: "09:00",
    body: "",
    snippet: subject,
  });
  const suggested = (dest: string) => ({ ai: { dest, confidence: 0.9, rationale: "" } });

  it("speaks for its newest letter, says how many it holds, and carries a claimed company's warning", () => {
    const paula = sender("paula", "Paula Pay", {
      held: [
        letter("p-1", "The oldest one"),
        letter("p-2", "The middle one"),
        letter("p-3", "The newest one"),
      ],
      checked: { reason: "impersonation", brand: "Paybank", domainShared: false, domain: "paula.example" },
    });
    mountPlace(modelOf(asked, { waiting: [paula, ...QUEUE], waitingCount: 4 }));
    const row = within(list()).getByRole("option", { name: "Paula Pay: The newest one" });
    expect(row.textContent).toContain("3 held");
    expect(row.textContent).toContain("Not Paybank");
    expect(within(list()).getByRole("img", { name: "Lookalike" })).toBeTruthy();
    expect(within(list()).getByRole("option", { name: /Ben Kiln/ }).textContent).not.toContain("held");
  });

  it("accepts its suggestion in one press, and the open sender stays open", () => {
    const ben = sender("ben", "Ben Kiln", suggested("reads"));
    mountPlace(modelOf(asked, { waiting: [QUEUE[0]!, ben, QUEUE[2]!], waitingCount: 3 }));
    fireEvent.click(within(list()).getByRole("button", { name: "News" }));
    expect(asked.decided).toEqual([{ id: "ben", dest: "reads", read: false, scope: "sender" }]);
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
  });

  it("a row's accept that would send an unsubscribe asks first, for a sender that is not open; Cancel files nothing; the yes files that sender once and the open sender stays open", () => {
    const ben = sender("ben", "Ben Kiln", suggested("screened"));
    const sends = (() => "sends") as never;
    mountPlace(
      modelOf(asked, { waiting: [QUEUE[0]!, ben, QUEUE[2]!], waitingCount: 3, unsubClaimOf: sends }),
    );
    const accept = () => within(list()).getByRole("button", { name: "Screen out and unsubscribe" });
    expect(accept().textContent).toBe("Screen out");
    fireEvent.click(accept());
    expect(asked.decided).toBeUndefined();
    const ask = screen.getByRole("dialog");
    expect(ask.textContent).toContain("ben@ben.example is still waiting");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(asked.decided).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(accept());
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Screen out and unsubscribe" }),
    );
    expect(asked.decided).toEqual([{ id: "ben", dest: "screened", read: false, scope: "sender" }]);
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
  });

  it("chooses another place from the row's menu, and a row with no suggestion offers the choice alone", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    const choose = within(list()).getAllByRole("button", { name: "Choose a place" });
    expect(choose).toHaveLength(3);
    expect(choose[1]!.textContent).toBe("Choose");
    fireEvent.click(choose[1]!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Receipts/ }));
    expect(asked.decided).toEqual([{ id: "ben", dest: "receipts", read: false, scope: "sender" }]);
  });

  it("offers no place on an install that may not decide", () => {
    mountPlace(
      modelOf(asked, {
        waiting: QUEUE,
        waitingCount: 3,
        role: { mode: "blocked", name: "Mac", reason: "another", oauthOnly: false } as never,
      }),
    );
    expect(within(list()).queryByRole("button", { name: "Choose a place" })).toBeNull();
  });
});

describe("a decision", () => {
  it("brings in the next sender after a decision", () => {
    const style = document.createElement("style");
    style.textContent = ".sc-next-sender { --d-out: 200ms; --x-col: translateY(6px); --e-out: linear; }";
    document.head.append(style);
    const original = Element.prototype.animate;
    const animated: Element[] = [];
    Element.prototype.animate = function () {
      animated.push(this);
      return { cancel() {}, addEventListener() {} } as unknown as Animation;
    };
    try {
      mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
      fireEvent.click(within(reading()).getByRole("button", { name: /Screen out/ }));
      expect(within(reading()).getByRole("heading", { name: /Ben Kiln goes to/ })).toBeTruthy();
      expect(animated.some((el) => reading().contains(el))).toBe(true);
    } finally {
      Element.prototype.animate = original;
      style.remove();
    }
  });

  it("from the panel leaves once and opens the next sender below", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    fireEvent.click(within(list()).getByRole("option", { name: /Ben Kiln/ }));
    const panel = within(reading()).getByRole("toolbar", { name: "Actions" });
    const verbs = within(panel)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    expect(verbs.some((v) => v.includes("Screen out"))).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: /Screen out/ }));
    expect(asked.decided).toEqual([{ id: "ben", dest: "screened", read: false, scope: "sender" }]);
    expect(within(reading()).getByRole("heading", { name: /Ada Pine goes to/ })).toBeTruthy();
  });

  it("from a key leaves once; Shift marks read on a pile that lets the sender in", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }));
    act(() => {
      fireEvent.keyDown(document.body, { key: "R", shiftKey: true });
    });
    expect(asked.decided).toEqual([{ id: "lena", dest: "reads", read: true, scope: "sender" }]);
  });

  it("an install that may not decide draws no verb, only who decides, and stays on the sender", () => {
    const role = { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role }));
    const panel = within(reading()).getByRole("toolbar", { name: "Actions" });
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
    expect(panel.textContent).toContain("Nothing organizes this mailbox");
    act(() => {
      fireEvent.keyDown(document.body, { key: "o" });
    });
    expect(within(reading()).getByRole("heading", { name: /Lena Hart goes to/ })).toBeTruthy();
  });

  it("a press refused because nothing organizes the mailbox yet is not offered, and the panel says why", () => {
    const role = {
      mode: "organizer",
      name: null,
      reason: null,
      oauthOnly: false,
      pressRefusal: { kind: "nobody" },
    };
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role: role as never }));
    const panel = within(reading()).getByRole("toolbar", { name: "Actions" });
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
    expect(panel.textContent).toContain("Nothing organizes this mailbox");
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
  });

  it("while this install's own organizing is starting the panel says so, as the model's refusal does", () => {
    const role = {
      mode: "organizer",
      name: null,
      reason: null,
      oauthOnly: false,
      pressRefusal: { kind: "starting" },
    };
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role: role as never }));
    const panel = within(reading()).getByRole("toolbar", { name: "Actions" });
    expect(panel.textContent).toContain("Organizing here starts within a minute");
    expect(panel.textContent).not.toContain("Nothing organizes this mailbox");
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
  });

  it("a press the posture refuses offers no place and no reach to choose, in the sentence or the card", () => {
    const role = {
      mode: "organizer",
      name: null,
      reason: null,
      oauthOnly: false,
      pressRefusal: { kind: "nobody" },
    };
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role: role as never }));
    expect(within(reading()).queryByRole("button", { name: "Decision scope" })).toBeNull();
    expect(
      within(reading()).queryByRole("button", { name: "Choose where this sender's mail goes" }),
    ).toBeNull();
    fireEvent.click(within(reading()).getByRole("button", { name: "lena@lena.example" }));
    const card = screen.getByRole("dialog", { name: "Change this sender's screening" });
    expect(within(card).queryAllByRole("radio")).toEqual([]);
    expect(asked.decided).toBeUndefined();
  });
});

describe("what the panel says before the press", () => {
  const panel = () => within(reading()).getByRole("toolbar", { name: "Actions" });
  const decision = (over: object) => ({
    subject: "x",
    scope: "sender",
    decidedAt: "2026-11-10",
    holder: "Mac",
    ...over,
  });

  it("a reader whose organizer files the decision says who files it, beside the verbs", () => {
    const role = { mode: "pending", name: "Mac", reason: null, oauthOnly: false } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role }));
    expect(panel().textContent).toContain("Mac files what you decide");
    expect(within(panel()).getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("a sender decided here waits for the organizer, with no verb; a refused one says why, with its verbs", () => {
    const decided = [{ sender: sender("zed", "Zed Oak"), decision: decision({}) }];
    const refused = [{ sender: QUEUE[0], decision: decision({ state: "refused", refusedReason: "stale" }) }];
    mountPlace(
      modelOf(asked, {
        waiting: QUEUE,
        waitingCount: 3,
        decided: decided as never,
        notApplied: refused as never,
      }),
    );
    expect(panel().textContent).toContain("Not applied");
    expect(within(panel()).getAllByRole("button").length).toBeGreaterThan(0);
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Screener" })).getByRole("option", { name: /^Zed Oak/ }),
    );
    expect(panel().textContent).toContain("Sent to Mac, waiting for it to apply.");
    expect(within(panel()).queryAllByRole("button")).toEqual([]);
  });
});

it("asks once before applying suggestions that unsubscribe, including across devices", async () => {
  const accounts = new Map<string, number>();
  const applyAll = vi.fn();
  const writes = vi.fn();
  const waiting = [sender("lena", "Lena Hart", { ai: { dest: "spam", confidence: 0.95, rationale: "" } })];
  const mountAccount = async (accountScope: string) => {
    const read = vi.fn();
    const consent = consentVia(async (path, init) => {
      if (path === "/consent/settings") {
        writes(JSON.parse(String(init?.body)));
        accounts.set(accountScope, 4);
      } else {
        read();
      }
      return Response.json({
        seedConfirmedAt: null,
        dormancyDays: 60,
        screenerAcknowledgements: accounts.get(accountScope) ?? 0,
      });
    });
    const world = mountPlace(
      modelOf(asked, {
        accountScope,
        waiting,
        waitingCount: 1,
        suggestedCount: 1,
        applyAll,
        unsubClaimOf: () => "sends",
      }),
      { consent: { ...consent, foldersStorable: false } },
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    return world;
  };
  const apply = () => fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));
  const question = () => within(screen.getByRole("dialog", { name: "Apply 1 suggestion?" }));

  const first = await mountAccount("account-one");
  apply();
  fireEvent.click(question().getByRole("button", { name: "Cancel" }));
  expect(applyAll).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  apply();
  expect(question().getByText(/1 unsubscribe request and no undo/)).toBeTruthy();
  fireEvent.click(question().getByRole("button", { name: "Apply 1 suggestion" }));
  apply();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(applyAll).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(writes).toHaveBeenCalledWith({ acknowledgeScreener: "applySuggestions" }));
  first.view.unmount();

  localStorage.clear();
  const second = await mountAccount("account-one");
  apply();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(applyAll).toHaveBeenCalledTimes(3);
  second.view.unmount();

  await mountAccount("account-two");
  apply();
  expect(question().getByText(/1 unsubscribe request and no undo/)).toBeTruthy();
  expect(applyAll).toHaveBeenCalledTimes(3);
});

it("asks again when the organizer becomes unavailable during bulk confirmation", () => {
  const ready = modelOf(asked, {
    waiting: [sender("lena", "Lena Hart", { ai: { dest: "spam", confidence: 0.95, rationale: "" } })],
    waitingCount: 1,
    suggestedCount: 1,
    applyAll: vi.fn(),
    unsubClaimOf: () => "sends",
  });
  const remember = vi.fn(async () => ({ screenerAcknowledgements: 4 }));
  const consent = consentVia(async () => Response.json({ seedConfirmedAt: null, dormancyDays: 60 }));
  const world = mountPlace(ready, { consent: { ...consent, acknowledgeScreener: remember } });
  const apply = () => fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));
  const question = () => screen.getByRole("dialog", { name: "Apply 1 suggestion?" });

  apply();
  world.again({ ...ready, role: { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } });
  fireEvent.click(within(question()).getByRole("button", { name: "Apply 1 suggestion" }));
  expect(ready.applyAll).not.toHaveBeenCalled();
  world.again(ready);
  apply();
  expect(question()).toBeTruthy();
  expect(remember).not.toHaveBeenCalled();
});

describe("Mark all spam", () => {
  it("asks first: nothing moves before the yes, Cancel moves nothing, the yes moves the senders it named once", () => {
    const spammed: string[][] = [];
    const markAllSpam = (_: unknown, only?: (s: { id: string }) => boolean) =>
      spammed.push(QUEUE.filter((s: { id: string }) => only?.(s) ?? true).map((s: { id: string }) => s.id));
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, markAllSpam: markAllSpam as never }));
    pressMarkAllSpam();
    const ask = screen.getByRole("dialog");
    expect(ask.textContent).toContain("Mark 3 as spam");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(spammed).toEqual([]);
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(spammed).toEqual([]);
    pressMarkAllSpam();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark as spam" }));
    expect(spammed).toEqual([["lena", "ben", "ada"]]);
    expect(asked.decided).toBeUndefined();
  });

  it("describes unsubscribe in the confirmation without adding a toolbar explanation", () => {
    const told = "also ask to unsubscribe you";
    const warning = /Later mail goes too, with \d+ unsubscribe requests? and no undo\./;
    const markAllSpam = (() => undefined) as never;
    const world = mountPlace(
      modelOf(asked, {
        waiting: QUEUE,
        waitingCount: 3,
        suggestedCount: 1,
        unsubClaimOf: (() => "sends") as never,
        markAllSpam,
      }),
    );
    expect(screen.getByRole("group", { name: "Act on all waiting senders" }).textContent).not.toContain(told);
    pressMarkAllSpam();
    expect(screen.getByRole("dialog").textContent).toMatch(warning);
    world.view.unmount();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, suggestedCount: 1, markAllSpam }));
    expect(screen.getByRole("group", { name: "Act on all waiting senders" }).textContent).not.toContain(told);
    pressMarkAllSpam();
    expect(screen.getByRole("dialog").textContent).not.toMatch(warning);
  });

  it("omits the unsubscribe explanation even when a sender offers it and there is no Apply action", () => {
    const told = "also ask to unsubscribe you";
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, unsubClaimOf: (() => "sends") as never }));
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
    expect(screen.getByRole("group", { name: "Act on all waiting senders" }).textContent).not.toContain(told);
    expect(asked.decided).toBeUndefined();
  });

  it("is not offered where this install may not decide", () => {
    const role = { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, role }));
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
  });
});

describe("a mailbox nothing organizes, under an empty queue", () => {
  const firstRun = { id: "firstRun" as const, Body: () => null };
  const facts = (notOrganizingYet: unknown) => ({
    ...BESIDE,
    facts: { ...BESIDE.facts, notOrganizingYet: notOrganizingYet as never },
  });

  it("one nobody agreed to: the press asks the first run's question again for that mailbox", () => {
    const world = mountPlace(modelOf(asked), {
      beside: facts({ every: true, mailboxes: [{ id: "mb-1", address: "me@home.example" }] }),
      stages: { firstRun },
    });
    expect(screen.getByText(/Not organizing yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(world.address.read()).toBe("#/first-run/again?mailbox=mb-1");
  });

  it("where the host has no first run, the sentence stands with no press", () => {
    mountPlace(modelOf(asked), {
      beside: facts({ every: true, mailboxes: [{ id: "mb-1", address: "me@home.example" }] }),
    });
    expect(screen.getByText(/Not organizing yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("some of them: each named under the empty queue, and the press for the first", () => {
    const world = mountPlace(modelOf(asked), {
      beside: facts({
        every: false,
        mailboxes: [{ id: "mb-2", address: "work@home.example", why: "stopped" }],
      }),
    });
    expect(screen.getByText(/Nothing organizes work@home.example/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mailboxes" }));
    expect(world.address.read()).toBe("#/settings/mailboxes");
  });
});

describe("the parts beside the queue", () => {
  it("a letter its provider failed is decided alone: Not from them to Spam, It's from them to the Ohbox", () => {
    const failed = [
      {
        id: "f1",
        from: { name: null, address: "bank@bank.example" },
        subject: "Your card",
        time: "08:00",
        mailboxId: "mb",
        own: false,
      },
    ];
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, failedAtGate: failed as never }));
    const failedRow = () =>
      within(screen.getByRole("listbox", { name: "Messages that failed the sender check" })).getByRole(
        "option",
      );
    fireEvent.click(failedRow());
    fireEvent.click(within(reading()).getByRole("button", { name: "Not from them" }));
    fireEvent.click(failedRow());
    fireEvent.click(within(reading()).getByRole("button", { name: "It's from them" }));
    expect(asked.filedFailed).toEqual([
      ["f1", "spam"],
      ["f1", "ohbox"],
    ]);
  });

  it("a reader whose organizer runs elsewhere is offered no answer to a failed letter, and the letter stays open", () => {
    const failed = [
      {
        id: "f1",
        from: { name: null, address: "bank@bank.example" },
        subject: "Your card",
        time: "08:00",
        mailboxId: "mb",
        own: false,
      },
    ];
    const role = { mode: "pending", name: "Mac", reason: null, oauthOnly: false } as never;
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, failedAtGate: failed as never, role }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Messages that failed the sender check" })).getByRole(
        "option",
      ),
    );
    const answers = within(reading()).getByRole("toolbar", { name: "Messages that failed the sender check" });
    expect(
      within(answers)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mailboxes"]);
    expect(answers.textContent).toContain("This computer does not move this mailbox's mail");
    expect(asked.filedFailed).toBeUndefined();
  });

  it("Show more senders loads on a press only, and a page that failed offers Try again", () => {
    const more = (over: object) => ({
      available: true,
      loading: false,
      failed: false,
      load: () => (asked.loads = (asked.loads ?? 0) + 1),
      ...over,
    });
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 300, waitingMore: more({}) }));
    expect(asked.loads).toBeUndefined();
    fireEvent.scroll(list());
    expect(asked.loads).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Show more senders" }));
    expect(asked.loads).toBe(1);
    world.again(modelOf(asked, { waiting: QUEUE, waitingCount: 300, waitingMore: more({ failed: true }) }));
    expect(screen.getByText("More senders could not be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(asked.loads).toBe(2);
  });

  it("an empty section says so once it may, and nothing before the queue is read", () => {
    const messages = () => screen.getByRole("region", { name: "Messages" }).textContent ?? "";
    const early = { ...BESIDE, facts: { ...BESIDE.facts, settled: false } };
    const world = mountPlace(modelOf(asked, { queueSettled: false, waitingSource: "device" }), {
      beside: early,
    });
    expect(messages()).not.toContain("No one’s waiting");
    expect(messages()).toContain("Loading your mail");
    world.view.unmount();
    mountPlace(modelOf(asked));
    expect(screen.getByRole("region", { name: "Reading" }).textContent).toContain("No one’s waiting");
  });

  it("speaks German", () => {
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3 }), { lang: "de" });
    expect(screen.getByRole("group", { name: "Screener-Bereiche" })).toBeTruthy();
  });
});

describe("the place's own notices", () => {
  const claimedOf = (over: Record<string, unknown> = {}) => {
    const calls = { toggles: 0, oks: 0, back: [] as string[][] };
    const impersonationFiled = {
      items: [
        {
          messageId: "m-1",
          from: "billing@hostwerk-rechnung.example",
          subject: "Your domain expires",
          brand: "Hostwerk",
        },
        { messageId: "m-2", from: "team@gmail.com", subject: "Sign in", brand: "Paperbird" },
      ],
      open: false,
      toggle: () => void (calls.toggles += 1),
      busy: false,
      said: null,
      putBack: (ids: readonly string[]) => void calls.back.push([...ids]),
      acknowledge: () => void (calls.oks += 1),
      ...over,
    };
    return { impersonationFiled: impersonationFiled as never, calls };
  };

  it("letters filed to Spam for claiming a company: Review lists each with its claim and Put back; OK lets the line go", () => {
    const { impersonationFiled, calls } = claimedOf();
    const world = mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    expect(document.body.textContent).toContain("2 letters that claimed to be a company went to Spam");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(calls.toggles).toBe(1);
    const open = claimedOf({ open: true });
    world.again(
      modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled: open.impersonationFiled }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("hostwerk-rechnung.example isn't one of Hostwerk's addresses");
    expect(dialog.textContent).toContain("anyone can register a gmail.com address");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Put back" })[0]!);
    expect(open.calls.back).toEqual([["m-1"]]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Put back all 2" }));
    expect(open.calls.back).toEqual([["m-1"], ["m-1", "m-2"]]);
    world.view.unmount();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(calls.oks).toBe(1);
    expect(asked.decided).toBeUndefined();
  });

  it("a Put back that did not work says so on the line", () => {
    const { impersonationFiled } = claimedOf({ said: "failed" });
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    expect(document.body.textContent).toContain("Couldn't put that back");
  });

  it("OK is off while a Put back is on its way: it stands, and a press of it does nothing", () => {
    const { impersonationFiled, calls } = claimedOf({ busy: true });
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(false);
    const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(calls.oks).toBe(0);
  });

  it("a Put back that did not work is said in the dialog where it was pressed, over its answers, no item of the list", () => {
    const { impersonationFiled } = claimedOf({ open: true, said: "failed" });
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    const dialog = screen.getByRole("dialog");
    const line = within(dialog).getByText(/Couldn't put that back/);
    expect(line.closest('[role="list"]')).toBeNull();
    expect(within(dialog).getAllByText(/Couldn't put that back/)).toHaveLength(1);
  });

  it("a Put back handed to the organizer is said in the dialog where it was pressed, as a status, no item of the list", () => {
    const { impersonationFiled } = claimedOf({ open: true, said: "requested" });
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    const dialog = screen.getByRole("dialog");
    const line = within(dialog).getByText(/Whoever organizes this mailbox puts them back/);
    expect(line.closest('[role="status"]')).toBeTruthy();
    expect(line.closest('[role="list"]')).toBeNull();
  });

  it("gives the impersonation notice the first line, with no held-mail banner", () => {
    const { impersonationFiled } = claimedOf();
    mountPlace(modelOf(asked, { waiting: QUEUE, waitingCount: 3, impersonationFiled }));
    expect(document.body.textContent).toContain("2 letters that claimed to be a company went to Spam");
    expect(document.body.textContent).not.toContain("held, already decided");
    expect(screen.queryByRole("button", { name: "More that needs you here" })).toBeNull();
  });
});
