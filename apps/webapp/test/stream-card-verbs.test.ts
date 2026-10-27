/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { senderHitOf } from "../app/shell/sender-hit";

/**
 * READS AND RECEIPTS GET THE MESSAGE, NOT A PREVIEW OF IT.
 *
 * Both views read in the card and mount no reading pane, and the two things that hang off a
 * reading pane were therefore missing from them: the message's verbs, and the sender's screening
 * sheet. The same message in the Ohbox had both a click away. Two absences with one shape — a
 * surface built as a skim and then used as a reader.
 *
 * What is asserted here is the wiring, on the surfaces that were missing it:
 *
 *   · the card being read carries the verbs, and the hundreds that are not do not;
 *   · pressing one dispatches the shell's action for THAT message;
 *   · a click on a card's address resolves to the card's message, exactly as a click on a
 *     list row's address resolves to the row's.
 *
 * The hit test is asserted as itself rather than through the shell: it is a pure function of one
 * element (`sender-hit.ts`), and routing it through thousands of lines of shell to press a
 * `<span>` would test the shell's mounting, not the selector that was wrong.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

// jsdom ships no `CSS` object; the view's ↵ binding selects its card with `CSS.escape`.
const g = globalThis as unknown as { CSS?: { escape: (s: string) => string } };
if (!g.CSS) g.CSS = { escape: (s: string) => s };
// …nor a layout, so nothing scrolls. The stream's scroll-to-current is not what is under test.
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");

function msg(id: string): Record<string, unknown> {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `subject of ${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date: "2026-08-03T09:00:00.000Z",
    folder: "INBOX",
    snippet: `snippet of ${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-03T09:00:00.000Z",
  };
}

const ONE = msg("one");
const TWO = msg("two");

let host: HTMLDivElement | null = null;
let root: Root | null = null;
/** Every `(action, message.id)` the view dispatched. */
let dispatched: Array<[string, string]> = [];

/** Mount Reads with `one` under the cursor and `two` merely present. */
async function mountReads(opts: { wired: boolean }): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  // The view registers j/k/↵ on mount, as it does in the shell.
  const { KeymapProvider } = await import("../app/shell/keymap.js");

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, { children: h(MessageChromeProvider as never, {
          value: {
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => [],
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string,
              state: "snippet",
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
          },
          children: h(ReadsView as never, {
    settled: true, owed: false,
            partition: { fresh: [ONE, TWO], seen: [], waterline: null },
            tags: [],
            now: NOW,
            cur: "one",
            onCur: () => {},
            aiChip: null,
            chipState: null,
            onChipState: () => {},
            markSeen: () => {},
            isSeen: () => true,
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string, state: "snippet", html: null,
              loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            jumpTo: null,
            onJumped: () => {},
            // The shell's `onMessageAction`, or nothing at all — a view mounted without a shell
            // must show no bar rather than a bar with nothing behind it.
            ...(opts.wired
              ? { onAction: (a: string, m: { id: string }) => { dispatched.push([a, m.id]); } }
              : {}),
          } as never),
        } as never) }),
      }),
    );
  });
}

const cardOf = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`.scast[data-sid="${id}"]`)!;
const buttonsIn = (el: Element): string[] =>
  [...el.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

beforeEach(() => {
  dispatched = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const clickCard = async (id: string): Promise<void> => {
  await act(async () => {
    cardOf(id).click();
    await Promise.resolve();
  });
};

describe("the card being read carries the message's verbs", () => {
  it("keeps the bar off a card the cursor merely rests on (scroll must not surface it)", async () => {
    await mountReads({ wired: true });

    // `cur` is "one" — the scroll-spy's current card. Gating the bar on `current` made it pop in
    // on every card a reader scrolled past; the bar now follows EXPANSION, so a cursor alone
    // shows nothing.
    expect(
      cardOf("one").querySelector(".sc-actions"),
      "the bar appeared on the current card with no click — a scroll surfaces the reply pill",
    ).toBeNull();
    expect(cardOf("two").querySelector(".sc-actions")).toBeNull();
  });

  it("surfaces the bar on the card the reader clicks, and on no other", async () => {
    await mountReads({ wired: true });
    await clickCard("one");

    const cur = cardOf("one").querySelector(".sc-actions");
    expect(cur, "clicking a card did not expand it and raise its verbs").not.toBeNull();
    expect(buttonsIn(cur!)).toContain("Reply");
    expect(buttonsIn(cur!)).toContain("Later");

    expect(
      cardOf("two").querySelector(".sc-actions"),
      "a second card mounted a bar — the bar is single, on the expanded card",
    ).toBeNull();
  });

  it("dispatches the shell's action, for the message the bar is on", async () => {
    await mountReads({ wired: true });
    await clickCard("one");

    const later = [...cardOf("one").querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Later")!;
    await act(async () => {
      later.click();
      await Promise.resolve();
    });

    expect(dispatched, "the bar rendered but nothing reached the shell").toEqual([["later", "one"]]);
  });

  it("shows NO bar at all when the view is mounted without one", async () => {
    await mountReads({ wired: false });
    expect(
      host!.querySelector(".sc-actions"),
      "a control with nothing behind it — every press would answer 'that did not work'",
    ).toBeNull();
  });
});

/**
 * REPLY IN PLACE (owner 2026-10-26: "reply in place looks good, build it in"). Reply turns the
 * letter into the Ohbox's conversation where its card stood, the reply joins it after the send,
 * and a letter left with nothing sent gets its card back. Driven through the chrome, the seam the
 * shell answers with: `replyTo`, the conversation and the send lanes.
 */
describe("a letter answered in place", () => {
  const LETTER = { ...msg("one"), threadId: "t1" };
  const SENT = {
    ...msg("sent-1"), threadId: "t1", folder: "Sent", local: true, date: "2026-08-04T11:00:00.000Z",
    from: { name: "Mila", address: "mila@example.com" },
    to: [{ name: "Sender one", address: "one@example.invalid" }],
    snippet: "Thank you, lovely issue.", body: "Thank you, lovely issue.\n\nMila",
  };
  const OLDER = { ...SENT, id: "sent-0", local: false, date: "2026-08-02T09:00:00.000Z" };
  let answer: { replyTo: string | null; conv: Array<Record<string, unknown>>; phases: Record<string, string> };
  let render: () => Promise<void>;

  async function mountAnswer(): Promise<void> {
    const { ReadsView } = await import("../app/views/ReadsView.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
    const { KeymapProvider } = await import("../app/shell/keymap.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const body = (m: Record<string, unknown>) => ({
      text: (m.body as string | undefined) ?? (m.snippet as string), state: "full", html: null,
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    });
    const tree = () => h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, { children: h(MessageChromeProvider as never, {
        value: {
          nowAt: () => NOW, ownAddresses: [], absoluteTime: false, onToggleAbsoluteTime: () => {},
          replyTo: answer.replyTo,
          replyBody: { text: "", html: "" },
          onReplyBody: () => {}, closeReply: () => {}, sendReply: () => {},
          replyEnvelope: null, replyFromId: null, replyAttachments: [], replySubjectEdit: null,
          replySig: { mode: "following" }, replySendShowing: null,
          replySendState: (lane: string) => ({ phase: answer.phases[lane] ?? "idle" }),
          openSenderMenu: () => {}, openAttachmentPreview: () => {},
          conversationOf: (id: string) => (answer.conv.some((m) => m.id === id) ? answer.conv : []),
          bodyOf: body, hydrateBody: () => {}, hydrateThread: () => {},
        },
        children: h(ReadsView as never, {
          settled: true, owed: false,
          // A fresh pile per render, as the shell's is per mirror version.
          partition: { fresh: [LETTER, TWO], seen: [], waterline: null },
          tags: [], now: NOW, cur: "one", onCur: () => {},
          aiChip: null, chipState: null, onChipState: () => {}, markSeen: () => {},
          bodyOf: body, hydrateBody: () => {}, jumpTo: null, onJumped: () => {},
          onAction: (a: string, m: { id: string }) => { dispatched.push([a, m.id]); },
        } as never),
      } as never) }),
    });
    render = async () => { await act(async () => { root!.render(tree()); await Promise.resolve(); }); };
    await render();
    await render();
  }

  const placed = (): HTMLElement | null => host!.querySelector<HTMLElement>(".scast[data-sid='one'].in-place");
  const rowOf = (id: string): HTMLElement => host!.querySelector<HTMLElement>(`.row[data-id='${id}']`)!;

  beforeEach(() => {
    answer = { replyTo: null, conv: [], phases: {} };
  });

  it("at rest nothing is a conversation; Reply makes the letter one, in its own card's element", async () => {
    await mountAnswer();
    const card = cardOf("one");
    expect(host!.querySelector(".conv")).toBeNull();
    answer.replyTo = "one";
    await render();
    expect(cardOf("one"), "the same element").toBe(card);
    expect(placed()?.querySelectorAll(".conv[data-stream] > article.pm")).toHaveLength(1);
    expect(placed()?.querySelector(".reply-dock .reply[data-reply-for]")).not.toBeNull();
    expect(placed()?.querySelector(".abar-tag"), "the streams' verbs carry no Tag").toBeNull();
    expect(cardOf("two").classList.contains("in-place")).toBe(false);
  });

  it("the reply joins as a second panel with its square, and the row reads as yours", async () => {
    answer.conv = [LETTER];
    await mountAnswer();
    answer.replyTo = "one";
    await render();
    answer.conv = [LETTER, SENT];
    answer.replyTo = null;
    await render();
    expect(placed()?.querySelectorAll(".conv > article.pm")).toHaveLength(2);
    const squares = [...placed()!.querySelectorAll<HTMLElement>(".thread-marks .tm-mb")];
    expect(squares.map((b) => b.dataset.for)).toEqual(["one", "sent-1"]);
    expect(squares[1]!.querySelector(".tm-sq.mine")).not.toBeNull();
    const reply = placed()!.querySelector("[data-conv-id='sent-1']")!;
    expect([...reply.querySelectorAll("p")].map((p) => p.textContent?.trim()), "the paragraph break")
      .toEqual(expect.arrayContaining(["Thank you, lovely issue.", "Mila"]));
    expect(rowOf("one").querySelector(".who")?.textContent).toBe("Me → Sender one");
    expect(rowOf("one").querySelector(".addr")).toBeNull();
    expect(rowOf("one").querySelector(".prev")?.textContent).toBe("Thank you, lovely issue.");
  });

  it("a handed-off send keeps it in place; a failed one gives the card back", async () => {
    await mountAnswer();
    answer.replyTo = "one";
    await render();
    answer.replyTo = null;
    answer.phases = { one: "sending" };
    await render();
    expect(placed(), "the dock closed at the press while the send is on its way").not.toBeNull();
    answer.phases = { one: "failed" };
    await render();
    expect(placed()).toBeNull();
    expect(cardOf("one").querySelector(".sc-head")).not.toBeNull();
  });

  it("Esc with nothing sent gives the card back, an own reply that was already there included", async () => {
    for (const conv of [[], [OLDER, LETTER]]) {
      answer = { replyTo: null, conv, phases: {} };
      await mountAnswer();
      answer.replyTo = "one";
      await render();
      expect(placed()).not.toBeNull();
      answer.replyTo = null;
      await render();
      expect(placed(), `${conv.length} members at entry`).toBeNull();
      expect(cardOf("one").querySelector(".sc-head")).not.toBeNull();
      expect(host!.querySelector(".conv")).toBeNull();
      await act(async () => { root!.unmount(); });
      host!.remove();
      root = null;
      host = null;
    }
  });

  it("the in-place bar dispatches for the letter", async () => {
    await mountAnswer();
    answer.replyTo = "one";
    await render();
    const later = [...placed()!.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("Later"))!;
    await act(async () => { later.click(); await Promise.resolve(); });
    expect(dispatched).toContainEqual(["later", "one"]);
  });
});

describe("a sender's address is the handle on the sender, on cards as on rows", () => {
  const dom = (html: string): HTMLElement => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  };

  it("resolves a click on a stream card's address to the card's message", () => {
    const el = dom('<article class="scast" data-sid="m1"><div class="sc-line"><span class="addr">a@b.c</span></div></article>');
    const addr = el.querySelector(".addr")!;
    const hit = senderHitOf(addr);
    expect(hit?.id, "clicking a card's address found no message — the gesture is dead in Reads and Receipts")
      .toBe("m1");
    expect(hit?.anchor, "the popover was anchored to the text rather than to the card")
      .toBe(el.querySelector(".scast"));
  });

  it("still resolves both handles on a list row", () => {
    const el = dom('<button class="row" data-id="m2"><span class="av"></span><span class="addr">a@b.c</span></button>');
    expect(senderHitOf(el.querySelector(".av"))?.id).toBe("m2");
    expect(senderHitOf(el.querySelector(".addr"))?.id).toBe("m2");
  });

  it("answers nothing for the rest of the card, so an ordinary click stays ordinary", () => {
    const el = dom('<article class="scast" data-sid="m3"><h3>subject</h3><p class="sc-body">text</p></article>');
    expect(senderHitOf(el.querySelector("h3")), "the subject opened the screening sheet").toBeNull();
    expect(senderHitOf(el.querySelector(".sc-body"))).toBeNull();
  });
});
