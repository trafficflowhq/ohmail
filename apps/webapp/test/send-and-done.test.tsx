/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * SEND + DONE — THE SECOND SEND ACTION, driven through the WHOLE shell.
 *
 * The rule is the engine's (`sendAndDonePlanFor`, measured in `client-engine`); what is measured
 * here is the shell honouring it: the button appears only where the engine offers a plan, the
 * press sends through the SAME send and files the source only after the engine confirms it, the
 * pill says one thing and carries the Undo that puts the row back, and the source that is now
 * finished stops offering the action.
 *
 * The demo adapter confirms every send, so the REFUSED arm cannot be driven here: it is measured
 * where it decides — `client-engine/test/send-and-done.test.ts` drives the intent with a send
 * that answers `false` and asserts nothing is dispatched, and the case below pins the other half
 * of that composition, that the shell answers the arm `true` on a CONFIRMATION and on nothing
 * else.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* Every case here mounts the WHOLE shell in jsdom. The default 5 s deadline is a FALSE RED on a
   busy box and nothing else: this file read 8/8 failed at load average 46 on this host and 8/8
   passed at the next run, with the first case's mount simply not finishing in time. */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hadScrollIntoView: unknown;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
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

async function mountShell(locale: "en" | "de" = "en"): Promise<void> {
  await unmount();
  const { AppShell } = await import("./_todays-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: (locale === "de" ? de : messages) as never, timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  /* THE EDITOR ARRIVES THROUGH THE ONE DYNAMIC DOOR, so the chunk is asked for the way the
     product asks for it — `preloadRichEditor`, the door's own preload — and then settled. A
     press alone leaves the Suspense frame standing, and this file's subject is the second
     BUTTON beside Send, not how many rounds the import takes. */
  const { preloadRichEditor } = await import("../app/shell/RichEditorLazy.js");
  await act(async () => { await preloadRichEditor(); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // The Ohbox rests until somebody picks a row; `j` is the product's own act.
  await key("j");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

/* The editor arrives through a dynamic import (the shell loads it off the first paint), so a
   press that opens one is followed by a drain before the surface is read — the subject here is
   the second BUTTON, never how many microtasks the import takes. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

const editors = (): HTMLElement[] =>
  [...host!.querySelectorAll<HTMLElement>(".reader .msg, .read-col .msg")]
    .flatMap((m) => [...m.querySelectorAll<HTMLElement>(".rte-surface")]);

async function type(text: string): Promise<void> {
  const editor = editors()[0]!;
  await act(async () => { typeInto(editor, text); });
}

/** The second action, found by the class the shell gives it — never by its words. */
const doneButton = (): HTMLButtonElement | null =>
  host!.querySelector<HTMLButtonElement>(".reply-actions .reply-send-done");
const sendButton = (): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(".reply-actions .btn.primary")!;
/** The message the open editor answers. */
const replyFor = (): string =>
  host!.querySelector<HTMLElement>(".reply[data-reply-for]")?.dataset.replyFor ?? "";

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

beforeEach(() => {
  vi.useFakeTimers();
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  hadScrollIntoView = proto.scrollIntoView;
  proto.scrollIntoView = function noop() { /* jsdom runs no layout */ };
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = hadScrollIntoView;
});

describe("the second action is offered exactly where the engine offers a plan", () => {
  /**
   * CONTROL. MUTATION WATCHED: hand the editor `onSendAndDone` unconditionally in
   * `MessagePane` (drop the `chrome.sendReplyAndDone?.(…)` call) and the fresh compose below
   * grows a second send button.
   */
  it("a reply to an unread Ohbox row offers it; a fresh compose does not", async () => {
    await mountShell();
    await key("r");
    await drain();
    expect(editors().length).toBeGreaterThan(0);
    expect(doneButton(), "a reply to an Ohbox row offers Send + Done").not.toBeNull();
    expect(doneButton()!.textContent).toContain("Send + Done");

    /* THE FRESH COMPOSE — no source, so no plan and no second button. */
    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(host!.querySelector(".reply-send-done")).toBeNull();
  });

  /**
   * CONTROL. MUTATION WATCHED: delete the `if (undo.length === 0) return null` line in the
   * engine's `planOver` and the answered message keeps offering an action that would change
   * nothing.
   */
  it("a message this press just finished stops offering it", async () => {
    await mountShell();
    await key("r");
    await drain();
    const messageId = replyFor();
    await type("Donnerstag passt.");
    await act(async () => { doneButton()!.click(); });
    await settle();

    /* The editor is still open on the same message — the closing beat has not run out — and
       the message is read, unpinned and unbooked now. Nothing is left to finish, so the
       second action is gone from the row it was pressed on. */
    expect(replyFor()).toBe(messageId);
    expect(doneButton(), "the finished message still offered Send + Done").toBeNull();
  });
});

describe("the press sends, then files, and says so once", () => {
  /**
   * CONTROL. MUTATION WATCHED: hand the editor a callback unconditionally in `MessagePane`
   * (`?? (() => {})`) and this case goes red — the press reaches a lane nobody armed and the
   * pill says "Reply sent." over a message that was never filed.
   */
  it("one pill: Sent · marked done, with Undo", async () => {
    await mountShell();
    await key("r");
    await drain();
    await type("Donnerstag passt.");
    await act(async () => { doneButton()!.click(); });
    await settle();

    expect(host!.textContent).toContain("Sent · marked done");
    /* The SETTLED pill. "One press, one sentence" is not readable here — the host renders one
       capsule and both sentences would land in a single React flush, so a displaced one leaves
       nothing to assert on (a per-step sampler was tried and read green under the mutation).
       That rule is measured where it is observable: the hook case below, which records every
       sentence the lane raises, and the phone suite, which records every toast. */
    const undo = [...host!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === "Undo");
    expect(undo, "the pill carried no way back").toBeTruthy();
  });

  /**
   * CONTROL. MUTATION WATCHED: drop the `andDone` arm and press plain Send — this case reads
   * the ordinary sentence, which is what says the two presses are still two acts.
   */
  it("plain Send is untouched — it sends and says only that", async () => {
    await mountShell();
    await key("r");
    await drain();
    await type("Donnerstag passt.");
    await act(async () => { sendButton().click(); });
    await settle();

    expect(host!.textContent).toContain("Reply sent.");
    expect(host!.textContent).not.toContain("Sent · marked done");
  });

  /**
   * CONTROL. MUTATION WATCHED: drop `inInput` from the binding, or bind the chord without the
   * shift claim, and the chord reaches nothing from inside the editor.
   */
  it("⌘⇧↩ is the same press from the keyboard", async () => {
    await mountShell();
    await key("r");
    await drain();
    await type("Donnerstag passt.");
    const editor = editors()[0]!;
    editor.focus();
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    });
    await settle();
    expect(host!.textContent).toContain("Sent · marked done");
  });
  /**
   * CONTROL. MUTATION WATCHED: read the plan AFTER the send instead of at the press (move the
   * `sendAndDonePlanFor` call in `pressSendAndDone` into `onSendOutcome`) and Undo puts the row
   * back where the SEND left it rather than where the reader found it — the second action
   * returns for a message the undo was supposed to have restored, and this case goes red.
   */
  it("Undo puts the row back in the section it left", async () => {
    await mountShell();
    await key("r");
    await drain();
    await type("Donnerstag passt.");
    await act(async () => { doneButton()!.click(); });
    await settle();
    expect(doneButton()).toBeNull();

    const undo = [...host!.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === "Undo")!;
    await act(async () => { undo.click(); });
    await settle();

    expect(host!.textContent).toContain("Undone");
    /* The row is back where it was, which is exactly what the offer returning says: the
       engine's rule answers a plan again only for a message that is not finished. */
    expect(doneButton(), "Undo did not restore the row").not.toBeNull();
  });
});

describe("nothing is filed until the engine has confirmed the send", () => {
  /**
   * CONTROL. MUTATION WATCHED: call the outcome hook with `true` from `absorb`'s terminal
   * branch, or drop the `next.phase !== "queued"` test, and a send that FAILED files the
   * message it never delivered.
   *
   * The demo adapter confirms everything, so this drives `useMailSend` directly against an
   * engine that rejects. The other half of the composition — that a `false` dispatches nothing
   * — is measured on the intent itself in `client-engine/test/send-and-done.test.ts`.
   */
  it("a failed send answers the arm false; a confirmed one answers true", async () => {
    await unmount();
    const { useMailSend } = await import("@ohmail/app-logic/writing/mail-send");
    const { useMailSendText } = await import("../app/shell/mail-send-text.js");
    const answers: boolean[] = [];
    const toasts: string[] = [];
    const message = { id: "m1", folder: "INBOX", unread: true, triage: null };
    const reader = { get: () => message, list: () => [], entries: () => [], version: () => 1 };
    /** Rejects the first send, confirms the second — one engine, both outcomes. */
    let nth = 0;
    const engine = {
      mutate: async () => {
        nth += 1;
        return nth === 1
          ? { id: "i", key: `k${nth}`, seq: nth, status: "rolled_back", error: { code: "send_failed", retryable: false } }
          : { id: "i", key: `k${nth}`, seq: nth, status: "confirmed" };
      },
      read: () => reader,
      flushPending: async () => [],
      pendingMutations: () => [],
      subscribe: () => () => { /* nothing notifies */ },
      hasLateResults: () => false,
    };
    let api!: { send: (m: Record<string, unknown>) => void };
    const Probe = (): null => {
      api = useMailSend(
        engine as never,
        null,
        ((m: string) => toasts.push(m)) as never,
        useMailSendText(), (() => { /* the close is another case */ }) as never,
        ((_key: string, _m: unknown, accepted: boolean) => { answers.push(accepted); return accepted; }) as never,
      ) as never;
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(Probe),
      }));
    });

    await act(async () => { api.send({ kind: "mail_send", inReplyTo: "m1", body: "one" }); });
    await settle();
    expect(answers, "the failed send did not answer the arm").toEqual([false]);

    await act(async () => { api.send({ kind: "mail_send", inReplyTo: "m1", body: "two" }); });
    await settle();
    expect(answers).toEqual([false, true]);
    /* …and the lane kept its silence for the confirmed one, because the arm spoke. */
    expect(toasts).not.toContain("Reply sent.");
  });
});

describe("the offer reads the Ohbox ON SCREEN", () => {
  /**
   * The rule is asked of `presented` — the projection `ohboxView` is called on thousands of
   * lines above — and never of the raw mirror, where a message a rule presents under Reads or
   * Receipts still sits in INBOX and would offer the action over a row the Ohbox does not show.
   * Read from the source because the demo world routes nothing: there is no fixture here in
   * which the two readers disagree, so the wiring is the only thing that can be measured.
   *
   * CONTROL. MUTATION WATCHED: change any of the three to `reader` and this goes red.
   */
  it("every site that asks the rule asks the projection", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    /* The root run and the package run are both what CI does — jsdom has no file `import.meta`,
       so the path is resolved from the working directory, as `reply-panel.test.tsx` does. */
    /* THE THREE SITES ARE THREE FILES NOW (ARCH-022). The shell's press went to `shell-compose.ts`
       with the editor and the chord to `shell-keys.tsx` with the keymap; only the per-render offer
       stayed. Counting one file read 2 and said the rule had lost a site. So the census names the
       files it covers and asks the WHOLE set — the claim was never "three in AppShell", it was
       "every site, and every one of them asks the projection". A file that cannot be read is a
       refusal, not a zero. */
    const rels = [
      "apps/webapp/app/shell/AppShell.tsx",
      "apps/webapp/app/shell/shell-compose.ts",
      "apps/webapp/app/shell/shell-keys.tsx",
    ];
    const read = (rel: string): string => {
      try { return readFileSync(resolve(process.cwd(), rel), "utf8"); }
      catch { return readFileSync(resolve(process.cwd(), `../../${rel}`), "utf8"); }
    };
    const per = rels.map((rel) => ({ rel, calls: read(rel).match(/sendAndDonePlanFor\([a-zA-Z]+,/g) ?? [] }));
    const calls = per.flatMap((f) => f.calls);
    expect(
      per.map((f) => `${f.rel}:${f.calls.length}`),
      "the rule is asked at the press, at every render and by the chord — one site in each",
    ).toEqual(rels.map((rel) => `${rel}:1`));
    expect(calls.length, "the rule is asked at the press, at every render and by the chord").toBe(3);
    expect([...new Set(calls)]).toEqual(["sendAndDonePlanFor(presented,"]);
  });
});

describe("the German catalogue carries both halves", () => {
  it("the button and the pill are German", async () => {
    await mountShell("de");
    await key("r");
    await drain();
    expect(doneButton()!.textContent).toContain("Senden + Erledigt");
    await type("Donnerstag passt.");
    await act(async () => { doneButton()!.click(); });
    await settle();
    expect(host!.textContent).toContain("Gesendet · erledigt");
  });
});
