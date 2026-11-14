/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createTranslator } from "next-intl";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MessageHead } from "@ohmail/ui/mail";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { listFrame } from "../../../packages/app/test/places/list-seat.js";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { code } from "./_news-recipient-source.js";
import { message as shellMessage, mountShell, stubDom, unmountAll as unmountShells } from "./_draft-shell.js";
import { BROWSER_READER } from "../app/shell/browser-mail";

/**
 * ═══ A READS CARD SAYS WHO ELSE GOT THE MESSAGE ════════════════════════════════════════════
 *
 * The Reads header used to be sender and time and nothing else, so a message that went to
 * eleven people looked exactly like one written to you. It now wears the READING PANE'S OWN
 * recipients block — `MessageRecipients`, the component `MessageCard` was carrying inline —
 * capped, with the remainder folded behind the disclosure that block already had.
 *
 * Four ways this ships wrong, and one test each:
 *
 *  · **A second spelling.** The obvious implementation is a small `To: …` line written into
 *    `StreamCard`, which is a copy of the pane's block that drifts from it the first time
 *    either changes. The source census below is what makes "one component" checkable rather
 *    than merely intended.
 *  · **A line that never says anything.** Drawing the block on every card puts "To: you" under
 *    every subject in the stream. The item asks that a message with SEVERAL recipients say so,
 *    so a one-recipient card must be the header it always was — asserted as an ABSENCE, which
 *    is the assertion nobody writes and the reason this regresses quietly.
 *  · **A "+0 more".** A cap of two over a message with exactly two recipients must not fold:
 *    an off-by-one here reads as a control that hides nothing and is pressable anyway.
 *  · **The press that also moves the surface underneath it.** A stream card selects AND expands
 *    on any click it receives (`StreamCard.expandOnClick`), which the reading pane has no
 *    equivalent of. A chip that does not stop its own press opens a popover and re-lays out the
 *    card under it in the same tick — a defect that exists only on the new host, so no existing
 *    test could have seen it.
 */

const ISO = "2026-08-04T09:00:00.000Z";

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Addr {
  name: string | null;
  address: string;
}

/** The same message with the two OPTIONAL disclosure fields varied — both are wire-optional. */
const without = (m: EngineMessage, drop: { date?: boolean; folder?: boolean }): EngineMessage => {
  const o = { ...(m as unknown as Record<string, unknown>) };
  if (drop.date) o.date = null;
  if (drop.folder) delete o.physicalFolder;
  return o as unknown as EngineMessage;
};

const message = (to: Addr[], cc: Addr[] = []): EngineMessage =>
  ({
    id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "The weekly note", from: { name: "Ida Vogt", address: "ida@x.invalid" },
    to, cc, date: ISO, folder: "INBOX", physicalFolder: "INBOX",
    snippet: "the opening line of the issue",
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

function repoFile(rel: string): string {
  const path = [resolve(process.cwd(), rel), resolve(process.cwd(), "../..", rel)].find(existsSync);
  expect(path, `could not find ${rel} from ${process.cwd()}`).toBeTruthy();
  return path!;
}

let host: HTMLElement | null = null;

async function mountReads(m: EngineMessage, locale: "en" | "de" = "en"): Promise<void> {
  await mountRecipientLetter(m, { locale, expand: false });
  host = screen.getByRole("region", { name: (locale === "de" ? de : en).news.stream.label });
}

/** The shared header accepts numeric limits that the application's fixed limits never pass. */
function mountRaw(m: EngineMessage, max: number, locale: "en" | "de" = "en"): void {
  const messages = locale === "de" ? de : en;
  const t = createTranslator({ locale, messages, namespace: "message" });
  host = render(
    <MessageHead
      staticMetadata
      sender={{ name: m.from.name ?? "", address: m.from.address }}
      stamp={{ when: "", full: false, title: "" }}
      to={[{ word: "to", people: m.to.map((person) => ({ name: person.name ?? person.address })) }]}
      details={{
        label: "details",
        open: false,
        max,
        lines: [],
        more: (_field, shown) => ({
          text: t("moreRecipients", { count: m.to.length - shown.length }),
          name: t("moreRecipientsAriaOnly"),
        }),
      }}
    />,
  ).container;
}

async function unmountAll(): Promise<void> {
  cleanup();
  host = null;
}

afterEach(unmountAll);

const card = (): HTMLElement => within(host!).getByRole("article");
const block = (): HTMLElement | null => card().querySelector(".oh-messagehead-to");
const chips = (): HTMLElement[] =>
  within(host!).queryAllByRole("button").filter((button) => button.getAttribute("aria-haspopup") === "dialog");
const fold = (): HTMLElement | null =>
  within(host!).queryAllByRole("button").find((button) => button.hasAttribute("data-details")) ?? null;

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    (node as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const three: Addr[] = [
  { name: "Anna Roth", address: "anna@x.invalid" },
  { name: "Bo Lind", address: "bo@x.invalid" },
  { name: "Cy Cole", address: "cy@x.invalid" },
];

function mountRegisteredReads(to: Addr[]) {
  return mountStreamFrame({
    at: "#/reads",
    letters: [issue("m1", 12, { to, physicalFolder: "INBOX", body: undefined })],
  });
}

async function mountRecipientLetter(
  letter: EngineMessage,
  { locale = "en", expand = true, own = [] }: { locale?: "en" | "de"; expand?: boolean; own?: string[] } = {},
) {
  stubDom();
  const messages = locale === "de" ? de : en;
  const { host } = listFrame({
    first: "#/reads",
    letters: [{ ...letter, folder: "ohmail/News", body: undefined }],
    mailboxes: own.length === 0 ? undefined : async () => own.map((address, index) => ({
      id: `mb${index}`, address, status: "connected", errorCode: null, disabledReason: null,
      syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null,
    })),
    more: {
      "rule:news": {
        id: "news", kind: "sender", match: letter.from.address, destination: "ohmail/News",
        priority: 0, provenance: "manual", enabled: true,
      },
    },
  });
  render(
    <TextProvider locale={locale} messages={messages} timeZone="UTC" now={new Date(ISO)}>
      <Frame host={host} />
    </TextProvider>,
  );
  const region = within(screen.getByRole("region", { name: messages.news.stream.label }));
  if (expand) await click(region.getByRole("button", { name: messages.news.item.expand }));
  return region;
}

const registeredCard = () => within(screen.getByRole("region", { name: "News stream" }));
const recipientButtons = (field: HTMLElement) =>
  within(field).getAllByRole("button").filter((button) => button.getAttribute("aria-haspopup") === "dialog");
const toField = (): HTMLElement => {
  const label = registeredCard().getByText("to", { exact: true });
  return label.parentElement!;
};
const toCount = () => registeredCard().getByRole("button", { name: /^to Anna Roth, Bo Lind and 1 other/ });

/* ══ SEVERAL RECIPIENTS — the card says so ═════════════════════════════════════════════════ */

describe("a Reads card with several recipients names them in its header", () => {
  it("renders the reading pane's own block, inside the card's head", async () => {
    await mountReads(message(three));
    const b = block();
    expect(b, "the card's header carries no recipients block").toBeTruthy();
    // Inside the head, under the subject — not appended after the body or the pill.
    expect(b!.closest(".oh-messagehead"), "the block is not in the card's head").toBeTruthy();
    expect(b!.querySelector("[data-recipient-field] > span")!.textContent?.trim()).toBe("To");
  });

  it("names the first two and folds the rest into a count — not a name dropped in silence", () => {
    mountRegisteredReads(three);
    expect(recipientButtons(toField()).map((button) => button.textContent)).toEqual(["Anna Roth", "Bo Lind"]);
    expect(toCount().textContent).toContain("and 1 other");
  });

  it("each field folds on its own line — Cc keeps its own names and its own count", async () => {
    await mountReads(message(three, [...three].reverse()));
    const rows = [...host!.querySelectorAll<HTMLElement>("[data-recipient-field]")];
    expect(rows.map((r) => recipientButtons(r).length)).toEqual([2, 2]);
    expect(rows[1]!.querySelector("span")!.textContent?.trim()).toBe("Cc");
    expect(within(rows[1]!).getByRole("button", { name: /and 1 other/ })!.textContent).toContain("and 1 other");
  });

  it("pressing the count names everyone, and the control goes back to being `details`", async () => {
    mountRegisteredReads(three);
    await click(toCount());
    expect(recipientButtons(toField()).map((button) => button.textContent)).toEqual(["Anna Roth", "Bo Lind", "Cy Cole"]);
    const details = registeredCard().getByRole("button", { name: "Hide the additional details" });
    expect(details.textContent).toContain("details");
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(registeredCard().getAllByRole("term").length, "the details block did not open").toBeGreaterThan(0);
  });

  it("the German face carries its own count, not the English one", async () => {
    await mountReads(message(three), "de");
    expect(fold()!.textContent).toContain("und 1 weitere");
    expect(block()!.querySelector("[data-recipient-field] > span")!.textContent?.trim()).toBe("An");
  });
});

/* ══ ONE RECIPIENT — the header it always was ══════════════════════════════════════════════ */

describe("a card with one recipient is the header it was", () => {
  it("exactly two recipients draws both and NO count — the cap is not a `+0`", () => {
    mountRegisteredReads(three.slice(0, 2));
    expect(recipientButtons(toField())).toHaveLength(2);
    expect(registeredCard().queryByRole("button", { name: /^to .*other/ })).toBeNull();
    const details = registeredCard().getByRole("button", { name: "Show the exact date and where this message sits" });
    expect(details.textContent).not.toContain("other");
    expect(details.textContent).toContain("details");
  });
});

/* ══ THE PRESS STOPS AT THE CHIP ═══════════════════════════════════════════════════════════ */

describe("a chip press does not also move the card under it", () => {
  it("opens the popover and leaves the card collapsed", async () => {
    const { address } = mountRegisteredReads(three);
    expect(registeredCard().getByRole("button", { name: "Expand" })).toBeTruthy();
    await click(registeredCard().getByRole("button", { name: "Anna Roth" }));
    expect(screen.getByRole("dialog", { name: "Options for Anna Roth" })).toBeTruthy();
    expect(registeredCard().getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(address.read()).toBe("#/reads");
  });

  it("pressing the fold does not expand the card either", async () => {
    const { address } = mountRegisteredReads(three);
    await click(toCount());
    expect(registeredCard().getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(address.read()).toBe("#/reads");
  });
});

/* ══ ONE COMPONENT, TWO MOUNTS ═════════════════════════════════════════════════════════════ */

describe("the block is mounted, never re-spelled", () => {
  it("exactly ONE recipients block and ONE popover render, however many surfaces mount it", async () => {
    mountRegisteredReads(three);
    await click(registeredCard().getByRole("button", { name: "Anna Roth" }));

    const blocks = [...document.querySelectorAll(".oh-messagehead-to")];
    expect(blocks).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Options for Anna Roth" })).toBeTruthy();
    for (const chip of document.querySelectorAll('.oh-messagehead-person[aria-haspopup="dialog"]')) {
      expect(blocks[0]!.contains(chip), "a chip rendered outside the recipients block").toBe(true);
    }
  });

  it("the card's cap is stated once, as a named constant", () => {
    const stream = code(readFileSync(repoFile("packages/app/src/reader/Letter.tsx"), "utf8"));
    expect(stream).toMatch(/const CARD_RECIPIENT_CHIPS = \d+;/);
    expect(stream).toContain("max: CARD_RECIPIENT_CHIPS");
  });
});

/* ══ THE CAP IS NORMALISED AT THE BOUNDARY ═════════════════════════════════════════════════ */

describe("a nonsense cap cannot produce a plausible-looking block", () => {
  it("a NEGATIVE cap does not slice from the end — a field still shows its first name", async () => {
    // `slice(0, -1)` keeps everything but the LAST recipient, which is the inverse of "the
    // first N" and renders a block that looks entirely reasonable. Nothing in the product
    // passes a negative; that is exactly why it would never have been noticed.
    mountRaw(message(three), -1);
    expect(chips().map((c) => c.textContent), "a negative cap sliced from the end").toEqual(["Anna Roth"]);
    expect(fold()!.textContent).toContain("and 2 others");
  });

  it("a cap of zero still names one person per field — never a label with only a count", async () => {
    mountRaw(message(three), 0);
    expect(chips()).toHaveLength(1);
    expect(fold()!.textContent).toContain("and 2 others");
  });

  it("a fractional cap is truncated, so the count agrees with the chips drawn", async () => {
    const { name, address } = message(three).from;
    const t = createTranslator({ locale: "en", messages: en, namespace: "message" });
    const { container } = render(
      <MessageHead
        sender={{ name: name!, address }}
        stamp={{ when: "", full: false, title: "" }}
        to={[{ word: "to", people: three.map((person) => ({ name: person.name! })) }]}
        details={{
          label: "details",
          open: false,
          max: 2.7,
          lines: [],
          more: (_group, shown) => {
            const count = three.length - shown.length;
            return { text: t("moreRecipients", { count }), name: t("moreRecipientsAriaOnly") };
          },
        }}
      />,
    );
    const field = within(container).getByText("to", { exact: true }).parentElement!;
    expect(recipientButtons(field)).toHaveLength(2);
    expect(within(field).getByRole("button", { name: "Show every recipient" }).textContent)
      .toContain("and 1 other");
  });
});

/* ══ A FOLDED FIELD IS ONE LINE — a name that does not fit goes to the count ═══════════════ */

describe("a folded field hands a cut name to the count", () => {
  /* jsdom lays nothing out. A name is clipped when its field exceeds the fixture's capacity. */
  const cutWhileMoreThan = (fits: number) => {
    const chip = 'button[aria-haspopup="dialog"]';
    const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", {
      ...client,
      get(this: Element): number {
        return this.matches(chip) ? 50 : client.get!.call(this);
      },
    });
    Object.defineProperty(Element.prototype, "scrollWidth", {
      ...scroll,
      get(this: Element): number {
        const field = this.matches(chip) ? this.closest("[data-recipient-field]") : null;
        return field && field.querySelectorAll(chip).length > fits ? 100 : scroll.get!.call(this);
      },
    });
    return () => {
      Object.defineProperty(Element.prototype, "clientWidth", client);
      Object.defineProperty(Element.prototype, "scrollWidth", scroll);
    };
  };
  const five: Addr[] = [...three, { name: "Di Falk", address: "di@x.invalid" }, { name: "Ed Holm", address: "ed@x.invalid" }];

  it("drops names until the rest fit whole, and the count grows to match", async () => {
    const restore = cutWhileMoreThan(2);
    try {
      const card = await mountRecipientLetter(message(five));
      const field = card.getByText("to", { exact: true }).parentElement!;
      expect(recipientButtons(field).map((chip) => chip.textContent)).toEqual(["Anna Roth", "Bo Lind"]);
      expect(card.getByRole("button", { name: /^to Anna Roth, Bo Lind and 3 others/i }).textContent)
        .toContain("and 3 others");
    } finally { restore(); }
  });

  it("never drops the last name — a lone long name stays, the count beside it", async () => {
    const restore = cutWhileMoreThan(0);
    try {
      const card = await mountRecipientLetter(message(five));
      const field = card.getByText("to", { exact: true }).parentElement!;
      expect(recipientButtons(field).map((chip) => chip.textContent)).toEqual(["Anna Roth"]);
      const count = card.getByRole("button", { name: /^to Anna Roth and 4 others/i });
      expect(count.textContent).toContain("and 4 others");
      // Expanded, every name is back: the measure only ever trims the fold.
      await click(count);
      expect(recipientButtons(field)).toHaveLength(5);
    } finally { restore(); }
  });
});

/* ══ THE PRESS STOPS INSIDE THE POPOVER TOO ════════════════════════════════════════════════ */

describe("a press on the popover's own items does not expand the card under it", () => {
  it("pressing Copy leaves the card collapsed", async () => {
    stubDom();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await mountShell("#/reads", [shellMessage("news-copy", {
        folder: "ohmail/News", to: three, physicalFolder: "INBOX",
      })], [], { reader: BROWSER_READER });
      await click(registeredCard().getByRole("button", { name: "Anna Roth" }));
      const contact = within(screen.getByRole("dialog", { name: "Options for Anna Roth" }));
      await click(contact.getByRole("button", { name: "Copy address" }));
      expect(writeText.mock.calls).toEqual([[three[0]!.address]]);
      expect(registeredCard().getByRole("button", { name: "Expand" })).toBeTruthy();
      expect(registeredCard().queryByRole("button", { name: "Collapse" })).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      await unmountShells();
    }
  });

  it("a press on the popover's head is stopped as well", async () => {
    const { address } = mountRegisteredReads(three);
    await click(registeredCard().getByRole("button", { name: "Anna Roth" }));
    const contact = within(screen.getByRole("dialog", { name: "Options for Anna Roth" }));
    await click(contact.getByText("Anna Roth", { exact: true }));
    expect(registeredCard().getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(address.read()).toBe("#/reads");
  });
});

/* ══ THE DISCLOSURE'S ACCESSIBLE NAME FOLLOWS ITS NEXT PRESS ═══════════════════════════════ */

describe("the fold control never announces the opposite of what it does", () => {
  it("collapsed it offers to show, expanded it offers to hide", async () => {
    mountRegisteredReads(three);
    const count = toCount();
    expect(count.getAttribute("aria-label")!.toLowerCase()).toContain("show");
    await click(count);
    const fold = registeredCard().getByRole("button", { name: "Hide the additional details" });
    const hidden = fold.getAttribute("aria-label")!.toLowerCase();
    expect(hidden).not.toContain("show");
    expect(hidden).toContain("hide");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });

  it("the German face says it in German", async () => {
    const card = await mountRecipientLetter(message(three), { locale: "de", expand: false });
    await click(card.getByRole("button", { name: /und 1 weitere/ }));
    const details = card.getByRole("button", { name: "Weitere Angaben ausblenden" });
    expect(details.getAttribute("aria-label")).toBe("Weitere Angaben ausblenden");
  });
});

/* ══ THE CHIP IS A DISCLOSURE — THE REAL PRESS SEQUENCE, NOT JUST THE CLICK ════════════════ */

/**
 * A REAL PRESS IS mousedown THEN click, AND ONLY THE PAIR SHOWS THIS.
 *
 * `MoreMenu` dismisses on `mousedown` and excludes its `anchor`; the chip's own handler toggles
 * on `click`. Both halves are needed and they are on DIFFERENT events, so a test that dispatches
 * `click` alone exercises the toggle while the dismiss listener never runs — and passes with the
 * `anchor` prop deleted. Measured at the rebase: removing `anchor={contactAnchor.current}` left
 * the whole suite green, while in a browser mousedown would dismiss and the click would re-open,
 * so the popover could never be closed by its own chip. That is the defect the prop exists to
 * prevent, restored here at the extraction and now guarded at the event level.
 */
describe("a second press on the chip closes it, under the real event sequence", () => {
  /**
   * TWO ACTS, WITH A RENDER BETWEEN THEM — and that detail is the whole test.
   *
   * Dispatched inside ONE `act`, React batches the pair: the dismiss sets the state to null and
   * the click handler still reads the PREVIOUS render's closure, where the popover is open, so
   * it toggles closed and everything passes — with or without the fix. A browser commits between
   * the two events, the click's closure then reads null, and the toggle RE-OPENS what the
   * dismiss just closed. Measured: batched, deleting `anchor` stayed green; unbatched, it fails.
   */
  const press = async (el: Element): Promise<void> => {
    await act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  it("mousedown+click on the open chip closes it — the trigger is excluded from the dismiss", async () => {
    const article = await mountRecipientLetter(message(three));
    const chip = article.getByRole("button", { name: "Anna Roth" });
    await press(chip);
    expect(screen.queryByRole("dialog", { name: "Options for Anna Roth" }), "the first press must open it").toBeTruthy();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await press(chip);
    expect(screen.queryByRole("dialog", { name: "Options for Anna Roth" }), "the second press must CLOSE it, not re-open it").toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("a mousedown somewhere else still dismisses — the exclusion is the trigger, not everything", async () => {
    mountRegisteredReads(three);
    await press(registeredCard().getByRole("button", { name: "Anna Roth" }));
    const name = "Options for Anna Roth";
    const contact = screen.getByRole("dialog", { name });
    const backdrop = contact.parentElement!.querySelector("[data-veil]");
    expect(backdrop, "there is no outside press surface").toBeTruthy();
    fireEvent.pointerDown(backdrop!);
    expect(screen.queryByRole("dialog", { name }), "an outside press must still dismiss").toBeNull();
  });
});

/* ══ THE ACCESSIBLE NAME PROMISES ONLY WHAT IS BEHIND THE PRESS ════════════════════════════ */

/**
 * The name is a CLAIM, and both things it used to claim are optional on the wire: a message with
 * no `Date:` header renders no date row (routine — spam and scripts omit it), and
 * `physicalFolder` is optional. The name said "the exact date and where this message sits"
 * regardless, so a screen-reader user was promised two things and handed one, or none.
 */
describe("the disclosure names only what it will actually reveal", () => {
  it("both present: the wording is unchanged", async () => {
    const card = await mountRecipientLetter(message(three));
    const details = card.getByRole("button", { name: "Show the exact date and where this message sits" });
    expect(details.getAttribute("aria-label")).toBe("Show the exact date and where this message sits");
  });

  it("no folder: it stops claiming a folder", async () => {
    const card = await mountRecipientLetter(without(message(three), { folder: true }));
    const details = card.getByRole("button", { name: "Show the exact date" });
    expect(details.getAttribute("aria-label")).toBe("Show the exact date");
  });

  it("no date: it stops claiming a date", async () => {
    const card = await mountRecipientLetter(without(message(three), { date: true }));
    const details = card.getByRole("button", { name: "Show where this message sits" });
    expect(details.getAttribute("aria-label")).toBe("Show where this message sits");
  });

  const ariaOf = (): string => fold()!.getAttribute("aria-label")!;

  it("folded, and neither optional field: it claims the recipients alone", async () => {
    await mountReads(without(message(three), { date: true, folder: true }));
    expect(ariaOf()).toBe("To Anna Roth, Bo Lind and 1 other. Show every recipient");
    expect(fold()!.textContent).toContain("and 1 other");
  });

  it("folded with a date only, and with a folder only", async () => {
    await mountReads(without(message(three), { folder: true }));
    expect(ariaOf()).toBe("To Anna Roth, Bo Lind and 1 other. Show every recipient and the exact date");
    await unmountAll();
    await mountReads(without(message(three), { date: true }));
    expect(ariaOf()).toBe("To Anna Roth, Bo Lind and 1 other. Show every recipient and where this message sits");
  });

  it("nothing behind the press at all: there is no press", async () => {
    // No names held back, no date, no folder — the control would open an empty list. The chips
    // stay; the dead control goes, which is the rule the header's own menu already keeps.
    const card = await mountRecipientLetter(without(message(three), { date: true, folder: true }));
    const field = card.getByText("to", { exact: true }).parentElement!;
    expect(field.parentElement!.querySelector("button[data-details]"), "a disclosure rendered with nothing behind it").toBeNull();
    expect(recipientButtons(field), "the chips went with it").toHaveLength(3);
  });

  it("the German face makes the same distinctions", async () => {
    const card = await mountRecipientLetter(without(message(three), { folder: true }), { locale: "de" });
    const details = card.getByRole("button", { name: "Das genaue Datum anzeigen" });
    expect(details.getAttribute("aria-label")).toBe("Das genaue Datum anzeigen");
  });
});

/* ══ THE FOLD IS ONE DISCLOSURE FOR THE KEYBOARD AND THE SCREEN READER ═════════════════════ */

describe("the count keeps focus, always folds back, and says what it counts", () => {
  const six: Addr[] = [...three, { name: "Di Falk", address: "di@x.invalid" },
    { name: "Ed Holm", address: "ed@x.invalid" }, { name: "Fe Berg", address: "fe@x.invalid" }];

  it("a keyboard press on the count leaves focus on the expanded control, and back", async () => {
    const card = await mountRecipientLetter(message(six));
    const count = () => card.getByRole("button", { name: /^to Anna Roth, Bo Lind, Cy Cole and 3 others/i });
    count().focus();
    await click(document.activeElement);
    const hide = card.getByRole("button", { name: "Hide the additional details" });
    expect(document.activeElement, "focus fell to the page").not.toBe(document.body);
    expect(document.activeElement).toBe(hide);
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    await click(document.activeElement);
    const field = card.getByText("to", { exact: true }).parentElement!;
    expect(recipientButtons(field)).toHaveLength(3);
    expect(document.activeElement).toBe(count());
    expect(count().getAttribute("aria-expanded")).toBe("false");
  });

  it("a letter with no date and no folder still folds back after it was expanded", async () => {
    const card = await mountRecipientLetter(without(message(six), { date: true, folder: true }));
    const count = () => card.getByRole("button", { name: /^to Anna Roth, Bo Lind, Cy Cole and 3 others/i });
    const field = card.getByText("to", { exact: true }).parentElement!;
    await click(count());
    expect(recipientButtons(field)).toHaveLength(6);
    const hide = card.getByRole("button", { name: "Hide the additional details" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    await click(hide);
    expect(recipientButtons(field).map((chip) => chip.textContent)).toEqual(["Anna Roth", "Bo Lind", "Cy Cole"]);
    expect(count().textContent).toContain("and 3 others");
  });

  it("the count's accessible name carries the field, the names and the count", async () => {
    await mountRecipientLetter(message([{ name: null, address: "me@x.invalid" }, ...six], six), { own: ["me@x.invalid"] });
    host = screen.getByRole("region", { name: en.news.stream.label });
    const [toCount, ccCount] = within(host!).queryAllByRole("button")
      .filter((button) => button.getAttribute("data-details"));
    expect(toCount!.getAttribute("aria-label")).toBe(
      "To you, Anna Roth, Bo Lind and 4 others. Show every recipient, the exact date and where this message sits");
    expect(ccCount!.getAttribute("aria-label")).toBe(
      "Cc Anna Roth, Bo Lind, Cy Cole and 3 others. Show every recipient, the exact date and where this message sits");
  });

  it("the German count says it in German", async () => {
    await mountRecipientLetter(without(message(six), { folder: true }), { locale: "de" });
    host = screen.getByRole("region", { name: de.news.stream.label });
    expect(fold()!.getAttribute("aria-label")).toBe(
      "An Anna Roth, Bo Lind, Cy Cole und 3 weitere. Alle Empfänger und das genaue Datum anzeigen");
  });
});
