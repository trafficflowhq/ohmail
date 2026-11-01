/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, EntityReader } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { KeymapProvider, useKeyBindings } from "../app/shell/keymap";
import { ShortcutSheet } from "../app/shell/ShortcutSheet";
import { readerMoveRefusal, rosterStateOf, type RosterState } from "../app/shell/mail-state";
import { isModalOpen } from "../app/shell/modal-gate";
import {
  DELETE_INTENT_TTL_MS,
  armDeleteIntent,
  deleteIntentsKey,
  takeDeleteIntents,
} from "../app/shell/delete-intents";
import {
  UNDO_MS,
  createDeleteUndo,
  deleteKeyBindings,
  hideMessages,
  replayDeleteIntents,
  useDeleteUndo,
} from "../app/shell/delete-undo";

/**
 * ═══ BACKSPACE AND DELETE FILE THE FOCUSED MESSAGE TO TRASH ═════════════════════════════════
 *
 * The rules, over the real units. `delete-key-shell.test.tsx` proves they are reached.
 *
 * ── EVERY NEGATIVE HAS A POSITIVE CONTROL, AND THAT IS NOT DECORATION ──────────────────────
 *
 * The first version of this file asserted "nothing was deleted" in eight places, and review
 * pointed out that every one of them ALSO passes with the feature deleted. A negative on its own
 * says nothing about whether the harness can see a delete at all — it is green over a working
 * guard and green over an absent verb, which is precisely the class of guard this repository
 * keeps finding in its own history.
 *
 * So each refusal case here presses TWICE: once in the condition under test, and once in the
 * mirror-image condition where the verb must work. The pair is the assertion — the first press
 * did nothing AND the second one did, through the same harness, in the same test. Remove the
 * feature and the control goes red; remove the guard and the negative goes red.
 *
 * ── HOW TO WATCH THE REST FAIL ─────────────────────────────────────────────────────────────
 *
 *   · delete `"Delete"` from `deleteKeyBindings` → "both keys" goes red;
 *   · add `inInput: true` → the text-field case goes red;
 *   · drop `!isModalOpen(...)` from `when` → the modal cases go red;
 *   · make `remove` dispatch immediately → the window and undo cases go red;
 *   · drop the `open.has` guard → "a second press is one press" goes red;
 *   · drop `armDeleteIntent` → the durability cases go red;
 *   · make `readerMoveRefusal` answer `null` for a null roster or a foreign mailbox → the
 *     roster cases go red with a delete on the wire for a mailbox this install does not organize.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
afterEach(async () => { await unmount(); vi.useRealTimers(); window.localStorage.clear(); });

const press = async (key: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

const message = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  id: "m1",
  accountId: "a1",
  mailboxId: "mb1",
  threadId: "t1",
  folder: "INBOX",
  subject: "The invoice",
  from: { address: "someone@example.invalid", name: "Someone" },
  to: [],
  date: "2026-09-04T09:00:00.000Z",
  unread: true,
  updatedAt: "2026-09-04T09:00:00.000Z",
  ...over,
} as unknown as EngineMessage);

/** Mount the REAL registry over the REAL binding factory. Nothing here is a stand-in. */
async function mountKeys(opts: {
  focused?: EngineMessage | null;
  canDelete?: boolean;
  sheetOpen?: boolean;
  run: (m: EngineMessage) => void;
}): Promise<void> {
  await unmount();
  function Shell(): React.ReactNode {
    useKeyBindings(
      deleteKeyBindings({
        focused: opts.focused === undefined ? message() : opts.focused,
        label: en.shortcuts.deleteKey,
        canDelete: opts.canDelete ?? true,
        run: opts.run,
      }),
      "global",
    );
    return h(ShortcutSheet, { open: opts.sheetOpen ?? false, onClose: () => {} });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-09-04T09:00:00.000Z"),
      children: h(KeymapProvider, { children: h(Shell) }),
    }));
  });
}

describe("the keys", () => {
  it("BOTH Backspace and Delete file the focused message", async () => {
    const filed: string[] = [];
    await mountKeys({ run: (m) => filed.push(m.id) });
    await press("Backspace");
    await press("Delete");
    expect(filed).toEqual(["m1", "m1"]);
  });

  it("a HELD key is one press — and a fresh press still works, so the guard is not just silence", async () => {
    const filed: string[] = [];
    await mountKeys({ run: (m) => filed.push(m.id) });
    await press("Backspace", { repeat: true });
    expect(filed, "a repeat must not file").toEqual([]);
    // THE CONTROL. Same harness, same key, `repeat` false: if the verb were absent this is red.
    await press("Backspace");
    expect(filed).toEqual(["m1"]);
  });

  it("a TEXT FIELD keeps its own Backspace — and the same key on the document files", async () => {
    const filed: string[] = [];
    await mountKeys({ run: (m) => filed.push(m.id) });
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    const rich = document.createElement("div");
    /* jsdom does not derive `isContentEditable` from the attribute, so it is defined the way
       `isTypingTarget` reads it — the predicate under test is the shell's, not jsdom's. */
    Object.defineProperty(rich, "isContentEditable", { value: true });
    for (const el of [input, area, rich]) {
      document.body.appendChild(el);
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
      });
      el.remove();
    }
    expect(filed, "typing must not delete").toEqual([]);
    await press("Backspace");
    expect(filed, "the control: the same key on the document does file").toEqual(["m1"]);
  });

  it("no cursor, or a row the strip would refuse to draw — and the control shows the harness works", async () => {
    const filed: string[] = [];
    await mountKeys({ focused: null, run: (m) => filed.push(m.id) });
    await press("Backspace");
    expect(filed).toEqual([]);
    await mountKeys({ canDelete: false, run: (m) => filed.push(m.id) });
    await press("Delete");
    expect(filed).toEqual([]);
    await mountKeys({ run: (m) => filed.push(m.id) });
    await press("Delete");
    expect(filed, "the control").toEqual(["m1"]);
  });

  it("the `?` sheet lists it ONCE, with both keycaps", async () => {
    await mountKeys({ sheetOpen: true, run: () => {} });
    const rows = [...host!.querySelectorAll("li")]
      .filter((li) => li.textContent?.includes(en.shortcuts.deleteKey));
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌫", "⌦"]);
  });

  /**
   * ⇧⌫ AND ⇧⌦ ARE NOT THIS VERB — and this case is RED ON PURPOSE until the registry is fixed.
   *
   * `chordMatches` holds only single LETTERS to the no-shift rule (`/^[a-z]$/`), so a bare
   * `Backspace` binding also matches `Shift+Backspace`: the destructive verb runs on a chord the
   * `?` sheet does not advertise, and `preventDefault` eats that chord's own meaning on the way
   * (⇧⌦ is Cut in several environments). Found by review, 2026-09-06.
   *
   * The fix belonged to `keymap.tsx`, another lane's file that wave, so this guard was written
   * against the agreed behaviour and marked `it.fails` — which inverts: it passed while the
   * assertion failed and went RED the moment the assertion started passing, asking to be turned
   * into a plain `it` rather than being silently skipped or deleted.
   *
   * IT DID EXACTLY THAT. The registry fix landed as "a shifted press of a named key is not its
   * bare chord": `chordMatches` now refuses a shifted press for any key whose identity Shift
   * cannot change (`key.length > 1` — Backspace, Delete, Enter, Escape, the arrows) as well as
   * for letters, while punctuation stays allowed because there Shift is how the character is
   * typed and `?` must keep opening this very sheet. So the announcement arrived, and this is a
   * plain `it` now.
   */
  it("⇧⌫ and ⇧⌦ do nothing — a shifted press is not the bare chord", async () => {
    const filed: string[] = [];
    await mountKeys({ run: (m) => filed.push(m.id) });
    await press("Backspace", { shiftKey: true });
    await press("Delete", { shiftKey: true });
    expect(filed).toEqual([]);
  });
});

/* ── the modal gate, asked of the DOM ──────────────────────────────────────────────────────── */

describe("isModalOpen", () => {
  const add = (html: string): HTMLElement => {
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  };
  afterEach(() => { document.body.innerHTML = ""; });

  it("an empty page is not a question", () => {
    expect(isModalOpen(document)).toBe(false);
  });

  it("FIRST RUN gates it — the case the enumerated list could not see", () => {
    // `FirstRun.tsx` renders exactly this: a card with the modal claim, over a live Ohbox.
    add('<div class="login-card ob-card set-pane" role="dialog" aria-modal="true"></div>');
    expect(isModalOpen(document)).toBe(true);
  });

  it("a CONTACT POPOVER and a message MENU gate it — state the shell never holds", () => {
    const pop = add('<div class="cpop" role="dialog"></div>');
    expect(isModalOpen(document)).toBe(true);
    pop.remove();
    add('<div role="menu"><button role="menuitem">More</button></div>');
    expect(isModalOpen(document)).toBe(true);
  });

  it("the READING SHEET does not — it is the surface the verb acts on", () => {
    // `Reader.tsx` is `role="dialog"` and `aria-modal` at every width but the Zero push tier.
    add('<div class="reader" role="dialog" aria-modal="true"><article>the message</article></div>');
    expect(isModalOpen(document)).toBe(false);
  });

  it("…but a real dialog INSIDE the sheet does", () => {
    /* THIS TEST HELD THE DEFECT IN PLACE UNDER A NAME CLAIMING THE OPPOSITE. The exclusion was
       `closest('.reader')`, which walks UP from the match and so excluded every dialog the sheet
       CONTAINS; the assertion here read `toBe(false)` beneath a comment saying the exclusion
       cannot be a hiding place. It is the sharpest shape a bad guard takes — the name and the
       comment describe the safe behaviour, and the expectation pins the unsafe one, so the file
       reads as covered.

       It is reachable, which is what makes it worth this much comment: `.senderm` is in the
       selector so the sender popover gates, and that popover opens INSIDE the reader — reader
       open, screening open over it, ⌫ filed the message underneath. */
    add('<div class="reader" role="dialog"><div class="senderm" role="dialog"></div></div>');
    expect(isModalOpen(document)).toBe(true);
    document.body.innerHTML = "";
    add('<div class="reader" role="dialog"><div role="alertdialog"></div></div>');
    expect(isModalOpen(document), "an alertdialog nested in the sheet gates").toBe(true);
    document.body.innerHTML = "";
    // …and the sheet ALONE still does not, which is the half the exclusion exists for.
    add('<div class="reader" role="dialog" aria-modal="true"><article>the message</article></div>');
    expect(isModalOpen(document), "the sheet itself is not a question").toBe(false);
    document.body.innerHTML = "";
    add('<div class="reader" role="dialog"></div><div class="senderm" role="dialog"></div>');
    expect(isModalOpen(document)).toBe(true);
  });

  it("a HIDDEN dialog is not standing over anything", () => {
    const el = add('<div role="dialog" hidden></div>');
    expect(isModalOpen(document)).toBe(false);
    el.querySelector("div")!.removeAttribute("hidden");
    expect(isModalOpen(document), "the control").toBe(true);
  });

  it("an aria-hidden dialog is not either", () => {
    add('<div role="dialog" aria-hidden="true"></div>');
    expect(isModalOpen(document)).toBe(false);
  });

  it("a card that stands BESIDE the mail is not either; a question inside it still is", () => {
    const card = add('<div role="dialog" data-key-beside=""></div>');
    expect(isModalOpen(document)).toBe(false);
    card.querySelector("div")!.innerHTML = '<div role="menu"></div>';
    expect(isModalOpen(document), "a menu opened from the card").toBe(true);
  });
});

/* ── who may write to this mailbox ─────────────────────────────────────────────────────────── */

type Row = Parameters<typeof readerMoveRefusal>[0] extends ReadonlyArray<infer R> | null ? R : never;

const organizerRow = (id: string): Row => ({
  id, status: "connected", disabledReason: null, organizerRole: "organizer",
  organizedBy: null, organizeConsentedAt: "2026-09-02T09:00:00.000Z",
} as Row);
const readerRow = (id: string, name: string | null = "ohmail Cloud"): Row => ({
  id, status: "connected", disabledReason: null, organizerRole: "reader",
  organizedBy: { kind: "cloud", name, since: "2026-09-02T09:00:00.000Z" },
  organizeConsentedAt: "2026-09-02T09:00:00.000Z",
} as Row);

/** The `known` state, for the cases that are about the ROWS rather than about the state. */
const known = (rows: Row[]): RosterState => ({ kind: "known", rows });

const SAY = {
  named: (name: string) => en.screener.readerMoveRefused.replace("{name}", name),
  unknown: () => en.screener.readerMoveRefusedUnknown,
  nobody: () => en.screener.readerMoveRefusedNobody,
};

describe("readerMoveRefusal", () => {
  it("an organizer mailbox may be written to", () => {
    expect(readerMoveRefusal(known([organizerRow("mb1")]), ["mb1"], SAY)).toBeNull();
  });

  it("a reader mailbox is refused, and the holder is named", () => {
    expect(readerMoveRefusal(known([readerRow("mb1")]), ["mb1"], SAY))
      .toBe(en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"));
  });

  it("a reader whose holder this build cannot name gets the unnamed sentence", () => {
    expect(readerMoveRefusal(known([readerRow("mb1", null)]), ["mb1"], SAY))
      .toBe(en.screener.readerMoveRefusedUnknown);
  });

  it("A MIXED ROSTER judges the named mailbox, not the account", () => {
    /* THE DEFECT THIS REPLACES: `screenerMode` aggregates and answers `organizer` whenever ANY
       live mailbox is organized here, so a delete on the mailbox somebody else holds was offered,
       hidden and dispatched, and only the server rolled it back. Both directions asserted, so the
       fix cannot be "refuse everything". */
    const roster = [organizerRow("mine"), readerRow("theirs")];
    expect(readerMoveRefusal(known(roster), ["theirs"], SAY))
      .toBe(en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"));
    expect(readerMoveRefusal(known(roster), ["mine"], SAY)).toBeNull();
  });

  it("a selection spanning both is refused, and the FIRST refusing mailbox names the sentence", () => {
    const roster = [organizerRow("mine"), readerRow("a", "Studio"), readerRow("b", "Laptop")];
    expect(readerMoveRefusal(known(roster), ["mine", "a", "b"], SAY))
      .toBe(en.screener.readerMoveRefused.replace("{name}", "Studio"));
    expect(readerMoveRefusal(known(roster), ["mine", "b", "a"], SAY))
      .toBe(en.screener.readerMoveRefused.replace("{name}", "Laptop"));
  });

  it("AN UNKNOWN ROSTER REFUSES — a destructive verb fails closed", () => {
    // Null before the first probe answers, and through an outage. The control below shows the
    // predicate is not simply refusing everything.
    expect(readerMoveRefusal({ kind: "pending" }, ["mb1"], SAY)).toBe(en.screener.readerMoveRefusedUnknown);
    expect(readerMoveRefusal(known([organizerRow("mb1")]), ["mb1"], SAY), "the control").toBeNull();
  });

  it("A SHELL WITH NO PROBE PERMITS — the desktop and the demo, where there is no roster at all", () => {
    /* THE REGRESSION THIS CLOSES, measured 2026-09-06. `mailboxFacts` is an optional prop and the
       desktop and the demo supply none, so the provider's `mailboxes` is `null` there for ever —
       the same `null` a Cloud tab shows mid-first-poll. Reading only that array, this predicate
       refused EVERY delete on those doors with "the install that organizes this mailbox…", a
       sentence that is false on a desktop that organizes it itself. Nothing errored, and neither
       lane's suite had a case for a door with no roster: failure wearing health's clothes.

       The rule is not "refuse when we cannot see": it is "refuse when we cannot see YET". Where
       there is no probe the wire remains the only authority, exactly as before this predicate
       existed — the server still refuses a reader's delete with `assertOrganizerRole`. */
    expect(readerMoveRefusal({ kind: "absent" }, ["mb1"], SAY)).toBeNull();
    expect(readerMoveRefusal({ kind: "absent" }, [], SAY), "and with nothing to name").toBeNull();
  });

  it("A PENDING PROBE REFUSES — the arm the rule was actually written for", () => {
    expect(readerMoveRefusal({ kind: "pending" }, ["mb1"], SAY))
      .toBe(en.screener.readerMoveRefusedUnknown);
  });

  it("rosterStateOf keeps the two apart — no probe is not an unanswered probe", () => {
    /* One place builds the state, so the collapse cannot come back by somebody reading the array
       again. Both directions asserted: `absent` must not become `pending`, and a probe that HAS
       answered must not become `absent`. */
    expect(rosterStateOf(false, null)).toEqual({ kind: "absent" });
    expect(rosterStateOf(false, [])).toEqual({ kind: "absent" });
    expect(rosterStateOf(true, null)).toEqual({ kind: "pending" });
    expect(rosterStateOf(true, [])).toEqual({ kind: "known", rows: [] });
  });

  it("an empty list, an unknown id and a removed mailbox all refuse", () => {
    expect(readerMoveRefusal(known([organizerRow("mb1")]), [], SAY)).toBe(en.screener.readerMoveRefusedUnknown);
    expect(readerMoveRefusal(known([organizerRow("mb1")]), ["nope"], SAY)).toBe(en.screener.readerMoveRefusedUnknown);
    // A tombstone keeps whatever role it had; nothing should be written to a removed mailbox.
    const gone = { ...(organizerRow("mb1") as object), status: "disabled" } as Row;
    expect(readerMoveRefusal(known([gone]), ["mb1"], SAY)).toBe(en.screener.readerMoveRefusedUnknown);
  });
});

/* ── the window in which the delete has not happened ───────────────────────────────────────── */

interface Sent { kind: string; messageId: string }

function queueOver(roster: RosterState, catalogue: typeof en) {
  const sent: Sent[] = [];
  const said: string[] = [];
  let actions: Array<() => void> = [];
  const queue = createDeleteUndo({
    mutate: async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status: "confirmed" }; },
    toast: (msg, opts) => {
      said.push(msg);
      if (opts?.onAction) actions.push(opts.onAction);
    },
    copy: {
      deleted: catalogue.ohbox.toastDeleted,
      undo: catalogue.screener.toastUndo,
      undone: catalogue.ohbox.deleteUndone,
      failed: catalogue.ohbox.deleteFailed,
      noUndo: catalogue.session.noUndoHere,
      deletedMany: (n: number) => `${n} moved`,
      undoneMany: (n: number) => `${n} kept`,
      failedMany: (n: number) => `${n} refused`,
    },
    onHeld: () => {},
    /* THE REAL PATH: the shipped predicate over a real roster, choosing out of the shipped
       catalogue. Nothing about the verdict is stubbed. */
    refusal: (mailboxIds) => readerMoveRefusal(roster, mailboxIds.map((id) => id ?? ""), {
      named: (name) => catalogue.screener.readerMoveRefused.replace("{name}", name),
      unknown: () => catalogue.screener.readerMoveRefusedUnknown,
      nobody: () => catalogue.screener.readerMoveRefusedNobody,
    }),
    now: () => 1_000_000,
    pressId: (() => { let n = 0; return () => `press-${++n}`; })(),
  });
  const target = { id: "m1", mailboxId: "mb1" };
  return {
    queue, sent, said, target,
    /** How many toasts carried an Undo — the affordance itself, not the sentence about it. */
    undoable: () => actions.length,
    pressUndo: () => { const a = actions; actions = []; a.forEach((f) => f()); },
    stored: () => takeDeleteIntents(1_000_000).flatMap((r) => r.messageIds),
    presses: () => takeDeleteIntents(1_000_000).length,
  };
}

const ORGANIZER: RosterState = known([organizerRow("mb1")]);
const READER: RosterState = known([readerRow("mb1")]);

describe("the undo window", () => {
  it("AN ORGANIZER: nothing on the wire inside the window, and the delete lands when it closes", async () => {
    const { queue, sent, said, target } = queueOver(ORGANIZER, en);
    expect(queue.remove(target)).toBe(true);
    expect(said).toEqual([en.ohbox.toastDeleted]);
    expect(sent, "the press is reversible because it has not been made yet").toEqual([]);
    expect([...queue.held()]).toEqual(["m1"]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
    expect([...queue.held()]).toEqual([]);
  });

  it("UNDO cancels before any request leaves, and the control shows one would have left", async () => {
    const { queue, sent, said, target, pressUndo } = queueOver(ORGANIZER, en);
    queue.remove(target);
    pressUndo();
    expect(said).toEqual([en.ohbox.toastDeleted, en.ohbox.deleteUndone]);
    expect([...queue.held()]).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 4); });
    expect(sent, "the timer was disarmed, not merely ignored").toEqual([]);
    // THE CONTROL: the same queue, the same window, no Undo — one delete goes out.
    queue.remove({ id: "m2", mailboxId: "mb1" });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m2" }]);
  });

  it("A LATE UNDO claims nothing — the toast's button outlives its own window", async () => {
    /* The toast host keeps the capsule in the DOM after the timer, so the button can be pressed
       after the delete has committed. It must not say "not deleted" about a delete that happened.
       This is the `screener-state.ts` rule ("nothing restored is not an undo") one verb over. */
    const { queue, sent, said, target, pressUndo } = queueOver(ORGANIZER, en);
    queue.remove(target);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toHaveLength(1);
    pressUndo();
    expect(said, "no second sentence").toEqual([en.ohbox.toastDeleted]);
    expect(sent, "and nothing was re-sent or un-sent").toHaveLength(1);
  });

  it("a SECOND press inside the window is one press — never two deletes for one message", async () => {
    const { queue, sent, said, target } = queueOver(ORGANIZER, en);
    expect(queue.remove(target)).toBe(true);
    expect(queue.remove(target), "the second press did not act").toBe(false);
    expect(said).toEqual([en.ohbox.toastDeleted]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
  });

  it("LEAVING commits every open window — an unmount is not a retraction", async () => {
    const { queue, sent, target } = queueOver(ORGANIZER, en);
    queue.remove(target);
    queue.remove({ id: "m2", mailboxId: "mb1" });
    queue.flush();
    expect(sent).toEqual([
      { kind: "message_delete", messageId: "m1" },
      { kind: "message_delete", messageId: "m2" },
    ]);
  });

  it("A READER is refused, nothing is dispatched — and an organizer press proves the harness sends", async () => {
    const { queue, sent, said, target } = queueOver(READER, en);
    expect(queue.remove(target), "the press must report that it did NOT act").toBe(false);
    expect(said).toEqual([en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud")]);
    expect(sent).toEqual([]);
    expect([...queue.held()], "nothing was hidden either").toEqual([]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 3); });
    expect(sent, "and no window opened behind the refusal").toEqual([]);

    // THE CONTROL, in the same test: the same queue shape over an organizer roster does send.
    const ok = queueOver(ORGANIZER, en);
    ok.queue.remove(ok.target);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(ok.sent).toHaveLength(1);
  });

  it("AN UNKNOWN ROSTER refuses the press outright", async () => {
    const { queue, sent, said, target } = queueOver({ kind: "pending" }, en);
    expect(queue.remove(target)).toBe(false);
    expect(said).toEqual([en.screener.readerMoveRefusedUnknown]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 3); });
    expect(sent).toEqual([]);
  });

  it("a REFUSED delete puts the sentence up when the window closes", async () => {
    const sent: Sent[] = [];
    const said: string[] = [];
    const queue = createDeleteUndo({
      // A mailbox with no Trash folder: the server answers 422 and the engine rolls the overlay
      // back whole, so the row is where it was and the toast has to say so.
      mutate: async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status: "rolled_back" }; },
      toast: (msg) => { said.push(msg); },
      copy: {
        deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
        undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
        noUndo: en.session.noUndoHere,
      },
      onHeld: () => {},
      refusal: () => null,
    });
    queue.remove({ id: "m1", mailboxId: "mb1" });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toHaveLength(1);
    expect(said).toEqual([en.ohbox.toastDeleted, en.ohbox.deleteFailed]);
  });

  it("NO TRASH FOLDER is said as the reason, and the next press on that mailbox is refused at once", async () => {
    const sent: string[] = [];
    const said: string[] = [];
    const queue = createDeleteUndo({
      mutate: async (messageId) => {
        sent.push(messageId);
        return messageId === "m3" ? { status: "confirmed" } : { status: "rolled_back", error: { code: "no_trash_folder" } };
      },
      toast: (msg) => { said.push(msg); },
      copy: {
        deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
        undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
        noUndo: en.session.noUndoHere, noTrash: en.ohbox.deleteNoTrash,
      },
      onHeld: () => {},
      refusal: () => null,
    });
    const NO_TRASH = "Not deleted — this mailbox has no Trash folder, and ohmail never erases mail.";
    queue.remove({ id: "m1", mailboxId: "mb1" });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(said).toEqual([en.ohbox.toastDeleted, NO_TRASH]);
    // Known now: no "Moved to Trash." that is taken back later, and nothing sent.
    expect(queue.remove({ id: "m2", mailboxId: "mb1" })).toBe(false);
    expect(said.at(-1)).toBe(NO_TRASH);
    expect(queue.held().size).toBe(0);
    // Control: another mailbox still deletes.
    expect(queue.remove({ id: "m3", mailboxId: "mb2" })).toBe(true);
    expect(said.at(-1)).toBe(en.ohbox.toastDeleted);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toEqual(["m1", "m3"]);
  });
});

/* ── one press, however many messages ──────────────────────────────────────────────────────── */

describe("a press over a SET is one press", () => {
  const three = [
    { id: "m1", mailboxId: "mb1" },
    { id: "m2", mailboxId: "mb1" },
    { id: "m3", mailboxId: "mb1" },
  ];

  it("the SINGLE press: one window, one intent, the SINGULAR sentence word for word", async () => {
    const { queue, sent, said, target, stored, presses } = queueOver(ORGANIZER, en);
    expect(queue.remove(target)).toBe(true);
    expect(said, "the key's own sentence, unchanged").toEqual([en.ohbox.toastDeleted]);
    expect(presses(), "one journal entry").toBe(1);
    expect(stored()).toEqual(["m1"]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
  });

  it("the THREE-ID press: ONE window, ONE intent, the PLURAL sentence", async () => {
    /* N separate windows would give N toasts that replace each other — only the last still
       undoable — and a tab closed mid-way would delete an arbitrary prefix of the selection. */
    const { queue, sent, said, stored, presses } = queueOver(ORGANIZER, en);
    expect(queue.remove(three)).toBe(true);
    expect(said, "one toast, and it counts").toEqual(["3 moved"]);
    expect(presses(), "ONE journal entry for the press").toBe(1);
    expect(stored().sort()).toEqual(["m1", "m2", "m3"]);
    expect([...queue.held()].sort()).toEqual(["m1", "m2", "m3"]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent.map((m) => m.messageId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("ONE Undo takes the whole selection back", async () => {
    const { queue, sent, said, pressUndo } = queueOver(ORGANIZER, en);
    queue.remove(three);
    pressUndo();
    expect(said).toEqual(["3 moved", "3 kept"]);
    expect([...queue.held()]).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 3); });
    expect(sent, "nothing left, for any of the three").toEqual([]);
  });

  it("PAGEHIDE-style flush commits the press ATOMICALLY — all three, not a prefix", async () => {
    const { queue, sent, presses } = queueOver(ORGANIZER, en);
    queue.remove(three);
    queue.flush();
    expect(sent.map((m) => m.messageId).sort()).toEqual(["m1", "m2", "m3"]);
    // The journal entry clears only once EVERY message in the press has settled.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(presses()).toBe(0);
  });

  it("ONE READER MAILBOX REFUSES THE WHOLE PRESS — never the permitted half", async () => {
    /* The mixed selection is the case the signature exists for: answering per message would
       delete the half that is permitted and refuse the half that is not, in one gesture, reported
       by one toast. */
    const mixed = known([organizerRow("mb1"), readerRow("theirs")]);
    const { queue, sent, said } = queueOver(mixed, en);
    expect(queue.remove([
      { id: "m1", mailboxId: "mb1" },
      { id: "m2", mailboxId: "theirs" },
    ])).toBe(false);
    expect(said).toEqual([en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud")]);
    expect(sent).toEqual([]);
    expect([...queue.held()], "not even the permitted one").toEqual([]);
    // THE CONTROL: the same queue, the same shape, both mailboxes organized here.
    expect(queue.remove([{ id: "m3", mailboxId: "mb1" }, { id: "m4", mailboxId: "mb1" }])).toBe(true);
  });

  it("IDEMPOTENCE IS OVER THE SET — ids already held drop out, and a press of none is no press", async () => {
    const { queue, sent, said, presses } = queueOver(ORGANIZER, en);
    queue.remove([{ id: "m1", mailboxId: "mb1" }]);
    // m1 is already in a window; the second press carries m2 only.
    expect(queue.remove(three)).toBe(true);
    expect(said).toEqual([en.ohbox.toastDeleted, "2 moved"]);
    expect(presses(), "two presses, and m1 belongs to exactly one of them").toBe(2);
    // …and a press consisting only of held ids acts on nothing and says so.
    expect(queue.remove([{ id: "m1", mailboxId: "mb1" }])).toBe(false);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent.map((m) => m.messageId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("a duplicate id inside ONE press is carried once", async () => {
    const { queue, sent, said } = queueOver(ORGANIZER, en);
    queue.remove([{ id: "m1", mailboxId: "mb1" }, { id: "m1", mailboxId: "mb1" }]);
    expect(said, "one message, so the singular sentence").toEqual([en.ohbox.toastDeleted]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
  });

  it("undo() by MESSAGE id takes back the press that holds it", async () => {
    const { queue, sent, said, queue: q } = queueOver(ORGANIZER, en);
    q.remove(three);
    q.undo("m2");
    expect(said).toEqual(["3 moved", "3 kept"]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(sent).toEqual([]);
    void queue;
  });
});

/* ── the request survives the tab ──────────────────────────────────────────────────────────── */

describe("the durable intent", () => {
  it("is on disk BEFORE the window opens, and gone once the engine has the verb", async () => {
    const { queue, sent, target, stored } = queueOver(ORGANIZER, en);
    queue.remove(target);
    expect(stored(), "written synchronously at the press").toEqual(["m1"]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    await act(async () => { await Promise.resolve(); });
    expect(sent).toHaveLength(1);
    expect(stored(), "cleared only after the mutation settled").toEqual([]);
  });

  it("UNDO takes it off disk too — an undone delete must not be replayed at the next launch", () => {
    const { queue, target, stored, pressUndo } = queueOver(ORGANIZER, en);
    queue.remove(target);
    expect(stored()).toEqual(["m1"]);
    pressUndo();
    expect(stored()).toEqual([]);
  });

  it("A REFUSED press writes nothing", () => {
    const { queue, target, stored } = queueOver(READER, en);
    queue.remove(target);
    expect(stored()).toEqual([]);
  });

  it("REPLAY finishes what a killed tab started, once, and clears the journal", async () => {
    const { queue, target } = queueOver(ORGANIZER, en);
    queue.remove(target);
    // The tab dies here: the timer never fires, and the journal is the only record.
    const sent: Sent[] = [];
    const count = replayDeleteIntents(async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status: "confirmed" }; }, 1_000_001);
    expect(count).toBe(1);
    await act(async () => { await Promise.resolve(); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
    expect(takeDeleteIntents(1_000_002)).toEqual([]);
  });

  it("an EXPIRED intent is swept rather than replayed for ever", () => {
    const { queue, target } = queueOver(ORGANIZER, en);
    queue.remove(target);
    const sent: Sent[] = [];
    const count = replayDeleteIntents(
      async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status: "confirmed" }; },
      1_000_000 + DELETE_INTENT_TTL_MS + 1,
    );
    expect(count).toBe(0);
    expect(sent).toEqual([]);
    expect(window.localStorage.getItem(deleteIntentsKey()), "and the row is gone").toBeNull();
  });

  it("THE ENTRY CLEARS ON THE LAST SETTLE, not the first — a half-sent press stays written down", async () => {
    /* The window is over; three mutations are in flight. If the journal entry went the moment the
       FIRST one settled, a tab dying between the first and the third would leave two messages
       neither sent nor recorded — the exact hole the journal exists to close, moved a moment
       later. Held open here with deferred promises. */
    const resolvers: Array<() => void> = [];
    const queue = createDeleteUndo({
      mutate: () => new Promise((resolve) => {
        resolvers.push(() => resolve({ status: "confirmed" }));
      }),
      toast: () => {},
      copy: {
        deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
        undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
        noUndo: en.session.noUndoHere,
        deletedMany: (n) => `${n} moved`, undoneMany: (n) => `${n} kept`,
        failedMany: (n) => `${n} refused`,
      },
      onHeld: () => {},
      refusal: () => null,
      now: () => 1_000_000,
      pressId: () => "press-1",
    });
    queue.remove([
      { id: "m1", mailboxId: "mb1" }, { id: "m2", mailboxId: "mb1" }, { id: "m3", mailboxId: "mb1" },
    ]);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS); });
    expect(resolvers, "three in flight").toHaveLength(3);

    resolvers[0]!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(takeDeleteIntents(1_000_000), "still written down after the FIRST settles").toHaveLength(1);

    resolvers[1]!();
    resolvers[2]!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(takeDeleteIntents(1_000_000), "and gone once the LAST one has").toHaveLength(0);
  });

  it("REPLAY holds the entry until the whole press has settled too", async () => {
    /* Same rule on the boot path, where it matters more: this runs precisely because a previous
       tab died, so a second death mid-replay must not lose what is left. */
    window.localStorage.setItem(deleteIntentsKey(), JSON.stringify([
      { id: "press-9", messageIds: ["m1", "m2"], at: 1_000_000 },
    ]));
    const resolvers: Array<() => void> = [];
    replayDeleteIntents(
      () => new Promise((resolve) => { resolvers.push(() => resolve({ status: "confirmed" })); }),
      1_000_001,
    );
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(2);
    resolvers[0]!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(takeDeleteIntents(1_000_002), "one still in flight, so the record stands").toHaveLength(1);
    resolvers[1]!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(takeDeleteIntents(1_000_003)).toHaveLength(0);
  });

  it("a message belongs to AT MOST ONE press on disk", () => {
    /* Two presses naming the same message would replay it twice after a crash, and the second
       would fail against a row that is already gone — a refusal sentence for a delete that in
       fact happened. `armDeleteIntent` takes the id off every older press. */
    window.localStorage.setItem(deleteIntentsKey(), JSON.stringify([
      { id: "press-1", messageIds: ["m1", "m2"], at: 1_000_000 },
    ]));
    armDeleteIntent({ id: "press-2", messageIds: ["m2", "m3"], at: 1_000_001 });
    const rows = takeDeleteIntents(1_000_002);
    expect(rows.map((r) => r.id)).toEqual(["press-1", "press-2"]);
    expect(rows[0]!.messageIds, "m2 left the older press").toEqual(["m1"]);
    expect(rows[1]!.messageIds).toEqual(["m2", "m3"]);
    const everywhere = rows.flatMap((r) => r.messageIds);
    expect(new Set(everywhere).size, "no id in two presses").toBe(everywhere.length);
  });

  it("a press left holding NOTHING is removed rather than kept empty", () => {
    window.localStorage.setItem(deleteIntentsKey(), JSON.stringify([
      { id: "press-1", messageIds: ["m1"], at: 1_000_000 },
    ]));
    armDeleteIntent({ id: "press-2", messageIds: ["m1"], at: 1_000_001 });
    expect(takeDeleteIntents(1_000_002).map((r) => r.id)).toEqual(["press-2"]);
  });

  it("A ROW THE PREVIOUS BUILD WROTE is still acted on — the upgrade must not eat the request", async () => {
    /* The first version of this journal stored `{ messageId, at }`. Somebody who closes the tab
       inside the window and reloads onto a new build must not lose the delete BECAUSE the record
       changed shape: that is the failure this file exists to prevent, arriving through the
       upgrade instead of through the crash. */
    window.localStorage.setItem(deleteIntentsKey(), JSON.stringify([
      { messageId: "legacy-1", at: 1_000_000 },
    ]));
    const sent: Sent[] = [];
    const count = replayDeleteIntents(
      async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status: "confirmed" }; }, 1_000_001,
    );
    expect(count).toBe(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "legacy-1" }]);
    expect(takeDeleteIntents(1_000_002)).toEqual([]);
  });

  it("a row that parses but names no message is dropped, not guessed at", () => {
    window.localStorage.setItem(deleteIntentsKey(), JSON.stringify([
      { id: "x", messageIds: [], at: 1_000_000 },
      { id: "y", at: 1_000_000 },
      { id: "z", messageIds: ["ok"], at: "not a number" },
      "a string",
      { id: "w", messageIds: ["kept"], at: 1_000_000 },
    ]));
    expect(takeDeleteIntents(1_000_001).map((r) => r.id)).toEqual(["w"]);
  });

  /**
   * A REFUSED JAR TAKES THE UNDO AWAY, NOT THE DELETE.
   *
   * This used to assert the opposite and was right about the press: the window still opened, the
   * toast still said "Moved to Trash." and the Undo was still offered — over a record the jar had
   * refused. So a tab closed inside those four seconds dropped a delete the product had already
   * reported, which is the hole `delete-intents.ts` exists to close, reached through a private
   * window instead of through a crash. With nothing on disk to postpone against, the press acts at
   * once and the sentence says there is no undo.
   */
  it("a REFUSED jar deletes at once and offers no undo", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const { queue, target, said, sent, undoable } = queueOver(ORGANIZER, en);
      expect(queue.remove(target), "the press must still work").toBe(true);
      expect(sent, "the delete was postponed against a record nobody holds")
        .toEqual([{ kind: "message_delete", messageId: "m1" }]);
      expect(said).toEqual([`${en.ohbox.toastDeleted} ${en.session.noUndoHere}`]);
      expect(undoable(), "an undo was offered over a write that failed").toBe(0);
    } finally {
      setItem.mockRestore();
    }
  });

  /**
   * THE POSITIVE CONTROL — a healthy jar keeps today's behaviour, byte for byte. Without it the
   * arm above is satisfied by a press that ALWAYS deletes at once, which would be the defect from
   * the other side.
   */
  it("a HEALTHY jar still opens the window and offers the undo", () => {
    const { queue, target, said, sent, undoable } = queueOver(ORGANIZER, en);
    expect(queue.remove(target)).toBe(true);
    expect(sent, "nothing may reach the wire inside the window").toEqual([]);
    expect(said).toEqual([en.ohbox.toastDeleted]);
    expect(undoable()).toBe(1);
  });
});

/* ── the hook's own lifetimes ──────────────────────────────────────────────────────────────── */

describe("useDeleteUndo", () => {
  async function mountHook(
    sent: Sent[], status = "confirmed",
  ): Promise<{ remove: (t: { id: string; mailboxId: string }) => boolean; landed: number }> {
    await unmount();
    const api = { remove: (() => false) as (t: { id: string; mailboxId: string }) => boolean, landed: -1 };
    function Probe(): null {
      const d = useDeleteUndo({
        mutate: async (messageId) => { sent.push({ kind: "message_delete", messageId }); return { status }; },
        toast: () => {},
        copy: {
          deleted: en.ohbox.toastDeleted, undo: en.screener.toastUndo,
          undone: en.ohbox.deleteUndone, failed: en.ohbox.deleteFailed,
          noUndo: en.session.noUndoHere,
        },
        refusal: () => null,
      });
      api.remove = d.remove;
      api.landed = (d as { landed?: number }).landed ?? -1;
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Probe)); });
    return api;
  }

  it("counts the deletes the server took, so an open Trash can read them in", async () => {
    const sent: Sent[] = [];
    const api = await mountHook(sent);
    expect(api.landed).toBe(0);
    api.remove({ id: "m1", mailboxId: "mb1" });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await act(async () => { await Promise.resolve(); });
    expect(api.landed).toBe(1);
    const refused = await mountHook([], "rolled_back");
    refused.remove({ id: "m2", mailboxId: "mb1" });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await act(async () => { await Promise.resolve(); });
    expect(refused.landed, "a refused delete put nothing in Trash").toBe(0);
  });

  it("UNMOUNT commits the open window — the cleanup effect is not decoration", async () => {
    /* The queue's own `flush()` is covered above; what is covered HERE is that something calls
       it. Deleting the cleanup effect leaves that green and this red. */
    const sent: Sent[] = [];
    const api = await mountHook(sent);
    api.remove({ id: "m1", mailboxId: "mb1" });
    expect(sent).toEqual([]);
    await unmount();
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
  });

  it("PAGEHIDE commits it too — a closing tab is the last moment anything can act", async () => {
    const sent: Sent[] = [];
    const api = await mountHook(sent);
    api.remove({ id: "m1", mailboxId: "mb1" });
    expect(sent).toEqual([]);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(sent).toEqual([{ kind: "message_delete", messageId: "m1" }]);
  });
});

/* ── the copy, in both languages, as the call sites read it ────────────────────────────────── */

describe("the catalogues", () => {
  const KEYS: Array<[ns: "ohbox" | "shortcuts" | "screener", key: string]> = [
    ["shortcuts", "deleteKey"],
    ["ohbox", "deleteUndone"],
    ["ohbox", "toastDeleted"],
    ["ohbox", "deleteFailed"],
    ["ohbox", "toastDeletedMany"],
    ["ohbox", "deleteUndoneMany"],
    ["ohbox", "deleteFailedMany"],
    ["screener", "toastUndo"],
    ["screener", "readerMoveRefused"],
    ["screener", "readerMoveRefusedUnknown"],
  ];

  it("every key this verb reads exists in BOTH catalogues", () => {
    for (const [ns, key] of KEYS) {
      const e = (en as unknown as Record<string, Record<string, string>>)[ns]?.[key];
      const d = (de as unknown as Record<string, Record<string, string>>)[ns]?.[key];
      expect(e, `en.${ns}.${key}`).toBeTruthy();
      expect(d, `de.${ns}.${key}`).toBeTruthy();
    }
  });

  it("and their ICU ARGUMENTS match — a placeholder in one language only is a broken sentence", () => {
    /* The German assertion used to be "both strings exist and differ", which proves nothing about
       whether the sentence can be rendered. This compares the argument sets. */
    /* AN ARGUMENT IS A NAME FOLLOWED BY `,` OR `}` — `{count, plural, …}` or `{name}`. The first
       spelling of this matched `\{(\w+)` and so read the first word of every nested ICU branch
       (`other {# messages moved…}`) as an argument, which made the German twin "differ" for a
       reason that was the regex's rather than the sentence's. */
    const args = (s: string): string[] =>
      [...s.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]!).sort();
    for (const [ns, key] of KEYS) {
      const e = (en as unknown as Record<string, Record<string, string>>)[ns]![key]!;
      const d = (de as unknown as Record<string, Record<string, string>>)[ns]![key]!;
      expect(args(d), `de.${ns}.${key} arguments`).toEqual(args(e));
    }
    expect(args(en.screener.readerMoveRefused), "the one argument this verb interpolates").toEqual(["name"]);
    // The plural set is ICU, so its argument must be present in BOTH languages or the sentence
    // cannot render at all — the case a "both strings exist" assertion would have missed.
    for (const key of ["toastDeletedMany", "deleteUndoneMany", "deleteFailedMany"] as const) {
      expect(args(en.ohbox[key]), `en.ohbox.${key}`).toEqual(["count"]);
      expect(args(de.ohbox[key]), `de.ohbox.${key}`).toEqual(["count"]);
    }
  });

  it("the German twins are translated, not copied", () => {
    expect(de.shortcuts.deleteKey).not.toBe(en.shortcuts.deleteKey);
    expect(de.ohbox.deleteUndone).not.toBe(en.ohbox.deleteUndone);
  });

  it("the refusal renders in German through the same predicate", () => {
    expect(readerMoveRefusal(known([readerRow("mb1")]), ["mb1"], {
      named: (name) => de.screener.readerMoveRefused.replace("{name}", name),
      unknown: () => de.screener.readerMoveRefusedUnknown,
      nobody: () => de.screener.readerMoveRefusedNobody,
    })).toBe(de.screener.readerMoveRefused.replace("{name}", "ohmail Cloud"));
  });
});

/* ── what makes a held delete look like a delete ───────────────────────────────────────────── */

describe("hideMessages", () => {
  const rows = [message({ id: "m1" }), message({ id: "m2" })];
  const tags = [{ id: "t1", name: "Work" }];
  const base: EntityReader = {
    version: () => 7,
    // This fixture's mirror never moves, so every stamp is the one constant it reports.
    stampOf: () => 7,
    stampExcept: () => 7,
    get: <T,>(type: string, id: string) =>
      (type === "message" ? rows.find((r) => r.id === id)
        : type === "tag" ? tags.find((t) => t.id === id) : undefined) as T | undefined,
    list: <T,>(type: string) => (type === "message" ? [...rows] : type === "tag" ? [...tags] : []) as T[],
    // `seq` is the record's last-applied one; this stub has never been through a drain, so 0 is
    // the honest answer and nothing under test here reads it.
    entries: <T,>(type: string) =>
      (type === "message"
        ? rows.map((r) => ({ id: r.id, entity: r, seq: 0 }))
        : type === "tag" ? tags.map((t) => ({ id: t.id, entity: t, seq: 0 })) : []
      ) as Array<{ id: string; entity: T; seq: number }>,
  };

  it("the row leaves every list while it is held, and the MIRROR still has it", () => {
    const hidden = hideMessages(base, new Set(["m1"]));
    expect(hidden.list<EngineMessage>("message").map((m) => m.id)).toEqual(["m2"]);
    expect(hidden.entries("message").map((e) => e.id)).toEqual(["m2"]);
    expect(hidden.get("message", "m1")).toBeUndefined();
    // The mutation, the body open and the search index all read the base reader — and a delete
    // that has not been sent yet must still be findable there.
    expect(base.get<EngineMessage>("message", "m1")?.id).toBe("m1");
  });

  it("holds NOTHING back when nothing is held — the same reader object, not a copy", () => {
    // Identity is the assertion: every pile selector memoises on this reference, and a fresh
    // wrapper per render would re-derive the whole mirror on every keystroke in the app.
    expect(hideMessages(base, new Set())).toBe(base);
  });

  it("passes NON-MESSAGE types through with their contents, not merely with the right length", () => {
    /* This assertion used to compare `list("tag")` to `[]` over a base whose tag list was already
       empty — vacuous: an implementation that emptied every non-message list passed it. The base
       now HOLDS a tag, so the passthrough is a real claim (review finding). */
    const hidden = hideMessages(base, new Set(["m1"]));
    expect(hidden.list("tag")).toEqual(tags);
    expect(hidden.entries("tag").map((e) => e.id)).toEqual(["t1"]);
    expect(hidden.get("tag", "t1")).toEqual(tags[0]);
    expect(hidden.version()).toBe(7);
  });
});
