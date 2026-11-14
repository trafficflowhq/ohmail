/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { OhmailEngine, type EngineAdapter, type EngineMutation } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { useComposeAutosave, AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import {
  composeDraftKey, clearComposeDraft, readComposeDraft, writeComposeDraft,
  EMPTY_COMPOSE, LEGACY_COMPOSE_DRAFT_KEY, type ComposeFields,
} from "../app/shell/compose";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ ABANDONING A MESSAGE FROM THE SURFACE YOU ARE WRITING IT ON ═════════════════════════
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────
 *
 * Compose had no cancel of any kind. Escape LEFT the view and the row autosave had written
 * stayed on the account, so throwing a half-written message away meant going to Drafts and
 * discarding it there — a second surface, after the fact, for a decision taken here. The reply
 * editor has had a Cancel since it was built; the compose form never did.
 *
 * ── THE SEMANTICS, AND WHY THEY ARE SPLIT ────────────────────────────────────────────────
 *
 *   · NOTHING WORTH KEEPING ⇒ leave, delete the row, ask nothing. The predicate is
 *     `worthSaving` — the SAME one that decided whether to write a row at all — so "there was
 *     nothing to save" and "there is nothing to ask about" cannot drift apart.
 *   · ANYTHING WRITTEN ⇒ the Drafts list's two-press confirm, in the panel's foot. NOT an undo
 *     toast: `DELETE /drafts/:id` is a real delete and the row is the only copy of an unsent
 *     message, so an undo affordance would offer something the product cannot do.
 *   · ESCAPE NEVER DESTROYS. It closes the confirm when one is open and leaves the view
 *     otherwise — the escape cascade's own rule (`AppShell`: close the innermost open thing),
 *     read at view scope. The press that deletes is the one labelled with what it deletes.
 *
 * ── AND THE WINDOW CANCEL MAKES EASY TO HIT ──────────────────────────────────────────────
 *
 * The debounce is two seconds and a create takes a round trip, so a form can be abandoned
 * WHILE ITS FIRST SAVE IS ON THE WIRE. The create then confirms into a hook that has already
 * released, and its `entityId` used to be adopted — leaving a row on the account belonging to a
 * message that was discarded. Nothing surfaces it; the Drafts list simply grows a copy. The
 * last describe is that race, run deliberately.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  try {
    return readFileSync(resolve(process.cwd(), fromRoot), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
   PART ONE — the surface, driven through the shipped shell.
   ───────────────────────────────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The whole client on the fixture world, parked on `#/compose`. */
async function mountCompose(): Promise<void> {
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
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

/** The foot's Cancel — matched on its own class, never on a label another button could share. */
const cancelButton = (): HTMLButtonElement =>
  q<HTMLButtonElement>(".compose-foot .compose-cancel")!;

/**
 * The To entries as the FORM holds them — settled chips plus the input's raw tail.
 *
 * This used to read `#compose-to`'s `.value` alone, and that read was only ever true by
 * accident: the form opened with nothing focused, so the typed text sat in the input for
 * ever. Compose now focuses To on mount (`ComposeView.initialFocus`), so when the discard
 * question takes focus the field BLURS — and leaving the field commits the typed entry into
 * a chip, by design ("the entry is finished by the leaving", `RecipientField.tsx`). The
 * property guarded by the callers is unchanged — the question must not DESTROY the text —
 * and a settled chip IS the text, kept; this reads it wherever it lives.
 */
const toEntries = (): string => {
  const field = q<HTMLInputElement>("#compose-to")!;
  const chips = [...field.closest(".rcp")!.querySelectorAll(".rcp-chip-addr")]
    .map((n) => n.textContent ?? "");
  return [...chips, field.value].filter(Boolean).join(", ");
};

const btnIn = (sel: string, label: string): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(`${sel} button`)]
    .find((b) => b.textContent === label)!;

/** Type into the To field the way React sees it — the native setter, then an input event. */
async function typeTo(value: string): Promise<void> {
  const input = q<HTMLInputElement>("#compose-to")!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

const escape = async (): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
};

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
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

describe("Compose offers a cancel at all", () => {
  /**
   * Mutation: delete the `.compose-cancel` button from `ComposeView`. Real failure text:
   *   AssertionError: the compose foot has no cancel — abandoning a message still means going
   *   to the Drafts list: expected null not to be null
   */
  it("renders it in the foot, beside Send", async () => {
    await mountCompose();
    const foot = q<HTMLElement>(".compose-foot");
    expect(foot, "compose rendered no foot").not.toBeNull();
    expect(
      foot!.querySelector(".compose-cancel"),
      "the compose foot has no cancel — abandoning a message still means going to the "
        + "Drafts list",
    ).not.toBeNull();
    // In the SEND ROW: the two ways this message can end, in one place.
    expect(
      q(".compose-foot .send-row .compose-cancel"),
      "the cancel is in the foot but not beside Send",
    ).not.toBeNull();
  });
});

describe("an empty compose is cancelled with one press", () => {
  /**
   * NOTHING WRITTEN ⇒ NO QUESTION. A confirm over an empty form is a dialog about nothing, and
   * the user has to read it to find that out.
   *
   * Mutation: drop the `worthSaving(fields)` test in `cancel` (always confirm). Real failure
   * text:
   *   AssertionError: cancelling an untouched compose asked a question about nothing: expected
   *   <div class="compose-confirm"…> to be null
   */
  it("leaves immediately and asks nothing", async () => {
    await mountCompose();
    expect(q(".view-compose"), "the compose view is not on screen").not.toBeNull();

    await press(cancelButton());

    expect(
      q(".compose-confirm"),
      "cancelling an untouched compose asked a question about nothing",
    ).toBeNull();
    expect(window.location.hash, "cancelling an empty compose did not leave the view")
      .toBe("#/ohbox");
  });
});

describe("a written compose is cancelled with a confirm", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * ONE PRESS MUST NOT DELETE A MESSAGE. The row is the only copy of something unsent and the
   * delete is real, so the first press asks and the second acts — the Drafts list's idiom, for
   * the reason its header gives.
   *
   * Mutation: make `cancel` call `onCancel()` unconditionally. Real failure text:
   *   AssertionError: cancelling a written compose left the view without asking: expected
   *   '#/ohbox' to be '#/compose'
   */
  it("asks first, and stays on the message while it asks", async () => {
    await mountCompose();
    await typeTo("sam@example.com");

    await press(cancelButton());

    const panel = q<HTMLElement>(".compose-confirm");
    expect(panel, "cancelling a written compose asked nothing").not.toBeNull();
    expect(window.location.hash, "cancelling a written compose left the view without asking")
      .toBe("#/compose");
    expect(toEntries(), "the text was taken away by the question")
      .toContain("sam@example.com");
    /* A DIALOG TO THE ACCESSIBILITY TREE, NOT A SILENT GROUP — CMP-F12. `role="group"` appears
       without an announcement and without a focus move, so a screen-reader user pressed Cancel
       and heard nothing while a destructive question sat on screen.
       Mutation: put `role="group"` back and drop the focus effect. Real failure text:
         AssertionError: the discard question opened without taking focus — it is silent to a
         screen reader: expected <body></body> to be <div class="compose-confirm"…> */
    expect(panel!.getAttribute("role")).toBe("alertdialog");
    expect(panel!.getAttribute("aria-label")).toBe("Discard message");
    expect(
      panel!.getAttribute("aria-describedby"),
      "the dialog does not name its own sentence — the label alone is read",
    ).toBe("compose-cancel-what");
    expect(
      document.activeElement,
      "the discard question opened without taking focus — it is silent to a screen reader",
    ).toBe(panel);
    expect(cancelButton().getAttribute("aria-expanded")).toBe("true");
  });

  /**
   * ══ CMP-F5 — THE GUARD MUST SEE THE FILES ══════════════════════════════════════════════
   *
   * `worthSaving` reads the text fields only, and rightly (attachment bytes are never
   * autosaved, so they are no reason to write a row). But the cancel question is about what
   * the user LOSES, and picked files are exactly that: a compose holding only an attachment
   * used to discard silently.
   *
   * The file is a plain text file on purpose — `shrinkImage` passes non-images through
   * untouched, so no canvas model is needed in jsdom.
   *
   * Mutation: drop the `(fields.attachments?.length ?? 0) > 0` term from `cancel`. Real
   * failure text:
   *   AssertionError: cancelling a compose that holds only an attachment discarded it silently
   *   — the files are a loss the question must name: expected '#/ohbox' to be '#/compose'
   */
  it("asks before discarding a compose that holds ONLY an attachment", async () => {
    await mountCompose();
    const input = q<HTMLInputElement>('.compose-attach input[type="file"]')!;
    const file = new File([new Uint8Array(2048)], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // FileReader delivers as a task — drain it before pressing anything.
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(
      q(".compose-attach-item"),
      "the file never attached, so the cancel question proves nothing",
    ).not.toBeNull();

    await press(cancelButton());

    expect(
      window.location.hash,
      "cancelling a compose that holds only an attachment discarded it silently — the files "
        + "are a loss the question must name",
    ).toBe("#/compose");
    expect(q(".compose-confirm")).not.toBeNull();
  });

  /**
   * ══ CMP-F12's SECOND HALF — THE SENTENCE IS EXACTLY AS WIDE AS THE TRUTH ═══════════════
   *
   * "here and on your account" is right once autosave has written a row and wrong before it
   * has: a never-saved message exists in this browser alone, and a warning that exaggerates
   * teaches people warnings exaggerate. The debounce is two seconds, so pressing Cancel
   * straight after typing is exactly the never-saved case.
   *
   * Mutation: render `t("cancelWhat")` unconditionally. Real failure text:
   *   AssertionError: the confirm claims the account holds a copy it does not hold: expected
   *   'This deletes what you've written, here an…' not to contain 'on your account'
   */
  it("does not claim `on your account` before a row exists there", async () => {
    await mountCompose();
    await typeTo("sam@example.com");

    await press(cancelButton());

    const what = q<HTMLElement>("#compose-cancel-what");
    expect(what, "the confirm carries no sentence at all").not.toBeNull();
    expect(
      what!.textContent ?? "",
      "the confirm claims the account holds a copy it does not hold",
    ).not.toContain("on your account");
  });

  /** "Keep writing" is not the press that deletes, and it puts the form back as it was. */
  it("`Keep writing` closes the question and changes nothing", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    await press(cancelButton());

    await press(btnIn(".compose-confirm", "Keep writing"));

    expect(q(".compose-confirm"), "`Keep writing` left the question open").toBeNull();
    expect(window.location.hash, "`Keep writing` left the view").toBe("#/compose");
    expect(toEntries()).toContain("sam@example.com");
    expect(cancelButton().getAttribute("aria-expanded")).toBe("false");
    // Focus goes back where the question came from — the dialog took it, so closing without
    // acting must return it (CMP-F12; a keyboard user is otherwise dropped on <body>).
    expect(
      document.activeElement,
      "closing the question stranded focus instead of returning it to the trigger",
    ).toBe(cancelButton());
  });

  /**
   * AND THE CONFIRM EMPTIES ALL THREE COPIES. The form, the `localStorage` scratch buffer and
   * the account row are three places the same message lives; leaving any one of them is the
   * message coming back. The row is asserted in PART TWO (it needs a recording adapter); the
   * two this surface owns are asserted here.
   *
   * THE BUFFER IS READ OUT OF STORAGE AND NOT INFERRED FROM THE REOPENED FORM, and that
   * correction is the whole reason this comment is long. Re-entering `#/compose` and finding it
   * empty proves NOTHING about the buffer: `AppShell` seeds the form from `readComposeDraft()`
   * in a `useState` initialiser, which runs once per MOUNT, and a hash change does not remount
   * the shell. Measured — deleting `clearComposeDraft()` from `cancelCompose` left this test
   * green when it asserted the reopened field. It survives the next reload, not the next
   * navigation, so the storage key is the only honest place to ask.
   *
   * Mutation: drop `clearComposeDraft()` from `cancelCompose`. Real failure text:
   *   AssertionError: the discarded message is still in the local scratch buffer — the next
   *   time this browser opens Compose it comes back: expected '{"to":"sam@example.com"…' to be
   *   null
   */
  it("`Discard message` leaves, empties the form and clears the local buffer", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    expect(
      window.localStorage.getItem(composeDraftKey()),
      "typing wrote no scratch buffer, so clearing one proves nothing",
    ).toContain("sam@example.com");

    await press(cancelButton());
    await press(btnIn(".compose-confirm", "Discard message"));

    expect(window.location.hash, "the confirm did not leave the view").toBe("#/ohbox");
    expect(
      window.localStorage.getItem(composeDraftKey()),
      "the discarded message is still in the local scratch buffer — the next time this browser "
        + "opens Compose it comes back",
    ).toBeNull();

    // …and the in-memory form is empty too, which is the half a returning navigation sees.
    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settleFirstPaint();
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(
      q<HTMLInputElement>("#compose-to")!.value,
      "the discarded message is still in the form",
    ).toBe("");
  });
});

describe("Escape closes the question, and never the message", () => {
  /**
   * ONE Escape BINDING, BRANCHING — the escape cascade's rule at view scope. A second binding
   * for the confirm would be the two-lists shape `AppShell`'s cascade exists to refuse.
   *
   * Mutation: restore the unconditional `run: () => go("ohbox")`. Real failure text:
   *   AssertionError: Escape left Compose while the discard question was open: expected
   *   '#/ohbox' to be '#/compose'
   */
  it("closes the confirm rather than leaving, while one is open", async () => {
    await mountCompose();
    await typeTo("sam@example.com");
    await press(cancelButton());
    expect(q(".compose-confirm")).not.toBeNull();

    await escape();

    expect(q(".compose-confirm"), "Escape did not close the discard question").toBeNull();
    expect(window.location.hash, "Escape left Compose while the discard question was open")
      .toBe("#/compose");
    // The message is untouched: Escape is not a delete, however many times it is pressed.
    expect(toEntries()).toContain("sam@example.com");
  });

  /** With nothing open it is the leave it has always been, and the draft is KEPT. */
  it("leaves Compose when no question is open, and does not throw the message away", async () => {
    await mountCompose();
    await typeTo("sam@example.com");

    await escape();

    expect(window.location.hash, "Escape no longer leaves Compose").toBe("#/ohbox");
    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settleFirstPaint();
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(
      q<HTMLInputElement>("#compose-to")!.value,
      "Escape destroyed the message — it is a leave, not a discard",
    ).toBe("sam@example.com");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   PART TWO — the account row, on a recording adapter.

   The demo engine is a fixtures world with no drafts in it, so the mutation half is driven
   through the hook `AppShell` calls, with the wiring pinned structurally below. This is the
   division `compose-autosave.test.ts` already uses and for the reason its last describe gives:
   a hook that works perfectly and is called by nothing is the failure mode.
   ───────────────────────────────────────────────────────────────────────────────────────── */

let sent: EngineMutation[];
let minted: number;
let seq: number;
let hookRoot: Root | null = null;
let hookHost: HTMLDivElement | null = null;
let seen: ReturnType<typeof useComposeAutosave>;
/** Resolved by the test to release a create that is deliberately held in flight. */
let holdCreate: ((go: () => void) => void) | null = null;

function recordingAdapter(): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async (m: EngineMutation) => {
      sent.push(m);
      const n = ++seq;
      if (m.kind === "draft_save") {
        if (m.draftId === null && holdCreate) {
          await new Promise<void>((go) => { holdCreate!(go); });
        }
        const id = m.draftId ?? `srv-${++minted}`;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id, mailboxId: "mb-1", status: "draft" } as unknown as Record<string, unknown>,
          }] as never,
          seq: n,
          entityId: id,
        };
      }
      if (m.kind === "draft_discard") {
        return {
          changes: [{
            type: "draft", op: "delete", id: m.draftId, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z", entity: null,
          }] as never,
          seq: n,
        };
      }
      return { changes: [], seq: n };
    },
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
}

function Harness({ engine, fields }: { engine: OhmailEngine; fields: ComposeFields }) {
  seen = useComposeAutosave({ engine, fields, mailboxId: "mb-1", active: true });
  return null;
}

async function mountHook(engine: OhmailEngine, fields: ComposeFields): Promise<void> {
  hookHost = document.createElement("div");
  document.body.appendChild(hookHost);
  hookRoot = createRoot(hookHost);
  await act(async () => hookRoot!.render(h(Harness, { engine, fields })));
}

async function rerenderHook(engine: OhmailEngine, fields: ComposeFields): Promise<void> {
  await act(async () => hookRoot!.render(h(Harness, { engine, fields })));
}

/** Run the debounce out and let every promise it started settle. */
async function drain(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 10);
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  });
}

const typed = (over: Partial<ComposeFields> = {}): ComposeFields => ({
  ...EMPTY_COMPOSE, to: "sam@example.com", subject: "Friday", body: "Are we still on?", ...over,
});

describe("cancelling deletes the row the account is holding", () => {
  beforeEach(() => {
    sent = []; minted = 0; seq = 0; holdCreate = null;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    if (hookRoot) await act(async () => { hookRoot!.unmount(); });
    hookHost?.remove();
    hookRoot = null;
    hookHost = null;
    vi.useRealTimers();
  });

  /**
   * ══ THE MUTATION THE OWNER'S COMPLAINT IS ABOUT ════════════════════════════════════════
   *
   * A message that was written, autosaved and then emptied still HAS a row. Cancelling has to
   * delete it: a compose the user cleared and walked away from must not turn up in Drafts as an
   * empty draft they never chose to keep.
   *
   * Mutation: make `cancelCompose` clear the form without calling `autosave.discard()`. Real
   * failure text:
   *   AssertionError: cancelling left the row on the account: expected [ 'draft_save' ] to
   *   deeply equal [ 'draft_save', 'draft_discard' ]
   */
  it("an emptied compose still deletes its row", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    await mountHook(engine, typed());
    await drain();
    expect(seen.draftId, "nothing was written, so there is no row to cancel").toBe("srv-1");

    // Cleared by hand, then cancelled — `worthSaving` is false here, which is the branch that
    // leaves with no question and must still take the row with it.
    await rerenderHook(engine, EMPTY_COMPOSE);
    await act(async () => { await seen.discard(); });

    expect(
      sent.map((m) => m.kind),
      "cancelling left the row on the account",
    ).toEqual(["draft_save", "draft_discard"]);
    expect(sent[1]).toEqual({ kind: "draft_discard", draftId: "srv-1" });
    expect(seen.draftId, "the hook still points at a row that has been deleted").toBeNull();
  });

  /**
   * ══ THE RACE CANCEL MAKES EASY ═════════════════════════════════════════════════════════
   *
   * Cancel at 2.01s: the create is on the wire, `discard` releases, then the create confirms.
   * Without the epoch check the hook adopted that id — a row on the account for a message that
   * was discarded, which nothing on any surface will ever refer to again. It cannot be seen
   * from the compose form; it appears in the Drafts list as a copy of something thrown away.
   *
   * Mutation: delete the `era !== epoch.current` block in `compose-autosave.ts`. Real failure
   * text:
   *   AssertionError: a create that landed after the cancel was adopted instead of undone —
   *   the discarded message is a row on the account: expected [ 'draft_save' ] to deeply equal
   *   [ 'draft_save', 'draft_discard' ]
   */
  it("a create that lands AFTER the cancel is undone, not adopted", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    let release: (() => void) | null = null;
    holdCreate = (go) => { release = go; };

    await mountHook(engine, typed());
    await drain();
    // The create is in flight and the server has not answered.
    expect(sent.map((m) => m.kind)).toEqual(["draft_save"]);
    expect(seen.draftId, "the create answered before the test could cancel").toBeNull();

    // Cancel now. There is no id yet, so this is a pure release from the form's point of view.
    await act(async () => { await seen.discard(); });
    expect(sent.map((m) => m.kind), "the cancel deleted a row that does not exist yet")
      .toEqual(["draft_save"]);

    // …and NOW the server answers the create.
    await act(async () => {
      release!();
      for (let i = 0; i < 60; i += 1) await Promise.resolve();
    });

    expect(
      sent.map((m) => m.kind),
      "a create that landed after the cancel was adopted instead of undone — the discarded "
        + "message is a row on the account",
    ).toEqual(["draft_save", "draft_discard"]);
    expect(sent[1]).toEqual({ kind: "draft_discard", draftId: "srv-1" });
    expect(seen.draftId, "the hook adopted the row it had already abandoned").toBeNull();
  });

  /**
   * AND AN UPDATE THAT LANDS LATE IS LEFT ALONE. `release` is also what a SEND does, and the
   * row a send released has become a sent message — deleting it would destroy the account's
   * record of outgoing mail. Only a CREATE is undone.
   *
   * Mutation: drop the `draftId === null` term from the epoch block. Real failure text:
   *   AssertionError: a late UPDATE deleted the row — a sent message's record is not the
   *   compose form's to delete: expected [ …, 'draft_discard' ] to deeply equal
   *   [ 'draft_save', 'draft_save' ]
   */
  it("a late UPDATE is left alone — a released row may be a sent message", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    await mountHook(engine, typed());
    await drain();
    expect(seen.draftId).toBe("srv-1");

    await rerenderHook(engine, typed({ body: "one more line" }));
    await drain();
    expect(sent.map((m) => m.kind)).toEqual(["draft_save", "draft_save"]);

    // A send settles: the form is released, the row is now a sent message.
    await act(async () => { seen.release(); });
    expect(
      sent.map((m) => m.kind),
      "a late UPDATE deleted the row — a sent message's record is not the compose form's to "
        + "delete",
    ).toEqual(["draft_save", "draft_save"]);
  });
});

describe("a settle that did not use the row deletes it — the reported defect, reproduced", () => {
  beforeEach(() => {
    sent = []; minted = 0; seq = 0; holdCreate = null;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    if (hookRoot) await act(async () => { hookRoot!.unmount(); });
    hookHost?.remove();
    hookRoot = null;
    hookHost = null;
    vi.useRealTimers();
  });

  /**
   * ══ THE RACE A SINGLE SIGNED-IN SESSION REPRODUCED, 2026-08-12 ═════════════════════════
   *
   * Send pressed ~80ms after the autosave timer fired: the mutation was built while the first
   * save's create was still on the wire, so it carried NO `draftId`; the adapter made its own
   * row and sent THAT; the create then confirmed and was adopted. `release()` — the old settle
   * path — KEEPS an adopted row, so the sent message sat in Drafts under "haven't sent" through
   * seconds of syncs and a hard reload, reopenable with Send live: a double-send invite the server
   * cannot clear, because it legitimately holds the row as a draft.
   *
   * Mutation: make `settled` call `release()` unconditionally. Real failure text:
   *   AssertionError: the send made its own row and the adopted one was kept — the sent message
   *   is sitting in Drafts: expected [ 'draft_save' ] to deeply equal
   *   [ 'draft_save', 'draft_discard' ]
   */
  it("discards the adopted row when the settled send carried no draftId", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    await mountHook(engine, typed());
    await drain();
    expect(seen.draftId, "no row was adopted, so there is nothing to reconcile").toBe("srv-1");

    // The send that just confirmed was built before the create landed: `draftId` absent.
    await act(async () => { seen.settled(null); });

    expect(
      sent.map((m) => m.kind),
      "the send made its own row and the adopted one was kept — the sent message is sitting "
        + "in Drafts",
    ).toEqual(["draft_save", "draft_discard"]);
    expect(sent[1]).toEqual({ kind: "draft_discard", draftId: "srv-1" });
    expect(seen.draftId).toBeNull();
  });

  /**
   * THE ORDINARY SEND IS UNTOUCHED: the row the send carried became the sent message, and
   * deleting it would destroy the account's record of an outgoing mail.
   *
   * Mutation: make `settled` call `discard()` unconditionally. Real failure text:
   *   AssertionError: the settle deleted the row the send itself used — that row IS the sent
   *   message: expected [ 'draft_save', 'draft_discard' ] to deeply equal [ 'draft_save' ]
   */
  it("releases — never deletes — the row the send itself carried", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    await mountHook(engine, typed());
    await drain();
    expect(seen.draftId).toBe("srv-1");

    await act(async () => { seen.settled("srv-1"); });

    expect(
      sent.map((m) => m.kind),
      "the settle deleted the row the send itself used — that row IS the sent message",
    ).toEqual(["draft_save"]);
    expect(seen.draftId).toBeNull();
  });

  /**
   * AND THE CREATE THAT CONFIRMS ONLY AFTER THE SETTLE IS STILL UNDONE — the epoch guard's
   * case, reachable through `settled` too: pressing Send INSIDE the create's round trip means
   * nothing is adopted yet when the settle runs, and the row must not appear afterwards.
   */
  it("a create landing after the settle is undone, not adopted", async () => {
    const engine = new OhmailEngine({ adapter: recordingAdapter() });
    let release: (() => void) | null = null;
    holdCreate = (go) => { release = go; };

    await mountHook(engine, typed());
    await drain();
    expect(seen.draftId, "the create answered before the test could settle").toBeNull();

    await act(async () => { seen.settled(null); });

    await act(async () => {
      release!();
      for (let i = 0; i < 60; i += 1) await Promise.resolve();
    });

    expect(
      sent.map((m) => m.kind),
      "a create that landed after the settle was adopted — the sent message is a row in Drafts",
    ).toEqual(["draft_save", "draft_discard"]);
    expect(seen.draftId).toBeNull();
  });
});

describe("the shell is the consumer, not just the harness", () => {
  /**
   * BOTH ENDS OF THE WIRE, structurally — the blind spot `compose-autosave.test.ts` names: a
   * callback that does the right thing and is passed to nothing. `cancelCompose` has to name
   * all three copies of the message, because leaving any one of them is the message coming
   * back.
   */
  it("AppShell hands ComposeView a cancel that empties row, buffer and form", () => {
    /* The prop is JSX and stayed in the shell frame; the verb moved to `shell-compose.ts`
       (ARCH-022), so each half is asked of the file that holds it. */
    expect(
      readSource("app/shell/AppShell.tsx"),
      "ComposeView is rendered without a cancel — the button has nothing behind it",
    ).toMatch(/onCancel=\{cancelCompose\}/);
    const shell = readSource("app/shell/shell-compose.ts");

    const body = /const cancelCompose = useStableCallback\(\(\) => \{([\s\S]*?)\n  \}\);/.exec(shell)?.[1];
    expect(body, "there is no `cancelCompose` in the shell").toBeDefined();
    expect(body!, "cancelling does not delete the account row").toContain("autosave.discard()");
    expect(body!, "cancelling leaves the message in the local scratch buffer")
      .toContain("clearComposeDraft()");
    expect(body!, "cancelling leaves the message in the form").toContain("EMPTY_COMPOSE");
    expect(body!, "cancelling does not leave the compose view").toMatch(/go\("ohbox"\)/);
  });

  /**
   * ══ CMP-F1's WIRING, BOTH SURFACES ═════════════════════════════════════════════════════
   *
   * The hook's `settled` is exercised above; what a hook cannot prove is that the SHELL routes
   * a settle through it — a `settled` that works perfectly and is never called leaves the
   * production repro exactly as it was. Same blind spot this describe exists for.
   */
  it("AppShell routes the settle through the draft bookkeeping, compose and reply alike", () => {
    const shell = readSource("app/shell/shell-compose.ts");
    /*
     * ── THE ROUTE MOVED AND THE CLAIM DID NOT ──────────────────────────────────────────────
     *
     * `releaseDraft.current(m.draftId ?? null)` stood here. The live confirmed path now goes
     * through `settleCompose` — invariant T's one function — because the reload path cleared a
     * compose in two statements while this one cleared it in four, and the two drifted until a
     * delivered message sat in the composer behind an idle projection.
     *
     * The claim under test is unchanged and is still asserted whole: the settle consults the
     * SETTLED MUTATION's own `draftId` (a send that made its own row must not leave the adopted
     * one in Drafts), and release-vs-discard is still decided by the hook's `settled` — which
     * `settleCompose` calls, so the judgement did not move, only its caller.
     */
    expect(
      shell,
      "the compose settle no longer consults the settled mutation's draftId — a send that made "
        + "its own row leaves the adopted one in Drafts",
    ).toMatch(/kind: "sentByMirror", rowId: m\.draftId \?\? null/);
    expect(
      shell,
      "the settle handler is not the autosave hook's own ending — release-vs-discard is "
        + "decided nowhere",
    ).toMatch(/settleComposeRef\.current = autosave\.settleCompose;/);
    expect(
      readSource("app/shell/compose-autosave.ts"),
      "`settleCompose` stopped calling the hook's own `settled`, so release-vs-discard is decided "
        + "nowhere",
    ).toMatch(/settledRef\.current\(fate\.rowId\);/);
    expect(
      shell,
      "a reply seeded from a Drafts row keeps that row after delivery — the sent reply sits in "
        + "Drafts as a phantom",
    ).toMatch(/replySeedDrafts\.current\.get\(key\)/);
    expect(shell).toMatch(/kind: "draft_discard", draftId: seeded/);
  });

  /**
   * The question is asked by the SAME predicate that decided the row was worth writing — plus
   * ONE named term for what that predicate rightly ignores: the picked files (CMP-F5).
   * Attachments are never autosaved, so they are no reason to write a row, and they are
   * exactly a reason to ask before deleting. The term lives beside `worthSaving`, never inside
   * it, so autosave cannot start writing rows for attachment-only forms by accident.
   */
  it("ComposeView gates the confirm on `worthSaving` plus the attachments term", () => {
    const view = readSource("app/views/ComposeView.tsx");
    /* The SPECIFIER, not the whole list: the view also takes `draftNoteKey` from this module (the
       save door's ceiling and the sentence it renders are one decision), and pinning the list
       spelling made an unrelated addition red about nothing. `worthSaving` is still required. */
    expect(view, "the compose view no longer imports the autosave predicate")
      .toMatch(/import \{[^}]*\bworthSaving\b[^}]*\} from "\.\.\/shell\/compose-autosave"/);
    expect(
      view,
      "the confirm is gated on something other than `worthSaving` — a second rule about what "
        + "counts as a written message is a rule that drifts",
    ).toMatch(
      /if \(worthSaving\(fields\) \|\| \(fields\.attachments\?\.length \?\? 0\) > 0\) setConfirmCancel\(true\);/,
    );
  });
});

/**
 * ── THE SCRATCH BUFFER BELONGS TO AN ACCOUNT, NOT TO A BROWSER ──────────────────────────
 *
 * `localStorage` is per-ORIGIN. Nothing in sign-out could reach the old un-owned key:
 * `clearBootCaches()` removes the `ohmail.boot.` prefix and `clearAllMirrors()` is IndexedDB,
 * so `ohmail.ui.compose` outlived the session that wrote it. The next account to sign in on
 * that browser opened Compose and got the previous person's unfinished message — recipients,
 * subject and body — which autosave could then persist as a draft on THEIR mailbox.
 *
 * Mutation: make `composeDraftKey` return the bare `"ohmail.ui.compose"` again. Both cases
 * below go red; every other compose test stays green, because with one account in the jar the
 * owned and un-owned keys are indistinguishable.
 */
describe("the compose scratch buffer is scoped to the signed-in account", () => {
  const asOwner = (id: string | null) => {
    // `readOwner` reads `document.cookie`; jsdom lets us write it.
    document.cookie = id === null
      ? "tf_owner=; Max-Age=0; Path=/"
      : `tf_owner=${id}; Path=/`;
  };
  /* These cases are about a SIGNED-IN product client, and the mounts above this describe render
     `AppShell demo`, which leaves the demo's storage partition latched in this module. Restoring
     the precondition is the reset, not a weakening: the mutation named above still reddens both. */
  beforeEach(() => { resetStorageOwnerForTest(); });
  afterEach(() => { asOwner(null); window.localStorage.clear(); resetStorageOwnerForTest(); });

  it("a draft written by one account is not restored for the next one", () => {
    asOwner("11111111-1111-4111-8111-111111111111");
    writeComposeDraft({
      ...EMPTY_COMPOSE, to: "counterparty@example.com",
      subject: "the acquisition price", body: "we can go to 4.2",
    });
    expect(readComposeDraft().subject, "the writer still reads their own draft")
      .toBe("the acquisition price");

    asOwner("22222222-2222-4222-8222-222222222222");
    const next = readComposeDraft();
    expect(next.subject, "the second account must not inherit the first's message").toBe("");
    expect(next.to).toBe("");
    expect(next.body).toBe("");
  });

  it("the legacy un-owned key is drained on clear and never read back", () => {
    // A browser upgraded from an earlier bundle still holds it. Reading it once "to migrate"
    // would BE the leak — the reader cannot know whose draft it is — so it is only removed.
    window.localStorage.setItem(
      LEGACY_COMPOSE_DRAFT_KEY,
      JSON.stringify({ to: "stranger@example.com", subject: "left behind", body: "x" }),
    );
    asOwner("33333333-3333-4333-8333-333333333333");
    expect(readComposeDraft().subject, "the legacy key is not a source").toBe("");
    clearComposeDraft();
    expect(window.localStorage.getItem(LEGACY_COMPOSE_DRAFT_KEY)).toBeNull();
  });
});
