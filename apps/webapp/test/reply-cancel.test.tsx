/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { Editor } from "@tiptap/react";
import messages from "../messages/en.json";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";

/**
 * ═══ CANCELLING A REPLY PUTS YOU BACK IN THE MESSAGE, WITH NOTHING LEFT BEHIND ═══════════
 *
 * The reply editor has always had a Cancel; what was never guarded is what it LEAVES. Two
 * things can go wrong and neither is visible from the editor's own markup:
 *
 *  1. THE DOCK. At split width the editor is wrapped in `.reply-dock` — a sticky positioner
 *     pinned to the bottom of the reading column (`reader.css`; the panel inside it carries
 *     the skin and its own viewport bound — `reply-panel.test.tsx`). The
 *     wrapper is `ReadingPane`'s, not the editor's, so a cancel that unmounted the editor while
 *     the wrapper survived would leave a padded empty band stuck across the foot of
 *     every message the reader opened afterwards. `ReadingPane` renders no wrapper when there
 *     is no reply — that is the invariant, and this file is what watches it.
 *
 *  2. THE TEXT. Cancel CLOSES; it does not discard. The per-message scratch buffer
 *     (`mail-send.ts`, `localStorage`) survives, so reopening the editor on that message brings
 *     back what was written. That is deliberate and it is what makes Cancel safe to press —
 *     Escape does exactly the same thing (`AppShell`'s escape cascade closes the innermost open
 *     layer), and neither key destroys a half-written answer. The compose surface's Cancel is a
 *     different verb for a different reason: it owns a row on the ACCOUNT, so leaving it alone
 *     would strand a draft (`compose-cancel.test.tsx`). Asserted here so that difference is a
 *     decision on the record rather than an accident nobody notices when one of them changes.
 *
 *  3. THE SEND. Cancel is the word on the button, and a QUEUED send is an intent standing on the
 *     outbox that the next reconnect delivers — so closing this dock over one used to leave a
 *     reply somebody had cancelled to go anyway, once, which is why it read as ordinary. The
 *     compose surface's Cancel has withdrawn its send since the composer got one; this one had
 *     not. It is the SAME act, so it is the same withdrawal — and it still does not touch the
 *     scratch, which is what keeps the two rules from becoming one.
 *
 * Driven through the whole shell in demo mode, for the reason `inline-reply.test.ts` gives: the
 * open, the close and the ownership of Escape all live in `AppShell`, and a `MessagePane`
 * mounted alone could not see any of it.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

/** The whole client on the fixture world, with a message open in the reading column. */
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
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // The Ohbox rests until somebody picks a row; `j` is the product's own way of doing that.
  await key("j");
  /* WAITED FOR, not assumed. `j` only opens a message once the fixtures engine has drained,
     and how many microtasks that takes depends on what else the runner has in flight — this
     suite failed once, in a nine-file parallel run, and passed alone and in fifteen repeats
     afterwards. A fixed flush count is a race with an unstated bound; the wait has an explicit
     one and says so when it expires, so "the Ohbox never opened a message" stays a loud
     failure instead of becoming a confusing assertion further down. */
  await waitFor(() => openSubject() !== "", "the Ohbox never opened a message");
}

/** Poll until `ready()`, draining React between attempts; bounded by real time, never a tick count. */
async function waitFor(ready: () => boolean, why: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(why);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** Open the reply editor and wait for it to be on screen. */
async function openReply(): Promise<void> {
  await key("r");
  await waitFor(() => replySurface() !== null, "`r` opened no reply editor");
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
};

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

/**
 * The open reply editor's surface, or null when the editor is closed.
 *
 * Scoped to a RENDERED MESSAGE (`.reader .msg` / `.read-col .msg`) rather than to `.reply`
 * alone, which is `inline-reply.test.ts`'s selector and answers the journey's own question:
 * an editor that is not inside the message it answers is the defect that moved Reply out of
 * Compose in the first place.
 */
const replySurface = (): HTMLElement | null =>
  [...host!.querySelectorAll<HTMLElement>(".reader .msg, .read-col .msg")]
    .flatMap((m) => [...m.querySelectorAll<HTMLElement>(".rte-surface")])[0] ?? null;

/** ProseMirror mounts a tick after the commit (`immediatelyRender: false`). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/**
 * The reply editor's surface, once ProseMirror has attached its handle to it.
 *
 * POLLED rather than flushed a fixed number of times: `RichEditor` sets
 * `immediatelyRender: false`, so the surface is in the DOM for at least one commit before the
 * handle exists, and how many microtasks that takes depends on what else the shell is
 * draining. The surface — not the `Editor` — is what comes back, because that is what
 * `typeInto` takes; handing it an `Editor` throws the driver's "pass the `.rte-surface`"
 * error, which reads exactly like "the editor never mounted" and is not.
 */
async function replyEditorSurface(): Promise<HTMLElement> {
  const handled = (): boolean => !!(replySurface() as unknown as { editor?: Editor } | null)?.editor;
  await waitFor(handled, "the reply editor never mounted a ProseMirror handle");
  return replySurface()!;
}

// Selector updated by the viewer redesign — the subject lives in the header's `.msg-subject`
// line now (SUBJECT-D), not a 24px `h2`; the assertion is untouched.
const openSubject = (): string =>
  q(".reader .msg .msg-subject")?.textContent ?? q(".read-col .msg .msg-subject")?.textContent ?? "";

/** The editor's own Cancel — scoped to `.reply-actions`, never a label found anywhere. */
const replyCancel = (): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => b.textContent === "Cancel");

beforeEach(() => {
  setViewport(false);
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("Cancel returns to the message and strands nothing", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * Mutation: give `ReadingPane` an unconditional `<div className="reply-dock">{reply}</div>`.
   * Three of this file's four go red; the first to fire is the REST state, because an
   * unconditional wrapper is already wrong before anything is opened. Real failure text:
   *   AssertionError: a reply dock exists before a reply was opened: expected
   *   <div class="reply-dock" /> to be null
   * …followed by `Escape left the dock behind` and the source guard below.
   */
  it("closes the editor AND takes the dock with it", async () => {
    await mountShell();
    const subject = openSubject();
    expect(subject, "the demo Ohbox rendered no message").not.toBe("");
    expect(q(".reply-dock"), "a reply dock exists before a reply was opened").toBeNull();

    await openReply();
    expect(q(".reply-dock"), "the open editor is not in a dock").not.toBeNull();

    const cancel = replyCancel();
    expect(cancel, "the reply editor offers no Cancel").toBeDefined();
    await act(async () => { cancel!.click(); });

    expect(replySurface(), "Cancel left the editor open").toBeNull();
    expect(
      q(".reply-dock"),
      "the reply dock survived the cancel — an empty sticky strip is pinned across the foot of "
        + "the reading column",
    ).toBeNull();
    // …and it is a RETURN, not a navigation: the message is still the one being read.
    expect(openSubject(), "cancelling the reply took the message off the screen").toBe(subject);
    // The view is unchanged; the open message rides the hash by design (`message-url.test.tsx`).
    expect(window.location.hash, "cancelling the reply changed the route").toMatch(/^#\/ohbox(\/m\/|$)/);
    expect(q(".view-compose"), "cancelling the reply landed in Compose").toBeNull();
  });

  /**
   * CANCEL IS A CLOSE, NOT A DISCARD — and the reply text is the thing that proves which.
   *
   * Mutation: clear the scratch buffer in `closeReply`. Real failure text:
   *   AssertionError: cancelling the reply destroyed what was written — Cancel closes the
   *   editor, it does not throw the answer away: expected '' to contain 'half a sentence'
   */
  it("keeps what was written, so reopening the reply restores it", async () => {
    await mountShell();
    await openReply();
    const surface = await replyEditorSurface();
    await act(async () => { typeInto(surface, "half a sentence"); });
    await settle();
    expect(editorOf(await replyEditorSurface()).getText()).toBe("half a sentence");

    await act(async () => { replyCancel()!.click(); });
    expect(replySurface()).toBeNull();

    await openReply();
    expect(
      editorOf(await replyEditorSurface()).getText(),
      "cancelling the reply destroyed what was written — Cancel closes the editor, it does not "
        + "throw the answer away",
    ).toBe("half a sentence");
  });

  /**
   * CANCEL WITHDRAWS THE SEND — the third thing this button leaves.
   *
   * Mutation: drop the `mailSend.withdraw` call from `closeReply`. Real failure text:
   *   AssertionError: closing the dock left a queued reply standing on the outbox: expected
   *   [] to have a length of 1
   *
   * The double answers `queued` — the engine's word for a wire that refused retryably, which is
   * what leaves an intent under its key. The withdrawal's own VERDICT is what is asserted, and
   * it is the engine's answer about the engine's own queue: `withdrawn` means a row was found
   * and taken off it, where `gone` means there was nothing there. A spy that only counted calls
   * would pass over a withdrawal that withdrew nothing.
   */
  it("withdraws a queued send, and still leaves what was written", async () => {
    await mountShell();
    await openReply();
    const surface = await replyEditorSurface();
    await act(async () => { typeInto(surface, "a queued answer"); });
    await settle();

    /* THE SEND IS MADE TO QUEUE: the fixtures adapter refuses retryably, which is exactly the
       state Cancel exists for — nothing on the wire, an intent under its key. */
    const { FixturesAdapter, MutationRejectedError, OhmailEngine } = await import("@ohmail/client-engine");
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async () => {
      throw new MutationRejectedError("offline", { status: 0, code: "network", retryable: true });
    });
    const withdrawals: string[] = [];
    const realWithdraw = OhmailEngine.prototype.withdrawQueued;
    vi.spyOn(OhmailEngine.prototype, "withdrawQueued").mockImplementation(async function (
      this: InstanceType<typeof OhmailEngine>, key: string,
    ) {
      const outcome = await realWithdraw.call(this, key);
      withdrawals.push(outcome);
      return outcome;
    });
    const send = [...host!.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
      .find((b) => (b.textContent ?? "").startsWith("Send"));
    expect(send, "the reply editor offers no Send").toBeDefined();
    await act(async () => { send!.click(); });
    await waitFor(
      () => (send!.getAttribute("data-send") ?? "") === "queued",
      "the send never reached the queued state this case is about",
    );

    await act(async () => { replyCancel()!.click(); });
    await waitFor(() => replySurface() === null, "closing the dock left the editor open");
    await waitFor(
      () => withdrawals.length > 0,
      "closing the dock left a queued reply standing on the outbox",
    );
    expect(
      withdrawals,
      "the dock asked for a withdrawal and the engine had nothing queued to withdraw",
    ).toEqual(["withdrawn"]);

    /* …and the text is still there, which is the other half of the rule: withdrawing the SEND is
       not discarding the ANSWER. */
    await openReply();
    expect(
      editorOf(await replyEditorSurface()).getText(),
      "withdrawing the queued send threw the written answer away with it",
    ).toBe("a queued answer");
  });

  /** Escape is the same act as Cancel here — one meaning for "back out of this editor". */
  it("Escape does what Cancel does, and also leaves the message open", async () => {
    await mountShell();
    const subject = openSubject();
    await openReply();

    await key("Escape");

    expect(replySurface(), "Escape left the editor open").toBeNull();
    expect(q(".reply-dock"), "Escape left the dock behind").toBeNull();
    expect(openSubject(), "Escape closed the message as well as the editor").toBe(subject);
  });
});

describe("the dock wrapper is conditional at the source", () => {
  /**
   * The rendered guard above can only see the demo's own width. This pins the RULE, so the
   * wrapper cannot become unconditional in a build where no test happens to open a reply — the
   * `screener-row-actions-overlay.test.ts` idiom, and `readFileSync` for the reason its header
   * gives about this repo's `grep`.
   */
  it("`ReadingPane` renders `.reply-dock` only when there is a reply", () => {
    const src = readFileSync(
      resolve(process.cwd(), fromRootOrApp("packages/ui/src/composites/ReadingPane.tsx")),
      "utf8",
    );
    expect(
      src,
      "the reply dock is no longer conditional — it would outlive the editor it wraps",
    ).toMatch(/\{reply \?\s*<div className="reply-dock">\{reply\}<\/div>\s*:\s*null\}/);
  });
});

/** The repo root from either working directory — the root run is what CI does. */
function fromRootOrApp(relFromRoot: string): string {
  try {
    readFileSync(resolve(process.cwd(), relFromRoot), "utf8");
    return relFromRoot;
  } catch {
    return `../../${relFromRoot}`;
  }
}
