/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { settleEditor, settleFirstPaint } from "./_first-paint.js";
import { typeInto } from "./fixtures/rich-editor-driver";
import { openRow } from "./ohbox/_finders.js";

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
 * that answers `false` and asserts nothing is dispatched, and the confirmation test pins the other half
 * of that composition: Writing answers the arm true only on confirmation.
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
  const { MailShell } = await import("./_mail-shell.js");
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
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
        }),
      }),
    );
  });
  await settleFirstPaint();
  // The Ohbox rests until somebody picks a row; `j` is the product's own act.
  await key("j");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  /* The address a key writes is announced by the browser as a task (`hashchange`), and this file's clock is fake:
     run what is due now, so the seated place, which follows the address, hears it. No time passes. */
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};

/* The editor arrives through a dynamic import (the shell loads it off the first paint), so a
   press that opens one is followed by a drain before the surface is read — the subject here is
   the second BUTTON, never how many microtasks the import takes. */
const drain = settleEditor;

const page = () => within(host!);

const editors = (): HTMLElement[] => [
  ...page().queryAllByRole("textbox", { name: messages.write.reply.text }),
  ...page().queryAllByRole("textbox", { name: de.write.reply.text }),
];

async function type(text: string): Promise<void> {
  const editor = editors()[0]!;
  await act(async () => { typeInto(editor, text); });
}

const reports = (words: string): HTMLElement[] =>
  page().queryAllByRole("status").filter((status) => status.textContent?.includes(words));

const undoPress = (): HTMLElement | null => {
  const report = reports(messages.reply.toastSentAndDone)[0];
  return report === undefined ? null : within(report).queryByRole("button", { name: /^Undo\b/ });
};

const doneButton = (): HTMLElement | null =>
  page().queryByRole("button", { name: messages.reply.sendAndDone })
  ?? page().queryByRole("button", { name: de.reply.sendAndDone });
const sendButton = (): HTMLElement => page().getByRole("button", { name: messages.write.send });
/** The message the open editor answers: the open letter's, while a reply's editor stands under it. */
const replyFor = (): string =>
  editors().length > 0 ? (openRow(host!)?.dataset.id ?? "") : "";

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
    expect(page().getByRole("textbox", { name: messages.write.subject })).toBeTruthy();
    expect(sendButton()).toBeTruthy();
    expect(doneButton()).toBeNull();
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

    expect(reports("Sent · marked done")).toHaveLength(1);
    /* The SETTLED pill. "One press, one sentence" is not readable here — the host renders one
       capsule and both sentences would land in a single React flush, so a displaced one leaves
       nothing to assert on (a per-step sampler was tried and read green under the mutation).
       That rule is measured where it is observable: the hook case below, which records every
       sentence the lane raises, and the phone suite, which records every toast. */
    const undo = undoPress();
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

    expect(reports("Reply sent.")).toHaveLength(1);
    expect(reports("Sent · marked done")).toHaveLength(0);
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
    expect(reports("Sent · marked done")).toHaveLength(1);
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

    const undo = undoPress()!;
    await act(async () => { undo.click(); });
    await settle();

    expect(reports("Undone")).toHaveLength(1);
    /* The row is back where it was, which is exactly what the offer returning says: the
       engine's rule answers a plan again only for a message that is not finished. */
    expect(doneButton(), "Undo did not restore the row").not.toBeNull();
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
    // The composer checks the projected list again at the press. Write's displayed offer
    // checks it at render, and the keyboard uses that same offer.
    const rels = [
      "packages/app-logic/src/writing/writing-of.ts",
      "packages/app-logic/src/writing/shell-compose.ts",
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
    expect(calls.length, "the rule is asked at the press, at every render and by the chord").toBe(rels.length);
    expect([...new Set(calls)]).toEqual(["sendAndDonePlanFor(presented,"]);
    expect(
      read("packages/app/src/mail/ground/MailKeys.tsx"),
      "the chord asks the per-render offer (the projection's), never a rule of its own",
    ).toMatch(/writing\.sendReplyAndDone\(replyTo\)/);
    expect(read("packages/app/src/mail/ground/MailKeys.tsx")).not.toMatch(/sendAndDonePlanFor\(/);
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
    expect(reports("Gesendet · erledigt")).toHaveLength(1);
  });
});
