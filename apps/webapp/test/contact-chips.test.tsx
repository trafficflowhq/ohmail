/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";

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

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

/** A webapp file, whether the suite runs from the repo root or from `apps/webapp`. */
function repoFile(rel: string): string {
  const path = [resolve(process.cwd(), rel), resolve(process.cwd(), "apps/webapp", rel)].find(existsSync);
  expect(path, `could not find ${rel} from ${process.cwd()}`).toBeTruthy();
  return path!;
}

/** The IDN pair the round-trip guard runs on — stored A-label, readable form. */
const ACE = "xn--mller-kva.example";
const UNI = "müller.example";

interface Addr {
  name: string | null;
  address: string;
}

function msg(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "m1",
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "Quote",
    from: { name: "Sender One", address: "sender@example.invalid" },
    to: [
      { name: "Anna Roth", address: "anna@x.invalid" },
      { name: null, address: "bare@x.invalid" },
    ] satisfies Addr[],
    cc: [{ name: "Cy Cole", address: "cy@x.invalid" }] satisfies Addr[],
    date: "2026-08-01T09:00:00.000Z",
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What `writeTo` was handed: `"address"` or `"address|name"`. */
let wrote: string[] = [];
/** What `screenAddress` was handed: `"messageId|address"` plus whether an anchor element came. */
let screened: string[] = [];
let screenAnchors: Array<HTMLElement | null> = [];
/** Everything handed to the clipboard. */
let copied: string[] = [];
/** Whether the chrome wires the two verbs at all — `false` is the inert branch. */
let wired = true;
let ownAddresses: string[] = [];
let ownName: string | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountHeader(open: Record<string, unknown>): Promise<void> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            ownAddresses,
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => [],
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string, state: "full", html: null,
              loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            hydrateThread: () => {},
            ...(ownName !== null ? { ownNameOf: () => ownName } : {}),
            ...(wired
              ? {
                  writeTo: (address: string, name?: string) => { wrote.push(name ? `${address}|${name}` : address); },
                  screenAddress: (messageId: string, address: string, anchor: HTMLElement | null) => {
                    screened.push(`${messageId}|${address}`);
                    screenAnchors.push(anchor);
                  },
                }
              : {}),
          },
          children: h(MessagePane as never, {
            message: open, tags: [], now: NOW,
            onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

/** Every rendered chip, in DOM order. */
const chips = (): HTMLButtonElement[] => [...host!.querySelectorAll<HTMLButtonElement>(".rcpt-chip")];
const chipByText = (text: string): HTMLButtonElement | undefined =>
  chips().find((c) => (c.textContent ?? "").includes(text));
const popover = (): HTMLElement | null => host!.querySelector<HTMLElement>(".cpop");
const items = (): HTMLButtonElement[] => [...(popover()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const itemByText = (text: string): HTMLButtonElement | undefined =>
  items().find((i) => (i.textContent ?? "").includes(text));

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    (node as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  setActiveFormatZone("UTC");
  wrote = [];
  screened = [];
  screenAnchors = [];
  copied = [];
  wired = true;
  ownAddresses = [];
  ownName = null;
  // jsdom carries no clipboard; the popover's Copy is driven through this stub.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
  });
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

/* ══ THE BLOCK — To and Cc written out, every recipient a chip ═════════════════════════════ */

describe("the recipients block: names, folded when the letter went to many", () => {
  it("a small letter names everyone — no count stands in for a person", async () => {
    await mountHeader(msg());
    const block = host!.querySelector(".msg-rcpts");
    expect(block, "no recipients block rendered").toBeTruthy();
    expect(chips()).toHaveLength(3);
    expect(block!.textContent).not.toMatch(/other/);
  });

  it("a letter to 34 people folds To to one line of three names and a count, Cc likewise", async () => {
    const people = (n: number, tag: string): Addr[] =>
      Array.from({ length: n }, (_, i) => ({ name: `${tag} Person${i + 1}`, address: `${tag.toLowerCase()}${i + 1}@example.com` }));
    ownAddresses = ["to5@example.com"];
    await mountHeader(msg({ to: people(34, "To"), cc: people(4, "Cc") }));
    const rows = [...host!.querySelectorAll<HTMLElement>(".rcpt-row")];
    expect(rows).toHaveLength(2);
    // The reader's own address comes first in its field, as "you".
    expect([...rows[0]!.querySelectorAll(".rcpt-chip")].map((c) => c.textContent))
      .toEqual(["you", "To Person1", "To Person2"]);
    expect(rows[0]!.querySelector(".msg-rcpt-more")!.textContent).toContain("and 31 others");
    expect(rows[1]!.querySelectorAll(".rcpt-chip")).toHaveLength(3);
    expect(rows[1]!.querySelector(".msg-rcpt-more")!.textContent).toContain("and 1 other");
    // Expanding names all 38, and the press becomes the collapse.
    await click(rows[0]!.querySelector(".msg-rcpt-more"));
    expect(chips()).toHaveLength(38);
    expect(host!.querySelector(".msg-rcpt-more")!.getAttribute("aria-expanded")).toBe("true");
    expect(host!.querySelector(".msg-rcpt-full"), "the details opened with the names").toBeTruthy();
    await click(host!.querySelector(".msg-rcpt-more"));
    expect(chips()).toHaveLength(6);
  });

  it("labels the rows To and Cc, with the Cc person under the Cc label", async () => {
    await mountHeader(msg());
    const rows = [...host!.querySelectorAll<HTMLElement>(".rcpt-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".rcpt-k")!.textContent).toBe("To");
    expect(rows[1]!.querySelector(".rcpt-k")!.textContent).toBe("Cc");
    expect(rows[1]!.textContent).toContain("Cy Cole");
  });

  it("a named chip reads the name alone, its address on the title; a no-name one prints the address once", async () => {
    await mountHeader(msg());
    const anna = chipByText("Anna Roth")!;
    expect(anna.textContent).toBe("Anna Roth");
    expect(anna.title).toBe("anna@x.invalid");
    const bare = chipByText("bare@x.invalid")!;
    expect(bare.textContent).toBe("bare@x.invalid");
  });

  it("renders NO block when there is no To and no Cc — never a dangling label", async () => {
    await mountHeader(msg({ to: [], cc: [] }));
    expect(host!.querySelector(".msg-rcpts")).toBeNull();
  });

  it("every chip is a real <button> — focusable, not a styled span", async () => {
    await mountHeader(msg());
    for (const c of chips()) expect(c.tagName).toBe("BUTTON");
  });
});

/* ══ LEFT ALIGNMENT — the block sits on the body text's own left edge ══════════════════════ */

describe("the block is left-aligned to the body text", () => {
  it("is a direct child of the panel flow, sibling of the body — not nested under the sender", async () => {
    await mountHeader(msg());
    const block = host!.querySelector(".msg-rcpts")!;
    // The structural half: the block must not live inside the from-line (whose avatar would
    // indent it) — it stands in the same flow the body prose stands in.
    expect(block.closest(".msg-from"), "the block is nested inside the from-line").toBeNull();
  });

  it("the stylesheet gives the block no left indent — margin and padding stay on the panel edge", () => {
    const css = readFileSync(repoFile("app/app.css"), "utf8");
    const rule = /\.msg-rcpts\s*\{([^}]*)\}/.exec(css);
    expect(rule, "app.css carries no .msg-rcpts rule").toBeTruthy();
    expect(rule![1]).not.toMatch(/margin-left|padding-left|text-indent/);
    // A shorthand may only set a zero left half: `margin: 10px 0 0` is fine, `margin: 0 0 0 24px` is not.
    const shorthand = /margin:\s*([^;]+);/.exec(rule![1]);
    if (shorthand) {
      const parts = shorthand[1]!.trim().split(/\s+/);
      expect(parts.length, "a 4-part margin shorthand smuggles in a left indent").toBeLessThan(4);
    }
  });
});

/* ══ THE POPOVER — exactly Copy address · Everything from and to this address · Write · Screener settings ══ */

describe("the contact popover", () => {
  it("opens on a chip press with exactly the four verbs, in order", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    expect(popover()).toBeTruthy();
    expect(items().map((i) => i.textContent)).toEqual([
      "Copy address", "Everything from and to this address", "Write", "Screener settings",
    ]);
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

  /**
   * THE GUARD THE SLICE IS NAMED FOR. `openSenderMenu` resolves "the sender of message X", so
   * wiring the Screener item with the message id alone would open the sheet on the SENDER —
   * a control labelled for the Cc'd person that rules on somebody else. The CC ADDRESS must
   * travel beside the id. Mutation: drop the address from the dispatch — red here.
   */
  it("Screener settings dispatches the CHIP'S address — the Cc person, not the message's sender", async () => {
    await mountHeader(msg());
    await click(chipByText("Cy Cole"));
    await click(itemByText("Screener settings"));
    expect(screened).toEqual(["m1|cy@x.invalid"]);
    expect(screened[0]).not.toContain("sender@example.invalid");
    // Anchored on the chip, so the sheet opens where the press was.
    expect(screenAnchors[0]).toBeInstanceOf(HTMLElement);
    expect(popover()).toBeNull();
  });

  it("one popover at a time — pressing a second chip re-points it", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    await click(chipByText("Cy Cole"));
    const open = [...host!.querySelectorAll(".cpop")];
    expect(open).toHaveLength(1);
    expect(open[0]!.textContent).toContain("Cy Cole");
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
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(popover(), "an outside press must close the popover").toBeNull();
  });
});

/* ══ INERT CHROME — items are OMITTED, the chip and Copy survive ═══════════════════════════ */

describe("inert chrome: the branch production desktop and every bare harness take", () => {
  it("omits Write and Screener settings — the popover still opens, Copy still works", async () => {
    wired = false;
    await mountHeader(msg());
    const chip = chipByText("Anna Roth")!;
    expect(chip.tagName).toBe("BUTTON");
    await click(chip);
    expect(popover(), "the popover must open even with nothing but Copy in it").toBeTruthy();
    // The address view rides the hash router, which every host has — so it stays, like Copy.
    expect(items().map((i) => i.textContent)).toEqual(["Copy address", "Everything from and to this address"]);
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
    await mountHeader(msg({ to: [{ name: null, address: `sarada@${ACE}` }], cc: [] }));
    await click(chipByText(`sarada@${UNI}`));
    await click(itemByText("Write"));
    await click(chipByText(`sarada@${UNI}`));
    await click(itemByText("Screener settings"));
    expect(wrote).toEqual([`sarada@${ACE}`]);
    expect(screened).toEqual([`m1|sarada@${ACE}`]);
  });
});

/* ══ Tab+Enter opens, Escape dismisses, the menu roves ══════════════════════════════ */

describe("keyboard", () => {
  it("the chip is a disclosure: haspopup, live expanded, and focus lands in the menu", async () => {
    await mountHeader(msg());
    const chip = chipByText("Anna Roth")!;
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
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

  it("ArrowDown roves through the items", async () => {
    await mountHeader(msg());
    await click(chipByText("Anna Roth"));
    await act(async () => {
      items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(items()[1]);
  });
});

/* ══ THE APPSHELL WIRING — source-held, because the closures are unreachable from a test ═══
   The chain chip → screenAddress → openSenderMenu(id, anchor, ADDRESS) → SenderMenuState.address
   → senderScreening(reader, id, address) lives in `AppShell`'s closures. The resolution itself
   is guarded live in `sender-screening.test.ts` and the sheet's face in
   `sender-sheet-reachable.test.tsx`; what remains is that AppShell actually THREADS the address,
   which — like `attachments-wired.test.ts` before this — is asserted against the comment-stripped
   source, since a wiring that drops the argument is otherwise green everywhere. */

describe("AppShell threads the override", () => {
  const src = readFileSync(repoFile("app/shell/AppShell.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

  it("resolves the sheet from the OVERRIDE address, not the message's sender alone", () => {
    // The list's placement rides after the override (the sheet's "Now in", `sender-sheet-now-in`).
    expect(src).toMatch(/senderScreening\(engine\.verbRead\(\),\s*senderMenu\.messageId,\s*senderMenu\.address(?:,\s*consentView\?\.placeOf)?\)/);
  });

  it("the dispatch and the audit both carry it — the sheet must rule on what it shows", () => {
    expect(src).toMatch(/changeScreening\(senderMenu!\.messageId,[^)]*senderMenu!\.address, press\)/);
    expect(src).toMatch(/openSenderAudit\(senderMenu!\.messageId,[^)]*senderMenu!\.address\)/);
  });

  it("the chrome's screenAddress is the widened openSenderMenu, address riding along", () => {
    expect(src).toMatch(/screenAddress:[\s\S]{0,200}?openSenderMenu\(messageId,\s*anchor,\s*address\)/);
  });

  it("the subject-rule row is withheld under an override — it would rule on the SENDER", () => {
    // `subjectRuleContext` resolves the message's sender; offering the row from a sheet that
    // shows the Cc person would write a rule about somebody the sheet never named.
    expect(src).toMatch(/senderMenu!\.address\s*==\s*null\s*\?[^:]*openSubjectRule/);
  });
});
