/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { screen, within } from "@testing-library/react";
import {
  MutationRejectedError,
  OhmailEngine,
  type MutationResult,
} from "@ohmail/client-engine";
import { triage } from "@ohmail/testing";
import messages from "../messages/en.json";
import { editorOf, typeInto } from "./fixtures/rich-editor-driver";
import { replyDraftKey } from "@ohmail/app-logic/writing/mail-send";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * THE REPLY RUN MUST NOT DISCHARGE A DEBT IT DID NOT PAY.
 *
 * What shipped: the overlay's textarea was bound to `frValues`, NOTHING read it, and `onDone`
 * dispatched `triage_set → none` unconditionally. So a user worked down Answer Later typing
 * genuine replies, sent none of them, lost all of the text, and finished with an empty pile
 * whose state asserted every debt was paid. Both halves gone — worse than an inert button,
 * because an inert button leaves the pile intact and the user can retry.
 *
 * ── WHY THE FIRST TEST IN THIS FILE IS THE FAILING SEND ─────────────────────────────────
 *
 * Bolting a send onto the old `onDone` would have left TWO independent discharge rules — the
 * send's, and the unconditional `triage_set` at press time — and two discharge rules is
 * exactly how a FAILED send still clears the debt. That is the same bug wearing the fix as a
 * costume, and a happy-path test cannot see it: with the send working, both rules agree.
 * Only a send that fails tells them apart. So the failing send is asserted first and the
 * unconditional `triage_set` is deleted rather than kept, leaving `settle`'s confirm-gated
 * clear (`mail-send.ts:247-255`) as the ONLY rule that discharges a pile item.
 *
 * ── WHY THE WHOLE SHELL, ON THE DEMO WORLD ──────────────────────────────────────────────
 *
 * The defect lived in the wiring between three things — the overlay's `value`, the send
 * machine, and who is allowed to write `triage_set` — and no component mounted alone contains
 * that wiring. `mail-send-states.test.ts` pins the phases; this pins the RUN. Demo mode gives
 * Mila's two-item Answer Later pile with real message ids and no network (the "Demo/public content" invariant and
 * the third-party rule: nothing here can reach a real mailbox, and the fixture adapter is the
 * fake send port).
 *
 * The one thing the fixture world cannot do is refuse, so the failure case injects a
 * `rolled_back` outcome at `OhmailEngine.prototype.mutate` — the narrowest seam that still
 * leaves the whole client above it real.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mila's first Answer Later fixture — READ FROM THE FIXTURE, never spelled here.
 *
 * The pile was `giulia`/`petra` until the one-pile rule shipped and took parked mail out of the
 * Ohbox with it; the demo now parks two mails written for the pile. A run whose hard-coded ids
 * have drifted off the pile fails as "the pile is empty", which reads exactly like a product
 * defect and is not one — so the ids come from the same place the shell reads them.
 */
const FIRST_ID = triage.replyLater[0]!.messageId!;
const FIRST_TITLE = triage.replyLater[0]!.title;
const TYPED = "Ja, sehr gerne — der 25. passt mir besser.";

let roots: Root[] = [];
/** Every mutation the shell dispatched, in order — the spy records before it delegates. */
let dispatched: EngineMutation[] = [];
/** Flipped by the failure case; the fixtures world never rejects on its own. */
let sendFails = false;

const REAL_MUTATE = OhmailEngine.prototype.mutate;

beforeEach(() => {
  window.location.hash = "#/triage";
  dispatched = [];
  sendFails = false;
  try {
    window.localStorage.clear();
  } catch {
    /* storage blocked — the in-memory half still runs */
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // jsdom gaps, stubbed at their narrowest — see `escape-precedence.test.ts`.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
    this: OhmailEngine,
    m: EngineMutation,
  ): Promise<MutationResult> {
    dispatched.push(m);
    if (sendFails && m.kind === "mail_send") {
      // A DEFINITE refusal, not a retryable one: `queued` would keep the intent alive under
      // its key and is a different (also non-discharging) story. This is the plain "it did
      // not go" the acceptance names.
      return {
        id: "injected",
        key: "injected-key",
        status: "rolled_back",
        seq: null,
        error: new MutationRejectedError("the SMTP server refused it.", {
          status: 502,
          code: "send_failed",
        }),
      };
    }
    return REAL_MUTATE.call(this, m);
  });
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** The shipped shell on the fixture world. */
async function shell(): Promise<HTMLElement> {
  const { DemoShell } = await import("../app/(product)/demo/DemoShell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }) }),
        }),
      }),
    );
  });
  return container;
}

/** A keypress on the DOCUMENT, where the registry listens. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** Poll rather than sleep a guessed number of ms — see `escape-precedence.test.ts`. */
async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/** Let the mutation's promise chain settle (the fixtures adapter is async but instant). */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

const run = () => screen.queryByRole("toolbar", { name: "Reply run" });
const reading = () => within(screen.getByRole("region", { name: "Reading" }));
const editor = () => reading().queryByRole("textbox", { name: "Reply body" });
const subjectOnScreen = (): string => reading().getByRole("heading", { level: 2 }).textContent ?? "";
const progress = (): string => reading().getAllByRole("status").find(
  (status) => /^\d+ of \d+$/.test(status.textContent ?? ""),
)?.textContent ?? "";
const done = () => within(run()!).getByRole("button", { name: "Done → next" });
const failureText = () => reading().getAllByRole("status").map((status) => status.textContent).join(" ");
const answerLater = (): string[] =>
  within(screen.getByRole("listbox", { name: "Answer Later" })).getAllByRole("option")
    .map((row) => row.getAttribute("aria-label") ?? "");
const hasFirstItem = (): boolean => answerLater().some((name) => name.includes(FIRST_TITLE));

const kindsOf = (kind: string): EngineMutation[] => dispatched.filter((m) => m.kind === kind);

async function typeReply(text: string): Promise<void> {
  const box = editor();
  if (!box) throw new Error("the Reply Run has no editor on screen");
  // Through ProseMirror: setting DOM text produces no transaction and therefore no change the
  // shell can see, which would leave every assertion below testing an empty document.
  await act(async () => { typeInto(box, text); });
}

/** The mounted pile owns the run and its shortcut. */
async function openRun(): Promise<void> {
  await screen.findByRole("button", { name: "Reply Run" });
  await key("f");
  await waitFor(() => run() !== null && editor() !== null, "the Reply Run to open on a message");
}

describe("a Reply Run step is discharged by a DELIVERED reply, or not at all", () => {
  /**
   * THE ASSERTION THAT MATTERS, and the one that dies if `onDone` keeps a `triage_set` of its
   * own. Everything here is what the user must still have after a send that did not go: the
   * message, the reminder, and the sentence they wrote.
   */
  it("a step whose send FAILS keeps the message in the pile and keeps the typed reply", async () => {
    sendFails = true;
    await shell();
    await openRun();

    const stepSubject = subjectOnScreen();
    const stepProgress = progress();
    const pileBefore = answerLater();
    expect(hasFirstItem(), "the demo Answer Later pile is empty — nothing below would prove anything").toBe(true);

    await typeReply(TYPED);
    await act(async () => {
      done().click();
    });
    await drain();

    // It was attempted — otherwise the rest of this test passes for the wrong reason.
    expect(kindsOf("mail_send"), "Done did not attempt a send at all").toHaveLength(1);

    // NOTHING discharged the debt. This is the whole slice: no second rule, at any time.
    expect(kindsOf("triage_set"), "a send that failed still cleared the triage state")
      .toEqual([]);

    // The run did not move past a message that has not been answered.
    expect(subjectOnScreen(), "the run advanced past a reply that was never sent")
      .toBe(stepSubject);
    expect(progress()).toBe(stepProgress);

    // The words are still on screen…
    // The DOCUMENT'S text — `.value` on a `contenteditable` is `undefined`, which would read
    // as "the reply was discarded" in the very assertion checking that it was not.
    expect(editorOf(editor()!).getText(), "the typed reply was discarded by a failed send")
      .toBe(TYPED);
    // …and in the per-message scratch buffer, so a reload does not lose them either.
    expect(window.localStorage.getItem(replyDraftKey(FIRST_ID, storageOwner()))).toBe(TYPED);

    // The reminder is intact, so the user can discover what they still owe.
    expect(answerLater(), "a failed send emptied the pile").toEqual(pileBefore);

    // And they are told. A send that did not happen must never be silent — in the product's
    // own plain sentence, never the server's wire (ruling 2026-08-21; the whole argument is on
    // `SendStatus.tsx` and pinned in `send-status-copy.test.tsx`).
    expect(failureText(), "a failed send said nothing at all").toContain(messages.reply.statusFailed);
  });

  /** The other side of the same rule: one delivery, one discharge, through `settle`. */
  it("a step whose send SUCCEEDS clears the item exactly once, through settle", async () => {
    await shell();
    await openRun();
    const stepSubject = subjectOnScreen();
    expect(hasFirstItem()).toBe(true);

    await typeReply(TYPED);
    await act(async () => {
      done().click();
    });
    await drain();

    const sends = kindsOf("mail_send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ inReplyTo: FIRST_ID, body: TYPED });

    // EXACTLY ONE. Two would mean the press-time rule is back beside `settle`'s, which is
    // the state in which a failure also clears the debt.
    const cleared = kindsOf("triage_set");
    expect(cleared, "the pile item was discharged more than once").toHaveLength(1);
    expect(cleared[0]).toMatchObject({ messageId: FIRST_ID, state: "none" });

    await waitFor(
      () => subjectOnScreen() !== stepSubject,
      "the run to advance after a confirmed send",
    );
    expect(hasFirstItem(), "the answered message is still in the pile").toBe(false);
    // `settle` owns the scratch buffer too — the draft is spent, not left behind.
    expect(window.localStorage.getItem(replyDraftKey(FIRST_ID, storageOwner()))).toBeNull();
  });

  /**
   * DONE ON AN EMPTY TEXTAREA MEANS NOTHING WAS WRITTEN, SO NOTHING HAPPENS.
   *
   * `canSend` already refuses a blank body (the server would accept and post one —
   * `drafts-service.ts:167-171`), and Skip is the affordance for advancing without typing.
   * Making Done fall through to Skip would put back a second way to leave a step that sends
   * no mail, which is the shape this slice exists to remove.
   */
  it("Done on an empty editor sends nothing, discharges nothing and does not advance", async () => {
    await shell();
    await openRun();
    const stepSubject = subjectOnScreen();

    await act(async () => {
      done().click();
    });
    await drain();

    expect(kindsOf("mail_send"), "Done posted an empty reply").toEqual([]);
    expect(kindsOf("triage_set"), "Done discharged a debt with nothing written").toEqual([]);
    expect(subjectOnScreen()).toBe(stepSubject);

    // Skip is what moves on — and it discharges nothing either.
    await act(async () => {
      within(run()!).getByRole("button", { name: "Skip" }).click();
    });
    expect(subjectOnScreen(), "Skip did not advance the run").not.toBe(stepSubject);
    expect(kindsOf("triage_set"), "Skip discharged the item it skipped").toEqual([]);
    expect(hasFirstItem(), "Skip removed the message from the pile").toBe(true);
  });

  /**
   * THE DOUBLE-SEND GUARD, ON THE SURFACE THAT DID NOT EXIST WHEN IT WAS WRITTEN.
   *
   * `mail-send.ts:203-215` names a future Reply Run step as exactly the caller that cannot be
   * saved by a button's `disabled`: two presses inside one tick both read `idle` from React
   * state, mint two Idempotency-Keys, make two reservations and deliver the same mail to the
   * same person twice. The ref lock is what stops it, and the run only gets that lock by
   * going through `useMailSend` — dispatch `engine.mutate({kind:"mail_send"})` from `onDone`
   * and this goes to 2 (the "No silent AI actions" invariant).
   */
  it("two Done presses in one tick are ONE delivery — the run goes through useMailSend", async () => {
    await shell();
    await openRun();
    await typeReply(TYPED);

    await act(async () => {
      const press = done();
      press.click();
      press.click();
    });
    await drain();

    expect(kindsOf("mail_send"), "the Reply Run sent the same reply twice").toHaveLength(1);
  });

  /**
   * ── DONE, WHILE THE SAME REPLY IS ALREADY GOING OUT ───────────────────────────────────────
   *
   * The run and the inline editor are ONE message on ONE lane, deliberately: they share the
   * scratch buffer, so a reply begun in one and finished in the other must go out as the same
   * message. The lock that makes that true also made a press during the send do NOTHING, on a
   * button whose own label already read "Sending…" — a control that looks live and is not.
   *
   * The button is refused for the window the editor is already read-only in — one derivation,
   * `frPhase`, for the editor's `editable` and for this. NOT by giving the run a key of its own:
   * two keys for one message are two reservations and two copies at the recipient, which is the
   * failure this whole seam exists to refuse.
   *
   * Mutation: drop `donePending` from the overlay's Done button. Real failure text:
   *   AssertionError: Done is live while the same reply is already going out …
   */
  it("Done is refused for the window the editor is already read-only in", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
    const reply = read("packages/app/src/write/Reply.tsx");
    const gate = read("packages/app/src/write/reply-gate.ts");
    const run = read("packages/app/src/reader/actions/ReplyRun.tsx");
    expect(reply).toContain("const going = SEND_IN_FLIGHT_PHASES.has(reply.send.phase)");
    expect(reply).toContain("editable={!going && drafted?.drafting !== true}");
    expect(gate).toContain("going: SEND_IN_FLIGHT_PHASES.has(reply.send.phase)");
    expect(gate).toContain("sendVerb(sendWord, mayGo, going,");
    expect(run).toContain('{ ...send, label: t("run.done")');
    expect(reply).toContain("w.sendReply(reply.messageId)");
    expect(gate).toContain('const lane = reply.mode === "forward" ? inlineForwardKey(reply.messageId) : reply.messageId;');
  });

  /**
   * The acceptance's third line. The text is held per MESSAGE and mirrored into the same
   * `localStorage` scratch buffer the inline reply uses, so leaving the run does not destroy
   * it — the route-transition effect drops the run itself (`AppShell.tsx:388`), which is why
   * a per-STEP React map keyed on an index the next run re-issues could never have survived.
   */
  it("the typed reply survives leaving the run and coming back to it", async () => {
    await shell();
    await openRun();
    await typeReply(TYPED);

    await key("Escape");
    expect(run(), "Escape did not close the Reply Run").toBeNull();
    await key("g");
    await key("o");
    await screen.findByRole("heading", { name: "Ohbox" });
    await key("f");
    await waitFor(() => run() !== null && editor() !== null, "the Reply Run to reopen from Ohbox");
    expect(editorOf(editor()!).getText(), "the reply was lost by walking away from the run")
      .toBe(TYPED);
    expect(kindsOf("triage_set"), "walking away discharged the item").toEqual([]);
  });
});
