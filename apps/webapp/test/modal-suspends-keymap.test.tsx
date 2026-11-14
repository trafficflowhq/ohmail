/** @vitest-environment jsdom */
/**
 * ═══ A BLOCKING DIALOG SUSPENDS THE MAILBOX KEYS ══════════════════════════════════════════
 *
 * The session dialogs say `role="alertdialog"` with `aria-modal="true"` and render over a
 * scrimmed layer, which is a claim that the mailbox behind them cannot be used. The first
 * attempt at making that claim true set `inert` on `.app-root`, and `inert` is exactly right
 * for the subtree it is on and irrelevant here: `KeymapProvider` binds ONE listener to
 * `document`, and the dialog's own buttons are SIBLINGS of the mailbox rather than
 * descendants of it. An event that starts on the Try again button was never travelling into
 * the inert subtree, so the listener ran, the mailbox bindings were still registered, and:
 *
 *   · `e` parked the focused message;
 *   · `d` `d` ran the delete ceremony, which finishes by programmatically clicking its own
 *     danger button — and a programmatic click is not blocked by `inert` either.
 *
 * A screen saying the session is in question could quietly park or delete mail. So the keymap
 * asks whether a modal is open (`shell/modal-gate.ts`) instead of trusting a DOM attribute.
 *
 * The two bindings below stand for those two acts. Testing them here rather than through a
 * mounted mailbox is deliberate: the defect is in the DISPATCHER, and a fixture with no mail
 * in it would prove nothing about a keypress that never reached a message. What is asserted is
 * the thing that was broken — that a registered destructive binding does not run while a
 * dialog is up — plus, separately, that both dialogs actually hold the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";

const h = React.createElement;
const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React: unknown }).React = React;

const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap");
const { resetModalGateForTests, useModalGate } = await import("@ohmail/app-logic/session/modal-gate");

/** What the keys did. `park`/`delete` stand for the two acts the defect actually reached. */
let ran: string[] = [];
let host: HTMLDivElement;
let root: Root | null = null;

/** A component registering the two mailbox bindings the dialog must suspend. */
function Mailbox() {
  useKeyBindings([
    { chord: "e", group: "message", label: "Park", run: () => ran.push("park") },
    { chord: "d d", group: "message", label: "Delete", run: () => ran.push("delete") },
  ], "view");
  return h("div", { className: "app-root" }, "mailbox");
}

/** A dialog that holds the modal gate exactly as `SessionEnded`/`UnconfirmedOverlay` do. */
function Dialog({ open }: { open: boolean }) {
  useModalGate(open);
  return open ? h("div", { className: "session-end" }, h("button", { type: "button" }, "Try again")) : null;
}

async function mount(open: boolean): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(KeymapProvider, { children: [h(Mailbox, { key: "m" }), h(Dialog, { key: "d", open })] }));
  });
}

/** Press a key AT THE DIALOG'S BUTTON when there is one — the exact origin that defeats `inert`. */
async function press(key: string): Promise<void> {
  const target = host.querySelector("button") ?? document.body;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  ran = [];
  resetModalGateForTests();
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  resetModalGateForTests();
});

describe("with no dialog open the mailbox keys work", () => {
  it("`e` parks and `d` `d` deletes — otherwise the suspension below proves nothing", async () => {
    await mount(false);
    await press("e");
    await press("d");
    await press("d");
    expect(ran, "the bindings never ran at all, so the guard below is vacuous")
      .toEqual(["park", "delete"]);
  });
});

describe("with a blocking dialog open the mailbox keys are suspended", () => {
  it("`e` does not park", async () => {
    await mount(true);
    await press("e");
    expect(ran, "a message was parked behind a modal dialog").toEqual([]);
  });

  it("`d` `d` does not delete", async () => {
    await mount(true);
    await press("d");
    await press("d");
    expect(ran, "the delete ceremony ran behind a modal dialog").toEqual([]);
  });

  it("and the keys come back when the dialog closes", async () => {
    await mount(true);
    await press("e");
    expect(ran).toEqual([]);
    await act(async () => {
      root!.render(h(KeymapProvider, {
        children: [h(Mailbox, { key: "m" }), h(Dialog, { key: "d", open: false })],
      }));
    });
    await press("e");
    expect(ran, "the gate never released — the mailbox is deaf for the rest of the session")
      .toEqual(["park"]);
  });
});

describe("the gate is taken IN the commit, not one frame after it", () => {
  /**
   * ── THE WINDOW A PASSIVE EFFECT LEAVES OPEN, MADE DETERMINISTIC ────────────────────────────
   *
   * Every case above flushes React's passive effects before it presses a key, because `act`
   * does — so all of them measure the state a beat AFTER the dialog appeared and none can see
   * the beat itself. A passive `useEffect` is scheduled after the commit that paints the dialog:
   * for that window the scrim is drawn, the button is focused, and `modalIsOpen()` answers
   * false. A key event arriving there dispatched a mailbox verb.
   *
   * TWO SHAPES OF THIS TEST WERE WRONG BEFORE THIS ONE, and both went green over the defect:
   *
   *  · `flushSync` around the render. It looks like the gap — commit now, passive queue later —
   *    and it is not: React drains pending passive effects as part of a synchronous flush, so
   *    the gate was already held whichever hook took it. Measured: reverting the implementation
   *    to `useEffect` left all six cases green.
   *  · anything that waits (`await act`, a timer, a microtask). Waiting is precisely what closes
   *    the window; a test that waits can only ever observe the state after it has closed.
   *
   * What is deterministic is the COMMIT ITSELF. A sibling's own layout effect runs inside the
   * same commit, after the dialog's, so a keypress dispatched from there is an event arriving at
   * exactly the moment in question — earlier than any passive effect, and with no timing
   * assumption anywhere in the test. That is the property under test stated directly: by the end
   * of the commit that paints a dialog, the mailbox keys are already suspended.
   */
  it("a key pressed inside the dialog's own commit does nothing", async () => {
    const { modalIsOpen } = await import("@ohmail/app-logic/session/modal-gate");
    let heldAtCommit: boolean | null = null;

    /** Presses `d` `d` from inside the commit that paints the dialog. */
    function PressDuringCommit({ armed }: { armed: boolean }) {
      React.useLayoutEffect(() => {
        if (!armed) return;
        heldAtCommit = modalIsOpen();
        const at = document.querySelector(".session-end button") ?? document.body;
        at.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
        at.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      }, [armed]);
      return null;
    }

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const tree = (open: boolean) => h(KeymapProvider, {
      children: [
        h(Mailbox, { key: "m" }),
        h(Dialog, { key: "d", open }),
        // AFTER the dialog: sibling layout effects run in tree order, so this one runs once the
        // dialog's has had its chance to take the gate.
        h(PressDuringCommit, { key: "p", armed: open }),
      ],
    });
    await act(async () => { root!.render(tree(false)); });
    await act(async () => { root!.render(tree(true)); });

    expect(host.querySelector(".session-end"), "the dialog never painted").toBeTruthy();
    expect(heldAtCommit, "the presses never happened — the probe did not run").not.toBeNull();
    expect(heldAtCommit, "the gate was still closed at the end of the dialog's own commit")
      .toBe(true);
    expect(ran, "a delete ran inside the commit that painted the dialog").toEqual([]);

    /* THE CONTROL: the same two presses with no dialog DO run, so the assertion above is about
       the gate and not about the probe firing into nothing. Dispatched at the MAILBOX — the
       dialog's button is detached by then, and an event on a detached node reaches no listener,
       which would make this pass for the wrong reason. */
    await act(async () => { root!.render(tree(false)); });
    const back = host.querySelector(".app-root") ?? document.body;
    await act(async () => {
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });
    expect(ran, "the presses never reached the dispatcher at all").toEqual(["delete"]);
  });
});

describe("both session dialogs hold the gate", () => {
  it("SessionEnded and UnconfirmedOverlay each call useModalGate", () => {
    /*
     * A source check, because the two dialogs mount only behind a live engine and a confirmed
     * server state. The behavioural half above proves the GATE works; this proves the two
     * surfaces that need it are wired to it — which is the half a refactor drops silently.
     */
    const src = readFileSync(`${process.cwd()}/apps/webapp/app/shell/engine.tsx`, "utf8");
    const calls = src.match(/useModalGate\(/g) ?? [];
    expect(calls, "a session dialog stopped holding the modal gate").toHaveLength(2);
    // `inert` stays beside it: it is what removes the background from focus and hit-testing,
    // which the gate cannot do. Neither replaces the other.
    // Call sites only — `useInertBackground` is DECLARED in this file, so a bare token count
    // is off by one and would go green with a call removed.
    expect(src.match(/^\s+useInertBackground\(/gm) ?? [],
      "a session dialog stopped making the background inert").toHaveLength(2);
  });
});
