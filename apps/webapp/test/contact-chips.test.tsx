/** @vitest-environment jsdom */
process.env.TZ = "UTC";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { act, cleanup, screen, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrame, useLinkedDraft } from "../../../packages/app/src/frame/commands.js";
import { browserCopy } from "../app/shell/browser-mail.js";
import { READER_PLACE, letter, mountLetters } from "./_reader-1-letters.js";

/**
 * ═══ VIEWER CONTACT CHIPS AND THEIR POPOVER ═══════════════════════════════════════════
 *
 * The recipients under a message header are NAMED — each recipient a focusable <button> chip, a
 * field of more than three folded to three names and a count — and pressing a chip opens a small popover with exactly four verbs:
 * Copy address · Everything from and to this address · Write · Screener settings. The three
 * claims this file holds, each of which has a specific way of silently shipping wrong:
 *
 *  · **The chip's ADDRESS travels, not the message's sender.** `openSenderMenu` has resolved
 *    "the sender of message X" since it existed, so the natural wiring mistake is to pass the
 *    message id alone and let the sheet open on the SENDER — a control that says "Screener
 *    settings" for the Cc'd person and silently rules on somebody else. The dispatch is
 *    asserted argument-for-argument.
 *  · **The face decodes, the action does not.** An IDN recipient's chip reads `…@müller.example`
 *    while Copy must yield the STORED `xn--…` form — the same display/identity split `idn.ts`
 *    enforces everywhere else, asserted here at the one new surface that could break it.
 *  · **Inert chrome OMITS, never deadens.** A mount with no compose seam and no screening
 *    machine (a bare harness, a provider-less pane) keeps the chip and the popover — Copy
 *    always works, and so does the address view, which needs no machine but the hash router —
 *    but Write and Screener settings are ABSENT, not dead.
 */

/* The mounted reader opens the kit card. The tests exercise the clipboard, the frame's
 * linked draft and address route, and the room's real screening planner and Undo window. */
const NOW = new Date("2026-08-02T12:00:00.000Z");

/** The IDN pair the round-trip guard runs on — stored A-label, readable form. */
const ACE = "xn--mller-kva.example";
const UNI = "müller.example";

interface Addr {
  name: string | null;
  address: string;
}

function msg(over: Partial<EngineMessage> = {}): EngineMessage {
  return letter("m1", {
    subject: "Quote",
    from: { name: "Sender One", address: "sender@example.invalid" },
    to: [
      { name: "Anna Roth", address: "anna@x.invalid" },
      { name: null, address: "bare@x.invalid" },
    ] satisfies Addr[],
    cc: [{ name: "Cy Cole", address: "cy@x.invalid" }] satisfies Addr[],
    date: "2026-08-01T09:00:00.000Z",
    unread: false,
    ...over,
  });
}

/** What the place that writes was handed: `"address"` or `"address|name"` (a recipient written `Name <address>`). */
let wrote: string[] = [];
let mutations: EngineMutation[] = [];
let openedAddress: string | null | undefined;
const newRules = () => mutations.filter((mutation) => mutation.kind === "rule_create");
/** Everything handed to the clipboard. */
let copied: string[] = [];
let ownAddresses: string[] = [];
let ownName: string | null = null;

/** The place that writes, as this file stands it: it takes the letter handed to it and records its recipients. */
function TakesTheDraft(): React.ReactElement {
  const take = useLinkedDraft();
  React.useEffect(() => {
    const draft = take();
    for (const to of draft?.to ?? []) {
      const named = /^(.*?)\s*<([^>]+)>$/.exec(to);
      wrote.push(named ? `${named[2]}|${named[1]}` : to);
    }
  });
  return <p>the place that writes</p>;
}

function AddressView() {
  openedAddress = useFrame().route.sub;
  return <p>The address view</p>;
}

async function mountHeader(open: EngineMessage, inert = false) {
  cleanup();
  const own = ownAddresses.map((address, i) => ({ id: `mb-${i + 1}`, address, addressIsOwn: true, status: "active", ...(ownName !== null ? { displayName: ownName } : {}) }));
  const mounted = mountLetters({
    letters: [open],
    parts: { copy: browserCopy },
    open: open.id,
    host: {
      mailboxes: async () => own as never,
      places: {
        ohbox: READER_PLACE,
        address: { id: "address", body: "address", rail: null, panes: { kind: "wide", Wide: AddressView } },
        ...(inert ? {} : {
          write: { id: "write", body: "write", rail: null, panes: { kind: "wide", Wide: TakesTheDraft } },
          screener: { id: "screener", body: "screener", rail: null, panes: { kind: "wide", Wide: () => null } },
        }),
      },
    },
  });
  mutations = mounted.mail.mutations;
  await act(async () => { await Promise.resolve(); });
  if (ownAddresses.length > 0) await screen.findByRole("button", { name: "you" });
  return mounted;
}

/** The recipients' line of the open letter's head. */
const line = (): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>("[data-conv-id] p")].find((p) => /^(to|cc) /.test(p.textContent ?? "")) ?? null;
/** Every name on the recipients' line, in order (the details' toggle is not a name). */
const chips = (): HTMLButtonElement[] =>
  [...(line()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter((b) => !b.hasAttribute("aria-expanded") || b.textContent !== "details");
const chipByText = (text: string): HTMLButtonElement | undefined =>
  chips().find((c) => (c.textContent ?? "").includes(text));
/** The contact cards that are open (the kit's ContactCard: a dialog named "Options for <the person>"). */
const cards = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => /^Options for /.test(d.getAttribute("aria-label") ?? ""));
/** The contact card that is open, or null. */
const popover = (): HTMLElement | null => cards()[0] ?? null;
const items = (): HTMLButtonElement[] => [...(popover()?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
const itemByText = (text: string): HTMLElement | undefined =>
  text === "Copy address" && popover()
    ? within(popover()!).queryByRole("button", { name: text }) ?? undefined
    : items().find((i) => (i.textContent ?? "").includes(text));

const news = () => within(popover()!).getByRole("radio", { name: "News" });
const commitRouting = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  await act(async () => { await Promise.resolve(); });
};

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    (node as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  wrote = [];
  mutations = [];
  openedAddress = undefined;
  window.localStorage.clear();
  copied = [];
  ownAddresses = [];
  ownName = null;
  // jsdom carries no clipboard; the card's Copy is driven through this stub.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

/* ══ THE BLOCK — To and Cc written out, every recipient a chip ═════════════════════════════
   Retired by their rows, held by the reader's own cases: a small letter names everyone, the To and Cc words, every
   name a button (`letters.test.tsx` "the recipients' line says to and cc as the head says them"), no line with no To
   and no Cc (`conversation.test.ts` "renders NO recipients block when there is no To and no Cc"), and the fold of a
   letter to many (the new head folds no field: everyone is named in its details). The two alignment cases read
   today's markup and stylesheet and left with them. */

describe("the recipients block: names, folded when the letter went to many", () => {
  it("a named chip reads the name alone, its address on the title; a no-name one prints the address once", async () => {
    await mountHeader(msg());
    const anna = chipByText("Anna Roth")!;
    expect(anna.textContent).toBe("Anna Roth");
    expect(anna.title).toBe("anna@x.invalid");
    const bare = chipByText("bare@x.invalid")!;
    expect(bare.textContent).toBe("bare@x.invalid");
  });
});

/* ══ THE POPOVER — exactly Copy address · Everything from and to this address · Write · Screener settings ══ */

describe("the contact popover", () => {
  it("opens on a chip press with exactly the four verbs, in order", async () => {
    const message = msg();
    await mountHeader(message);
    await click(chipByText("Anna Roth"));
    expect(popover()).toBeTruthy();
    const card = within(popover()!);
    expect(card.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(card.getByRole("radiogroup", { name: "Where their mail goes" })).toBeTruthy();
    expect(items().map((item) => item.textContent)).toEqual(["Everything from and to this address", "Write"]);
    expect(card.queryByText("Only some of their mail? Make a rule on the subject too")).toBeNull();
    await click(itemByText("Everything from and to this address"));
    expect(openedAddress).toBe(message.to[0]!.address);
    expect(popover()).toBeNull();
  });

  it("Copy yields the STORED address and closes", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    await click(itemByText("Copy address"));
    expect(copied).toEqual(["anna@x.invalid"]);
    expect(popover()).toBeNull();
  });

  it("Write hands the chip's address AND name to the compose seam", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    await click(itemByText("Write"));
    expect(wrote).toEqual(["anna@x.invalid|Anna Roth"]);
    expect(popover()).toBeNull();
  });

  it("Write on a no-name chip hands the address alone", async () => {
    await mountHeader(msg());
    await click(chipByText("bare@x.invalid"));
    await click(itemByText("Write"));
    expect(wrote).toEqual(["bare@x.invalid"]);
  });

  it("Screener settings dispatches the CHIP'S address — the Cc person, not the message's sender", async () => {
    const message = msg();
    await mountHeader(message);
    await click(chipByText("Cy Cole"));
    expect(newRules()).toEqual([]);
    await click(news());
    expect(newRules()).toEqual([]);
    expect(popover()).toBeNull();
    await click(screen.getByRole("button", { name: "Undo" }));
    await commitRouting();
    expect(newRules()).toEqual([]);
    await click(chipByText("Cy Cole"));
    await click(news());
    await commitRouting();
    expect(newRules()).toEqual([expect.objectContaining({
      ruleKind: "sender", match: message.cc[0]!.address, applyRetro: true,
    })]);
    expect(mutations.some((mutation) => mutation.kind === "move" && mutation.messageId === message.id)).toBe(false);
    expect(newRules()[0]?.match).not.toBe(message.from.address);
    await click(chipByText("Cy Cole"));
    const card = within(popover()!);
    await click(card.getByRole("radio", { name: /^Everyone at / }));
    await click(card.getByRole("switch", { name: "Also apply the rule to mail already here" }));
    await click(news());
    expect(newRules().slice(1)).toEqual([expect.objectContaining({
      ruleKind: "domain", match: message.cc[0]!.address.split("@")[1], applyRetro: false,
    })]);
    expect(mutations.some((mutation) => mutation.kind === "move" && mutation.messageId === message.id)).toBe(false);
  });

  it("one popover at a time — pressing a second chip re-points it", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    await click(chipByText("Cy Cole"));
    const open = cards();
    expect(open).toHaveLength(1);
    expect(open[0]!.textContent).toContain("Cy Cole");
    await click(screen.getByRole("button", { name: /^Sender One / }));
    await click(itemByText("Only some of their mail? Make a rule on the subject too"));
    const dialog = screen.getByRole("dialog", { name: /Make a rule for mail from Sender One/ });
    expect(within(dialog).getByRole("textbox", { name: "Which subject term" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(newRules()).toEqual([]);
  });

  /* A DISCLOSURE TOGGLES. Two changes met here and the pair, not either one, is the claim:
     the outside-press listener now EXCLUDES the chip (otherwise one press closed the popover
     and the chip's own handler immediately re-opened it, so the control looked dead), and the
     handler had always set the state unconditionally. Exclusion without a toggle leaves the
     popover with nothing that dismisses it from its own trigger. Both halves are asserted —
     the second press closes, and a press elsewhere still closes — because removing either one
     alone puts the surface back in a state a person cannot leave. */
  it("a second press on the SAME chip closes it, and aria-expanded follows both ways", async () => {
    await mountHeader(msg());
    const chip = chipByText("Anna Roth")!;
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await click(chip);
    expect(popover(), "the first press must open it").not.toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    await click(chip);
    expect(popover(), "the chip is a disclosure — pressing it again must CLOSE it").toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("a press away from the chip still dismisses — the exclusion is scoped to the trigger", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    expect(popover()).not.toBeNull();
    // Away from the chip, the press lands on what lies over the page while a card is open (the kit's veil).
    const away = document.querySelector<HTMLElement>("[data-veil]") ?? document.body;
    await act(async () => {
      away.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      away.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      away.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(popover(), "an outside press must close the popover").toBeNull();
  });
});

/* ══ INERT CHROME — items are OMITTED, the chip and Copy survive ═══════════════════════════ */

describe("inert chrome: the branch production desktop and every bare harness take", () => {
  it("omits Write and Screener settings — the popover still opens, Copy still works", async () => {
    await mountHeader(msg(), true);
    const chip = chipByText("Anna Roth")!;
    expect(chip.tagName).toBe("BUTTON");
    await click(chip);
    expect(popover()).toBeTruthy();
    expect(items().map((item) => item.textContent)).toEqual(["Everything from and to this address"]);
    expect(within(popover()!).queryByRole("radiogroup")).toBeNull();
    await click(itemByText("Copy address"));
    expect(copied).toEqual(["anna@x.invalid"]);
  });
});

/* ══ THE "ME" CHIP — the account's own identity, from GET /mailboxes ═══════════════════════ */

describe("the reader's own address reads as you", () => {
  it("reads `you`, first in its field, with the account's name and address on its title", async () => {
    ownAddresses = ["bare@x.invalid"];
    ownName = "Mila Brändli";
    await mountHeader(msg());
    const me = chips()[0]!;
    expect(me.textContent).toBe("you");
    expect(me.title).toBe("Mila Brändli <bare@x.invalid>");
    await click(me);
    expect(popover()!.textContent).toContain("Mila Brändli");
    await click(itemByText("Copy address"));
    expect(copied).toEqual(["bare@x.invalid"]);
  });

  it("with no display name the title is the bare address — never invented", async () => {
    ownAddresses = ["bare@x.invalid"];
    ownName = null;
    await mountHeader(msg());
    expect(chips()[0]!.textContent).toBe("you");
    expect(chips()[0]!.title).toBe("bare@x.invalid");
  });

  it("the account name never replaces a STRANGER'S name — only the me-fold reads it", async () => {
    ownAddresses = ["bare@x.invalid"];
    ownName = "Mila Brändli";
    await mountHeader(msg());
    expect(chipByText("Anna Roth")!.textContent).toBe("Anna Roth");
  });
});

/* ══ IDN — the face decodes, every action yields the wire form ═════════════════════════════ */

describe("an internationalized recipient", () => {
  it("shows the readable domain on the chip face while Copy yields the A-label", async () => {
    await mountHeader(msg({ to: [{ name: null, address: `sarada@${ACE}` }], cc: [] }));
    const chip = chipByText(`sarada@${UNI}`);
    expect(chip, "the chip face did not decode").toBeTruthy();
    expect(chip!.textContent).not.toContain("xn--");
    await click(chip);
    await click(itemByText("Copy address"));
    expect(copied).toEqual([`sarada@${ACE}`]);
  });

  it("Screener settings and Write both dispatch the STORED form", async () => {
    const mounted = await mountHeader(msg({ to: [{ name: null, address: `sarada@${ACE}` }], cc: [] }));
    await click(chipByText(`sarada@${UNI}`));
    await click(itemByText("Write"));
    await act(async () => mounted.host.device.address.write("#/ohbox/m/m1", "replace"));
    await click(chipByText(`sarada@${UNI}`));
    await click(news());
    await commitRouting();
    expect(wrote).toEqual([`sarada@${ACE}`]);
    expect(newRules()).toEqual([expect.objectContaining({ match: `sarada@${ACE}` })]);
  });
});

/* ══ Tab+Enter opens, Escape dismisses, the menu roves ══════════════════════════════
   "ArrowDown roves through the items" is retired by its row: the card is the kit's Menu, whose arrows are held by
   `packages/ui/test/base/overlays.test.tsx` ("the arrows move and wrap past an item that is off"). */

describe("keyboard", () => {
  it("the chip is a disclosure: haspopup, live expanded, and focus lands in the menu", async () => {
    await mountHeader(msg());
    const chip = chipByText("Anna Roth")!;
    // The recipient's name opens the contact dialog.
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement, "opening must put the keyboard in the menu")
      .toBe(items()[0]);
  });

  it("Escape dismisses and returns focus to the chip", async () => {
    await mountHeader(msg());
    const chip = chipByText("Anna Roth")!;
    await click(chip);
    await act(async () => {
      items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

/* ══ THE APPSHELL WIRING — retired by their rows with today's shell (their whole subject was `AppShell`'s
   closures: the chip's address threaded into the screening sheet, its dispatch and audit, the subject rule withheld
   under the override). The card that screens a recipient is the reader's gap; its never-red case above holds the
   address that must travel, and STOP 4 of share reader-1 carries the subject-rule half to whoever builds it. ═══ */
