/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { shellFrameOf } from "./source-anchor.js";

/**
 * THE OPEN MESSAGE'S TAGS FOLD INTO A DISCLOSURE, AND ITS STAMP FLIPS TO THE EXACT DATE ON CLICK.
 *
 *  · TAGS. The reader's own marks used to render as a row of full colour chips directly under
 *    the subject, louder than the sender. They now live in the same `(i)` disclosure the list
 *    explainers use (`InfoNote`/`.tag-note`): a quiet "{n} tags" line that opens to the chips. The
 *    LIST rows are untouched — a tag there is a scanning aid at row scale — so `MessageRow` still
 *    renders its chips inline.
 *
 *    R7-2 moved the ADD affordance out of this row entirely: the `+ Tag` chip is a verb of the
 *    action pill now, not chrome under the title. The assigned chips stayed exactly where they
 *    were, which is the half of the report that asked for nothing to change.
 *
 *  · STAMP. Every stamp shows the relative time with the exact instant on hover; clicking any
 *    one flips ALL of them (here, the one on screen) to the absolute form, driven by a shell-level
 *    boolean on the chrome. It is a `<button>`, so the flip is keyboard-reachable.
 *
 * The pane is driven through `MessageChromeProvider` exactly as the shell drives it — the
 * production seam, not a stub of it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "Quote for the north elevation",
    from: { name: "Ada Lovelace", address: "ada@example.invalid" },
    to: [],
    cc: [],
    date: "2026-07-28T14:32:00.000Z",
    folder: "INBOX",
    snippet: "the body",
    body: "the body",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-05T14:32:00.000Z",
    ...over,
  };
}

const WORK_TAG = { id: "work", name: "Work", hue: "moss" };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/**
 * A stateful harness: it holds `absoluteTime` and hands the pane a real `onToggleAbsoluteTime`
 * that flips it, so a click on the stamp exercises the whole loop the shell wires — not a prop
 * frozen at mount.
 */
async function mountPane(open: Record<string, unknown>, tags: Array<Record<string, unknown>>): Promise<void> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

  function Harness() {
    const [abs, setAbs] = React.useState(false);
    return h(MessageChromeProvider as never, {
      value: {
        ownAddresses: [],
        absoluteTime: abs,
        onToggleAbsoluteTime: () => setAbs((v) => !v),
        replyTo: null,
        replyBody: { text: "", html: "" },
        onReplyBody: () => {},
        closeReply: () => {},
        sendReply: () => {},
        replySendState: () => ({ phase: "idle" }),
        openSenderMenu: () => {},
        conversationOf: () => [],
        bodyOf: (m: Record<string, unknown>) => ({
          text: (m.body as string | undefined) ?? (m.snippet as string),
          state: "full",
          html: null,
          loadedRemoteContent: false,
          unsubscribe: "no_header",
          unsubscribeUrl: null,
        }),
        hydrateBody: () => {},
        hydrateThread: () => {},
      },
      children: h(MessagePane as never, {
        message: open, tags, now: NOW, onAction: () => {}, onAddTag: () => {},
      } as never),
    } as never);
  }

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Harness) }),
    );
  });
}

const q = <T extends HTMLElement>(sel: string): T | null => host!.querySelector<T>(sel);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await unmount(); vi.useRealTimers(); });

describe("the viewer's tags fold into the disclosure, the list rows do not", () => {
  it("renders the message's tags INSIDE the `(i)` disclosure, not in an inline row after the title", async () => {
    await mountPane(msg({ labels: ["work"] }), [WORK_TAG]);
    const note = q<HTMLDetailsElement>(".tag-note");
    expect(note, "no tag disclosure under the title").not.toBeNull();
    expect(note!.tagName, "the tag pill is not a real `<details>` disclosure").toBe("DETAILS");
    // THE GUARD. Revert the tag move (tags inline after the title) and the "Work" chip (`.tagchip`) is no
    // longer a descendant of the disclosure — it sits in a bare `.chips`/`.msg-signals` row.
    const workChip = q<HTMLElement>(".tag-note .tagchip");
    expect(workChip, "the tag chip is not inside the disclosure").not.toBeNull();
    expect(workChip!.textContent, "the disclosure holds the wrong tag").toContain("Work");
  });

  it("R7-2: THE ADD-TAG AFFORDANCE IS NOT UNDER THE TITLE ANY MORE — it is a verb of the pill", async () => {
    /**
     * ── THIS REVERSES THE CASE IT REPLACES, ON THE OWNER'S SECOND REPORT ─────────────────────
     *
     * What stood here asserted the opposite: a `.addtag` chip inside `.tag-chrome`, outside the
     * `<details>` so `addRef` always had a home. The reasoning was sound for a chip and the chip
     * is the thing that was wrong — *"Tag + is still under the title and not in the Pill shape (I
     * gave this feedback before). Added Tags should stay where they are, but the + Tag element
     * should go into the Pill UI."*
     *
     * So the assertion is not weakened, it is INVERTED and re-pointed: the entry point must be
     * gone from here, and it must exist in the bar. Both halves, or "removed" and "moved" become
     * indistinguishable — which is how a verb gets deleted by a cleanup that reads green.
     * `action-bar.test.ts` owns the rest of the pill's behaviour.
     */
    await mountPane(msg({ labels: ["work"] }), [WORK_TAG]);
    expect(q(".addtag"), "the dashed + Tag chip is back — that is the report, verbatim").toBeNull();
    const inBar = q<HTMLElement>(".abar-tag .abar-b");
    expect(inBar, "the entry point was removed from the title without arriving in the pill").not.toBeNull();
    expect(inBar!.textContent, "the pill's Tag verb lost its label").toContain("Tag");
  });

  it("THE ASSIGNED CHIPS DID NOT MOVE — only the `+` did", async () => {
    // "Added Tags should stay where they are." The disclosure under the title is exactly where
    // they were before this slice, and moving them into the pill alongside the verb would answer
    // a request nobody made.
    await mountPane(msg({ labels: ["work"] }), [WORK_TAG]);
    const chip = q<HTMLElement>(".tag-chrome .tag-note .tagchip");
    expect(chip, "the assigned tag left the disclosure under the title").not.toBeNull();
    expect(chip!.textContent).toContain("Work");
    expect(q(".abar .tagchip"), "assigned chips were moved into the pill").toBeNull();
  });

  it("a message with NO tags renders NO tag row at all — there is nothing left to put in it", async () => {
    // With the add chip gone, `.tag-chrome` on an untagged message would be an empty flex box
    // holding a gap under every untitled message. It used to be kept for the affordance; the
    // affordance is in the bar now, so the row goes with it.
    await mountPane(msg({ labels: [] }), [WORK_TAG]);
    expect(q(".tag-note"), "an untagged message rendered an empty tag disclosure").toBeNull();
    expect(q(".tag-chrome"), "an untagged message still renders an empty tag row").toBeNull();
  });

  it("LIST ROWS ARE UNCHANGED — `MessageRow` still renders its tag chips inline", async () => {
    const { MessageRow } = await import("@ohmail/ui");
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(MessageRow as never, {
          id: "r1", from: "Ada", subject: "Quote", time: "Mon",
          tags: [{ name: "Work", hue: "moss" }],
        } as never),
      );
    });
    // The row's tag is a plain inline chip inside the row — NOT wrapped in any disclosure.
    expect(host!.textContent, "the list row dropped its tag chip").toContain("Work");
    expect(host!.querySelector(".tag-note"), "a list row must not fold its tags").toBeNull();
    expect(host!.querySelector("details"), "a list row must not render a disclosure").toBeNull();
  });
});

describe("the stamp shows relative, exact on hover, and flips ALL stamps on click", () => {
  it("by default shows the relative stamp with the absolute instant on hover", async () => {
    const { displayTime, fullDateTime } = await import("../app/shell/format.js");
    const m = msg();
    const rel = displayTime(m as never, NOW);
    const abs = fullDateTime(m as never);
    expect(rel, "test fixture must have a rel/abs that actually differ").not.toBe(abs);

    await mountPane(m, []);
    const stamp = q<HTMLElement>(".msg-from .stamp-toggle time");
    expect(stamp, "no stamp in the open message header").not.toBeNull();
    expect(stamp!.textContent, "the resting stamp is not the relative form").toBe(rel);
    expect(stamp!.getAttribute("title"), "hover no longer shows the exact date").toBe(abs);
    expect(stamp!.getAttribute("datetime")).toBe(m.date);
  });

  it("clicking the stamp flips it to the absolute form (and the hover title to the relative one)", async () => {
    const { displayTime, fullDateTime } = await import("../app/shell/format.js");
    const m = msg();
    const rel = displayTime(m as never, NOW);
    const abs = fullDateTime(m as never);

    await mountPane(m, []);
    const button = q<HTMLButtonElement>(".msg-from .stamp-toggle")!;
    expect(button.getAttribute("aria-pressed"), "the stamp does not report its toggle state").toBe("false");
    await act(async () => { button.click(); });
    const stamp = q<HTMLElement>(".msg-from .stamp-toggle time")!;
    // THE GUARD. Revert (a bare `<time>` with no toggle) and this stays on the relative form.
    expect(stamp.textContent, "the click did not flip the stamp to the exact date").toBe(abs);
    expect(stamp.getAttribute("title"), "the exact-mode hover no longer offers the relative form").toBe(rel);
    expect(q<HTMLButtonElement>(".msg-from .stamp-toggle")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a letter dated after it arrived is dated by its arrival in both forms", async () => {
    const { setActiveFormatZone } = await import("../app/shell/locale.js");
    setActiveFormatZone("UTC");
    try {
      await mountPane(msg({ date: "2026-08-04T09:00:00.000Z", sortAt: "2026-08-02T09:07:00.000Z" }), []);
      const stamp = (): HTMLElement => q<HTMLElement>(".msg-from .stamp-toggle time")!;
      expect(stamp().getAttribute("datetime")).toBe("2026-08-02T09:07:00.000Z");
      expect(stamp().getAttribute("title")).toBe("Sun 2 Aug 2026, 09:07");
      await act(async () => { q<HTMLButtonElement>(".msg-from .stamp-toggle")!.click(); });
      expect(stamp().textContent).toBe("Sun 2 Aug 2026, 09:07");
    } finally {
      setActiveFormatZone(null);
    }
  });

  it("the flip is reset on a view switch — a `route.view`-keyed effect clears it", () => {
    // The reset lives in the shell (mounting the whole shell here would prove nothing the runtime
    // click above does not); this pins that the shell clears the flag when the view id changes,
    // which is the half the pane cannot own. Move the reset off `route.view` and it turns red.
    const shell = shellFrameOf("toggleAbsoluteTime").source;
    expect(shell, "the absolute-time flag is no longer reset on a view switch").toMatch(
      /setAbsoluteTime\(false\);\s*\}\s*,\s*\[route\.view\]\)/,
    );
  });
});
