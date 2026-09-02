/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import { DesktopAutoSuggest, autoSuggestCopy } from "../src/DesktopAutoSuggest.js";
import { DESKTOP_PANE_LABEL } from "../src/DesktopSettings.js";

/**
 * "SUGGEST FOR NEW SENDERS AUTOMATICALLY" — the row, mounted, on every state the engine can be in.
 *
 * ── WHY A RENDERING TEST AND NOT A SOURCE ASSERTION ─────────────────────────────────────────
 *
 * The claim under test is a CLAIM MADE TO A PERSON, and this project treats those as contracts:
 * the switch authorises an automatic path that asks a model on the installer's own key, so what
 * the row says about what is happening has to be true of what the engine will do. Three ways that
 * can be false, and none of them is visible to a test that reads this file's source:
 *
 *  1. THE ROW APPEARS ON A DOOR THAT DOES NOT SERVE IT. The hosted door arms this consent on its
 *     ACCOUNT and its engine answers 404 here; a row drawn anyway would be a second switch over a
 *     flag it does not write, and the direction that costs money is the one where the two disagree.
 *  2. THE ROW IS OFFERED WITH NO MODEL BEHIND IT. Nothing happens without one, so a switch that
 *     said only "on" would be reporting work that is not being done. It must say so instead — and
 *     it must still be usable, or somebody who arms it before setting up a key silently gets
 *     nothing when they do.
 *  3. THE SWITCH SHOWS WHAT WAS ASKED FOR RATHER THAN WHAT IS STORED. This is the person's only
 *     record of whether their own key is being spent unprompted, so a refused write must leave the
 *     control where it was.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Each mutation was run, seen red, and restored.
 *  · Delete the `!value.modelReady` arm from `autoSuggestCopy` → the no-model case says "Off" and
 *    claims senders are merely waiting for a press.
 *  · Make `readAutoSuggest` answer a 404 with a fabricated default instead of `not-served` → the
 *    hosted door draws a switch over a route that has no such setting. That mutation is on the
 *    TRANSPORT and not on the component, and the reason is worth knowing: the component holds one
 *    null for "no value", so hiding the row is not a decision it makes about 404s — the only way
 *    the row can wrongly appear is for the transport to invent a value.
 *  · Make `write` call `setValue({ ...value, on: next })` before the request → the refused-write
 *    case shows a switch that is on while the engine holds off.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** Encode an answer exactly as the shell's `engine_request` does — length, metadata, bytes. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked { method: string; url: string; body?: string }

/**
 * A shell whose engine answers the READ with one thing and every WRITE with another.
 *
 * Two answers rather than one, because the interesting cases here are exactly the ones where they
 * differ: a write that is refused, and a write that lands on a different value than it asked for.
 */
function shellAnswering(read: { status: number; body: string }, write?: { status: number; body: string }) {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const bytes = Uint8Array.from((payload?.body as number[]) ?? []);
      const method = String(payload?.method ?? "GET");
      asked.push({
        method,
        url: String(payload?.url ?? ""),
        ...(bytes.byteLength > 0 ? { body: new TextDecoder().decode(bytes) } : {}),
      });
      const answer = method === "GET" ? read : (write ?? read);
      return encode(answer.status, answer.body);
    },
  };
  return asked;
}

const state = (o: { on: boolean; since: string | null; modelReady: boolean }): string =>
  JSON.stringify(o);

const ON = state({ on: true, since: "2026-08-14T00:00:00.000Z", modelReady: true });
const OFF = state({ on: false, since: null, modelReady: true });
const NO_MODEL = state({ on: false, since: null, modelReady: false });
const NOT_SERVED = JSON.stringify({ error: { code: "not_found", message: "no such route" } });

let hostEl: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => { root.render(h(DesktopAutoSuggest)); });
  /* One more turn: the row reads its value in an effect, so the first render is always the empty
     one and every assertion belongs after the answer has landed. */
  await act(async () => { await Promise.resolve(); });
}

const text = (): string => hostEl.textContent ?? "";
const theSwitch = (): HTMLButtonElement | null =>
  hostEl.querySelector<HTMLButtonElement>('button[role="switch"]');

afterEach(async () => {
  await act(() => root.unmount());
  hostEl.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the automatic-suggestion row on the standalone door", () => {
  it("says what it does, and names the model as the installer's own", async () => {
    const asked = shellAnswering({ status: 200, body: ON });
    await mount();

    expect(theSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Suggest for new senders automatically");
    // The two halves of the claim: WHEN it happens, and that it still decides nothing.
    expect(text()).toContain("finishes bringing in new mail");
    expect(text()).toContain("every sender waits for you");
    // WHAT LEAVES THE MACHINE, on screen at the same moment the switch is on.
    expect(text()).toContain("the model you configured");
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(["GET /local/auto-suggest"]);
  });

  it("promises nothing while it is off", async () => {
    shellAnswering({ status: 200, body: OFF });
    await mount();
    expect(theSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("until you press Suggest");
    // The outbound note belongs to the state where something is actually going out.
    expect(text()).not.toContain("the model you configured");
  });

  /**
   * THE HONEST-COPY CASE, and the reason this row reports the engine's answer rather than its own.
   *
   * An install with no model is a complete, supported way to run this app — rules alone are the
   * product's floor. The pass can do nothing there, so the row must say so rather than present a
   * switch whose only effect is to store a flag. It must ALSO still write, so that arming it first
   * and adding a key afterwards works.
   */
  it("says there is no model to run it with, and still lets the setting be armed", async () => {
    const asked = shellAnswering(
      { status: 200, body: NO_MODEL },
      { status: 200, body: state({ on: true, since: "2026-08-14T00:00:00.000Z", modelReady: false }) },
    );
    await mount();

    expect(text()).toContain("no model set up yet");
    expect(text()).toContain("nothing is being suggested");
    const control = theSwitch()!;
    expect(control.hasAttribute("disabled")).toBe(false);

    await act(async () => { control.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      "GET /local/auto-suggest", "PUT /local/auto-suggest",
    ]);
    expect(asked[1]!.body).toBe(JSON.stringify({ on: true }));
    // ARMED, and STILL SAYING SO — the sentence follows the model, not the switch, so nobody is
    // told work is happening because they flipped something.
    expect(theSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("no model set up yet");
    expect(text()).not.toContain("the model you configured");
  });

  /**
   * AND IT POINTS AT A PANE THE NAV ACTUALLY DRAWS.
   *
   * The actionable half of that sentence said "under This install" — the pane's OLD heading. It is
   * `DESKTOP_PANE_LABEL` now ("Desktop"), which `DesktopGate` hands straight to the Settings nav,
   * so the instruction named a heading no window had drawn since the rename. Pinned against the
   * constant and not against a second literal, because a second literal is exactly what drifted.
   */
  it("sends somebody to the pane the nav actually draws", () => {
    const said = autoSuggestCopy({ on: false, since: null, modelReady: false });
    expect(said).toContain(`under ${DESKTOP_PANE_LABEL}`);
    expect(said).not.toContain("under This install");
  });

  it("draws nothing on a door that does not serve the route", async () => {
    shellAnswering({ status: 404, body: NOT_SERVED });
    await mount();
    // Not a disabled switch and not an error card: this consent lives on the account there, and a
    // second control over it in this window is the thing being avoided.
    expect(text()).toBe("");
    expect(theSwitch()).toBeNull();
  });

  it("leaves the switch where it was when the write is refused, and says so", async () => {
    shellAnswering(
      { status: 200, body: OFF },
      { status: 500, body: JSON.stringify({ error: { message: "the store would not take it" } }) },
    );
    await mount();

    await act(async () => { theSwitch()!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(theSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("That did not save. Nothing has changed.");
  });
});
