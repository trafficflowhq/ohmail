/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, type DraftShell } from "./_draft-shell.js";
import { barVerb, menuItem, moreButton, ohboxRow, openLetter } from "./ohbox/_finders.js";

/**
 * ═══ THE ACTION PANEL'S QUESTIONS, AND WHERE THE KEYBOARD IS DURING ONE ════════════════════
 *
 * Three verbs ask a question before they act: Move asks WHERE, Resurface asks WHEN, Delete asks whether you
 * meant it. Today's Resurface had no focus line at all, so opening the horizon chooser left focus on a button
 * that had just unmounted and the chooser could only be reached by Tabbing in from the top of the document.
 *
 * And all three did the opposite of opening when they closed. Cancelling put the question away and left focus
 * nowhere: the person was returned to the document, several stops from the panel they had been operating.
 * Escape is worse than a Cancel button here, because Escape is what people actually press.
 *
 * ── WHAT IS ASSERTED, AND BY NODE IDENTITY ──────────────────────────────────────────────────
 *
 * Every assertion re-queries the trigger after the close and compares `document.activeElement` to the node that
 * is on screen NOW. An assertion against a node captured before the press could compare against a detached
 * element; one against `textContent` would pass with focus on the body, because the document contains the word
 * "Resurface" either way.
 *
 * ── AND THE ONE ASYMMETRY, ON PURPOSE ───────────────────────────────────────────────────────
 *
 * ANSWERING is not cancelling. Choosing a horizon spends the verb on a message that then moves out from under the
 * panel, so focus is not sent back to the control that asked; the last case pins it, so the restore cannot quietly
 * become "whenever the question closes".
 *
 * RE-POINTED (share reader-1, the switch's older tests): the whole shell is the new one, through its test door
 * (`_draft-shell.ts`'s `mountShell`: the web's `MailShell`, the frame over the mail ground, the seated Ohbox and
 * the reader), in a narrow window as before; the letter is opened as before (`j`, then Enter). The questions are
 * the new panel's menus (`packages/app/src/reader/actions/ActionBar.tsx`, the kit's `Menu`, whose focus line is
 * `useOverlayFocus`). What the new design changed, by its rows: MOVE stands behind More, its only door (the case
 * opens it there, and the control that opened it is More's button); the Move menu has no Cancel, its way out is
 * Escape from inside it, as for every kit menu; DELETE has no confirm strip (DIFFERENCES-FROM-TODAY, the reader:
 * More is the ask, its Delete the deliberate second press), so leaving the question unanswered is leaving More
 * without pressing Delete. Escape is pressed where the keyboard is, as a person's is. A control is pressed as the
 * web's browsers press it, the keyboard on it first (`pressAt`; jsdom moves no focus on a pointer's press, and the
 * case is about where the keyboard goes back to). Each expectation as it stood; the answer case is split in two,
 * its act (the horizon on the wire) and its keyboard half, each a case of its own as it stood.
 */

let shell: DraftShell | null = null;

beforeEach(() => {
  /* The narrow arm, so the reader is a sheet and there is exactly ONE action panel in the document. */
  stubDom({ narrow: true });
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(async () => {
  shell = null;
  await unmountAll();
});

async function waitFor(ready: () => boolean, why: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${why}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** Every verb this shell put on the wire: the answer case reads it, the cancel cases require none. */
const sent = () => shell!.sent;

/** A keypress on the DOCUMENT, where the registry listens. */
const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};
/** A key pressed where focus is, as a person's keyboard delivers it. */
const keyAtFocus = async (k: string): Promise<void> => {
  const at = (document.activeElement ?? document.body) as HTMLElement;
  await act(async () => {
    at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

/** A verb on the one panel in the document, by its name. */
const verb = (name: string): HTMLButtonElement => {
  const found = barVerb(document, name);
  expect(found, `no panel verb named ${name}`).toBeTruthy();
  return found!;
};
const more = (): HTMLButtonElement => {
  const found = moreButton(document);
  expect(found, "the panel has no More").toBeTruthy();
  return found!;
};
/** The open menu named `name` (Resurface, Move, More), or null. */
const menu = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[role="menu"][aria-label="${name}"]`);
const item = (name: string): HTMLElement => {
  const found = menuItem(name);
  expect(found, `no menu item named ${name}`).toBeTruthy();
  return found!;
};

/** A press as the web's browsers make one on a button: the keyboard on it, then the pointer's three events. */
async function pressAt(target: HTMLElement, what: string): Promise<void> {
  await act(async () => { target.focus(); });
  await press(target, what);
}

/** The reader open on the row under the cursor: the surface every case below runs on. */
async function readerOpen(): Promise<void> {
  shell = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
  await waitFor(() => ohboxRow(document, "m1") !== null, "rows in the Ohbox");
  await key("j");
  await key("Enter");
  await waitFor(() => openLetter(document) !== null, "no reader opened in a narrow window");
  expect(barVerb(document, "Resurface"), "no action panel in the reader").not.toBeNull();
}

describe("opening a bar ceremony puts the keyboard in it", () => {
  it("RESURFACE lands on Now — the answer that costs nothing to change your mind about", async () => {
    await readerOpen();
    await pressAt(verb("Resurface"), "Resurface");
    expect(menu("Resurface"), "the chooser did not open").not.toBeNull();
    // Node identity, not text: the document contains the word "Now" whether or not focus moved.
    expect(document.activeElement).toBe(item("Now"));
  });

  it("MOVE lands on its first destination — the behaviour Resurface was missing", async () => {
    /* The positive control for the pair. Without it, "Resurface focuses its first answer" could be satisfied by a
       change that focuses the first control of EVERY menu by accident, and the two verbs' focus lines would have
       no evidence of being the same rule. Move stands behind More in the new panel: its only door. */
    await readerOpen();
    await pressAt(more(), "More");
    await press(item("Move"), "More's Move");
    const moveMenu = menu("Move");
    expect(moveMenu, "the destination menu did not open").not.toBeNull();
    const first = moveMenu!.querySelector<HTMLElement>('[role="menuitem"]');
    expect(first, "the destination menu has no destinations").toBeTruthy();
    expect(document.activeElement).toBe(first);
  });
});

describe("cancelling a ceremony puts the keyboard back on the control that opened it", () => {
  it("RESURFACE, by its Cancel button", async () => {
    await readerOpen();
    await pressAt(verb("Resurface"), "Resurface");
    await press(item("Cancel"), "the chooser's Cancel");
    expect(menu("Resurface"), "the chooser is still open").toBeNull();
    // Re-queried: the node on screen now.
    expect(document.activeElement).toBe(verb("Resurface"));
    expect(sent(), "cancelling put something on the wire").toEqual([]);
  });

  it("RESURFACE, by ESCAPE — which never travels through the bar at all", async () => {
    /* The case the fix exists for: Escape is the one people use, and a restore written into the Cancel button's
       handler would leave exactly this press unfixed. */
    await readerOpen();
    await pressAt(verb("Resurface"), "Resurface");
    await keyAtFocus("Escape");
    expect(menu("Resurface"), "Escape did not close the chooser").toBeNull();
    expect(openLetter(document), "Escape closed the reader as well").not.toBeNull();
    expect(document.activeElement).toBe(verb("Resurface"));
  });

  it("MOVE, by its Cancel button", async () => {
    /* The Move menu has no Cancel: Escape from inside it is its way out. Move's door is More, so More's button is
       the control that opened it. */
    await readerOpen();
    await pressAt(more(), "More");
    await press(item("Move"), "More's Move");
    expect(menu("Move"), "the destination menu did not open").not.toBeNull();
    await keyAtFocus("Escape");
    expect(menu("Move")).toBeNull();
    expect(document.activeElement).toBe(more());
    expect(sent()).toEqual([]);
  });

  it("DELETE, back to More — the disclosure is the only door the verb has", async () => {
    /* No confirm strip (DIFFERENCES-FROM-TODAY, the reader): More is the ask and its Delete the deliberate second
       press. Leaving the question unanswered is leaving More without pressing Delete. */
    await readerOpen();
    await pressAt(more(), "More");
    expect(menu("More"), "More opened no menu").not.toBeNull();
    expect(menuItem("Delete"), "More offers no Delete").not.toBeNull();
    await keyAtFocus("Escape");
    expect(menu("More")).toBeNull();
    expect(document.activeElement).toBe(more());
    expect(sent().filter((m) => m.kind === "message_delete")).toEqual([]);
  });
});

describe("an open disclosure keeps the keys, on the shipped shell", () => {
  it("a letter pressed inside the More menu does not reach the mail underneath", async () => {
    /* `a` is Answer Later on the shell's own map; with the menu open and the keyboard in it, the key used to travel
       to the document and park the message the menu was standing over, the menu still up afterwards, over mail that
       had changed.
     *
     * Dispatched on the FOCUSED ITEM and not on `document`: an event dispatched on the document never travels down
     * into the menu, so a press written that way would bypass the handler under test and report a pass for a rule
     * that had never run. */
    await readerOpen();
    await pressAt(more(), "More");
    const first = menu("More")?.querySelector<HTMLElement>('[role="menuitem"]') ?? null;
    expect(first, "the menu opened with no items").not.toBeNull();
    expect(document.activeElement, "the menu did not take the keyboard").toBe(first);
    await act(async () => {
      first!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    });
    expect(
      sent().flatMap((m) => (m.kind === "triage_set" ? [m.state] : [])),
      "`a` reached the shell and filed the message under the open menu",
    ).toEqual([]);
    expect(menu("More"), "the letter closed the menu").not.toBeNull();
  });
});

describe("answering is not cancelling", () => {
  it("choosing a horizon does NOT send the keyboard back to the trigger (its keyboard half)", async () => {
    // Tomorrow moves the letter out of the panel. The keyboard must not return to the spent trigger after that move.
    await readerOpen();
    await pressAt(verb("Resurface"), "Resurface");
    await press(item("Tomorrow"), "the chooser's Tomorrow");
    expect(menu("Resurface"), "the chooser stayed open after an answer").toBeNull();
    /* The horizon's own mutation: `EngineMutation` is keyed by `kind`, never by `type`. Tomorrow's horizon is the
       state that brings the letter back up then (`bubbled_up`); Now's (`resurfaced`) is read by the act's case below. */
    await waitFor(() => sent().some((m) => m.kind === "triage_set"), "the answer never reached the engine");
    expect(sent().flatMap((m) => (m.kind === "triage_set" ? [m.state] : []))).toContain("bubbled_up");
    expect(
      document.activeElement === barVerb(document, "Resurface"),
      "an answered ceremony returned the keyboard to the control that asked",
    ).toBe(false);
  });

  it("choosing a horizon files the letter with that horizon and closes the chooser", async () => {
    /* Split out of "choosing a horizon does NOT send the keyboard back to the trigger", as it stood: the act a person
       must never lose (the horizon reaches the engine, the chooser closes). */
    await readerOpen();
    await pressAt(verb("Resurface"), "Resurface");
    await press(item("Now"), "the chooser's Now");
    expect(menu("Resurface"), "the chooser stayed open after an answer").toBeNull();
    await waitFor(() => sent().some((m) => m.kind === "triage_set"), "the answer never reached the engine");
    expect(sent().flatMap((m) => (m.kind === "triage_set" ? [m.state] : []))).toContain("resurfaced");
  });
});
