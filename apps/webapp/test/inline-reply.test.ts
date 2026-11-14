/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { triage } from "@ohmail/testing";
import messages from "../messages/en.json";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor, settleFirstPaint } from "./_first-paint.js";
import { replyDraftKey } from "../app/shell/mail-send";
import { DEMO_STORAGE_OWNER } from "@ohmail/app-logic/storage/storage-owner";

/** The reply buffer for `id`, in the demo's own partition (this shell mounts in demo mode). */
const replyBuffer = (id: string): string | null => window.localStorage.getItem(replyDraftKey(id, DEMO_STORAGE_OWNER));

/**
 * REPLYING IN CONTEXT — driven through the WHOLE shell, not a stub.
 *
 * The failure this replaces was structural, not cosmetic: Reply called `go("compose")`, so
 * the route changed, the Ohbox unmounted, and the message being answered left the screen.
 * A test that mounted `MessagePane` alone could not have caught that and cannot catch its
 * return — the bug lived in the shell's action handler and in who owns Escape. So this
 * mounts the real `AppShell` in demo mode (fixtures, no network — see
 * `demo-zero-network.test.ts`) and drives it with keys, exactly as that change drives
 * production with CDP.
 *
 * Escape is the assertion that costs the most to get right. Four components had a
 * `document` Escape listener before that change; the reply editor could not simply have added a
 * fifth, because `Reader`'s would have closed the message in the same keypress. The
 * registry owns Escape now and `Reader` is passed `closeOnEscape={false}` — mutate either
 * and "Esc closed the editor and the message is still open" goes red.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom has no matchMedia; the Ohbox asks it whether it is in the split pane. */
function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The whole client, on the fixture world. `#/ohbox` is the default route. */
async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  // The fixtures engine hydrates synchronously but still through a promise chain.
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  /**
   * …AND THEN OPEN A MESSAGE, because the Ohbox no longer opens one by itself.
   *
   * This step used to be implicit: the shell resolved its Ohbox selection through
   * `?? allOhbox[0]`, so arriving at the route put the newest unread message in the reading
   * column with nobody having asked for it. That fallback is gone — a fresh Ohbox rests until
   * somebody picks a row — so every assertion below about "the open message" needs the act
   * that opens one. `j` is that act, and it is the product's own: it is what the resting
   * column tells the reader to press.
   */
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  // A key can open an editor, and the editor is behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
};

/** Editors that are INSIDE a rendered message — the journey's own question.
 *
 *  It selects `.rte-surface` and no longer `textarea`: the reply is a rich editor now, and
 *  `textarea` would answer zero everywhere while every assertion built on it read as "the
 *  editor is closed". The surface is also the element the driver needs — the `.rte` wrapper
 *  carries no TipTap handle. */
const editorsInMessage = (): HTMLElement[] =>
  [...host!.querySelectorAll<HTMLElement>(".reader .msg, .read-col .msg")]
    .flatMap((m) => [...m.querySelectorAll<HTMLElement>(".rte-surface")]);

/** The id of the message the reply editor is open on — the scratch buffer's key. */
const openMessageId = (): string =>
  host!.querySelector<HTMLElement>(".reply[data-reply-for]")?.dataset.replyFor ?? "";

// SELECTOR UPDATED BY THE VIEWER REDESIGN, ASSERTION UNTOUCHED: the subject moved from the
// 24px `h2` into the header's quiet per-message `.msg-subject` line (SUBJECT-D). What is
// asserted — the open pane shows the message that was opened — is exactly what it was.
const openSubject = (): string =>
  host!.querySelector(".reader .msg .msg-subject")?.textContent
  ?? host!.querySelector(".read-col .msg .msg-subject")?.textContent
  ?? "";

/** How many times `needle` occurs in `hay` — non-overlapping, plain string search. */
function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Elements somebody called `scrollIntoView` on, in order.
 *
 * jsdom does not implement it at all, so this is an installed recorder rather than a spy on
 * something real — which is also why `InlineReply` optional-chains the METHOD. A no-op body
 * on purpose: a stub that dispatched `scroll` would arm `useSeenOnScroll` sweeps in whatever
 * else the shell has mounted (see `seen-on-scroll-runaway.test.ts` for what that costs).
 */
const scrolled: Element[] = [];
/** The options each `scrollIntoView` call was given, in step with `scrolled`. */
const scrolledArgs: (ScrollIntoViewOptions | undefined)[] = [];
let hadScrollIntoView: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  setViewport(false);
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  hadScrollIntoView = proto.scrollIntoView;
  scrolled.length = 0;
  scrolledArgs.length = 0;
  proto.scrollIntoView = function record(this: Element, arg?: ScrollIntoViewOptions | boolean) {
    scrolled.push(this);
    scrolledArgs.push(typeof arg === "object" ? arg : undefined);
  };
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView =
    hadScrollIntoView;
});

describe("Reply opens inside the message", () => {
  it("r opens an editor INSIDE the open message and does not change the route", async () => {
    await mountShell();
    const subject = openSubject();
    expect(subject, "the demo Ohbox rendered no message").not.toBe("");
    expect(editorsInMessage()).toHaveLength(0);

    await key("r");

    expect(editorsInMessage().length).toBeGreaterThan(0);
    // The two halves of the complaint: the route did not move, and the message is still
    // on screen with the reply under it.
    // The VIEW is unchanged — the reading itself rides the hash now (`#/ohbox/m/<id>`),
    // so the claim is "no navigation", not "an empty bar". See `message-url.test.tsx`.
    expect(window.location.hash).toMatch(/^#\/ohbox(\/m\/|$)/);
    expect(openSubject()).toBe(subject);
    expect(host!.querySelector(".view-compose")).toBeNull();
  });

  it("the Reply button does the same thing as the key", async () => {
    await mountShell();
    /**
     * SELECTOR UPDATED BY THAT CHANGE, ASSERTION UNTOUCHED.
     *
     * This read `b.textContent?.trim() === "Reply"`. The bar now renders each verb's
     * keyboard shortcut beside it, so the Reply button's `textContent` is `"Replyr"` — the
     * button did not change, its rendered content did, which is the whole point of that
     * slice. Matching on the label WITHOUT the keycap is exactly as specific as the
     * original equality was: it still refuses "Reply all" or any other button whose label
     * merely starts with "Reply".
     */
    const reply = [...host!.querySelectorAll<HTMLButtonElement>(".read-col .msg-actions button")]
      .find((b) => labelWithoutKeycap(b) === "Reply")!;
    await act(async () => { reply.click(); });
    expect(editorsInMessage().length).toBeGreaterThan(0);
    // The VIEW is unchanged — the reading itself rides the hash now (`#/ohbox/m/<id>`),
    // so the claim is "no navigation", not "an empty bar". See `message-url.test.tsx`.
    expect(window.location.hash).toMatch(/^#\/ohbox(\/m\/|$)/);
  });

  it("the message is above the editor, and on screen exactly ONCE", async () => {
    /**
     * CONVERTED, NOT DELETED. This asserted that a `.reply-context` scroller existed above
     * the editor and quoted the sender — the design then reported: *"replying
     * repeats the message which is already visible, this is redundant.."* The editor's quote
     * included the focused message, so its body rendered twice in one scrolling column and
     * the textarea sat below a duplicate of what had just been read.
     *
     * Same two questions, same order — is the mail above the editor, and is the mail there —
     * asked as a COUNT instead of a location. Red both ways: delete the pane's copy and the
     * body count drops to zero; re-introduce a quote and it goes to two.
     *
     * `conversation.test.ts` asks it of a real three-deep thread; the demo world sets
     * `threadId: null` on every fixture row, so what is under test HERE is the shell's own
     * path with no conversation — the exact screen the report came from.
     */
    await mountShell();
    await key("r");
    const scope = host!.querySelector(".read-col .msg")!;
    const editor = scope.querySelector(".reply-editor")!;

    // No quoted context, anywhere.
    expect(scope.querySelector(".reply-context")).toBeNull();

    // The mail, once. `.msg-body` is the only thing that holds it (`ReadingPane`), and the
    // occurrence count catches a copy rendered by anything else.
    const bodies = [...scope.querySelectorAll<HTMLElement>(".msg-body")];
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!.textContent!;
    expect(body.length, "the demo message has no body to count").toBeGreaterThan(40);
    expect(occurrences(scope.textContent ?? "", body)).toBe(1);

    // DOM order IS reading order in one scrolling column: the editor comes after the mail.
    expect(bodies[0]!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("and it brings itself into view, because the mail above it can be taller than the pane", async () => {
    // THE GUARD for the one thing the pane's copy costs. It is no longer a 190px quote: on a
    // deep thread the conversation is as tall as it is, inside the column that scrolls, so an
    // editor that did not scroll itself into view could open below the fold — and an editor
    // nobody can see is the rejected compose dialog, wearing different clothes.
    // Drop the `scrollIntoView` call in `InlineReply` and this goes red.
    await mountShell();
    scrolled.length = 0;
    scrolledArgs.length = 0;
    await key("r");
    const box = host!.querySelector<HTMLElement>(".read-col .reply")!;
    expect(scrolled, "the editor did not scroll itself into view").toContain(box);
    // it is the editor's BOTTOM edge — the Send/Cancel row — that must land on screen, not
    // merely its nearest edge (on a tall editor that was its head, leaving the actions below the
    // fold). Change `block: "end"` back to `"nearest"` and this goes red.
    const at = scrolled.lastIndexOf(box);
    expect(scrolledArgs[at]?.block, "the editor did not scroll its actions row into view").toBe("end");
  });

  it("it no longer apologises for a conversation it is not showing", async () => {
    // This asserted the editor's `.reply-note` — "This is the only message ohmail has on this
    // conversation." — which was a caveat ABOUT the quoted context in the editor. The quote is
    // gone, so the caveat is not merely unnecessary, it would be describing nothing. (It had
    // already replaced "Threading is not built yet", which threading made false; that string stays
    // banned here for the same reason it was banned then.)
    await mountShell();
    await key("r");
    expect(host!.textContent).not.toContain("the only message ohmail has on this conversation");
    expect(host!.textContent).not.toContain("Threading is not built yet");
    // And the mail itself is still on screen — an absent note must not be a stood-down pane.
    expect(host!.querySelectorAll(".read-col .msg .msg-body")).toHaveLength(1);
  });
});

describe("Escape", () => {
  it("closes the editor — and leaves the message where it was", async () => {
    // THE GUARD. Give `Reader` back its own Escape (drop `closeOnEscape={false}` in
    // AppShell) and the second assertion fails in the split pane's sibling case; remove the
    // Escape binding from the registry's cascade and the first fails outright.
    await mountShell();
    await key("r");
    expect(editorsInMessage().length).toBeGreaterThan(0);
    const subject = openSubject();

    await key("Escape");

    expect(editorsInMessage()).toHaveLength(0);
    expect(openSubject()).toBe(subject);
    // The VIEW is unchanged — the reading itself rides the hash now (`#/ohbox/m/<id>`),
    // so the claim is "no navigation", not "an empty bar". See `message-url.test.tsx`.
    expect(window.location.hash).toMatch(/^#\/ohbox(\/m\/|$)/);
  });

  it("closes the editor even when rows are PICKED — the selection must not eat it", async () => {
    // THE GUARD, and a live journey paid for it. The reply journey went red on the hosted service the
    // first time a selection survived from the bulk-select journey into it: "r opened an inline editor but
    // Esc did not close it". The Ohbox declares Escape as a VIEW binding, which outranks the
    // shell's cascade, so a picked set was clearing itself instead of closing the editor.
    // Drop the `chrome.replyTo != null` term from that binding's `disabled` and this fails.
    await mountShell();
    await key("x");                                   // pick the row under the cursor
    expect(host!.querySelector('.list-foot .abar-count [role="status"]')?.textContent).toBe("1");
    await key("r");
    expect(editorsInMessage().length).toBeGreaterThan(0);

    await key("Escape");

    expect(editorsInMessage()).toHaveLength(0);
    // …and the selection is still there, because Escape closed the inner thing, not both.
    expect(host!.querySelector('.list-foot .abar-count [role="status"]')?.textContent).toBe("1");
    // A second Escape is what clears it — the cascade, one layer per press.
    await key("Escape");
    expect(host!.querySelector(".list-foot")).toBeNull();
  });

  it("works from INSIDE the editor, which is where the cursor actually is", async () => {
    // The editor takes focus on open, so an Escape binding without `inInput` would be
    // swallowed by the typing guard and the reported trap would simply move.
    await mountShell();
    await key("r");
    const editor = editorsInMessage()[0]!;
    editor.focus();
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(editorsInMessage()).toHaveLength(0);
  });

  it("Escape leaves Compose too — the other half of 'cant even esc out of it'", async () => {
    await mountShell();
    await act(async () => { window.location.hash = "#/compose"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await settleFirstPaint();
    expect(host!.querySelector(".view-compose")).toBeTruthy();
    await key("Escape");
    // The VIEW is unchanged — the reading itself rides the hash now (`#/ohbox/m/<id>`),
    // so the claim is "no navigation", not "an empty bar". See `message-url.test.tsx`.
    expect(window.location.hash).toMatch(/^#\/ohbox(\/m\/|$)/);
  });
});

/**
 * A bar button's visible label with its keycap removed.
 *
 * The action bar renders `<kbd>` inside each verb, so `textContent` carries the shortcut
 * too — `"Replyr"`. This strips only that element, so an exact-match selector stays exact.
 */
function labelWithoutKeycap(b: Element): string {
  return [...b.childNodes]
    .filter((n) => !(n.nodeType === 1 && (n as Element).tagName === "KBD"))
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

/** The Send button inside the open message's reply editor. */
const sendButton = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".read-col .msg .reply-actions button")]
    .find((b) => b.textContent?.trim().startsWith("Send"))!;

/** Type into the open reply editor — through ProseMirror, which is the only path that
 *  produces a change the shell can see. See `fixtures/rich-editor-driver.ts`. */
async function type(text: string): Promise<void> {
  const editor = editorsInMessage()[0]!;
  await act(async () => { typeInto(editor, text); });
}

/**
 * Let the send's promise chain settle across the TASK boundary a press now crosses.
 *
 * `useMailSend.send` paints the acknowledgement and defers `engine.mutate` to a later task
 * (`afterPaint`); microtasks drain before the task ends, so a `Promise.resolve()` loop never
 * reaches the dispatch at all — the mutation simply never arrives at the adapter.
 *
 * ADVANCED, not awaited: this suite installs FAKE timers (`vi.useFakeTimers()` in its
 * `beforeEach`), so a real `setTimeout` promise never settles and the helper would sit until the
 * case's own deadline — which looks exactly like a hang in the code under test, and did.
 *
 * This does NOT run out the closing beat; see {@link settleClosed}. Most cases here are about
 * what was SENT rather than about the editor going away.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }
}

/**
 * …and then run out the beat a delivered send is held on before the surface closes
 * (`SENT_BEAT_MS`). Only for cases that assert the editor is GONE — that is the one thing the
 * beat delays.
 */
async function settleClosed(): Promise<void> {
  await settle();
  const { SENT_BEAT_MS } = await import("../app/shell/mail-send.js");
  await act(async () => { await vi.advanceTimersByTimeAsync(SENT_BEAT_MS + 80); });
  await settle();
}

describe("sending the reply", () => {
  it("Send is a REAL primary control, and it is inert only while there is nothing to send", async () => {
    // THE GUARD FOR THE GAP ITSELF. The gap was "a primary button that does nothing":
    // `aria-disabled` with the tooltip "Sending is not connected yet." — a claim about the
    // MACHINERY. Since FIX-021 an empty reply's Send is pressable and wears the true reason
    // about the MESSAGE ("Write something or attach a file."), and the press ANSWERS — the
    // sentence renders. The unrepresentable state is unchanged: a primary that does nothing
    // and blames the connection.
    await mountShell();
    await key("r");
    // The demo's letter has a reply draft on the account, which Reply opens: emptied here.
    await type("");
    const btn = sendButton();

    expect(btn.getAttribute("title")).not.toBe("Sending is not connected yet.");
    expect(btn.getAttribute("title")).toBe("Write something or attach a file.");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    // Empty body ⇒ pressable, and the press DOES something: it says what is missing.
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); });
    expect(host!.textContent).toContain("Write something or attach a file.");

    await type("Donnerstag passt.");
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().getAttribute("aria-disabled")).toBeNull();
    expect(sendButton().getAttribute("title")).toBeNull();
    expect(host!.textContent, "the sentence outlived the words").not.toContain("Write something or attach a file.");
  });

  it("⌘↩ sends from inside the editor — the keyboard path, and it is documented", async () => {
    // `inInput` is the load-bearing flag: the editor takes focus on open, so a binding
    // without it would be eaten by the typing guard and the shortcut would exist only in the
    // sheet. Drop `inInput` from the binding and the first assertion fails.
    await mountShell();
    await key("r");
    await type("Donnerstag passt.");
    const editor = editorsInMessage()[0]!;
    editor.focus();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", metaKey: true, bubbles: true, cancelable: true,
      }));
    });
    await settleClosed();

    expect(editorsInMessage()).toHaveLength(0);
    expect(host!.textContent).toContain("Reply sent.");
  });

  it("⌘↩ with an empty editor sends nothing — the guard is not the button's", async () => {
    // The keyboard bypasses `disabled` entirely, which is exactly why `useReplySend.send`
    // consults `canSend` itself rather than trusting the control that called it.
    await mountShell();
    await key("r");
    // The demo's letter has a reply draft on the account, which Reply opens: emptied here.
    await type("");
    const editor = editorsInMessage()[0]!;
    editor.focus();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", metaKey: true, bubbles: true, cancelable: true,
      }));
    });
    await settle();

    // Still open, nothing claimed.
    expect(editorsInMessage().length).toBeGreaterThan(0);
    expect(host!.textContent).not.toContain("Reply sent.");
  });

  it("a send that lands closes the editor, says so, and drops the local draft", async () => {
    await mountShell();
    await key("r");
    await type("Donnerstag passt.");
    const messageId = host!.querySelector<HTMLElement>(".read-col .reply")!.dataset.replyFor!;
    expect(replyBuffer(messageId)).toBe("Donnerstag passt.");

    await act(async () => { sendButton().click(); });
    await settleClosed();

    expect(editorsInMessage()).toHaveLength(0);
    expect(host!.textContent).toContain("Reply sent.");
    // The scratch buffer goes with it — reopening must not resurrect a reply already sent.
    expect(replyBuffer(messageId)).toBeNull();
    // …and the copy that said sending was not connected is gone from the product.
    expect(host!.textContent).not.toContain("Sending is not connected yet");
  });

  it("replying clears the message's Answer Later", async () => {
    // `nadja` is the demo world's first Answer Later message (fixtures `triage.replyLater`), so
    // the pile is non-empty before the reply and one shorter after it. Drop the
    // `triage_set none` from `reply-send.ts:settle` and the last assertion fails.
    //
    // ANSWERED FROM THE PILE, not from the Ohbox. A mail is in exactly one pile: a parked
    // message is in no Ohbox group (`selectors.ts#parkedMessageIds`), so there is no
    // `.row[data-id="nadja"]` there to click — which is what this test used to do, against
    // `giulia`, back when the demo parked that instead.
    const first = triage.replyLater[0]!;
    const second = triage.replyLater[1]!;
    await mountShell();
    window.location.hash = "#/triage";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await settle();
    expect(host!.textContent, `the pile is not showing ${first.messageId}`).toContain(first.subtitle!);
    await key("r");
    await type("Sehr gerne — der 25. passt mir besser.");

    await act(async () => { sendButton().click(); });
    await settle();

    window.location.hash = "#/triage";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await settle();
    expect(host!.textContent).not.toContain(first.subtitle!);
    // The OTHER Answer Later entry is untouched — the reply cleared one debt, not the pile.
    expect(host!.textContent).toContain(second.title);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SLICE · WHAT THE SCREEN SHOWS IS NOT WHAT THE WIRE CARRIES
   ══════════════════════════════════════════════════════════════════════════════════════════

   The reply change altered one thing: which component renders the mail the reader is answering. It
   must not have changed the payload by so much as a byte, and the reason is the "Sensitive mail" invariant — a
   quoted original puts the PARENT's body into outgoing mail, and a message the pipeline
   marked sensitive carries `no_forward` with its stored body redacted. A client-side quote is
   exactly the seam through which an OTP leaves the account.

   `http-adapter.ts` `mailSend` says this in prose and `client-engine/test/mail-send.test.ts`
   asserts it of the DELIVERED message, one layer below the shell: it pins
   `delivered[0].text` to the string the test handed the engine, so it cannot notice a shell
   that composes a different string in the first place. `sendReply` in `AppShell` is where a
   quote would be added — the tempting place, now that the pane owns the conversation and a
   "…but the recipient can't see it" thought is one commit away — so the assertion is made
   HERE, through the render path, against the mutation the adapter is handed.

   RECORDED AT THE ADAPTER, not at the button: `Engine.enrich` freezes the envelope before
   dispatch and the adapter's argument IS what `POST /drafts` serialises, so this is the wire
   body without a network. */
describe("the outgoing reply is exactly what was typed", () => {
  const TYPED = "Donnerstag um zehn passt.";

  it("carries no part of the parent — asserted through the render path that shows it", async () => {
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown,
      m: unknown,
      opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>)
        .call(this, m, opts);
    } as never);

    await mountShell();
    await key("r");

    // The parent's body as the READER sees it — the copy this slice made the pane keep.
    const parentBody = host!.querySelector(".read-col .msg .msg-body")!.textContent!;
    expect(parentBody.length, "no parent body on screen ⇒ nothing to leak ⇒ vacuous").toBeGreaterThan(40);
    const parentLine = parentBody.split("\n").find((l) => l.trim().length > 20)!.trim();

    await type(TYPED);
    await act(async () => { sendButton().click(); });
    await settle();
    expect(host!.textContent).toContain("Reply sent.");

    const sends = seen.filter((m) => m.kind === "mail_send");
    expect(sends, "the send never reached the adapter").toHaveLength(1);
    const payload = sends[0]!;

    // THE ASSERTION. Byte-exact, so a quote appended, prepended or indented is red.
    expect(payload.body).toBe(TYPED);
    // …and no OTHER field smuggles it either — `subject` is derived, `to` is an address.
    expect(JSON.stringify(payload)).not.toContain(parentLine);

    /**
     * The envelope, spelled out. `{inReplyTo, body}` is what the editor sends and the four
     * derived fields are `Engine.enrich`'s (`mailboxId`, `threadId`, `subject`, `to`) — a
     * FIFTH key here would be a wire change, which this slice is not allowed to make. If a
     * later slice adds one deliberately, this list is where it gets acknowledged.
     * ACKNOWLEDGED: `draftId`. The demo's letter has a reply draft on the account; Reply opens
     * it and Send sends it, so one reply stays one row (tester round 24).
     */
    expect(Object.keys(payload).sort()).toEqual([
      "body", "draftId", "inReplyTo", "kind", "mailboxId", "subject", "threadId", "to",
    ]);
    expect(payload.draftId, "the reply was not sent as the draft Reply opened").toBe("draft-compose");

    /**
     * BYTE-IDENTITY, not just the key set — the guard R9-3/R9-7 must not weaken. The From selector
     * and reply attachments are OFF unless used, so an untouched reply's mutation is exactly what it
     * was: no `attachments`, and `mailboxId` is the PARENT's, derived by `Engine.enrich` and not
     * forced by the shell. Every fixture message arrived in `lichtgrat`, so that is what a reply
     * answers from; `sendReply` leaves the field off the wire (the resolved sender equals the
     * parent's, and there is no substitution or pick) and lets `enrich` own it. Make the shell
     * attach a resolved id unconditionally and this pins the wrong owner if it ever diverges.
     */
    expect(payload.mailboxId, "the untouched reply no longer answers from the mailbox it arrived in")
      .toBe("lichtgrat");
    expect(payload, "a plain reply carried an attachments key").not.toHaveProperty("attachments");
  });
});

describe("the draft", () => {
  it("survives closing and reopening the editor", async () => {
    await mountShell();
    await key("r");
    await type("half a sentence");
    await key("Escape");
    await key("r");
    // The DOCUMENT'S text, not a `value` property — the editor is a `contenteditable` and the
    // buffer it restores from is `rich-text.ts`'s. Written with no formatting, so this also
    // pins the legacy bare-string write: an envelope here would be a plain reply that a bundle
    // predating the rich editor could no longer read.
    expect(editorOf(editorsInMessage()[0]!).getText()).toBe("half a sentence");
    expect(replyBuffer(openMessageId())).toBe("half a sentence");
  });
});

/**
 * REPLY ATTACHMENTS (slice R9-3) — files ride the send and NOTHING ELSE.
 *
 * The wire already carries `attachments` on `mail_send` (`types.ts`); this asserts the CLIENT
 * wiring: a file picked in the reply reaches the mutation the adapter is handed, and it never
 * enters the `localStorage` reply scratch, which stays zero-at-rest (`ComposeAttachment`). The
 * mutation is recorded at the adapter — the same seam the body guard uses — so this is the
 * wire without a network.
 */
describe("reply attachments ride the send, never the account and never the scratch (R9-3)", () => {
  it("a picked file reaches the built mutation and stays out of the reply buffer", async () => {
    const { FixturesAdapter } = await import("@ohmail/testing/adapter");
    const seen: Array<Record<string, unknown>> = [];
    const realMutate = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown,
      m: unknown,
      opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (realMutate as (this: unknown, m: unknown, o: unknown) => Promise<unknown>)
        .call(this, m, opts);
    } as never);

    // A SYNCHRONOUS FileReader — the bytes are arbitrary, only that they are carried matters, and a
    // real reader's async load would not settle under this file's fake timers. Restored in `finally`.
    const RealFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      readAsDataURL(): void {
        this.result = "data:text/plain;base64,QUJDREU="; // "ABCDE"
        this.onload?.();
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = FakeFileReader;

    try {
      await mountShell();
      await key("r");
      await type("Mit Anhang.");
      const messageId = openMessageId();

      const input = host!.querySelector<HTMLInputElement>(".reply .compose-attach input[type='file']");
      expect(input, "the reply editor rendered no attach control").not.toBeNull();
      const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "note.txt", { type: "text/plain" });
      Object.defineProperty(input!, "files", {
        configurable: true,
        value: { 0: file, length: 1, item: () => file },
      });
      await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
      await settle();

      // The control lists the file, and the scratch buffer holds the BODY and only the body.
      expect(host!.textContent, "the picked file is not listed in the reply").toContain("note.txt");
      const buffered = replyBuffer(messageId) ?? "";
      expect(buffered, "the reply buffer lost the body it always held").toContain("Mit Anhang");
      expect(buffered, "attachment bytes leaked into the zero-at-rest reply scratch")
        .not.toContain("note.txt");
      expect(buffered).not.toContain("QUJDREU=");

      await act(async () => { sendButton().click(); });
      await settle();

      const sends = seen.filter((m) => m.kind === "mail_send");
      expect(sends, "the reply never reached the adapter").toHaveLength(1);
      const atts = sends[0]!.attachments as Array<{ filename: string }> | undefined;
      expect(atts, "the reply attachment never reached the built mutation").toBeDefined();
      expect(atts!.map((a) => a.filename)).toEqual(["note.txt"]);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });
});
